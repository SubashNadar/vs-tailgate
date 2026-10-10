# Catchup

Review what your AI coding agent just changed, while it keeps working.

Catchup is a VS Code extension. Open its panel in a git repository and it lists the files changed since your last
review. It reviews them in two ways.

**Live review**, for while the agent is running. Tick "Live review" in the panel and each changed file gets its own
card as soon as it has stopped changing for a few seconds: what changed, any risks, and one question. When the agent
edits a file again, only that file's card is rewritten. A serious risk on an early file shows up while the agent is
still working, so you can stop it before it builds on the mistake.

**Review all changes**, for when the agent has stopped. One review of everything together, which is what catches
problems that span files:

- **Summary** of what changed and what it appears to be for.
- **What changed**, file by file.
- **Worth a second look**: risks such as bugs, security problems and leftover debug code, linked to the file and, where
  the code can be pinpointed, the line.
- **Check your understanding**: up to three multiple-choice questions about the change, so you know whether you could
  own this code.

Every question can be answered two ways: pick one of the options, or type an answer in your own words and press
**Check**. A typed answer is sent to Claude with the question and marked as correct, partly right or not quite, with a
sentence on what you got and what you missed.

When you have read a review, **Mark as reviewed** moves the starting point forward, so the next review covers only what
changed after that.

## Requirements

- VS Code 1.90 or newer, on a local folder in a trusted workspace
- git
- One of these, signed in. No API key is needed for either.
  - The [Claude Code](https://claude.com/claude-code) CLI. Catchup runs it headless (`claude -p`). This is the default.
  - GitHub Copilot, through the GitHub Copilot Chat extension. Catchup calls it through VS Code's language model API.

Choose between them with the "Reviews written by" list in the panel, or the `catchup.provider` setting.

## What leaves your machine

A review sends the diff of your changed files to the service you chose: Claude through your own Claude Code CLI, or
GitHub Copilot through VS Code. It counts against your usage with that service. Catchup asks for your agreement
separately for each one, and VS Code adds its own prompt the first time an extension uses Copilot. Nothing is sent until you ask for a review or switch live review on, and the first time Catchup asks you
to confirm. With live review on, every changed file is sent as it settles, and again each time it changes, for as long
as the panel is open; closing the panel pauses it.

Some files are listed as changed but their contents are never sent:

- lock files and generated files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `*.min.js`, `*.map`, `*.snap`)
- files that commonly hold secrets (`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `id_rsa*`,
  `id_ed25519*`, `.npmrc`, `.netrc`, `credentials.json`, `secrets.*`)
- anything matching your own `catchup.exclude` patterns

This is a pattern list, not a secret scanner: a credential pasted into an ordinary source file will be sent. Files
ignored by git are never read at all.

The Claude CLI runs with every tool switched off, and Copilot is given no tools, so text inside a diff cannot make
either of them read or change anything.

## Run it from source

```bash
npm install
npm run compile
```

Then open this folder in VS Code and press F5. A second VS Code window opens with Catchup loaded; open a git repository
in it and click the Catchup icon in the activity bar.

## How it works

- **Tracking changes.** Catchup writes the working tree (tracked and untracked files, minus ignored ones) as a git tree
  object using a throwaway index, so your staging area is never touched. Changes are the diff between the tree you last
  marked as reviewed and the current one. Snapshots add objects to the repository's object store, so they only run
  while the panel is visible or automatic review is on. See `src/git.ts`.
- **Writing the review.** The diff goes to the Claude CLI and the reply is parsed as JSON. A diff larger than
  `catchup.maxDiffChars` is trimmed file by file. Each risk comes back with the line of code it is about, and Catchup
  finds that code in the diff to get the line number. See `src/reviewer.ts`.
- **Keeping it quick.** Starting the Claude CLI takes around ten seconds, so Catchup keeps one CLI process alive and
  sends it one request after another. The first review pays the startup; in our measurements later file reviews took
  about 7 seconds each with Sonnet. The process is replaced every 20 requests and stopped after three idle minutes.
  See `src/session.ts`.
- **Live cards.** Each changed file's diff is hashed. A file whose hash is unchanged keeps its card; one whose hash
  changed waits `catchup.liveReviewDelaySeconds` and is then reviewed by itself, oldest first, one at a time.
- **Showing it.** A webview view renders the review. See `src/panel.ts` and `media/main.js`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `catchup.provider` | `claude` | `claude` or `copilot`: which service writes the reviews. User setting only. |
| `catchup.copilotModel` | empty | Copilot model family, such as `gpt-4o`. Empty uses the first model Copilot offers. |
| `catchup.model` | `sonnet` | Model alias or full name passed to the Claude CLI. User setting only. |
| `catchup.claudePath` | `claude` | Path to the Claude CLI. User setting only. |
| `catchup.liveReview` | `false` | Review each file by itself as soon as it stops changing. User setting only. |
| `catchup.liveReviewDelaySeconds` | `4` | How long a file must stay unchanged before its live review starts. |
| `catchup.autoReview` | `false` | Write a review of everything automatically once files stop changing. User setting only. |
| `catchup.autoReviewDelaySeconds` | `20` | How long files must stay unchanged before an automatic review. |
| `catchup.exclude` | `[]` | Extra glob patterns for files whose contents must never be sent. |
| `catchup.maxDiffChars` | `60000` | Largest diff sent for review. |
| `catchup.timeoutSeconds` | `180` | How long to wait for a review. |

The settings marked "user setting only" cannot be set by a workspace, so a repository you open cannot choose which
program Catchup runs or make it spend your usage.

## Known limits

- A live card judges one file alone, so it can miss a problem that only shows when two files are read together.
  "Review all changes" covers that.
- A live card can describe a version of a file that the agent goes on to rewrite; it is replaced when that happens.
- Copilot support is covered by tests against a stand-in for VS Code's model API, and by a test that it fails cleanly
  when Copilot is missing. Review quality with Copilot's models has not been measured; `npm run eval` covers Claude only.
- In a multi-folder workspace, Catchup uses the first folder that is a git repository.
- Renamed files show as one deleted file and one added file.
- The starting point is kept as an unreferenced git object. If git prunes it (by default after about two weeks without
  a review), Catchup falls back to your last commit.

## Tests

```bash
npm test
```

Unit tests cover the git snapshot logic against a temporary repository, and the prompt, trimming and parsing code.

```bash
npm run test:host
```

The host test opens a real VS Code window with a throwaway profile, a temporary repository and a stand-in for the
Claude CLI, then walks the whole flow: activation, the file list, a review, the file watcher and marking as reviewed.
It needs VS Code installed and does not use your Claude usage.

```bash
npm run eval
```

The evaluation scores review quality. It runs one real review for each sample change in `eval/cases.js` (13 with a
planted bug, 3 clean) and reports how many bugs were flagged, whether each risk points at the right line, and how much
was flagged on the clean changes. It uses your Claude usage: one review per case. Add `-- --model haiku` to compare
models, `-- --only sql` to run matching cases, or `-- --per-file` to score live review's one-file-at-a-time prompt
through a long-lived CLI process. Results are saved in `eval/results/`.

To look at the panel UI in a plain browser with sample data, serve this folder's parent over HTTP and open
`test/panel-harness.html`.
