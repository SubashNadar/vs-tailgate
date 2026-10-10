import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAnswerPrompt,
  MAX_ANSWER_CHARS,
  parseAnswerFeedback,
  buildFilePrompt,
  buildPrompt,
  claudeArgs,
  describeFailure,
  newFileLines,
  parseCliOutput,
  parseFileReview,
  parseReview,
  shuffleOptions,
  splitDiff,
  truncateDiff,
} from '../src/reviewer';

const fileDiff = (name: string, body: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${body}\n`;

test('truncateDiff leaves a small diff alone', () => {
  const diff = fileDiff('a.ts', '+one');
  assert.deepEqual(truncateDiff(diff, 1000), { text: diff, omittedFiles: 0, hardCut: false });
});

test('truncateDiff drops whole files that do not fit and keeps later ones that do', () => {
  const small1 = fileDiff('a.ts', '+one');
  const big = fileDiff('big.ts', '+'.repeat(500));
  const small2 = fileDiff('c.ts', '+three');
  const cut = truncateDiff(small1 + big + small2, 200);
  assert.equal(cut.text, small1 + small2);
  assert.equal(cut.omittedFiles, 1);
  assert.equal(cut.hardCut, false);
});

test('truncateDiff cuts mid-file when even the first file is too large', () => {
  const cut = truncateDiff(fileDiff('big.ts', '+'.repeat(500)) + fileDiff('b.ts', '+'.repeat(500)), 100);
  assert.equal(cut.text.length, 100);
  assert.equal(cut.hardCut, true);
  assert.equal(cut.omittedFiles, 1);
});

test('buildPrompt lists files and flags an incomplete diff', () => {
  const files = [
    { path: 'src/a.ts', status: 'modified' as const, added: 3, deleted: 1 },
    { path: 'logo.png', status: 'added' as const, added: null, deleted: null },
  ];
  const full = buildPrompt(files, { text: 'DIFF', omittedFiles: 0, hardCut: false });
  assert.match(full, /- src\/a\.ts \(modified, \+3 -1\)/);
  assert.match(full, /- logo\.png \(added, binary\)/);
  assert.doesNotMatch(full, /incomplete/);
  assert.match(buildPrompt(files, { text: 'DIFF', omittedFiles: 2, hardCut: false }), /incomplete/);
});

test('parseCliOutput returns the result text and surfaces errors', () => {
  assert.equal(parseCliOutput('{"type":"result","is_error":false,"result":"hello"}\n'), 'hello');
  assert.equal(parseCliOutput('[{"type":"system"},{"type":"result","result":"hi"}]'), 'hi');
  assert.throws(() => parseCliOutput('{"type":"result","is_error":true,"result":"Not logged in"}'), /Not logged in/);
  assert.throws(() => parseCliOutput('not json'), /could not be read/);
});

test('parseReview reads fenced JSON and drops malformed entries', () => {
  const raw =
    'Here you go:\n```json\n' +
    JSON.stringify({
      summary: ' Adds a cache. ',
      changes: [{ file: 'a.ts', what: 'Adds cache' }, { file: '', what: 'no file' }, 'junk'],
      risks: [
        { severity: 'critical', file: 'a.ts', line: 12, title: 'No eviction', detail: 'Grows forever' },
        { severity: 'low', file: 'a.ts', quote: 'not in the diff', title: 'Naming', detail: '' },
        { severity: 'low', file: 'a.ts', detail: 'no title' },
      ],
      questions: [
        { question: 'What is cached?', options: ['a', 'b', 'c', 'd'], answer: 2, explanation: 'because' },
        { question: 'Out of range', options: ['a', 'b'], answer: 5, explanation: '' },
        { question: 'String answer', options: ['a', 'b'], answer: '1', explanation: '' },
      ],
    }) +
    '\n```';
  const review = parseReview(raw);
  assert.equal(review.summary, 'Adds a cache.');
  assert.deepEqual(review.changes, [{ file: 'a.ts', what: 'Adds cache' }]);
  assert.equal(review.risks.length, 2);
  assert.equal(review.risks[0].severity, 'medium');
  // A line number supplied by the model is never trusted.
  assert.equal(review.risks[0].line, undefined);
  assert.equal(review.risks[1].line, undefined);
  assert.equal(review.questions.length, 1);
  // Options are shuffled, so check the answer still points at the same option.
  assert.equal(review.questions[0].options[review.questions[0].answer], 'c');
  assert.deepEqual([...review.questions[0].options].sort(), ['a', 'b', 'c', 'd']);
});

test('shuffleOptions moves the correct answer around without losing it', () => {
  const question = { question: 'q', options: ['w', 'x', 'right', 'z'], answer: 2, explanation: '' };
  const positions = new Set<number>();
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 200; i++) {
    const shuffled = shuffleOptions(question, random);
    assert.equal(shuffled.options[shuffled.answer], 'right');
    assert.equal(shuffled.options.length, 4);
    positions.add(shuffled.answer);
  }
  assert.deepEqual([...positions].sort(), [0, 1, 2, 3]);
  assert.deepEqual(question.options, ['w', 'x', 'right', 'z']);
});

test('parseReview lists the most severe risks first', () => {
  const raw = JSON.stringify({
    summary: 's',
    risks: [
      { severity: 'low', file: 'a', title: 'minor' },
      { severity: 'high', file: 'a', title: 'serious' },
      { severity: 'medium', file: 'a', title: 'middling' },
    ],
  });
  assert.deepEqual(
    parseReview(raw).risks.map((r) => r.title),
    ['serious', 'middling', 'minor'],
  );
});

test('parseReview rejects output with no usable review', () => {
  assert.throws(() => parseReview('I cannot help with that.'), /did not return a review/);
  assert.throws(() => parseReview('{ not json }'), /could not be read/);
  assert.throws(() => parseReview('{"summary": ""}'), /no summary/);
});

const sampleDiff = [
  'diff --git a/users.js b/users.js',
  'index 111..222 100644',
  '--- a/users.js',
  '+++ b/users.js',
  '@@ -1,5 +1,7 @@',
  " const db = require('./db');",
  ' ',
  '+const cache = {};',
  '+',
  ' async function getUser(id) {',
  "-  return db.query('SELECT * FROM users WHERE id = ?', [id]);",
  "+  return db.query('SELECT * FROM users WHERE id = ' + id);",
  ' }',
  '@@ -20,3 +22,4 @@ function other() {',
  '   return 1;',
  ' }',
  "+console.log('debug');",
  ' ',
  'diff --git a/gone.js b/gone.js',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-old',
  '',
].join('\n');

test('newFileLines numbers the lines of each new file across hunks', () => {
  const lines = newFileLines(sampleDiff);
  assert.deepEqual([...lines.keys()], ['users.js']);
  const users = lines.get('users.js')!;
  assert.deepEqual(users.find((l) => l.text === 'const cache = {};'), { line: 3, text: 'const cache = {};', added: true });
  assert.equal(users.find((l) => l.text.includes('WHERE id = '))?.line, 6);
  assert.equal(users.find((l) => l.text.includes('debug'))?.line, 24);
});

test('parseReview works out risk lines from the quoted code', () => {
  const raw = JSON.stringify({
    summary: 'Adds a cache.',
    risks: [
      { severity: 'high', file: 'users.js', quote: "return db.query('SELECT * FROM users WHERE id = ' + id);", title: 'Injection' },
      { severity: 'low', file: 'users.js', quote: "console.log('debug')", title: 'Debug output' },
      { severity: 'low', file: 'users.js', quote: 'async function getUser(id) {', title: 'Context line' },
      { severity: 'low', file: 'other.js', quote: 'const cache = {};', title: 'Wrong file' },
    ],
  });
  assert.deepEqual(
    parseReview(raw, sampleDiff).risks.map((r) => r.line),
    [6, 24, 5, undefined],
  );
});

test('describeFailure explains a missing CLI and passes through CLI errors', () => {
  const windows = describeFailure(1, '', "'claude' is not recognized as an internal or external command,\r\noperable program or batch file.");
  assert.match(windows.message, /CLI was not found/);
  assert.match(describeFailure(127, '', 'sh: claude: command not found').message, /CLI was not found/);
  assert.match(describeFailure(1, '{"type":"result","is_error":true,"result":"Invalid API key"}', '').message, /Invalid API key/);
  assert.match(describeFailure(2, '', 'something else broke').message, /exited with code 2. something else broke/);
});

test('splitDiff gives each file its own diff', () => {
  const parts = splitDiff(sampleDiff);
  assert.deepEqual([...parts.keys()], ['users.js', 'gone.js']);
  assert.match(parts.get('users.js')!, /^diff --git a\/users\.js/);
  assert.doesNotMatch(parts.get('users.js')!, /gone\.js/);
  assert.match(parts.get('gone.js')!, /-old/);
});

test('buildFilePrompt names the file and carries its diff', () => {
  const file = { path: 'users.js', status: 'modified' as const, added: 4, deleted: 1 };
  const prompt = buildFilePrompt(file, 'THE DIFF', false);
  assert.match(prompt, /users\.js \(modified, \+4 -1\)/);
  assert.match(prompt, /<file-diff>\nTHE DIFF\n<\/file-diff>/);
  assert.doesNotMatch(prompt, /cut short/);
  assert.match(buildFilePrompt(file, 'THE DIFF', true), /cut short/);
});

test('parseFileReview reads one file review and locates its risks in that file', () => {
  const raw = JSON.stringify({
    what: 'Adds a cache.',
    risks: [{ severity: 'high', file: 'ignored.js', quote: "console.log('debug');", title: 'Debug output' }],
    question: { question: 'What is cached?', options: ['a', 'b', 'c', 'd'], answer: 3, explanation: 'because' },
  });
  const review = parseFileReview(raw, 'users.js', sampleDiff);
  assert.equal(review.what, 'Adds a cache.');
  assert.deepEqual(review.risks.map((r) => [r.file, r.line]), [['users.js', 24]]);
  assert.equal(review.question!.options[review.question!.answer], 'd');

  const trivial = parseFileReview('{"what": "Fixes a typo.", "risks": [], "question": null}', 'a.md');
  assert.deepEqual(trivial, { what: 'Fixes a typo.', risks: [], question: undefined });
  assert.throws(() => parseFileReview('{"risks": []}', 'a.md'), /no description/);
});

test('buildAnswerPrompt carries the question, the reference answer and the typed answer', () => {
  const question = { question: 'What is cached?', options: ['Orders', 'Users by id', 'Nothing', 'Sessions'], answer: 1, explanation: 'getUser stores each user.' };
  const prompt = buildAnswerPrompt(question, 'the user rows', 'THE DIFF');
  assert.match(prompt, /Question: What is cached\?/);
  assert.match(prompt, /Reference answer: Users by id/);
  assert.match(prompt, /<answer>\nthe user rows\n<\/answer>/);
  assert.match(prompt, /<diff>\nTHE DIFF\n<\/diff>/);
  assert.doesNotMatch(buildAnswerPrompt(question, 'x', ''), /<diff>\n/);
  // An over-long answer is cut rather than sent whole.
  assert.ok(!buildAnswerPrompt(question, 'y'.repeat(MAX_ANSWER_CHARS + 50), '').includes('y'.repeat(MAX_ANSWER_CHARS + 1)));
});

test('parseAnswerFeedback accepts the three verdicts and nothing else', () => {
  assert.deepEqual(parseAnswerFeedback('{"verdict": "partly", "feedback": " You missed eviction. "}'), {
    verdict: 'partly',
    feedback: 'You missed eviction.',
  });
  assert.equal(parseAnswerFeedback('```json\n{"verdict":"correct","feedback":""}\n```').verdict, 'correct');
  assert.throws(() => parseAnswerFeedback('{"verdict": "great", "feedback": "x"}'), /did not say/);
  assert.throws(() => parseAnswerFeedback('no json here'), /did not return/);
});

test('claudeArgs switches to line-by-line JSON for a long-lived process', () => {
  const oneShot = claudeArgs('sonnet');
  const streaming = claudeArgs('sonnet', true);
  assert.deepEqual(oneShot.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.ok(streaming.join(' ').includes('--input-format stream-json --output-format stream-json --verbose'));
  for (const args of [oneShot, streaming]) {
    assert.equal(args[args.indexOf('--tools') + 1], '', 'tools stay switched off');
  }
});

test('claudeArgs rejects model names that could break out of the command line', () => {
  assert.ok(claudeArgs('claude-sonnet-5-5').includes('claude-sonnet-5-5'));
  assert.throws(() => claudeArgs('sonnet & calc'), /not a valid model name/);
});
