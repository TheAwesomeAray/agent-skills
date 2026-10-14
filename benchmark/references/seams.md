# Finding and isolating seams

A seam is a place where the system can be cut so one part runs alone on a fixed input and its output can be judged without running what comes after. Benchmarking a seam separately is cheaper than an end-to-end run, has less variance (nothing upstream changes its input), and tells you which part to blame or credit.

## Contents
- Where seams show up
- Choosing which seams to benchmark
- Isolating a seam
- Loops, retries, and people
- Writing the seam entry

## Where seams show up

Read the orchestrator (the code that starts agents and decides what happens next) and any design docs first. These usually mark a seam:

- **A separate prompt or role per agent.** Prompt files named by role, a role enum, or a per-role model setting. Each role is a candidate.
- **A structured handoff.** An output schema, a custom tool the agent calls to submit its result, or a JSON file written between stages. A schema is the best seam there is: the input is capturable and the output is checkable.
- **A gate.** Code that validates an agent's output (schema checks, builds, test runs) before passing it on. The gate is a ready-made quality measure.
- **A stage boundary.** Phases that hand off through files, a register, a queue, or git (a branch, a commit). The artifact between them is the fixture.
- **A fan-out.** One step that starts several agents on independent items. Benchmark one item as the seam, and note that end-to-end time depends on concurrency, not the sum of item times.

Places that look like seams but usually aren't: helper functions inside one agent's turn, and agents that share a live conversation (their output depends on the whole exchange, so capture the exchange as the unit instead).

## Choosing which seams to benchmark

Not every seam is worth a benchmark. Prefer, in order:

1. Seams that the comparison actually changes. If the user is comparing models for the implementer role, benchmark the implementer seam; leave seams that use the same settings in every configuration to the end-to-end run.
2. Seams with the largest share of cost or time. If the system already logs per-agent usage, sum it by role from a recent end-to-end run and rank. Two or three seams usually account for most of the spend.
3. Seams whose failures send work back around a loop (a rejection that triggers a retry). Their quality drives the cost of everything around them.

Say which seams you skipped and why in the plan.

## Isolating a seam

The goal is for the seam to behave exactly as it does inside the system, only with its input fixed.

1. **Capture the input from a real run.** Use what the system already writes: event logs, run directories, the files passed between stages. Copy them to `.benchmark/fixtures/<seam-id>/`. If the input is a whole external repository or a database, pin it instead: the repo, the commit, and any state to restore, in `target.json`. If no run exists yet, the first end-to-end trial produces the fixtures; plan for that rather than running anything before the go-ahead.
2. **Invoke the seam through the system's own code.** Look for an existing entry point first: a CLI subcommand, a step flag, a test harness, a resume-from-stage option. If none exists, write a small driver in `.benchmark/drivers/<seam-id>.*` that imports the system's own agent construction, prompts, and tools and calls them with the fixture. Don't re-create the prompt or tools by hand; that benchmarks a copy, not the system.
3. **Stop at the seam's output.** Don't run downstream agents. Save the output to the trial's output folder for grading.
4. **Keep the environment the same across trials.** Fresh checkout or reset working directory per trial, same fixture, same tool access. If the seam writes to shared state (a repo, a register, a database), give each trial its own copy.

If a seam can't be isolated without changing the system's code (its agent is built inside a function you can't call, or there's no way to start mid-workflow), don't modify the system. Two options, and you can use both:

- **Attribute it.** If the system logs telemetry per role or step, measure the seam inside the end-to-end trials: sum the turns that belong to it for cost, tokens, and time, and score what is observable at its output (attempts, gate results, the artifact it produced). Mark the seam `"isolation": "attributed"` with `"attributed_from": "<end-to-end seam id>"`. Its input then varies with what upstream produced, so its spread is wider than an isolated seam's; the report says so.
- **Ask for an entry point.** In the step 4 message, propose the smallest change that would let the seam run alone (for example, a flag to start from a saved plan) and what it would buy (less noise, cheaper trials). Make the change only if the user agrees.

## Loops, retries, and people

- **Feedback loops** (agent submits, a gate or reviewer rejects, agent retries): benchmark the loop as one seam and record the number of rounds as a quality measure (fewer is better), because a cheap first attempt that needs three retries isn't cheap. If the user wants first-attempt quality, add a second seam that stops after one submission.
- **Approval points** that wait for a person: replay a recorded decision from the fixture so the run doesn't block. Exclude time spent waiting for the person from `duration_s`.
- **Timeouts and stalls**: record them as `status: "timeout"` with the time and tokens spent before the stop. They are real cost.

## Writing the seam entry

Each seam in `.benchmark/seams.json` should let someone else run it without rediscovering anything: what it is, where its input comes from, the exact command or driver that runs it, where the output lands, and how each quality measure is scored. See `references/formats.md` for the fields.

Always include an `end_to_end` entry, so the catalog describes the whole workflow even when a run uses only seams. "End to end" means the workflow the user's question is about. If the question is about one phase of a larger system, that phase is the end-to-end entry; keep a separate entry for the full system if it's worth running later. Use `stage` for parts of the workflow below that level.
