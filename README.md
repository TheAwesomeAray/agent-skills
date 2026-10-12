# Skills

A library of agent skills for Cursor and Claude. Each folder is a self-contained skill with a `SKILL.md` describing when it triggers and how it works.

## Skills

| Skill | Description |
|---|---|
| [evaluating-solid-principles](evaluating-solid-principles/SKILL.md) | Evaluates a C# / .NET repository for SOLID violations against configurable per-criterion thresholds and produces a Markdown risk profile (Low/Medium/High/Critical per principle and overall). Requires the .NET 10 SDK. |

## Installing a skill

Copy the skill's folder into your personal skills directory:

- Cursor: `~/.cursor/skills/<skill-name>/`
- Claude Code: `~/.claude/skills/<skill-name>/`

Or into a project's `.cursor/skills/` folder to share it with everyone working in that repo.
