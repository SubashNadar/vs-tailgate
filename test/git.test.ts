import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import * as git from '../src/git';

const EXCLUDES = [...git.GENERATED_EXCLUDES, ...git.SENSITIVE_EXCLUDES];

let repo: string;

const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
};

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tailgate-test-'));
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'core.autocrlf', 'false');
  write('.gitignore', 'ignored/\n');
  write('keep.txt', 'one\ntwo\n');
  write('remove.txt', 'bye\n');
  write('package-lock.json', '{}\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
});

after(() => fs.rmSync(repo, { recursive: true, force: true }));

test('isAvailable reports that git can run', async () => {
  assert.equal(await git.isAvailable(), true);
});

test('parseChangedFiles merges status and line counts, including awkward file names', () => {
  const files = git.parseChangedFiles(
    'M\0src/a b.ts\0A\0logo.png\0D\0old.ts\0A\0odd\t"name".txt\0',
    '3\t1\tsrc/a b.ts\0-\t-\tlogo.png\0' + '0\t9\told.ts\0' + '2\t0\todd\t"name".txt\0',
  );
  assert.deepEqual(files, [
    { path: 'src/a b.ts', status: 'modified', added: 3, deleted: 1 },
    { path: 'logo.png', status: 'added', added: null, deleted: null },
    { path: 'old.ts', status: 'deleted', added: 0, deleted: 9 },
    { path: 'odd\t"name".txt', status: 'added', added: 2, deleted: 0 },
  ]);
});

test('diffedPaths lists the files that have a section in a diff', () => {
  const diff = 'diff --git a/src/a b.ts b/src/a b.ts\n--- a/src/a b.ts\n+++ b/src/a b.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/new.txt b/new.txt\n';
  assert.deepEqual([...git.diffedPaths(diff)], ['src/a b.ts', 'new.txt']);
});

test('repoRoot finds the repository and returns undefined outside one', async () => {
  assert.equal(fs.realpathSync((await git.repoRoot(repo)) as string), fs.realpathSync(repo));
  assert.equal(await git.repoRoot(os.tmpdir()), undefined);
});

test('a clean working tree snapshots to the HEAD tree', async () => {
  const head = await git.headTree(repo);
  assert.equal(await git.snapshotTree(repo), head);
  assert.deepEqual(await git.changedFiles(repo, head, head), []);
});

test('snapshot sees edits, new, deleted and ignored files without touching the index', async () => {
  const head = await git.headTree(repo);
  write('keep.txt', 'one\ntwo\nthree\n');
  write('src/new file.ts', 'export const x = 1;\n');
  write('ignored/secret.txt', 'nope\n');
  write('package-lock.json', '{"changed":true}\n');
  write('.env', 'API_KEY=not-a-real-key\n');
  write('config/.env.local', 'TOKEN=also-not-real\n');
  fs.rmSync(path.join(repo, 'remove.txt'));

  const snap = await git.snapshotTree(repo);
  const files = await git.changedFiles(repo, head, snap);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.added, f.deleted]).sort(),
    [
      ['.env', 'added', 1, 0],
      ['config/.env.local', 'added', 1, 0],
      ['keep.txt', 'modified', 1, 0],
      ['package-lock.json', 'modified', 1, 1],
      ['remove.txt', 'deleted', 0, 1],
      ['src/new file.ts', 'added', 1, 0],
    ],
  );

  // The user's own staging area must be left exactly as it was.
  assert.equal(run('diff', '--cached', '--name-only').trim(), '');
  assert.match(run('status', '--porcelain'), /\?\? src\//);

  // Lock files and files that may hold secrets are listed above but their contents stay out of the diff.
  const diff = await git.diffText(repo, head, snap, EXCLUDES);
  assert.match(diff, /\+three/);
  assert.doesNotMatch(diff, /package-lock\.json/);
  assert.doesNotMatch(diff, /not-a-real-key|also-not-real|\.env/);
  assert.deepEqual([...git.diffedPaths(diff)].sort(), ['keep.txt', 'remove.txt', 'src/new file.ts']);

  assert.equal(await git.showFile(repo, head, 'keep.txt'), 'one\ntwo\n');
  assert.equal(await git.showFile(repo, head, 'src/new file.ts'), '');
  assert.equal(await git.treeExists(repo, snap), true);
  assert.equal(await git.treeExists(repo, '0123456789012345678901234567890123456789'), false);

  // Marking as reviewed moves the baseline; only later edits show up after that.
  write('src/new file.ts', 'export const x = 2;\n');
  const later = await git.snapshotTree(repo);
  assert.deepEqual(
    (await git.changedFiles(repo, snap, later)).map((f) => f.path),
    ['src/new file.ts'],
  );
});

test('a repository with no commits diffs against the empty tree', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tailgate-empty-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: empty });
    fs.writeFileSync(path.join(empty, 'first.txt'), 'hi\n');
    const base = await git.headTree(empty);
    assert.equal(base, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    const snap = await git.snapshotTree(empty);
    assert.deepEqual(
      (await git.changedFiles(empty, base, snap)).map((f) => [f.path, f.status]),
      [['first.txt', 'added']],
    );
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
