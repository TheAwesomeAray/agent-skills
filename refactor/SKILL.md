---
name: refactor
description: Reduces technical debt in a repository without changing its behavior, using a multi-agent harness on the Cursor SDK. The find phase analyzes the code through a lens (SOLID for C# / .NET today), has an analyst, a doubter, and a judge argue over every finding, and proposes the survivors as a technical debt register in a pull request. The fix phase takes register items one at a time, writes characterization tests before any change, plans and applies a behavior-preserving refactoring, verifies it, and opens a pull request per item. Use when the user wants to find, track, or fix design debt with tests protecting every change, run or resume the quality harness, refactor register items, or approve a paused refactoring. For a one-off SOLID report with no register or code changes, use evaluating-solid-principles instead.
---

# Refactor

The goal is behavior-preserving debt reduction: every change makes the design better, and tests written before the change prove the behavior did not move. Nothing reaches the base branch without a person merging a pull request.

You operate the harness; you do not play its roles. The harness is a program that starts every agent, gives each only what its job needs, checks each submission, and decides what happens next. Don't review findings, write plans or tests, or edit code for an item yourself, and don't edit the register's JSON by hand. If an agent's output looks wrong, report it and point at the files; don't patch around it.

## Two phases, joined by the register

1. **Find** (`run`): the lens's analyzer measures the code, the analyst reviews its findings, the doubter challenges the review for up to 3 rounds, the judge rules on what is still disputed, and code reconciles the result into `.tech-debt/` in the target repo. The run ends with a register pull request. A person merges it.
2. **Fix** (`refactor`): for each open register item, in order: screen its complexity, plan the refactoring (no test access), write characterization tests with a coverage map and risk rating, pause for a person's approval when the risk is high enough, implement, verify (build, all tests, the analyzer no longer reports the item), review, then push a branch and open a pull request. Items whose file is test code are refactored by the tester. Items that fail or exceed the complexity limit are deferred with a reason.

Who does what, and the diagrams: [references/workflow.md](references/workflow.md). Full designs: [references/analysis.md](references/analysis.md) (find phase and register), [references/refactor-phase.md](references/refactor-phase.md) (fix phase), [references/tests.md](references/tests.md) (the tester, its gates, and cases A, B, and C).

## Layout

- `harness/`: the program (`npm run quality`), its defaults in `harness.config.json`, and alternative model configs in `configs/`.
- `roles/<role>/`: each agent's prompts and submission schemas. `roles/shared/` holds what several roles read.
- `lenses/<name>/`: an analysis lens, meaning an analyzer, a guide (`LENS.md`), and criteria. `solid` is the only lens so far.

## Requirements

- Node 24 or later, with `npm install` run once in `harness/`.
- `CURSOR_API_KEY` in the environment.
- The GitHub CLI (`gh`), signed in, for pull requests.
- What the lens needs. For `solid`, that's the .NET 10 SDK.
- A target repo whose test projects build and pass. The fix phase stops if the baseline is red.

## Configure the target repo

Settings layer in this order: `harness/harness.config.json`, then `<repo>/.tech-debt/config.json`, then `--config <file>`, then `--set key=value`. Before the first fix-phase run, the target repo needs at least:

- `refactor.test_projects`: the test projects the baseline runs and the tester may add to.
- `refactor.test_dirs`: every folder holding test code. These are hidden from the planner and the implementer.
- `git.remote` and `git.pr_repo` if pushes or pull requests should go somewhere other than `origin`.

Before any run that pushes, confirm with the user which remote it pushes to. If a push URL is deliberately disabled, keep it that way, and use `--no-push` when unsure.

## Commands

Run from `harness/`:

```
npm run quality -- run --repo <path>                          # find phase, ends with a register PR
npm run quality -- resume <run-id> --repo <path>              # continue a find run that stopped
npm run quality -- refactor --repo <path> --select            # screen and rank only; prints an --item list
npm run quality -- refactor --repo <path> --item <id>[,<id>]  # fix exactly these items, in order
npm run quality -- refactor --repo <path> [--limit <n>]       # screen, then fix up to n items (default 1)
npm run quality -- accept <id> --repo <path> --reason <text>  # a person keeps this debt on purpose
```

Options for `refactor`:

- `--dry-run` stops after the tests and never changes production code.
- `--no-push` commits on a local branch instead of pushing.
- `--items-ref` and `--base` pick the register ref and the base commit.
- `--config <file>` merges a JSON file over the config, for example `configs/compare-opus.json`.

Run `npm run quality` with no arguments for the full usage.

Prefer `--select`, then `--item` with the user's choice, over letting the run pick. Runs take from minutes to hours, so start them in the background and check on them. Don't let a long run block the conversation.

## Approvals

When the tester's risk is at or above `refactor.approval_risk` (default `medium`), the run pauses before implementation. It writes `approval-request.json` in the item's output folder (`<work_dir>/<run-id>/out/items/<id>/`) and waits up to `refactor.approval_timeout_minutes` for `approval.json` beside it.

1. Show the user the goal, the tests, the uncovered gaps, and the risk from the request.
2. Write the user's decision for them, either `{"approved": true}` or `{"approved": false, "note": "..."}`. Never approve on your own judgment.

If nobody answers, the item is left `awaiting-approval`.

## Reading results

- **Find phase.** The register pull request and `.tech-debt/TECH-DEBT.md` in the target repo. The run's manifest and agent transcripts are in the work directory (`work_dir`, default `<temp>/quality`).
- **Fix phase.**
  - The run prints each item's outcome and pull request.
  - Per item, `out/items/<id>/` holds `plan.json`, `tests.json`, the test gates, each implementation diff, `verify-*.json`, and `review.json`.
  - `out/manifest.json` has every agent turn with model, tokens, time, and cost.
  - `refactor-outcomes.jsonl` in the work directory accumulates outcomes across runs.

When you report back, lead with the outcome of each item: pull request opened, deferred (and why), awaiting approval, or escalated. Then give the cost and time.

## Adding a lens

A lens is a folder under `lenses/` with an analyzer command that writes findings in the metrics format, a guide whose review steps the analyst follows, and criteria. Register it under `lenses` in the config with its `dir`, `id_prefix`, `references` (guide first), and `analyze` and `report` commands, then select it with `analysis`. See [references/analysis.md](references/analysis.md), sections 5 and 10.
