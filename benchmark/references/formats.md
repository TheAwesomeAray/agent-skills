# File formats

Everything lives in `<system-root>/.benchmark/`. The script validates all of it and lists every problem with the file and line.

## Contents
- standard.json
- seams.json
- plan.json
- records.jsonl
- grades.jsonl
- narrative.json

## standard.json

The report standard for this system. Created from `assets/standard.default.json` by `init` when missing. Keys missing from the system's file fall back to the defaults, so a system can keep only what it changes. Keys starting with `_` are ignored (use them for comments).

| Key | Meaning |
|---|---|
| `system` | Display name in the report title. |
| `trials.seam`, `trials.end_to_end` | Trials per configuration. 3 is the fewest that gives a usable spread; end-to-end defaults to 2 because each run is expensive. Raise them when a decision rests on a difference marked as noise. |
| `pricing_usd_per_million_tokens` | `{ "<model>": { "input", "output", "cache_read"?, "cache_write"? } }`. Model names must match `usage[].model` in records exactly. Cache prices fall back to the input price. |
| `thresholds` | When a candidate is flagged as worse than its reference: `cost_pct` and `time_pct` (percent increase), `quality_points` and `success_rate_points` (drop in points out of 100). |
| `report.title` | Report heading. |
| `report.sections` | Section order. Built-in: `summary`, `configurations`, `end_to_end`, `seams`, `comparison`, `observations`, `recommendations`, `method`. Remove any to omit it. Any other name is a custom section whose Markdown comes from `narrative.json` `custom.<name>`. |
| `report.per_trial_table` | `true` appends a table of every trial. |
| `publish.mode` | `pr` (branch, commit, push, pull request), `commit` (branch and commit only), or `none`. |
| `publish.branch_prefix`, `publish.base` | Branch is `<prefix><run-id>`. `base` is the pull request's target; empty means the repo's default branch. |

## seams.json

The system's seam catalog. Persists across runs; update it when the system changes.

```json
{
  "seams": [
    {
      "id": "planner",
      "kind": "agent",
      "description": "Refactorer in planning mode: turns one register item into a step plan.",
      "boundary": { "input": "register item + production checkout", "output": "plan.json matching schemas/refactor-plan.json" },
      "fixtures": [".benchmark/fixtures/planner/item-solid-7f3a9c/"],
      "invoke": "node .benchmark/drivers/planner.mjs --fixture <fixture> --out <trial-dir> --model <model>",
      "telemetry": "driver prints { duration_ms, usage } from the SDK run result",
      "quality": [
        { "name": "schema_valid", "kind": "gate", "weight": 1, "how": "harness plan validator accepts the plan" },
        { "name": "plan_rubric", "kind": "rubric", "weight": 2, "how": ".benchmark/fixtures/planner/rubric-plan_rubric.md, max 10; 0 if no plan was submitted" }
      ]
    },
    { "id": "end-to-end", "kind": "end_to_end", "description": "...", "invoke": "...", "quality": [ { "name": "resolved", "kind": "outcome", "how": "..." } ] }
  ]
}
```

- `id`: lowercase letters, digits, hyphens. Used in folder names and the report.
- `kind`: `agent` (one agent's turn or loop), `stage` (several agents or code steps), or `end_to_end` (the workflow the user's question is about).
- `isolation`: `isolated` (default; runs alone on a fixture) or `attributed` (measured from its share of another seam's trials). An attributed seam needs `attributed_from`, the id of that seam, and its records use the same trial numbers.
- `quality`: at least one measure. `weight` defaults to 1. See `references/quality.md` for kinds.
- `boundary`, `fixtures`, `invoke`, `telemetry` are for people and later runs; the script only displays `description` and `boundary`.

## plan.json

Written before any trial runs, in `.benchmark/runs/<run-id>/`. `run_id` must equal the folder name.

```json
{
  "run_id": "2026-10-13T2215Z-1a2b3c4-models",
  "label": "models",
  "system_commit": "1a2b3c4",
  "baseline_config": "opus",
  "configs": [
    { "name": "opus", "description": "All roles on Claude Opus", "models": ["claude-opus-5-5", "composer-2.5"], "settings": { "config_file": "configs/compare-opus.json" } },
    { "name": "mixed", "description": "Sonnet for implementer and test roles", "models": ["claude-opus-5-5", "claude-sonnet-5-5", "composer-2.5"], "settings": { "config_file": "configs/compare-mixed.json" } }
  ],
  "seams": ["planner", "implementer", "end-to-end"],
  "skipped_seams": { "screener": "same model in every configuration" },
  "trials": { "seam": 3, "end_to_end": 2 },
  "grader": "claude-opus-5-5, blind, rubric per seam",
  "estimate": { "cost_usd": 42.0, "minutes": 95, "basis": "per-role costs from the last end-to-end run" },
  "publish": "pr"
}
```

`trials` overrides the standard for this run only. `models` on a configuration is optional; when present, `validate --plan-only` warns about any without a price. `skipped_seams`, `estimate`, and `publish` are for the user's review; the script ignores them. Use `"estimate": { "pilot": true, ... }` when the numbers will come from a pilot.

## records.jsonl

One line per trial, appended as each trial finishes, including failed ones.

```json
{"seam":"planner","config":"opus","trial":1,"status":"ok","duration_s":184.2,"usage":[{"model":"claude-opus-5-5","input":120400,"output":8900,"cache_read":310000,"cache_write":40200}],"quality":{"schema_valid":1},"output":"outputs/planner/opus/1/","notes":""}
```

- `status`: `ok`, `failed`, or `timeout`.
- `duration_s`: wall-clock seconds for the trial, excluding time waiting on a person.
- `usage`: one entry per model used. Omit it if tokens weren't available; don't estimate them.
- `cost_usd`: optional. Use it when the system records cost itself; it takes precedence over `usage` times prices.
- `quality`: the automatic measures (gate, schema, reference, outcome, rounds), 0 to 1, or `null` when the measure doesn't apply to this trial (see "When a measure doesn't apply" in `references/quality.md`). Rubric scores go in `grades.jsonl`. A successful trial needs a value (number or null) for every measure.
- `output`: where the trial's artifacts are, relative to the run folder.

## grades.jsonl

One line per graded trial, written after grading and un-blinding. Merged into the matching record by `seam`, `config`, and `trial`.

```json
{"seam":"planner","config":"opus","trial":1,"quality":{"plan_rubric":0.8},"grader":"claude-opus-5-5","evidence":"Steps 2-4 cover all callers; misses the static factory in OrderFactory.cs"}
```

## narrative.json

Your interpretation, written after `validate` passes and prints the computed numbers per seam and configuration.

```json
{
  "summary": "2-5 sentences: what was compared, the answer, and how confident it is.",
  "seam_notes": { "planner": "Why this seam's numbers look the way they do." },
  "observations": ["Patterns, surprises, anything that limits the conclusions."],
  "recommendations": ["What to do next, most important first."],
  "custom": { "<custom-section>": "Markdown for a section the standard adds." }
}
```
