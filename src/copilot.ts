import type { ReviewBackend } from './session';

/** The slice of a VS Code chat model that Catchup uses. */
export interface LmModel {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  sendRequest(messages: unknown[], options: { justification?: string }, token: unknown): PromiseLike<{ text: AsyncIterable<string> }>;
}

/**
 * The slice of VS Code's language model API that Catchup uses, passed in so
 * this file can be tested without VS Code.
 */
export interface LmApi {
  selectChatModels(selector: { vendor: string; family?: string }): PromiseLike<LmModel[]>;
  userMessage(content: string): unknown;
  createCancellation(): { token: unknown; cancel(): void; dispose(): void };
}

export interface CopilotOptions {
  /** Model family to use, such as "gpt-4o". Empty means whichever model Copilot lists first. */
  family: string;
  timeoutMs: number;
}

const INSTRUCTIONS = 'You are a careful senior code reviewer. Reply with one JSON object only.\n\n';
const JUSTIFICATION = 'Catchup sends the diff of your changed files to write a review of them.';

/** Turns a language model failure into a message the user can act on. */
export function describeCopilotError(err: unknown): Error {
  const code = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'NoPermissions') {
    return new Error('Catchup is not allowed to use GitHub Copilot yet. Click "Review all changes" and choose Allow when VS Code asks.');
  }
  if (code === 'Blocked') {
    return new Error(`GitHub Copilot refused the request, which usually means a usage limit was reached. ${message}`.trim());
  }
  if (code === 'NotFound') {
    return new Error('The GitHub Copilot model is no longer available. Try again, or pick another in the catchup.copilotModel setting.');
  }
  return new Error(`GitHub Copilot could not write the review: ${message}`);
}

/**
 * Writes reviews with the user's GitHub Copilot subscription through VS Code's
 * language model API. Requests run one at a time, in order, like the Claude
 * backend, so a burst of file changes cannot fan out into parallel requests.
 */
export class CopilotBackend implements ReviewBackend {
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly lm: LmApi,
    private readonly options: () => CopilotOptions,
  ) {}

  ask(prompt: string, signal?: AbortSignal): Promise<string> {
    const run = () => this.request(prompt, signal);
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  // There is no process to start or replace: VS Code owns the connection.
  warm(): void {}
  restart(): void {}

  dispose(): void {
    this.disposed = true;
  }

  private async request(prompt: string, signal?: AbortSignal): Promise<string> {
    if (this.disposed || signal?.aborted) {
      throw new Error('Review cancelled.');
    }
    const { family, timeoutMs } = this.options();
    let models: LmModel[];
    try {
      models = await this.lm.selectChatModels({ vendor: 'copilot', ...(family ? { family } : {}) });
    } catch (err) {
      throw describeCopilotError(err);
    }
    if (models.length === 0) {
      throw new Error(
        family
          ? `GitHub Copilot has no model called "${family}". Check the catchup.copilotModel setting, or leave it empty.`
          : 'GitHub Copilot is not available. Install the GitHub Copilot Chat extension and sign in, or switch Catchup to the Claude CLI.',
      );
    }

    const cancellation = this.lm.createCancellation();
    let stopped: string | undefined;
    const stop = (reason: string) => {
      stopped = stopped ?? reason;
      cancellation.cancel();
    };
    const onAbort = () => stop('Review cancelled.');
    const timer = setTimeout(() => stop(`The review took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`), timeoutMs);
    signal?.addEventListener('abort', onAbort);
    try {
      const response = await models[0].sendRequest([this.lm.userMessage(INSTRUCTIONS + prompt)], { justification: JUSTIFICATION }, cancellation.token);
      let text = '';
      for await (const chunk of response.text) {
        text += chunk;
        if (stopped) {
          break;
        }
      }
      if (stopped) {
        throw new Error(stopped);
      }
      return text;
    } catch (err) {
      throw stopped ? new Error(stopped) : describeCopilotError(err);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      cancellation.dispose();
    }
  }
}
