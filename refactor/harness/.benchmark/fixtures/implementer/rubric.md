# Rubric: implementer

Written 2026-10-13, before any outputs. Score / 10 gives `change_quality`. The grader sees the register item, `plan.json`, and, under an opaque id, the final diff with the implementer's summary and deviations. It never sees the configuration, the cost, the verify reports, or the reviewer's verdict.

Use the same criteria as Part A of `../refactor-phase/rubric.md`, so the two seams' change-quality scores are comparable:

| # | Criterion | 2 (full) | 1 (partial) | 0 (none) |
|---|---|---|---|---|
| A1 | **Problem actually resolved** | The design problem in the finding is gone in substance | Resolved for the main path but a remnant remains | Not resolved, or hidden from the metric |
| A2 | **Behavior preserved** | No observable behavior change: exception types, ordering, null handling, side effects, DI lifetimes | One plausible minor behavior risk | A clear behavior change |
| A3 | **Follows the plan** | Every plan step applied; deviations listed and needed | Small unlisted or unneeded deviations | Skips steps or improvises |
| A4 | **Minimal and clean** | Only what the plan needs | Some noise | Large unrelated changes |
| A5 | **Idiomatic C# matching the codebase** | Matches surrounding style and DI registration | Reads foreign in places | Awkward or incorrect patterns |

Quote or point at the lines that earned or lost credit for each criterion.
