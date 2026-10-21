---
name: quality-pstack
description: Pay down design debt in pstack style. Finds debt through a lens with an analyst and a doubter, records it in a `.tech-debt/` register, and fixes one item per pull request behind characterization tests written before and blind to the change. Use for /quality-pstack, "find tech debt", "fix register item", or "pay down debt".
disable-model-invocation: true
---

# Quality (pstack)

**You own the register and every PR. Behavior does not move. Only a person merges.**

Requires the `refactor` skill beside this one (its lens, role prompts, vocabulary, and rubric are read from `../refactor/`), pstack installed (resolve `poteto-mode`, `interrogate`, and `show-me-your-work` wherever it lives), the .NET 10 SDK, and `gh` signed in. The register shares the refactor skill's format, so either skill can continue the other's work.

## Start

Open a todolist. Its first item is to read the Principles section of the **poteto-mode** skill. Then copy in the Find or Fix steps below verbatim. A step you skip stays as `skip: <reason>`. A run over several items, or one the user steps away from, keeps a decision trail via **show-me-your-work**.

## Rules

- **Agents rate. The script decides.** Every check that needs no judgment runs through `scripts/quality.cs` (`dotnet run scripts/quality.cs -- --help`). A gate's verdict is its exit code and JSON, never an agent's report (**principle-encode-lessons-in-structure**, **principle-build-the-lever**).
- **Only the script writes `.tech-debt/`.** Register changes are committed only in the register PR or in the item's own PR. Run `accept` only on a person's explicit words.
- **No agent judges its own work.** Every role is a fresh subagent with consolidated scope. You rule only on what is still disputed.
- **The planner and implementer never see tests.** They work in a `blind` worktree detached at the base commit, so the tester's commit is not in their history. Their brief forbids reading outside that path or printing other revisions. A regression reaches them as the behavior that broke, in plain words.
- **The tester never sees the implementation.** Its tests are committed before the implementer starts, and they run unchanged after.
- **Models.** `subagent_type: "poteto-agent"`. The implementer uses the `feature, refactoring` line of the pstack settings file. Every other role uses `judgment and prose`. Briefs are in [references/briefs.md](references/briefs.md).

## Find

1. Frame. Name the repo, the base commit, and the lens. The default lens is `../refactor/lenses/solid/LENS.md`. Read it.
2. Measure. Run the lens's analyzer in a worktree detached at the base commit, with `--register <repo>/.tech-debt`, so settled items carry forward.
3. Review. Spawn the analyst. It writes `review.json` in the lens's review format, with `register_checks` for every active review-added item.
4. Challenge. Spawn a fresh doubter on the review. A fresh analyst answers each challenge with concede, revise, or defend. Up to 3 rounds. No new targets after round 1.
5. Rule. For each challenge still open, write a verdict in the shape of `../refactor/roles/judge/rule.json`, per the lead judgment of the **interrogate** skill. Fold the outcomes into the final `review.json`.
6. Validate. Run the lens's `report` command on the final review. Fix the review until it passes.
7. Match. If the review adds findings and the register has review-added items, a fresh matcher writes `matches.json`.
8. Reconcile. On a branch off the base, run `quality.cs reconcile --commit <base sha> --matches <matches.json>` with the metrics, review, and run id. It rejects a malformed review and writes nothing. Read its change list against the review. A change you can't explain is a bug in the review or the script. Fix it there.
9. Run **Opening a PR** with the register change alone. A person merges it.

**Reply:** the change counts, the top open items, every ruling you made and why, the register PR.

## Fix

One item per branch and PR. `<base>` is the base commit. The item branch is `quality/<id>` in its own worktree. For each item, in order:

1. Pick. Take open and reopened items on the base branch with no open PR and no `quality/<id>` branch. If the user named items, take those. Otherwise spawn one screener per item in a blind worktree to rate complexity 1 to 5 against `../refactor/roles/shared/complexity-rubric.md`. Take the lowest first, then the highest severity. Skip any above the limit (default 2). If the item's file changed since `last_seen`, rerun the analyzer, and skip a finding that is gone.
2. Baseline. Build and run every test project at `<base>`. Red stops the run.
3. Plan blind. `quality.cs blind --base <base> --hide <every test folder>`. The planner writes `plan.json` in the shape of `../refactor/roles/planner/plan.json`, each step named from `../refactor/roles/shared/refactoring-vocabulary.md`. The effective complexity is the higher of its rating and the screener's. Above the limit, defer.
4. Characterize. `git worktree add -b quality/<id> <path> <base>`. The tester works there from the item and the plan only, per `../refactor/references/tests.md` sections 3.1 to 3.7. It writes a breakage map from each step's "Can break" notes, maps every test to a breakage, writes unit tests first and at most one wiring test, and rates the risk with every gap listed (**principle-test-behavior-not-implementation**). Commit the tests.
5. Gate the tests. `quality.cs scope --base <base> --allow <test folders, each ending in />`, so the tester added only test code. Build, then `quality.cs repeat --runs 3`, then `quality.cs sabotage` once per test with the tester's find-and-replace. A sabotage that doesn't compile, that the test survives, or that only an unrelated exception catches rejects that test. Then a fresh coverage reviewer checks names against bodies, the map against the plan, and the risk against the gaps, with the gate JSON as evidence. Rejections go to a fresh tester with consolidated scope. After 3 rounds, defer.
6. Approval. At risk `medium` or above, write `approval-request.md` (goal, tests, gaps, risk) on the item branch and go to the next item (**principle-never-block-on-the-human**). Ask in the reply. Never approve on your own judgment. When the person approves, continue that item at step 7.
7. Implement blind. A fresh `quality.cs blind --base <base>`. The implementer applies the plan step by step, edits only the plan's files, builds the production projects and not the solution, and commits. It reports `plan-wrong` instead of improvising.
8. Verify. `quality.cs scope` in the blind worktree with `--base <base> --allow <plan files>`. Cherry-pick its commit onto the item branch. There, build, run every test project, and run the analyzer, which must no longer report the item (**principle-prove-it-works**). On failure, a fresh implementer in a fresh blind worktree gets the broken behavior in plain words. Two attempts, then defer. If existing tests stop compiling, a fresh tester adapts only how they construct and call the code, never a name or an assertion. `scope --allow` the files it may touch, and the review in step 10 checks the rest.
9. Prune. A fresh reviewer reads the diff and every new test. Each test it keeps quotes the changed line and the mistake it would catch. Delete the rest, commit, and rerun the tests (**principle-laziness-protocol**).
10. Review. Run **interrogate** on `git diff <base>` of the item branch. The intent: the item's design problem is gone, not hidden from the metric, and no behavior changed that the tests would miss. An Act On finding defers the item.
11. Ship. On the item branch, `quality.cs claim`, then `quality.cs mark-fixed --commit <refactoring sha> --branch quality/<id>`, committed on their own. Run **Opening a PR**, with the plan, tests, sabotage results, risk, verification, and review in the description.

**Defer:** remove the item's worktrees and delete its branch. The register on the base branch never changed, so nothing else needs undoing. Record the reason in the decision trail.

**Reply:** each item's outcome first (PR link, deferred with the reason, or awaiting approval with its request), then the principles that changed a choice, then the subagent count.
