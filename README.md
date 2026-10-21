# Skills

A library of agent skills for Cursor and Claude. Each folder is a self-contained skill with a `SKILL.md` describing when it triggers and how it works.

## Skills

| Skill | Description |
|---|---|
| [benchmark](benchmark/SKILL.md) | Benchmarks multi-agent systems for cost, time, and quality. Finds seams between agents and stages to test separately, runs them and the end-to-end workflow across configurations, and writes a Markdown report in a per-system standard format (`.benchmark/standard.json`), committed through a pull request. Requires Node 18+ and the GitHub CLI. |
| [refactor](refactor/SKILL.md) | Behavior-preserving technical debt reduction with a multi-agent harness on the [Cursor SDK](https://cursor.com/docs/sdk/typescript). The find phase analyzes the code through a lens (SOLID for C# today) with an analyst, a doubter, and a judge, and proposes a technical debt register as a pull request. The fix phase resolves register items one at a time: characterization tests first, then a planned refactoring, verification, review, and a pull request per item. Requires Node 24, the .NET 10 SDK, the GitHub CLI, and `CURSOR_API_KEY`. |
| [quality-pstack](quality-pstack/SKILL.md) | The `refactor` skill's goals as a [pstack](https://github.com/cursor/plugins/tree/main/pstack) playbook: the agent runs the roles as Cursor subagents instead of an SDK program, and `scripts/quality.cs` makes every decision that needs no judgment (register reconciliation, status changes, blind worktrees, sabotage, determinism, and file scope). Install it alongside `refactor` and pstack. Requires the .NET 10 SDK and the GitHub CLI. |
| [evaluating-solid-principles](evaluating-solid-principles/SKILL.md) | A quick SOLID risk profile for a C# / .NET repository (Low/Medium/High/Critical per principle and overall), using the `refactor` skill's SOLID lens with no register or code changes. Install it alongside `refactor`. Requires the .NET 10 SDK. |

## Installing a skill

Copy the skill's folder into your personal skills directory:

- Cursor: `~/.cursor/skills/<skill-name>/`
- Claude Code: `~/.claude/skills/<skill-name>/`

Or into a project's `.cursor/skills/` folder to share it with everyone working in that repo.
