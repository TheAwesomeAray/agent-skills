---
name: benchmark
description: Benchmarks multi-agent systems (agent harnesses, orchestrators, SDK pipelines) for cost, time, and quality. Finds the seams between agents and stages that can be tested separately, runs them and the full end-to-end workflow across configurations such as model mixes, prompt versions, or settings, and produces a Markdown report in a per-system standard format that is committed to source control. Use this skill whenever the user wants to benchmark, compare, profile, or measure an agent system, asks which model or configuration is cheaper, faster, or better for some agent role, wants to know where an agent workflow spends its money or time, or wants to check that a change to a harness didn't regress cost or quality, even if they don't say "benchmark".
---

# Benchmark

Benchmark a multi-agent system on three axes: cost (dollars or tokens per trial), time (wall-clock seconds per trial), and quality (0 to 1 per trial, defined per seam). Run each part that can be cut out of the system (a seam) on a fixed input, and run the whole workflow end to end. Repeat each across the configurations being compared, then produce a report in the system's standard format.

Seams show which part is responsible for a difference; the end-to-end run shows whether the difference matters. A seam that looks better alone can make the whole workflow worse, so run both unless the user asks for one.

A script (`scripts/benchmark.mjs`) checks the files, does the statistics, and renders the report, so the report format and arithmetic are the same every run. Your job is the judgment: finding seams, running trials faithfully, grading quality, and interpreting the results.

## Requirements

- Node 18 or later (`node --version`). The script uses no packages.
- `git`, and the GitHub CLI (`gh auth status`) when the standard publishes as a pull request.
- Whatever the system under test needs to run (API keys, SDKs, toolchains). Find out in step 2.

## Workflow

Copy this checklist into your response and tick it off:

```
- [ ] 1. Find the system and its standard
- [ ] 2. Map the system and its seams
- [ ] 3. Capture fixtures and quality measures
- [ ] 4. Plan the run and get the user's go-ahead
- [ ] 5. Run the trials
- [ ] 6. Grade quality
- [ ] 7. Write the narrative and generate the report
- [ ] 8. Commit and publish
- [ ] 9. Summarize for the user
```

Paths are relative to this skill's directory (`<skill-dir>`) or to the system's root (`<system>`), the folder containing the system's code. Everything the skill writes goes in `<system>/.benchmark/`. See `references/formats.md` for every file's fields.

### 1. Find the system and its standard

The system is the path the user gives, or else the agent system in the workspace. Then run:

```
node <skill-dir>/scripts/benchmark.mjs init <system>
```

If `<system>/.benchmark/standard.json` exists, this uses it and prints its trials, sections, pricing, and publish mode. Otherwise it creates one from `assets/standard.default.json`. It also lists the seam catalog and previous runs, and suggests a run id.

- If the user asks for a format change ("add a section on retries", "always show every trial", "flag a 5% cost increase"), edit `standard.json` before running. The change then applies to every future run of this system. Custom sections are names in `report.sections` whose text you write in the narrative.
- **Pricing:** cost needs prices per model. Copy them from the system's own config if it has them (many harnesses keep a pricing table), and ask the user in step 4 for any model still missing. Don't use prices from memory: they change and the report would look authoritative while being wrong. Without prices, the report shows tokens and marks cost as not measured.
- Fix any warnings `init` prints about unknown keys (usually typos).

### 2. Map the system and its seams

If `.benchmark/seams.json` exists, check it against the current code: look at `git log` since the last run's `system_commit` for changes to the orchestrator, prompts, schemas, or agent roles, and update the entries that changed. Otherwise build it.

Read `references/seams.md`, then read the orchestrator and design docs. Identify:

- the agents, what each receives and returns, the gates between them, and the loops;
- where the system already records telemetry (many harnesses log per-turn usage and duration by role; use those records rather than re-measuring);
- state the system keeps between runs (work directories, branches, logs, registers, "already done" checks), because trials must not see each other's leftovers;
- whether the system is running right now (ask the user if you can't tell). A live run's logs are free data: use its per-role telemetry for the estimate and its intermediate files as fixtures, instead of paying for a pilot.

Write `.benchmark/seams.json` with one entry per seam worth benchmarking plus one `end_to_end` entry for the workflow the user's question is about. If they ask about one phase, that phase is the end-to-end workflow; phases that are identical in every configuration don't need to run. For each seam, record how to invoke it and where its numbers come from. If a seam can't run alone without changing the system, mark it `attributed` (see `references/seams.md`) and measure it from the end-to-end runs.

### 3. Capture fixtures and quality measures

For each seam, capture a real input into `.benchmark/fixtures/<seam-id>/` (see "Isolating a seam" in `references/seams.md`) and define its quality measures (see `references/quality.md`). When the input is large or external, such as another repository, pin it instead of copying it: record the repo, commit, and any state to restore in `fixtures/<seam-id>/target.json`. Write a rubric for any `rubric` measure now, before seeing any outputs, so the rubric isn't fitted to them.

If there's no earlier run to capture from, the first end-to-end trial produces the fixtures. Say so in the plan.

Fixtures and rubrics persist across runs. Reuse them; that is what makes runs comparable.

### 4. Plan the run and get the user's go-ahead

Benchmarks spend real money and can take hours, so nothing runs until the user approves the plan.

Create `.benchmark/runs/<run-id>/plan.json`. `run-id` is `YYYY-MM-DDTHHMMZ-<short commit>[-<label>]` in UTC, for example `2026-10-13T2215Z-1a2b3c4-models`. The plan lists:

- The configurations to compare and which is the baseline. If the user names only one configuration, the baseline is the system's current default, and the comparison is against the previous run (step 7).
- The seams to run, and which ones you skipped and why.
- Trials per configuration (the standard's, unless the user asks otherwise).
- The grader for rubric measures (see "Grading with a rubric" in `references/quality.md` for how to choose one).
- An estimate of cost and time: trials times the per-trial cost and time from previous runs or the system's logs. If there's no data, plan a pilot (trial 1 of each seam and configuration), extrapolate from it, and check with the user again before the remaining trials. The pilot is part of the plan, so it waits for the go-ahead like everything else.
- The publish mode.

Check the plan before showing it:

```
node <skill-dir>/scripts/benchmark.mjs validate --run <system>/.benchmark/runs/<run-id> --plan-only
```

Show the user the plan in a few lines: what will run, how many trials, the estimated cost and time (or the pilot and its rough size), and where results will be published. Put everything you need from them in the same message: missing prices, target repos or items, permission to auto-approve steps that normally wait for a person, and any change to the system that would let a seam run in isolation. Wait for their go-ahead. If they cut the budget, reduce end-to-end trials before seam trials, because seam trials are cheaper and less noisy.

### 5. Run the trials

Don't start trials while another run of the system is in progress. It shares rate limits, which skews timings, and often shares state (work directories, outcome logs, branches) that trials would read or corrupt. Wait for it to finish, or confirm with the user that the two are fully separate.

For every seam, configuration, and trial in the plan:

1. Reset the environment (fresh checkout or copy of the fixture) so trials don't see each other's output.
2. Run the seam's `invoke` with the configuration's settings. Save artifacts to `outputs/<seam>/<config>/<trial>/` in the run folder.
3. Append one line to `records.jsonl` right away, with status, duration, usage per model, and the automatic quality measures. Record failures and timeouts too: they spent money and time, and dropping them makes a flaky configuration look good.
4. For each `attributed` seam measured inside this trial, append a record for it too, with the same trial number, built from that seam's share of the trial's telemetry.

Alternate configurations (trial 1 of each, then trial 2 of each) rather than running all of one first, so drift in provider latency or load spreads evenly. Run independent trials in parallel only if the system is meant to run that way; contention changes timings.

Track spend as you go. If actual cost passes 1.5 times the estimate, pause and tell the user before continuing. By then the estimate was clearly wrong, and the user approved a number, not an open budget.

### 6. Grade quality

For rubric measures, grade blind with one grader model for the whole run, following "Grading with a rubric" in `references/quality.md`. Use a subagent that sees only the fixture, the rubric, and outputs under opaque ids. Write the results to `grades.jsonl`.

Then validate:

```
node <skill-dir>/scripts/benchmark.mjs validate --run <system>/.benchmark/runs/<run-id>
```

It lists every problem (unknown seams or measures, missing trials, scores outside 0 to 1, successful trials without a score). Fix them and rerun until it passes. It then prints cost, time, and quality per seam and configuration.

### 7. Write the narrative and generate the report

Read the numbers, open some of the outputs behind surprising ones, and write `narrative.json`: a summary, notes per seam, observations, recommendations, and text for any custom sections. Read "Reading the numbers" in `references/quality.md` first. In particular, don't draw conclusions from differences the report marks as noise.

```
node <skill-dir>/scripts/benchmark.mjs report --run <system>/.benchmark/runs/<run-id> [--previous <system>/.benchmark/runs/<earlier-run-id>]
```

Pass `--previous` with the most recent earlier run that covers the same seams, so the report shows the change over time. The script writes `results.json` and `REPORT.md` in the run folder and prints flagged comparisons. Don't hand-edit numbers in `REPORT.md`. To change what it says, change the records, grades, narrative, or standard, then regenerate.

### 8. Commit and publish

Follow `publish.mode` from the standard (the user approved it with the plan):

- `pr`: create branch `<branch_prefix><run-id>`, commit `.benchmark/` (standard, seams, fixtures, drivers, and the run folder), push, and open a pull request with `gh pr create`. Use the report's summary as the pull request body and link `REPORT.md`. Target `publish.base`, or the default branch if empty.
- `commit`: the branch and commit only.
- `none`: leave the files uncommitted.

Leave out large or sensitive artifacts: anything over a few MB, credentials, and logs containing API keys or customer data. List what you left out in the commit message so the run can still be understood.

### 9. Summarize for the user

Reply with:

- The answer to the question they asked (which configuration wins, where the money goes, whether the change regressed anything), with the confidence the trial counts support.
- End-to-end cost, time, and quality per configuration, in a sentence or a compact list.
- The seams that explain the difference.
- Anything flagged, and anything that limits the conclusions (unpriced models, high variance, seams that couldn't be isolated).
- The path to `REPORT.md` and the pull request link.

## Re-running

Later runs reuse `standard.json`, `seams.json`, fixtures, and rubrics, so start at step 1 and move quickly through steps 2 and 3, updating only what the system's changes require. Always pass `--previous` so trends show up. If you change a rubric or a fixture, earlier runs aren't comparable on the affected measures; say so in the observations.
