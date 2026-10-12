# Skills

A library of agent skills for Cursor and Claude. Each folder is a self-contained skill with a `SKILL.md` describing when it triggers and how it works.

## Skills

| Skill | Description |
|---|---|
| [evaluating-solid-principles](evaluating-solid-principles/SKILL.md) | Evaluates a C# / .NET repository for SOLID violations against configurable per-criterion thresholds and produces a Markdown risk profile (Low/Medium/High/Critical per principle and overall). Requires the .NET 10 SDK. |

## Harnesses

Programs that run skills with several cooperating agents through the [Cursor SDK](https://cursor.com/docs/sdk/typescript).

| Harness | Description |
|---|---|
| [solid-loop](harnesses/solid-loop/DESIGN.md) | Runs `evaluating-solid-principles` with an analyst agent, a doubter agent that challenges its review, and a judge for unresolved disputes. Records the result in a technical debt register committed to the target repo and proposes it as a pull request. Requires Node 24, the .NET 10 SDK, the GitHub CLI, and `CURSOR_API_KEY`. |

## Installing a skill

Copy the skill's folder into your personal skills directory:

- Cursor: `~/.cursor/skills/<skill-name>/`
- Claude Code: `~/.claude/skills/<skill-name>/`

Or into a project's `.cursor/skills/` folder to share it with everyone working in that repo.
