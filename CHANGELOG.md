# Changelog

## 0.0.1 (unreleased)

First version.

- Lists files changed since your last review and writes a review of them through the Claude Code CLI: summary,
  per-file changes, risks and a short quiz.
- Live review: each changed file gets its own card (what changed, risks, one question) as soon as it stops changing,
  and only files that change again are reviewed again.
- Questions can be answered by picking an option or by typing an answer in your own words, which Claude marks.
- Reviews can be written by GitHub Copilot instead of the Claude CLI; choose in the panel or with `catchup.provider`.
- One Claude CLI process is kept alive between requests, so reviews after the first skip the CLI's startup time.
- Mark as reviewed moves the starting point forward; clicking a changed file shows a before/after diff.
- Risk line numbers are worked out from the diff rather than taken from the model.
- Lock files, generated files and files that commonly hold secrets are never sent for review; `catchup.exclude` adds more.
- The first review asks for consent before any code leaves the machine.
- The CLI path, model and automatic review can only be set in user settings, never by a workspace.
- The extension starts only when its panel is opened, and only tracks changes while the panel is visible
  (or automatic review is on).
