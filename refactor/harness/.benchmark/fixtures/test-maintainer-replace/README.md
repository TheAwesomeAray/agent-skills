# Fixture: test-maintainer-replace (placeholder, not runnable yet)

Case C: `models.test_maintainer` replaces `needs_refactor` tests with cheaper unit tests after verification. `replaceFlagged()` is a closure inside `refactor()` in `src/refactor/run.ts`, so it can't be run alone without a harness change. It runs inside `refactor-phase` only when the tester flagged tests.

## What would go here

From a `refactor-phase` trial whose `tests.json` has tests with `needs_refactor` (`<work_dir>/<harness-run-id>/out/items/<id>/`):

- `target.json` (commit), `item.json`, `plan.json`, `tests.json`, `tests/`
- the final passing `implementation-<n>.diff` (the seam the replacements use)

Quality is the share of flagged tests replaced (`manifest.json` `items[].replaced` / `needs_refactor`). No rubric, because the gates, test auditor, and comparison reviewer already judge the replacements.
