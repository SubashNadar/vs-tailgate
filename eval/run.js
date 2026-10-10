// Scores review quality: runs a real review on every case in eval/cases.js and
// checks whether the planted bug was flagged and whether the risk points at the
// right line. Uses your Claude usage (one review per case).
//
//   npm run eval                      all cases, default model
//   npm run eval -- --model haiku     another model
//   npm run eval -- --only sql        cases whose name contains "sql"
//   npm run eval -- --per-file        review each file by itself through one long-lived CLI
//                                     process, the way live review does
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = path.resolve(__dirname, '..', 'out', 'src');
const git = require(path.join(out, 'git.js'));
const reviewer = require(path.join(out, 'reviewer.js'));
const { ClaudeSession } = require(path.join(out, 'session.js'));
const cases = require('./cases.js');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const model = arg('model', 'sonnet');
const only = arg('only', '');
const perFile = process.argv.includes('--per-file');
// One process answers per-file requests in turn, so running cases side by side would only blur the timings.
const concurrency = perFile ? 1 : Number(arg('concurrency', '3'));
const options = () => ({ bin: 'claude', model, timeoutMs: 180000, cwd: os.tmpdir() });
const session = perFile ? new ClaudeSession(options) : undefined;
const requestSeconds = [];

/** Reviews every file by itself and gathers the results into the shape of a full review. */
async function reviewPerFile(files, diff) {
  const review = { risks: [], questions: [] };
  for (const [file, part] of reviewer.splitDiff(diff)) {
    const started = Date.now();
    const reply = await session.ask(reviewer.buildFilePrompt(files.find((f) => f.path === file), part, false));
    requestSeconds.push((Date.now() - started) / 1000);
    const fileReview = reviewer.parseFileReview(reply, file, part);
    review.risks.push(...fileReview.risks);
    if (fileReview.question) {
      review.questions.push(fileReview.question);
    }
  }
  return review;
}

function writeFiles(repo, files, version) {
  for (const [file, versions] of Object.entries(files)) {
    const content = versions[version];
    const full = path.join(repo, file);
    if (content === null) {
      fs.rmSync(full, { force: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
}

async function runCase(testCase) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-eval-'));
  const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  try {
    run('init', '-q');
    run('config', 'user.email', 'eval@example.com');
    run('config', 'user.name', 'Eval');
    run('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), '# sample\n');
    writeFiles(repo, testCase.files, 0);
    run('add', '-A');
    run('commit', '-q', '-m', 'before');
    writeFiles(repo, testCase.files, 1);

    const base = await git.headTree(repo);
    const snap = await git.snapshotTree(repo);
    const files = await git.changedFiles(repo, base, snap);
    const diff = await git.diffText(repo, base, snap, [...git.GENERATED_EXCLUDES, ...git.SENSITIVE_EXCLUDES]);
    const cut = reviewer.truncateDiff(diff, 60000);

    const started = Date.now();
    const review = perFile
      ? await reviewPerFile(files, cut.text)
      : reviewer.parseReview(reviewer.parseCliOutput(await reviewer.runClaude(reviewer.buildPrompt(files, cut), options())), cut.text);
    const seconds = (Date.now() - started) / 1000;

    const bugs = testCase.bugs.map((bug) => {
      const risk = review.risks.find((r) => r.file === bug.file && bug.match.test(`${r.title} ${r.detail}`));
      const source = (testCase.files[bug.file][1] ?? '').split('\n');
      const pointedAt = risk?.line ? source[risk.line - 1] ?? '' : '';
      const located = [bug.at, ...(bug.alsoAt ?? [])].some((piece) => pointedAt.includes(piece));
      return { what: bug.what, caught: Boolean(risk), severity: risk?.severity, located, pointedAt: pointedAt.trim() };
    });

    return {
      name: testCase.name,
      seconds,
      bugs,
      risks: review.risks.map((r) => ({ severity: r.severity, title: r.title, line: r.line })),
      risksWithLine: review.risks.filter((r) => r.line).length,
      questions: review.questions.length,
      answers: review.questions.map((q) => q.answer),
    };
  } catch (err) {
    return { name: testCase.name, error: err.message };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

async function main() {
  const selected = cases.filter((c) => c.name.includes(only));
  const results = new Array(selected.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (next < selected.length) {
        const index = next++;
        results[index] = await runCase(selected[index]);
        const r = results[index];
        console.log(`${r.error ? 'error' : 'done '} ${r.name}${r.error ? `: ${r.error}` : ` (${r.seconds.toFixed(0)}s)`}`);
      }
    }),
  );

  const ok = results.filter((r) => !r.error);
  const buggy = ok.filter((r) => r.bugs.length > 0);
  const clean = ok.filter((r) => r.bugs.length === 0);
  const allBugs = buggy.flatMap((r) => r.bugs);
  const caught = allBugs.filter((b) => b.caught);
  const count = (list, pick) => list.reduce((sum, item) => sum + pick(item), 0);

  console.log('\nPlanted bugs');
  for (const r of buggy) {
    for (const b of r.bugs) {
      const verdict = !b.caught ? 'MISSED ' : b.located ? 'caught ' : 'caught, wrong or no line';
      console.log(`  ${verdict.padEnd(25)} ${r.name.padEnd(24)} ${b.caught ? `[${b.severity}]` : ''} ${b.caught && !b.located ? `-> "${b.pointedAt}"` : ''}`);
    }
  }
  console.log('\nClean changes (anything flagged here is a false alarm)');
  for (const r of clean) {
    const flagged = r.risks.map((risk) => `[${risk.severity}] ${risk.title}`).join('; ') || 'nothing flagged';
    console.log(`  ${r.name.padEnd(24)} ${flagged}`);
  }

  const summary = {
    model,
    cases: results.length,
    errors: results.length - ok.length,
    bugsCaught: `${caught.length}/${allBugs.length}`,
    caughtAsHigh: `${caught.filter((b) => b.severity === 'high').length}/${caught.length}`,
    caughtWithRightLine: `${caught.filter((b) => b.located).length}/${caught.length}`,
    risksWithALine: `${count(ok, (r) => r.risksWithLine)}/${count(ok, (r) => r.risks.length)}`,
    highFalseAlarmsOnCleanChanges: count(clean, (r) => r.risks.filter((risk) => risk.severity === 'high').length),
    mediumFalseAlarmsOnCleanChanges: count(clean, (r) => r.risks.filter((risk) => risk.severity === 'medium').length),
    extraRisksPerBuggyCase: buggy.length ? ((count(buggy, (r) => r.risks.length) - caught.length) / buggy.length).toFixed(1) : 'n/a',
    ...(perFile
      ? {
          fileRequests: requestSeconds.length,
          firstRequestSeconds: requestSeconds[0]?.toFixed(1),
          medianLaterRequestSeconds: requestSeconds.slice(1).sort((a, b) => a - b)[Math.floor((requestSeconds.length - 1) / 2)]?.toFixed(1),
          slowestLaterRequestSeconds: Math.max(...requestSeconds.slice(1)).toFixed(1),
        }
      : {}),
    reviewsWithThreeQuestions: `${ok.filter((r) => r.questions === 3).length}/${ok.length}`,
    correctAnswerPositions: [0, 1, 2, 3].map((i) => count(ok, (r) => r.answers.filter((a) => a === i).length)).join(' / '),
    medianSeconds: ok.length ? ok.map((r) => r.seconds).sort((a, b) => a - b)[Math.floor(ok.length / 2)].toFixed(0) : 'n/a',
  };
  console.log('\nSummary');
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key.padEnd(34)} ${value}`);
  }

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${model}${perFile ? '-per-file' : ''}.json`),JSON.stringify({ summary, results }, null, 2));
  session?.dispose();
  process.exitCode = summary.errors > 0 ? 1 : 0;
}

main();
