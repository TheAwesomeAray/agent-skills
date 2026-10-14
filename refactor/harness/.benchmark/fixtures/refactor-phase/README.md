# Fixture: refactor-phase (placeholder)

Not captured yet: no prior refactor run exists (no `manifest.json` or `refactor-outcomes.jsonl` under the configs' `work_dir`, `%TEMP%/quality-compare`, or the default `%TEMP%/quality`).

## What goes here

| File | Content | Captured from |
|---|---|---|
| `target.json` | `{ "repo": "<path or clone URL of the CRM target repo>", "commit": "<full sha>", "items_ref": "<ref holding .tech-debt/items>" }` | The target repo the configs were written for (test projects `UnitTests/CRM.Domain.UnitTests.csproj`, `CRM.Reports.UnitTests/...`, `IntegrationTests/...`). The user must name it. |
| `items.txt` | 2 register item ids, one per line, in run order | Chosen by the user, or from `selection.json` of one `refactor --select` run (Composer screener only). Pick production-code items (not under `test_dirs`) screened at complexity 1 or 2. Prefer one item whose change alters a constructor that existing tests call, so case A (adapt) can trigger. |
| `items/<id>.json` | Copy of each chosen `.tech-debt/items/<id>.json` at `commit` | Target repo |
| `approval.json` | `{ "approved": true, "note": "benchmark replay" }` | Recorded decision to replay. Both configs set `refactor.approval_risk: high`, so a high-risk item waits up to 240 minutes for this file in `out/items/<id>/`. |

## How a trial uses it

1. Fresh clone of `target.json.repo` at `commit` into the trial folder. This is required: a local `refactor/<id>-<run>` branch from an earlier trial makes the next `--item` run stop with "Already in review".
2. `npm run quality -- refactor --repo <clone> --item <ids> --limit 2 --no-push --config configs/compare-<config>.json --set work_dir=<trial-dir>/work`. A per-trial `work_dir` keeps `refactor-outcomes.jsonl` and the screen cache separate.
3. Approval replay: a watcher (to write as `.benchmark/drivers/approve.mjs`) copies `approval.json` into `<work_dir>/<run-id>/out/items/<id>/` when `approval-request.json` appears there. The time between the two files is subtracted from `duration_s`.
4. Copy `out/manifest.json`, `out/items/`, and the outcomes log line to the trial's output folder.

`rubric.md` here is final and must not be changed after outputs are seen.
