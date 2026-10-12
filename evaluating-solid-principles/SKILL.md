---
name: evaluating-solid-principles
description: Evaluates a C# / .NET application for SOLID principle violations (Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion) against configurable per-criterion thresholds and produces a Markdown risk profile with Low/Medium/High/Critical ratings per principle and overall. Use this skill whenever the user asks to assess, audit, or review a C# codebase for SOLID compliance, design quality, architectural risk, god classes, coupling, fat interfaces, or technical debt, wants a risk profile or design health report for a .NET repo, or wants to set or tune SOLID thresholds, even if they don't say "SOLID" explicitly.
---

# Evaluating SOLID principles

A Roslyn-based script measures every type in the repo and flags threshold breaches. You then review those findings against the code, dismiss false positives, adjust severity where context warrants, and add violations the metrics can't see. The script rolls everything up into a risk profile.

Metrics alone are noisy (a 600-line parser can be perfectly cohesive) and judgment alone isn't repeatable. The value of this skill comes from combining the two, so don't skip the review step.

## Requirements

- .NET 10 SDK or later (`dotnet --list-sdks`). The script is a single-file app run with `dotnet run`, and nothing needs to be installed beforehand.
- The first run restores two NuGet packages (Roslyn, YamlDotNet) and compiles the script, which takes about 15 to 60 seconds and needs network access to nuget.org. Later runs take a few seconds.



## Workflow

Copy this checklist into your response and tick it off:

```
- [ ] 1. Locate the repo and thresholds
- [ ] 2. Run the analysis
- [ ] 3. Review findings against the code
- [ ] 4. Write solid-review.json
- [ ] 5. Generate the report (fix validation errors until it passes)
- [ ] 6. Summarize for the user
```

Paths below are relative to this skill's directory (`<skill-dir>`). The output goes in `<repo>/.solid-analysis/`.

### 1. Locate the repo and thresholds

The target is the whole repository: the path the user gives, or else the workspace root. Confirm it contains `.cs` files.

Thresholds come from `assets/solid-thresholds.default.yaml`, overridden by `<repo>/solid-thresholds.yaml` if present. The override file only needs the values that differ from the defaults.

- If the user states thresholds in the request (e.g. "flag classes over 400 lines as high"), write or update `<repo>/solid-thresholds.yaml` with just those overrides before running. Use the same key structure as the defaults file.
- If the user asks to "set up" or "configure" thresholds, copy the defaults file to `<repo>/solid-thresholds.yaml` so they have the full annotated template to edit.
- Otherwise, run with whatever exists. Don't create a config file the user didn't ask for.



### 2. Run the analysis

```
dotnet run <skill-dir>/scripts/solid-analyzer.cs -- analyze <repo>
```

This writes `<repo>/.solid-analysis/solid-metrics.json` and prints counts by principle and severity plus the top 25 findings. Options: `--config <yaml>` to use a thresholds file at a different path, `--out <json>` to change the output location, `--register <dir>` to read a technical debt register (see "Re-running after changes").

Each finding has two names. `id` (e.g. `solid-7f3a9c`) is a hash of the principle, criterion, and type, so it stays the same across runs, edits, and file moves. `label` (e.g. `SRP-001`) is a readable position in this run's report and changes between runs.

Read the printed warnings. Unknown keys in the user's thresholds file usually mean a typo, so tell the user. Files with syntax errors produce incomplete metrics for those files.

If the run reports no files, the exclude globs filtered everything. Check the globs against the repo layout.

### 3. Review findings against the code

Read `references/criteria.md` before reviewing. For each criterion it lists the common false positives and the judgment checks for problems the metrics can't detect.

Work through `solid-metrics.json`:

1. **Every Critical and High finding:** open the code and decide whether to keep it, adjust its severity, or dismiss it. These drive the rating, so each one needs a look.
2. **Medium and Low findings:** spot-check them, prioritizing types that also have higher findings. If a criterion produces the same false positive repeatedly (e.g. every `*Mapper` class trips `class_lines`), dismiss those findings and suggest a threshold or exclude change in your recommendations.
3. **Hotspots:** types with findings across several principles. Read these closely and apply the judgment checks from `references/criteria.md`. Record real violations as added findings.
4. **Repo-level checks the per-type metrics miss:** whether core/domain projects reference infrastructure packages (check the `.csproj` files), and whether the same type-code switch is duplicated across classes.

Base every decision on what you actually read in the code, and keep the reasons specific: "DTO mapping table, no logic" rather than "false positive".

For large repos (hundreds of findings), review all Critical/High findings and the top 10 hotspots. Leave the remaining Medium/Low findings as-is; unreviewed findings count at their metric severity.

### 4. Write solid-review.json

Save to `<repo>/.solid-analysis/solid-review.json`:

```json
{
  "executive_summary": "2-5 sentences: overall risk, what drives it, where to focus first.",
  "reviewed": [
    { "id": "SRP-001", "action": "keep", "recommendation": "Split into X and Y along the field groups {a,b} and {c,d}.",
      "evidence": [{ "file": "src/Acme/OrderService.cs", "line": 40, "note": "Pricing methods never touch _repository" }] },
    { "id": "DIP-004", "action": "dismiss", "reason": "FileStore is the file-system adapter; File.* use is its job." },
    { "id": "LSP-002", "action": "adjust", "severity": "high", "reason": "Fly() is called on Bird collections in AviaryService, so this throws in production paths.", "recommendation": "..." }
  ],
  "added": [
    {
      "principle": "dip", "severity": "high",
      "title": "Domain project references EF Core",
      "type": "Acme.Domain", "file": "src/Acme.Domain/Acme.Domain.csproj", "line": 12,
      "details": "What you observed and why it violates the principle.",
      "recommendation": "Concrete next step."
    }
  ],
  "recommendations": ["Top 3-5 prioritized actions across the codebase."]
}
```

- `id` can be the finding's stable `id` or its `label`.
- `action` is `keep`, `dismiss`, or `adjust`. `dismiss` and `adjust` require a `reason`, and `adjust` also requires a `severity`.
- `evidence` is optional on reviewed and added findings: `file` paths relative to the repo, an optional `line`, and a `note`. The script rejects files that don't exist and lines past the end of the file, and the report shows the evidence under each High and Critical finding.
- `recommendation` is optional, but give one for every Critical and High finding you keep, because those are what readers act on.
- `added` findings require `principle` (srp/ocp/lsp/isp/dip), `severity`, `title`, `type`, `file`, and `details`. Use the severity rubric in `references/criteria.md`.
- `executive_summary` is required. Write it after reviewing, so it reflects the reviewed picture rather than the raw counts.
- Optional: `"application": "Display Name"` overrides the report title, which defaults to the repo folder name.



### 5. Generate the report

```
dotnet run <skill-dir>/scripts/solid-analyzer.cs -- report --metrics <repo>/.solid-analysis/solid-metrics.json --review <repo>/.solid-analysis/solid-review.json
```

If the review file has problems, the script lists each one (unknown ids, missing reasons, invalid severities) and writes nothing. Fix them and rerun until it succeeds.

On success it prints the overall and per-principle ratings and writes `<repo>/.solid-analysis/SOLID-RISK-PROFILE.md`. Ratings are computed by the script from the reviewed findings (severity points per 10 types, using the bands in the thresholds file), so don't hand-edit ratings in the report. To change a rating, change the review decisions or the thresholds and regenerate.

### 6. Summarize for the user

Reply with:

- The overall risk rating and a one-line reason.
- Each principle's rating, in a sentence or a compact list.
- The top 3 to 5 risks, naming the specific types and what to do about them.
- How many findings you dismissed and any threshold tuning you'd suggest, e.g. a criterion that produced mostly false positives in this codebase.
- The path to `SOLID-RISK-PROFILE.md`.

Mention that `.solid-analysis/` can be added to `.gitignore` if they don't want it committed.

## Re-running after changes

If the user changes thresholds or code and asks for a fresh profile, rerun step 2. Stable `id`s carry over, so decisions in an old `solid-review.json` that use `id`s still apply to the same type and criterion; decisions that use `label`s do not. Drop entries whose ids no longer appear, since the script rejects unknown ids.

If the repo keeps a technical debt register (`.tech-debt/items/*.json`, each with `id`, `status`, and `severity`), pass `--register <repo>/.tech-debt`. Findings the register marks `accepted` or `dismissed` get `carried_forward: true` unless their severity has risen, and don't need review. The report excludes carried-forward dismissals from the ratings.