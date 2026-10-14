# Fixture: test-maintainer-adapt (placeholder, not runnable yet)

Case A: `models.test_maintainer` adapts existing tests that no longer compile after the refactoring. `adaptTests()` is a closure inside `refactor()` in `src/refactor/run.ts`, so it can't be run alone without a harness change. It runs inside `refactor-phase` only when an item's diff breaks existing test code.

## What would go here

From a `refactor-phase` trial where `verify-<n>.json` has `build_errors` in test code (`<work_dir>/<harness-run-id>/out/items/<id>/`):

- `target.json` (commit), `item.json`, `plan.json`, `tests.json`, `tests/`
- `implementation-<n>.diff` (the diff that broke existing tests)
- `verify-<n>.json` (the test-code build errors handed to the test maintainer)

Quality is the gate `verify-<n>-adapted.json` `passed`. No rubric, because the harness's own checks (names and assertion lines unchanged, test-change reviewer) already judge the content.
