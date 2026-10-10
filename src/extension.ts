import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { coalesce } from './coalesce';
import * as git from './git';
import { FileCard, PanelMessage, PanelProvider, PanelState, TypedAnswer } from './panel';
import {
  buildAnswerPrompt,
  buildFilePrompt,
  buildPrompt,
  ClaudeOptions,
  MAX_ANSWER_CHARS,
  parseAnswerFeedback,
  parseFileReview,
  parseReview,
  Question,
  splitDiff,
  truncateDiff,
} from './reviewer';
import { ClaudeSession, ReviewBackend } from './session';
import { CopilotBackend, LmApi } from './copilot';

const BASELINE_KEY = 'tailgate.baseline';
const CONSENT_KEY = 'tailgate.consented';

type Provider = 'claude' | 'copilot';

/** Where each provider sends code, in the words used when asking for consent. */
const DESTINATION: Record<Provider, string> = {
  claude: 'Claude through the Claude Code CLI',
  copilot: 'GitHub Copilot through VS Code',
};

const lmApi: LmApi = {
  selectChatModels: (selector) => vscode.lm.selectChatModels(selector),
  userMessage: (content) => vscode.LanguageModelChatMessage.User(content),
  createCancellation: () => {
    const source = new vscode.CancellationTokenSource();
    return { token: source.token, cancel: () => source.cancel(), dispose: () => source.dispose() };
  },
};
const BASE_SCHEME = 'tailgate-base';
const REFRESH_DELAY_MS = 1500;

/** Returned from activate() so host tests can observe the extension. */
export interface TailgateApi {
  getState(): PanelState;
  /** Delivers a message as if the panel had sent it. */
  send(message: PanelMessage): Promise<void>;
}

/** One changed file's live review, with what is needed to write it. */
interface CardEntry {
  file: git.ChangedFile;
  diff: string;
  truncated: boolean;
  /** When this version of the file's diff was first seen. */
  changedAt: number;
  card: FileCard;
}

class Controller implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly panel: PanelProvider;
  private backend?: { provider: Provider; instance: ReviewBackend };
  state: PanelState = { status: 'idle', files: [] };

  private root?: string;
  /** Tree the user last marked as reviewed; changes are measured from here. */
  private baseline = '';
  /** Tree of the working directory at the last refresh. */
  private current = '';

  private visible = false;
  private refreshFailed = false;
  private refreshTimer?: NodeJS.Timeout;
  private autoTimer?: NodeJS.Timeout;
  private abort?: AbortController;

  private readonly cards = new Map<string, CardEntry>();
  private readonly typed = new Map<string, TypedAnswer>();
  private liveTimer?: NodeJS.Timeout;
  private liveBusy = false;

  /** Overlapping refreshes share one snapshot; awaiting it always yields fresh state. */
  private readonly refresh = coalesce(() => this.snapshot());

  constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = new PanelProvider(
      context.extensionUri,
      (message) => void this.handle(message),
      (visible) => this.setVisible(visible),
    );
  }

  async start(): Promise<void> {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFsEvent = (uri: vscode.Uri) => {
      // Snapshots write objects into .git, which must not trigger another snapshot.
      if (!/\/(\.git|node_modules)\//.test(uri.path)) {
        this.scheduleRefresh();
      }
    };

    this.disposables.push(
      vscode.window.registerWebviewViewProvider(PanelProvider.viewId, this.panel, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
        provideTextDocumentContent: (uri) => (this.root ? git.showFile(this.root, uri.query, uri.path.slice(1)) : ''),
      }),
      vscode.commands.registerCommand('tailgate.review', () => this.review()),
      vscode.commands.registerCommand('tailgate.markReviewed', () => this.markReviewed()),
      vscode.commands.registerCommand('tailgate.refresh', () => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.init()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('tailgate.claudePath') || event.affectsConfiguration('tailgate.model')) {
          this.backend?.instance.restart();
        }
        if (event.affectsConfiguration('tailgate.provider')) {
          this.warmIfLive();
          this.setState(this.state);
        }
        if (event.affectsConfiguration('tailgate.autoReview') || event.affectsConfiguration('tailgate.liveReview')) {
          this.warmIfLive();
          void this.refresh();
        }
      }),
      watcher,
      watcher.onDidChange(onFsEvent),
      watcher.onDidCreate(onFsEvent),
      watcher.onDidDelete(onFsEvent),
    );
    await this.init();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.autoTimer);
    clearTimeout(this.liveTimer);
    this.abort?.abort();
    this.backend?.instance.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('tailgate');
  }

  private provider(): Provider {
    return this.config().get<string>('provider', 'claude') === 'copilot' ? 'copilot' : 'claude';
  }

  /** The backend for the chosen provider, replaced when the choice changes. */
  private session(): ReviewBackend {
    const provider = this.provider();
    if (this.backend?.provider !== provider) {
      this.backend?.instance.dispose();
      const timeoutMs = () => Math.max(10, this.config().get<number>('timeoutSeconds', 180)) * 1000;
      const instance =
        provider === 'copilot'
          ? new CopilotBackend(lmApi, () => ({ family: this.config().get<string>('copilotModel', '').trim(), timeoutMs: timeoutMs() }))
          : new ClaudeSession(() => this.claudeOptions());
      this.backend = { provider, instance };
    }
    return this.backend.instance;
  }

  private claudeOptions(): ClaudeOptions {
    const config = this.config();
    return {
      bin: config.get<string>('claudePath', 'claude') || 'claude',
      model: config.get<string>('model', 'sonnet') || 'sonnet',
      timeoutMs: Math.max(10, config.get<number>('timeoutSeconds', 180)) * 1000,
      // A neutral directory keeps the reviewed project's own Claude settings and hooks out of the run.
      cwd: os.tmpdir(),
    };
  }

  private excludes(): string[] {
    const extra = this.config()
      .get<string[]>('exclude', [])
      .filter((p) => typeof p === 'string' && p.trim() !== '');
    return [...git.GENERATED_EXCLUDES, ...git.SENSITIVE_EXCLUDES, ...extra];
  }

  private maxDiffChars(): number {
    return Math.max(2000, this.config().get<number>('maxDiffChars', 60000));
  }

  /** Consent is kept per provider, because each one sends code to a different company. */
  private consentKey(): string {
    return this.provider() === 'claude' ? CONSENT_KEY : `${CONSENT_KEY}.${this.provider()}`;
  }

  private consented(): boolean {
    return Boolean(this.context.globalState.get<boolean>(this.consentKey())) || this.context.extensionMode === vscode.ExtensionMode.Test;
  }

  /** Every state update carries the live-review cards, so callers never have to. */
  private setState(state: PanelState): void {
    const cards: Record<string, FileCard> = {};
    for (const [file, entry] of this.cards) {
      cards[file] = entry.card;
    }
    this.state = { ...state, provider: this.provider(), live: this.liveEnabled(), cards, typed: Object.fromEntries(this.typed) };
    this.panel.setState(this.state);
  }

  /** Finds the question a key names, and the diff it is about, if that review is still on screen. */
  private findQuestion(key: string): { question: Question; diff: string } | undefined {
    const last = key.lastIndexOf(':');
    const [scope, id, tail] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1, last), key.slice(last + 1)];
    if (scope === 'file') {
      const entry = this.cards.get(id);
      const question = entry?.card.key === tail ? entry.card.review?.question : undefined;
      return question && entry ? { question, diff: entry.diff } : undefined;
    }
    if (scope === 'all' && this.state.reviewTree === id) {
      const question = this.state.review?.questions[Number(tail)];
      return question ? { question, diff: '' } : undefined;
    }
    return undefined;
  }

  /** Marks an answer the user typed in their own words. */
  private async answer(key: string, text: string): Promise<void> {
    const answer = typeof text === 'string' ? text.trim().slice(0, MAX_ANSWER_CHARS) : '';
    const found = typeof key === 'string' ? this.findQuestion(key) : undefined;
    if (!found || !answer || this.typed.get(key)?.state === 'loading' || !(await this.consent(false))) {
      return;
    }
    const entry: TypedAnswer = { state: 'loading', text: answer };
    this.typed.set(key, entry);
    this.setState(this.state);
    let done: TypedAnswer;
    try {
      const reply = await this.session().ask(buildAnswerPrompt(found.question, answer, found.diff));
      done = { state: 'ready', text: answer, result: parseAnswerFeedback(reply) };
    } catch (err) {
      done = { state: 'error', text: answer, error: (err as Error).message };
    }
    if (this.typed.get(key) === entry) {
      this.typed.set(key, done);
      this.setState(this.state);
    }
  }

  private autoReview(): boolean {
    return this.config().get<boolean>('autoReview', false);
  }

  /** Live review sends code as files change, so it needs both the setting and the one-time consent. */
  private liveEnabled(): boolean {
    return this.config().get<boolean>('liveReview', false) && this.consented();
  }

  /** Snapshots write to the repository's object store, so they only run while someone is looking. */
  private tracking(): boolean {
    return this.visible || this.autoReview();
  }

  private warmIfLive(): void {
    if (this.visible && this.liveEnabled() && this.root) {
      this.session().warm();
    }
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.warmIfLive();
      void this.refresh();
    } else {
      clearTimeout(this.liveTimer);
    }
  }

  private async init(): Promise<void> {
    this.abort?.abort();
    this.root = undefined;
    this.refreshFailed = false;
    this.cards.clear();
    try {
      if (!(await git.isAvailable())) {
        this.setState({ status: 'no-git', files: [] });
        return;
      }
      let root: string | undefined;
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        root = await git.repoRoot(folder.uri.fsPath);
        if (root) {
          break;
        }
      }
      if (!root) {
        this.setState({ status: 'no-repo', files: [] });
        return;
      }
      const saved = this.context.workspaceState.get<string>(BASELINE_KEY);
      this.baseline = saved && (await git.treeExists(root, saved)) ? saved : await git.headTree(root);
      this.current = this.baseline;
      this.root = root;
      this.setState({ status: 'idle', files: [] });
    } catch (err) {
      this.setState({ status: 'error', files: [], error: `Could not read the repository: ${(err as Error).message}` });
      return;
    }
    if (this.tracking()) {
      this.warmIfLive();
      await this.refresh();
    }
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    if (!this.tracking()) {
      return;
    }
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }

  private async snapshot(): Promise<void> {
    const root = this.root;
    if (!root) {
      return;
    }
    try {
      const current = await git.snapshotTree(root);
      const files = await git.changedFiles(root, this.baseline, current);
      const parts = this.liveEnabled() ? splitDiff(await git.diffText(root, this.baseline, current, this.excludes())) : undefined;
      if (root !== this.root) {
        return;
      }
      this.current = current;
      this.syncCards(files, parts);
      // A refresh error clears once the repository can be read again; a review error stays until retried.
      const recovered = this.refreshFailed && this.state.status === 'error';
      this.refreshFailed = false;
      this.setState({
        ...this.state,
        ...(recovered ? { status: this.state.review ? ('ready' as const) : ('idle' as const), error: undefined } : {}),
        files,
        stale: this.state.reviewTree !== undefined && this.state.reviewTree !== current,
      });
    } catch (err) {
      if (root !== this.root) {
        return;
      }
      this.refreshFailed = true;
      if (this.state.status !== 'loading') {
        this.setState({ ...this.state, status: 'error', error: `Could not read the repository: ${(err as Error).message}` });
      }
    }
    this.scheduleLive();
    this.scheduleAutoReview();
  }

  /**
   * Brings the live cards in line with the changed files. A file whose diff is
   * unchanged keeps its card; one that changed again goes back to waiting.
   */
  private syncCards(files: git.ChangedFile[], parts: Map<string, string> | undefined): void {
    if (!parts) {
      this.cards.clear();
      return;
    }
    const maxChars = this.maxDiffChars();
    const now = Date.now();
    for (const file of [...this.cards.keys()]) {
      if (!files.some((f) => f.path === file)) {
        this.cards.delete(file);
      }
    }
    for (const file of files) {
      const part = file.added === null ? undefined : parts.get(file.path);
      const key = part === undefined ? 'skipped' : crypto.createHash('sha1').update(part).digest('hex');
      if (this.cards.get(file.path)?.card.key === key) {
        continue;
      }
      this.cards.set(file.path, {
        file,
        diff: (part ?? '').slice(0, maxChars),
        truncated: (part ?? '').length > maxChars,
        changedAt: now,
        card: { key, state: part === undefined ? 'skipped' : 'waiting' },
      });
    }
  }

  private settleMs(): number {
    return Math.max(2, this.config().get<number>('liveReviewDelaySeconds', 4)) * 1000;
  }

  private scheduleLive(): void {
    clearTimeout(this.liveTimer);
    if (!this.visible || !this.liveEnabled() || this.liveBusy) {
      return;
    }
    const waiting = [...this.cards.values()].filter((entry) => entry.card.state === 'waiting');
    if (waiting.length === 0) {
      return;
    }
    const due = Math.min(...waiting.map((entry) => entry.changedAt)) + this.settleMs();
    this.liveTimer = setTimeout(() => void this.runLive(), Math.max(0, due - Date.now()));
  }

  /** Reviews, one at a time and oldest first, every file that has stopped changing. */
  private async runLive(): Promise<void> {
    if (this.liveBusy) {
      return;
    }
    this.liveBusy = true;
    try {
      while (this.visible && this.liveEnabled()) {
        const cutoff = Date.now() - this.settleMs();
        const next = [...this.cards.entries()]
          .filter(([, entry]) => entry.card.state === 'waiting' && entry.changedAt <= cutoff)
          .sort((a, b) => a[1].changedAt - b[1].changedAt)[0];
        if (!next) {
          break;
        }
        const [file, entry] = next;
        const key = entry.card.key;
        entry.card = { key, state: 'loading' };
        this.setState(this.state);
        let card: FileCard;
        try {
          const reply = await this.session().ask(buildFilePrompt(entry.file, entry.diff, entry.truncated));
          card = { key, state: 'ready', review: parseFileReview(reply, file, entry.diff) };
        } catch (err) {
          card = { key, state: 'error', error: (err as Error).message };
        }
        // The file may have changed again while its review was being written.
        if (this.cards.get(file) === entry) {
          entry.card = card;
          this.setState(this.state);
        }
      }
    } finally {
      this.liveBusy = false;
    }
    this.scheduleLive();
  }

  private scheduleAutoReview(): void {
    clearTimeout(this.autoTimer);
    if (
      !this.autoReview() ||
      this.state.files.length === 0 ||
      this.state.status === 'loading' ||
      this.state.status === 'error' ||
      this.state.reviewTree === this.current
    ) {
      return;
    }
    const delay = Math.max(5, this.config().get<number>('autoReviewDelaySeconds', 20)) * 1000;
    this.autoTimer = setTimeout(() => void this.review(true), delay);
  }

  /** Reviews send code off the machine, so the first one needs an explicit yes. */
  private async consent(automatic: boolean): Promise<boolean> {
    if (this.consented()) {
      return true;
    }
    if (automatic) {
      return false;
    }
    const answer = await vscode.window.showInformationMessage(
      `Tailgate writes reviews by sending the diff of your changed files to ${DESTINATION[this.provider()]}.`,
      {
        modal: true,
        detail:
          'Lock files, generated files and files that commonly hold secrets (such as .env and key files) are left out. ' +
          'Each review counts against your usage with that service. You will not be asked again for it.',
      },
      'Continue',
    );
    if (answer !== 'Continue') {
      return false;
    }
    await this.context.globalState.update(this.consentKey(), true);
    return true;
  }

  private async setLive(on: boolean): Promise<void> {
    if (on && !(await this.consent(false))) {
      return;
    }
    // The configuration change handler picks this up and refreshes.
    await this.config().update('liveReview', on, vscode.ConfigurationTarget.Global);
  }

  private async setProvider(provider: Provider): Promise<void> {
    // The configuration change handler picks this up.
    await this.config().update('provider', provider === 'copilot' ? 'copilot' : 'claude', vscode.ConfigurationTarget.Global);
    // Live review would otherwise stop without a word until the new provider has been agreed to.
    if (this.config().get<boolean>('liveReview', false) && (await this.consent(false))) {
      this.warmIfLive();
      await this.refresh();
    }
  }

  private async review(automatic = false): Promise<void> {
    if (!this.root) {
      if (!automatic) {
        void vscode.window.showInformationMessage('Tailgate needs git and a folder that is a git repository.');
      }
      return;
    }
    if (!(await this.consent(automatic))) {
      return;
    }
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    clearTimeout(this.autoTimer);

    await this.refresh();
    const root = this.root;
    if (abort.signal.aborted || !root) {
      return;
    }
    if (this.refreshFailed) {
      return;
    }
    if (this.state.files.length === 0) {
      if (!automatic) {
        void vscode.window.showInformationMessage('Tailgate: nothing has changed since your last review.');
      }
      return;
    }

    const tree = this.current;
    const files = this.state.files;
    this.setState({ status: 'loading', files });

    try {
      const diff = await git.diffText(root, this.baseline, tree, this.excludes());
      if (diff.trim() === '') {
        throw new Error('Every changed file is a lock file, a generated file or a file that may hold secrets, so there is nothing to review.');
      }
      const diffed = git.diffedPaths(diff);
      const cut = truncateDiff(diff, this.maxDiffChars());
      const reply = await this.session().ask(buildPrompt(files, cut), abort.signal);
      const review = parseReview(reply, cut.text);
      if (abort.signal.aborted) {
        return;
      }
      this.setState({
        status: 'ready',
        files: this.state.files,
        review,
        reviewTree: tree,
        stale: tree !== this.current,
        trimmedFiles: cut.omittedFiles + (cut.hardCut ? 1 : 0),
        excludedFiles: files.filter((f) => !diffed.has(f.path)).length,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        return;
      }
      this.setState({ status: 'error', files: this.state.files, error: (err as Error).message });
    }
  }

  private cancel(): void {
    if (this.state.status !== 'loading') {
      return;
    }
    this.abort?.abort();
    this.setState({ status: 'idle', files: this.state.files });
  }

  private async markReviewed(): Promise<void> {
    if (!this.root) {
      return;
    }
    this.abort?.abort();
    // With a review on screen, only what it covered counts as reviewed.
    if (this.state.status === 'ready' && this.state.reviewTree) {
      this.baseline = this.state.reviewTree;
    } else {
      await this.refresh();
      this.baseline = this.current;
    }
    await this.context.workspaceState.update(BASELINE_KEY, this.baseline);
    this.cards.clear();
    this.typed.clear();
    this.setState({ status: 'idle', files: [] });
    await this.refresh();
  }

  private resolveInRoot(file: string): string | undefined {
    if (!this.root || typeof file !== 'string') {
      return undefined;
    }
    const full = path.resolve(this.root, file);
    return full.startsWith(this.root + path.sep) ? full : undefined;
  }

  private async openDiff(file: string): Promise<void> {
    const full = this.resolveInRoot(file);
    const entry = this.state.files.find((f) => f.path === file);
    if (!full || !entry) {
      return;
    }
    const before = vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${entry.path}`, query: this.baseline });
    if (entry.status === 'deleted') {
      await vscode.window.showTextDocument(before, { preview: true });
    } else {
      await vscode.commands.executeCommand('vscode.diff', before, vscode.Uri.file(full), `${entry.path} (since last review)`);
    }
  }

  private async openFile(file: string, line?: number): Promise<void> {
    const full = this.resolveInRoot(file);
    if (!full) {
      return;
    }
    const row = typeof line === 'number' && Number.isInteger(line) && line > 0 ? line - 1 : undefined;
    const selection = row === undefined ? undefined : new vscode.Range(row, 0, row, 0);
    await vscode.window.showTextDocument(vscode.Uri.file(full), { preview: true, selection });
  }

  async handle(message: PanelMessage): Promise<void> {
    try {
      switch (message?.type) {
        case 'review':
          return await this.review();
        case 'cancel':
          return this.cancel();
        case 'markReviewed':
          return await this.markReviewed();
        case 'setLive':
          return await this.setLive(message.on === true);
        case 'setProvider':
          return await this.setProvider(message.provider);
        case 'answer':
          return await this.answer(message.key, message.text);
        case 'openDiff':
          return await this.openDiff(message.file);
        case 'openFile':
          return await this.openFile(message.file, message.line);
      }
    } catch (err) {
      void vscode.window.showWarningMessage(`Tailgate: ${(err as Error).message}`);
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<TailgateApi> {
  const controller = new Controller(context);
  context.subscriptions.push(controller);
  await controller.start();
  return { getState: () => controller.state, send: (message) => controller.handle(message) };
}

export function deactivate(): void {}
