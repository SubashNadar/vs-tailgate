import type { ChildProcess } from 'node:child_process';
import { ClaudeOptions, describeFailure, killTree, readResult, spawnClaude } from './reviewer';

/** Something that can turn a prompt into the model's reply. */
export interface ReviewBackend {
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
  /** Gets ready ahead of the first request, where that helps. */
  warm(): void;
  /** Drops any connection so the next request starts fresh. */
  restart(): void;
  dispose(): void;
}

interface Job {
  prompt: string;
  signal?: AbortSignal;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
}

/**
 * A Claude CLI process kept alive between requests. Starting the CLI takes
 * around ten seconds, so paying that once instead of per request is what makes
 * quick per-file reviews possible. Requests run one at a time, in order.
 *
 * The process keeps its conversation, so it is replaced after `maxRequests`
 * to stop the history growing without bound, and stopped when idle.
 */
export class ClaudeSession implements ReviewBackend {
  private child?: ChildProcess;
  private buffer = '';
  private stderr = '';
  private served = 0;
  private active?: Job;
  private readonly queue: Job[] = [];
  private idleTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly options: () => ClaudeOptions,
    private readonly maxRequests = 20,
    private readonly idleMs = 180000,
  ) {}

  /** Starts the process ahead of the first request. Failures surface on that request. */
  warm(): void {
    if (this.disposed) {
      return;
    }
    try {
      this.ensure();
      this.touch();
    } catch {
      // Reported when a request is made.
    }
  }

  ask(prompt: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('Review cancelled.'));
        return;
      }
      const job: Job = { prompt, signal, resolve, reject };
      if (signal?.aborted) {
        reject(new Error('Review cancelled.'));
        return;
      }
      job.onAbort = () => this.cancel(job);
      signal?.addEventListener('abort', job.onAbort);
      this.queue.push(job);
      this.pump();
    });
  }

  /** Stops the process and fails anything in flight. The next request starts a new process. */
  restart(): void {
    const child = this.child;
    this.child = undefined;
    if (child) {
      this.detach(child);
      killTree(child);
    }
    if (this.active) {
      this.settle(this.active, new Error('Review cancelled.'));
    }
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    for (const job of this.queue.splice(0)) {
      this.settle(job, new Error('Review cancelled.'));
    }
    this.restart();
  }

  private settle(job: Job, error: Error | undefined, value = ''): void {
    clearTimeout(job.timer);
    if (job.onAbort) {
      job.signal?.removeEventListener('abort', job.onAbort);
    }
    if (this.active === job) {
      this.active = undefined;
    }
    if (error) {
      job.reject(error);
    } else {
      job.resolve(value);
    }
  }

  private cancel(job: Job): void {
    const queued = this.queue.indexOf(job);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.settle(job, new Error('Review cancelled.'));
    } else if (this.active === job) {
      // A request in flight cannot be withdrawn, so the process is replaced.
      this.restart();
    }
  }

  /** Stops listening to a process that is being let go, without leaving its errors unhandled. */
  private detach(child: ChildProcess): void {
    child.removeAllListeners();
    child.on('error', () => undefined);
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.active && this.queue.length === 0) {
        this.restart();
      }
    }, this.idleMs);
  }

  private ensure(): ChildProcess {
    if (this.child && this.served < this.maxRequests) {
      return this.child;
    }
    if (this.child) {
      // Retire the old process politely: closing stdin lets it exit by itself.
      this.detach(this.child);
      this.child.stdin?.end();
    }
    const options = this.options();
    const child = spawnClaude(options, true);
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    this.served = 0;

    child.stdout!.on('data', (chunk) => this.read(child, String(chunk)));
    child.stderr!.on('data', (chunk) => (this.stderr = (this.stderr + chunk).slice(-2000)));
    child.stdin!.on('error', () => undefined);
    const gone = (error: Error) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      if (this.active) {
        this.settle(this.active, error);
      }
      this.pump();
    };
    child.on('error', (err: NodeJS.ErrnoException) =>
      gone(err.code === 'ENOENT' ? describeFailure(127, '', '') : new Error(`Could not start the Claude CLI (${err.message}).`)),
    );
    child.on('close', (code) => gone(describeFailure(code, '', this.stderr)));
    return child;
  }

  private read(child: ChildProcess, chunk: string): void {
    if (this.child !== child) {
      return;
    }
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let message: { type?: string };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type !== 'result' || !this.active) {
        continue;
      }
      const job = this.active;
      this.served++;
      try {
        this.settle(job, undefined, readResult(message));
      } catch (err) {
        this.settle(job, err as Error);
      }
      this.pump();
    }
  }

  private pump(): void {
    if (this.active || this.disposed) {
      return;
    }
    const job = this.queue.shift();
    if (!job) {
      return;
    }
    this.active = job;
    let child: ChildProcess;
    let timeoutMs: number;
    try {
      child = this.ensure();
      timeoutMs = this.options().timeoutMs;
    } catch (err) {
      this.settle(job, err as Error);
      this.pump();
      return;
    }
    job.timer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      // settle() first so restart() does not report this as a cancellation.
      this.settle(job, new Error(`The review took longer than ${seconds} seconds and was stopped.`));
      this.restart();
    }, timeoutMs);
    this.touch();
    child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: job.prompt } }) + '\n');
  }
}
