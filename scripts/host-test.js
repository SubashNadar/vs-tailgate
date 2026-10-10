// Runs test/host inside a real VS Code window, isolated from your own VS Code
// profile, against a temporary repository and a stand-in for the Claude CLI.
// Set TAILGATE_VSCODE to the VS Code executable if it is not found automatically.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');

function findVsCode() {
  if (process.env.TAILGATE_VSCODE) {
    return process.env.TAILGATE_VSCODE;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : ['/usr/share/code/code', '/usr/bin/code'];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('VS Code was not found. Set TAILGATE_VSCODE to its executable.');
  }
  return found;
}

function makeRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  fs.mkdirSync(dir, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'app.js'), 'function add(a, b) {\n  const total = a + b;\n  return total;\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'app.js'), 'function add(a, b) {\n  const total = a + b + 1;\n  return total;\n}\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=not-a-real-secret\n');
}

function makeFakeCli(dir, promptFile) {
  fs.mkdirSync(dir, { recursive: true });
  const review = {
    summary: 'Canned review from the stand-in CLI.',
    changes: [{ file: 'app.js', what: 'Adds one to the total.' }],
    risks: [{ severity: 'high', file: 'app.js', quote: 'const total = a + b + 1;', title: 'Off by one', detail: 'The sum is now wrong.' }],
    questions: [{ question: 'What does add(1, 1) return now?', options: ['2', '3', '1', '0'], answer: 1, explanation: 'One is added.' }],
  };
  const script = path.join(dir, 'fake-claude.js');
  // Speaks the CLI's streaming protocol: one JSON request per line in, one result per request out.
  // A single-file prompt gets a file review that echoes which file it saw; anything else gets the full review.
  fs.writeFileSync(
    script,
    `const fs = require('node:fs');
const review = ${JSON.stringify(review)};
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const prompt = JSON.parse(line).message.content;
    fs.appendFileSync(${JSON.stringify(promptFile)}, prompt + '\\n=====\\n');
    let reply = review;
    if (prompt.includes('<answer>')) {
      const right = /<answer>\\n[^<]*\\b3\\b/.test(prompt);
      reply = { verdict: right ? 'correct' : 'incorrect', feedback: right ? 'You have it.' : 'Look at the sum again.' };
    } else if (prompt.includes('<file-diff>')) {
      const file = /^diff --git a\\/(.+) b\\//m.exec(prompt)[1];
      const version = prompt.includes('+ 2;') ? 'second' : 'first';
      reply = {
        what: 'Card for ' + file + ' (' + version + ' version).',
        risks: file === 'app.js' ? [{ severity: 'high', quote: 'const total = a + b + ' + (version === 'second' ? '2' : '1') + ';', title: 'Off by one', detail: 'Wrong sum.' }] : [],
        question: file === 'app.js' ? review.questions[0] : null,
      };
    }
    console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(reply) }));
  }
});
process.stdin.on('end', () => process.exit(0));
`,
  );
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'fake-claude.cmd');
    fs.writeFileSync(cmd, `@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, 'fake-claude');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.js" "$@"\n`, { mode: 0o755 });
  return sh;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tailgate-host-'));
const repo = path.join(work, 'repo');
const userData = path.join(work, 'user-data');
const resultFile = path.join(work, 'result.json');
const promptFile = path.join(work, 'prompt.txt');

makeRepo(repo);
const fakeCli = makeFakeCli(path.join(work, 'cli'), promptFile);
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'User', 'settings.json'),
  JSON.stringify({
    'tailgate.claudePath': fakeCli,
    'tailgate.liveReview': true,
    'tailgate.liveReviewDelaySeconds': 2,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'git.enabled': false,
  }),
);

const env = { ...process.env, TAILGATE_HOST_RESULT: resultFile, TAILGATE_FAKE_PROMPT: promptFile };
// Inherited from an Electron-based parent, these would stop VS Code starting as an app.
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(
  findVsCode(),
  [
    repo,
    `--extensionDevelopmentPath=${extensionRoot}`,
    `--extensionTestsPath=${path.join(extensionRoot, 'out', 'test', 'host', 'index.js')}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(work, 'extensions')}`,
    '--disable-workspace-trust',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
  ],
  { env, stdio: 'ignore' },
);

const timer = setTimeout(() => {
  console.error('VS Code did not finish within 3 minutes; stopping it.');
  child.kill();
}, 180000);

child.on('exit', (code) => {
  clearTimeout(timer);
  let result = { ok: false, steps: [], error: `VS Code exited with code ${code} before the test reported a result.` };
  if (fs.existsSync(resultFile)) {
    result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  }
  for (const step of result.steps) {
    console.log(`ok - ${step}`);
  }
  if (!result.ok) {
    console.error(`FAILED\n${result.error}`);
  }
  // VS Code can still be releasing files; a leftover temp folder is harmless.
  fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }, () => process.exit(result.ok ? 0 : 1));
});
