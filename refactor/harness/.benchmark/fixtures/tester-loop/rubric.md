# Rubric: tester-loop

Written 2026-10-13, before any outputs. Score / 8 gives `safety_net`. The grader sees the register item, `plan.json`, and, under an opaque id, the accepted `tests.json` and test files. It never sees the configuration, the cost, the number of rounds, or the coverage reviewer's verdicts.

Use the same criteria as Part B of `../refactor-phase/rubric.md`:

| # | Criterion | 2 (full) | 1 (partial) | 0 (none) |
|---|---|---|---|---|
| B1 | **Breakages covered, nothing out of scope** | Every realistic way the plan's steps could break behavior is caught by a test (a dependency change has a wiring test), and no test guards logic the plan does not touch | One breakage missing without a valid reason, or one out-of-scope test | Key breakages missing, or most tests out of scope |
| B2 | **Plan risks covered** | Each `plan.risks` entry has a test that would fail if it happened, or an honest not-covered reason | Some risks covered only indirectly | Risks ignored |
| B3 | **Tests check behavior, not structure** | Assertions on observable results | Some assertions on implementation details | Mostly structural or tautological |
| B4 | **Risk rating honest** | `risk` level and `uncovered` list match the visible gaps | Slightly optimistic | Claims protection the tests don't give |

Quote or point at the tests that earned or lost credit for each criterion.
