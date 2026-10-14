# Fixture: tester-loop (placeholder, not runnable yet)

This seam cannot be run in isolation without a harness change: the tester turn and `reviewCoverage()` are inside `attempt()` in `src/refactor/run.ts`. `--dry-run` reaches them only after a fresh planner plan, so the input is not fixed. Measured inside `refactor-phase` until an entry point exists.

The configurations differ here only in `models.coverage_reviewer` (Sonnet vs Opus). The reviewer decides when the loop stops, so a more lenient reviewer can look cheaper (fewer tester rounds) while accepting a weaker safety net. That is why the quality measure is a rubric on the accepted tests, not the number of rounds.

## What would go here, per item

Captured from the first `refactor-phase` trial on the baseline config (opus), at `<work_dir>/<harness-run-id>/out/items/<id>/`:

| File | From |
|---|---|
| `target.json` | Same as `fixtures/refactor-phase/target.json` |
| `<id>/item.json` | `.tech-debt/items/<id>.json` |
| `<id>/plan.json`, `references.json` | `out/items/<id>/` |
| `baseline.json` | `out/baseline.json` |
