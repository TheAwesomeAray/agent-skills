# Subagent briefs

Each role's task is its prompt in `../refactor/roles/`. Don't restate it. Every brief stands alone and carries:

- The prompt's absolute path, and this instruction: "Read it as your task. Each `{{name}}` placeholder is filled by the value below with that name. The `{{tool}}` call means writing your JSON to the output path below. It must validate against the `.json` file beside the prompt. `build`, `run_tests`, and `write_test_file` are your own shell and file tools."
- The checkout to work in, and what it may change. "Read-only" means it changes no file outside the output path. A blind role also gets: "Read only inside this path. Don't run git commands that print other commits or branches."
- File pointers for the item, the plan, and the other inputs. Don't inline them.
- What to report back: the output path and one line of status.

| Role | Prompt | Checkout | May change |
|---|---|---|---|
| Analyst | `analyst/review.md`, then `analyst/respond.md` per round | Detached at base | Nothing |
| Doubter | `doubter/challenge.md` | Detached at base | Nothing |
| Matcher | `matcher/match.md` | None | Nothing |
| Screener | `screener/screen.md` | Blind at base | Nothing |
| Planner | `planner/plan.md` | Blind at base | Nothing |
| Tester | `tester/characterize.md` | Item branch | New files in the test projects |
| Coverage reviewer | `coverage-reviewer/coverage.md` and `auditor/names.md` | Item branch | Nothing |
| Implementer | `implementer/implement.md` | Blind at base | The plan's files |
| Test adapter | `test-maintainer/adapt.md` | Item branch | Existing test files that use a changed type |
| Pruner | `reviewer/relevance.md` | Item branch | Nothing |

Fill placeholders by pointing at files, not pasting them:

- `{{rubric}}` is `../refactor/roles/shared/complexity-rubric.md`, `{{vocabulary}}` is `../refactor/roles/shared/refactoring-vocabulary.md`, and `{{refactorings}}` is the vocabulary entries the plan's steps name.
- `{{skill}}` is the lens guide, `{{criteria}}` the lens's `references/criteria.md`, and `{{shared_rules}}` is `../refactor/roles/shared/analysis-rules.md`.
- `{{decisions_path}}` is the current `review.json`. `{{round_instructions}}` is "challenge any decision" in round 1, and the list of defended challenges after it. `{{references_json}}` is "search the work tree for whole-word uses of each type in the plan's change points".
- Any other name ending in `_json` or `_path`, and `{{diff}}`, `{{errors}}`, `{{file}}`, `{{files}}`, and `{{history}}`, point at the file the run already wrote or the item's own field.
- Limits (`{{complexity_limit}}`, `{{max_rounds}}`, `{{max_challenges}}`, `{{max_tests}}`, `{{material_severity}}`, `{{determinism_runs}}`) come from `../refactor/harness/harness.config.json` unless the user set them.
- Anything else is a fact you already hold, such as counts from the metrics file or the build projects. State it.

The doubter gets the analyst's review and never its reasoning. The implementer's retry brief names the behavior that broke and never quotes a test. Where a prompt says "the program checks" something no `quality.cs` gate covers, such as the one-wiring-test limit or no database in a unit test, the coverage reviewer checks it. The final review is the **interrogate** skill, not a brief here.
