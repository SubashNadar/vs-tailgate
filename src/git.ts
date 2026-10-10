import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Lock files and build output: noise in a review. */
export const GENERATED_EXCLUDES = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/*.min.js',
  '**/*.map',
  '**/*.snap',
];

/** Files that commonly hold credentials. Their contents are never sent for review. */
export const SENSITIVE_EXCLUDES = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
  '**/credentials.json',
  '**/secrets.*',
];

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** null for binary files */
  added: number | null;
  deleted: number | null;
}

let indexCounter = 0;

function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, env: options.env, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
        } else {
          resolve(stdout);
        }
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export async function isAvailable(): Promise<boolean> {
  try {
    await git(os.tmpdir(), ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return path.normalize((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return undefined;
  }
}

/** Tree of the last commit, or the empty tree in a repository with no commits. */
export async function headTree(root: string): Promise<string> {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'])).trim();
  } catch {
    // Asking git for the empty tree keeps this right for SHA-256 repositories too.
    return (await git(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' })).trim();
  }
}

export async function treeExists(root: string, tree: string): Promise<boolean> {
  try {
    await git(root, ['cat-file', '-e', `${tree}^{tree}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the working tree (tracked and untracked, minus ignored files) as a
 * git tree object and returns its hash. Uses a throwaway index so the user's
 * staging area is never touched.
 */
export async function snapshotTree(root: string): Promise<string> {
  const tmpIndex = path.join(os.tmpdir(), `tailgate-index-${process.pid}-${Date.now()}-${indexCounter++}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    // Start from a copy of the real index so unchanged files are not rehashed.
    const realIndex = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
    await fs.copyFile(realIndex, tmpIndex).catch(() => undefined);
    await git(root, ['add', '-A'], { env });
    return (await git(root, ['write-tree'], { env })).trim();
  } finally {
    await fs.rm(tmpIndex, { force: true });
    await fs.rm(`${tmpIndex}.lock`, { force: true });
  }
}

/** Parses `git diff --name-status -z` and `git diff --numstat -z` output (renames off). */
export function parseChangedFiles(nameStatus: string, numstat: string): ChangedFile[] {
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  for (const record of numstat.split('\0')) {
    const [added, deleted, ...rest] = record.split('\t');
    if (rest.length === 0) {
      continue;
    }
    counts.set(rest.join('\t'), {
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
    });
  }

  const files: ChangedFile[] = [];
  const fields = nameStatus.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i][0];
    const file = fields[i + 1];
    const count = counts.get(file) ?? { added: null, deleted: null };
    files.push({
      path: file,
      status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
      ...count,
    });
  }
  return files;
}

export async function changedFiles(root: string, base: string, head: string): Promise<ChangedFile[]> {
  if (base === head) {
    return [];
  }
  const [nameStatus, numstat] = await Promise.all([
    git(root, ['diff', '--no-renames', '--name-status', '-z', base, head]),
    git(root, ['diff', '--no-renames', '--numstat', '-z', base, head]),
  ]);
  return parseChangedFiles(nameStatus, numstat);
}

export function diffText(root: string, base: string, head: string, excludes: string[]): Promise<string> {
  return git(root, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '-U3',
    base,
    head,
    '--',
    '.',
    ...excludes.map((pattern) => `:(exclude,glob)${pattern}`),
  ]);
}

/** Paths that have a section in the given diff text. */
export function diffedPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+) b\/\1$/gm)) {
    paths.add(match[1]);
  }
  return paths;
}

/** Contents of a file as it was in the given tree; empty if it did not exist. */
export async function showFile(root: string, tree: string, file: string): Promise<string> {
  try {
    return await git(root, ['show', `${tree}:${file}`]);
  } catch {
    return '';
  }
}
