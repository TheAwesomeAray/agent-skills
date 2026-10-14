# Fixture: implementer (placeholder, not runnable yet)

This seam cannot be run in isolation without a harness change: `implementAndVerify()` is a closure inside `refactor()` in `src/refactor/run.ts`, and the CLI has no option to start an item from a saved plan and tests. It is measured inside `refactor-phase` until the user agrees to an entry point (for example `refactor --from <saved item dir>`, skipping plan and tests).

## What would go here, per item

Captured from the first `refactor-phase` trial on the baseline config (opus), at `<work_dir>/<harness-run-id>/out/`:

| File | From |
|---|---|
| `target.json` | Same as `fixtures/refactor-phase/target.json` |
| `<id>/item.json` | `.tech-debt/items/<id>.json` at the commit |
| `<id>/plan.json`, `gate.json`, `references.json` | `out/items/<id>/` |
| `<id>/tests.json`, `tests/` | `out/items/<id>/` (accepted characterization tests, copied into the verify tree unchanged) |
| `baseline.json` | `out/baseline.json` (pre-existing test failures, used by verify) |

Every implementer trial then starts from the same plan and tests, which removes the upstream variance that `refactor-phase` has.
