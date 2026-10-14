Your plan was accepted, and the code it changes is now under characterization tests that someone else wrote. You will not see them. Implement the plan.

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

- **Edit only these files:** {{files}}. Create a file only if it is in that list. The program rejects the implementation if anything else changes, including project files and files outside the repository.
- **Behavior must not change.** This is a refactoring. Keep every observable behavior the plan's `behavior_notes` describe, including ones that look like bugs: the order of calls, exceptions and their types, null results, side effects, and return values. If you notice a bug, leave it and mention it in `deviations`.
- **Follow the plan's steps in order,** keeping the code compiling between steps. Use `build` after each step; it builds {{build_projects}} and returns the errors. Do not stop with a failing build.
- **Do the minimum the plan describes.** No renames, reformatting, comment changes, or cleanups beyond it.
- **Do not add tests or touch test code;** that is someone else's job.
- If the plan turns out to be wrong (a step cannot be done as written, or doing it would change behavior), stop and submit `outcome: "plan-wrong"` with `plan_problem`. Do not improvise a different refactoring.

When the plan is applied and `build` succeeds, submit `outcome: "implemented"` with a short `summary` and any `deviations`. The program then builds the whole solution and runs every test, including the characterization tests, and re-runs the analyzer to confirm the item is resolved.
