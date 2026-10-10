import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { ChangedFile } from './git';
import type { AnswerFeedback, FileReview, Review } from './reviewer';

/** An answer the user typed in their own words, and what the model made of it. */
export interface TypedAnswer {
  state: 'loading' | 'ready' | 'error';
  text: string;
  result?: AnswerFeedback;
  error?: string;
}

/** Live review of one changed file. `key` changes whenever the file's diff does. */
export interface FileCard {
  key: string;
  state: 'waiting' | 'loading' | 'ready' | 'error' | 'skipped';
  review?: FileReview;
  error?: string;
}

export interface PanelState {
  status: 'no-git' | 'no-repo' | 'idle' | 'loading' | 'ready' | 'error';
  files: ChangedFile[];
  /** Which service writes the reviews. */
  provider?: 'claude' | 'copilot';
  /** Whether each file is reviewed by itself as soon as it stops changing. */
  live?: boolean;
  /** Live reviews by file path. */
  cards?: Record<string, FileCard>;
  /**
   * Typed answers by question key: "file:<path>:<card key>" for a live card's
   * question, "all:<review tree>:<index>" for a question in the full review.
   */
  typed?: Record<string, TypedAnswer>;
  review?: Review;
  /** Tree hash the review was written for; also keys quiz answers in the webview. */
  reviewTree?: string;
  /** Files changed again after the review was written. */
  stale?: boolean;
  /** Files left out or cut short because the diff was too large. */
  trimmedFiles?: number;
  /** Files held back on purpose: lock files, generated files and files that may hold secrets. */
  excludedFiles?: number;
  error?: string;
}

export type PanelMessage =
  | { type: 'review' }
  | { type: 'cancel' }
  | { type: 'markReviewed' }
  | { type: 'setLive'; on: boolean }
  | { type: 'setProvider'; provider: 'claude' | 'copilot' }
  | { type: 'answer'; key: string; text: string }
  | { type: 'openDiff'; file: string }
  | { type: 'openFile'; file: string; line?: number };

export class PanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'catchup.panel';

  private view?: vscode.WebviewView;
  private state: PanelState = { status: 'idle', files: [] };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: PanelMessage) => void,
    private readonly onVisibility: (visible: boolean) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') {
        this.post();
      } else {
        this.onMessage(message);
      }
    });
    view.onDidChangeVisibility(() => this.onVisibility(view.visible));
    view.onDidDispose(() => {
      this.view = undefined;
      this.onVisibility(false);
    });
    this.post();
    this.onVisibility(view.visible);
  }

  setState(state: PanelState): void {
    this.state = state;
    this.post();
  }

  private post(): void {
    if (!this.view) {
      return;
    }
    const count = this.state.files.length;
    this.view.badge = count > 0 ? { value: count, tooltip: `${count} changed file${count === 1 ? '' : 's'} to review` } : undefined;
    void this.view.webview.postMessage({ type: 'state', state: this.state });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
