# Measuring quality

Cost and time are measured; quality has to be defined. Each seam gets one or more quality measures, each scored from 0 to 1 per trial. The report combines them into a weighted mean per seam.

## Contents
- Measure kinds
- Defaults by seam type
- Grading with a rubric
- Reading the numbers

## Measure kinds

Use the most objective kind that captures what matters. Prefer measures the system already computes.

| Kind | Score | Use when |
|---|---|---|
| `gate` | 1 if the system's own check passes, else 0 | The system validates the output (schema, build, tests, analyzer). Free and exact. |
| `schema` | 1 if the output matches its schema, else 0 | The seam has an output schema but the system doesn't check it in isolation. |
| `reference` | Overlap with a known-good output, e.g. F1 of findings or the share of expected fields that match | A trusted output exists (a human-reviewed run, a golden file). Store it with the fixture. |
| `outcome` | 1 if the end result happened (PR opened, item resolved, tests green), else 0, or the share of items that succeeded | End-to-end workflows. |
| `rounds` | `1 / rounds` or `1 - (rounds - 1) / max_rounds` | Seams with retry loops. Say which formula in `how`. |
| `rubric` | Grader's score divided by the rubric's maximum | Judgment matters and nothing above captures it (plan quality, review accuracy). |

Write `how` so it is reproducible: the command, the file compared, or the rubric's location. A measure someone can't recompute isn't a benchmark.

### When a measure doesn't apply

A trial can end without reaching the thing a measure judges. For example, a refactor trial deferred its item before writing a diff, so the diff rubric has nothing to grade. Decide which case you're in:

- **The trial was supposed to reach it and didn't.** That is a failure of the configuration: score 0. If nothing useful came out at all, set the trial's `status` to `failed`.
- **It legitimately doesn't apply.** For example, the item had no existing tests to adapt: record `null`. The measure is left out of that trial's quality and out of its per-measure average.

Say in `how` which outcomes count as 0 and which as null, so every grader and every run decides the same way.

## Defaults by seam type

- **Agent with a structured output:** `gate` or `schema`, plus a `rubric` for whether the content is right. Weight the rubric higher (for example 2 to 1); valid-but-wrong output is the common failure.
- **Agent in a retry loop:** the above plus `rounds`.
- **Stage that ends in code changes:** `gate` on build and tests, plus `rubric` from a reviewer reading the diff.
- **End-to-end workflow:** `outcome`, plus a `rubric` on the final artifact if the outcome alone can be gamed (a PR that opens but doesn't solve the problem).

## Grading with a rubric

The grader decides the numbers the comparison rests on, so keep it consistent and blind.

- **Write the rubric once per measure**, in `.benchmark/fixtures/<seam-id>/rubric-<measure>.md`: 3 to 5 criteria, each with what earns full, partial, and no credit, and the maximum score. Reuse it across runs so scores stay comparable. If you change it, say so in the report's observations, because earlier runs aren't comparable on that measure anymore.
- **Use one grader model for every configuration in a run**, recorded as `grader` in `plan.json`. A different grader per configuration measures the graders. Prefer a capable model from a different family than the models being compared, because models tend to rate output in their own style higher. If none is available, use the strongest one and note the possible bias in the observations.
- **Blind the grader.** Give it the fixture, the rubric, and the outputs labeled only by an opaque id (for example `t07`), in shuffled order. Don't tell it which configuration produced which output, how much it cost, or which one is the baseline. Keep the id-to-trial mapping yourself.
- **Ask for evidence.** For each criterion, the grader quotes or points at the part of the output that earned or lost credit. Spot-check a few grades against the outputs; if a grade doesn't match what you read, fix the rubric rather than the number.
- **Write grades to `grades.jsonl`**, one line per trial, after un-blinding. Don't edit `records.jsonl` for this, so automatic measures and judged ones stay separate.

## Reading the numbers

- A difference smaller than the run-to-run spread (one standard deviation) is noise. The report marks it. If the decision rests on a difference marked as noise, recommend more trials rather than a conclusion.
- Quality and cost trade off. When a cheaper configuration loses quality, say how many points of quality each dollar saved costs, per seam, rather than calling either one better.
- A seam can look better alone and worse end to end (for example, a planner whose plans are better but longer, so the implementer spends more). When seam and end-to-end results disagree, trust end to end for the decision and use the seams to explain it.
