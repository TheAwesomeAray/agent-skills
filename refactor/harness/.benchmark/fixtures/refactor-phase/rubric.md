# Rubric: refactor-phase

Written 2026-10-13, before any outputs. Two parts, graded separately per item. Part A gives `change_quality` (score / 10); part B gives `safety_net` (score / 8). The grader sees the register item, `plan.json`, and, under an opaque id, either the final diff with the implementer's summary and deviations (A) or `tests.json` and the test files (B). It never sees which configuration produced them, the cost, the verify reports, or the reviewer's verdict.

For every criterion, quote or point at the lines that earned or lost credit.

## Part A: the change (max 10)

| # | Criterion | 2 (full) | 1 (partial) | 0 (none) |
|---|---|---|---|---|
| A1 | **Problem actually resolved** | The design problem in the finding is gone in substance (e.g. the dependency is injected, the responsibility is really separated) | Resolved for the main path but a remnant remains (one `new` left, a helper that still couples the types) | Not resolved, or hidden from the metric (static helper, factory that still news up the concrete type, split along meaningless lines) |
| A2 | **Behavior preserved** | Nothing in the diff can change observable behavior: exception types, ordering, null handling, side effects, DI lifetimes all unchanged | One plausible but minor behavior risk (e.g. lifetime differs in an edge case) | A clear behavior change |
| A3 | **Follows the plan** | Every plan step applied; deviations are listed and each was needed | Small unlisted deviations, or a listed one that wasn't needed | Skips steps, improvises a different refactoring, or touches unplanned code |
| A4 | **Minimal and clean** | Only what the plan needs; no stray formatting, dead code, or commented-out code | Some noise (reformatting, unused usings, leftover fields) | Large unrelated changes |
| A5 | **Idiomatic C# matching the codebase** | Names, null checks, and DI registration style match the surrounding code | Works but reads foreign to the codebase in places | Awkward or incorrect patterns (service locator, mutable statics, async misuse) |

An item that never produced a diff (plan-wrong, failed before implementation) is not graded on part A; `implement_rounds` and `items_committed` already count it.

## Part B: the safety net (max 8)

| # | Criterion | 2 (full) | 1 (partial) | 0 (none) |
|---|---|---|---|---|
| B1 | **Breakages covered, nothing out of scope** | Every realistic way the plan's steps could break behavior is caught by a test that stays in the PR (a dependency change has a wiring test), and every test in the PR guards a line the diff changed | One breakage missing without a valid reason, or one test that guards nothing the diff changed | Key breakages missing, or most tests guard nothing the diff changed |
| B2 | **Plan risks covered** | Each risk in `plan.risks` has a test that would fail if the risk happened, or an honest not-covered reason | Some risks covered only indirectly | Risks ignored |
| B3 | **Tests check behavior, not structure** | Assertions on observable results; tests would survive any behavior-preserving refactoring | Some assertions on implementation details (call counts on internals, private state) | Mostly structural or tautological |
| B4 | **Risk rating honest** | The `risk` level and `uncovered` list match the gaps you can see | Slightly optimistic | Claims protection the tests don't give |
