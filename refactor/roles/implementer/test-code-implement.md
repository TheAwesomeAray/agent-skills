Your plan was accepted. Implement it.

The repository is checked out at `{{worktree}}`. A program, not a person, orchestrates this work. Your only output that counts is the `{{tool}}` tool call.

The technical debt item:

```json
{{item_json}}
```

Your plan:

```json
{{plan_json}}
```

## Rules

- **Edit only these files:** {{files}}. Create a file only if it is in that list. The program rejects the implementation if anything else changes, including production code, project files, and package references.
- **Every test keeps checking exactly what it checks today.** Same inputs, same scenario, assertions at least as strong. Do not remove, add, skip, or weaken a test. Rename or move a test only as the plan's `renames` declares.
- **Follow the plan's steps in order,** keeping the code compiling between steps. `build` builds {{build_projects}} and returns the errors; `run_tests` runs tests so you can confirm they still pass. Do not stop with a failing build or a test that passed before and fails now.
- **Do the minimum the plan describes.** No reformatting, comment changes, or cleanups beyond it.
- If the plan turns out to be wrong (a step cannot be done as written, or doing it would change what a test verifies), stop and submit `outcome: "plan-wrong"` with `plan_problem`. Do not improvise a different refactoring.

When the plan is applied and `build` succeeds, submit `outcome: "implemented"` with a short `summary` and any `deviations`. The program then builds everything, runs every test project, checks that the same tests exist under their declared names and pass, and has a reviewer compare the old and new body of every test in your files.
