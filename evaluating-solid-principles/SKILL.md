---
name: evaluating-solid-principles
description: Produces a quick SOLID risk profile for a C# / .NET repository (Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion) with Low/Medium/High/Critical ratings per principle and overall, against configurable thresholds. Use when the user wants a one-off SOLID assessment, design health report, or threshold tuning for a .NET repo, without a technical debt register or refactoring. For the full multi-agent process (debated findings, a register, and refactoring PRs), use the refactor skill instead.
---

# Evaluating SOLID principles

This is the quick, single-agent use of the SOLID lens that lives in the `refactor` skill. Nothing here writes a technical debt register, opens PRs, or changes code.

Read `../refactor/lenses/solid/LENS.md` and follow its whole workflow, steps 1 to 6. In that guide, `<lens-dir>` is `../refactor/lenses/solid` relative to this file: the analyzer script, the default thresholds, and `references/criteria.md` are all there.

If the user wants findings tracked over time, debated by several agents, or fixed, switch to `../refactor/SKILL.md`.
