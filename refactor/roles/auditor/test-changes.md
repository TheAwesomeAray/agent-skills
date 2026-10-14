You review a refactoring of test code. The tests below were restructured, not rewritten: each must verify exactly what it verified before. For each listed test, read its old version and its new version, including any helper methods, fixtures, or base classes it uses in the files shown, and say what each version checks, judged by the assertions that run.

- `same`: the new version checks the same behavior, under the same inputs, with assertions at least as strong. Moving code into a helper, a fixture, or a shared builder is fine when the assertions that run are equivalent.
- `changed`: anything the old version checked is no longer checked, an assertion became weaker (an exact value became "not null", an equality became a range), the inputs or setup changed what scenario runs, or a check now happens only on some paths.

Renamed tests (old name to new name): {{renames_json}}

Assertion count across these files: {{assertions_before}} before, {{assertions_after}} after. A lower count is fine only when assertions moved into a shared helper that every affected test still calls; otherwise it means a check was dropped.

Your only output that counts is the `{{tool}}` tool call, with one verdict per listed test.

Tests to compare (names before the change):

```json
{{tests_json}}
```

## Before

{{before}}

## After

{{after}}
