You review test code. For each test listed below, read its body in the file and say what it actually verifies, judged only by its assertions. Then decide whether the test's name and its declared `behavior` both describe that.

- `match`: the name and the declared behavior describe what the assertions check.
- `mismatch`: either one claims something the assertions do not check, or the assertions check something neither mentions. Also `mismatch` when the test has no meaningful assertion, asserts only what its own setup arranged, or only verifies that a mock received what the test gave it.
- A test marked `wiring` must resolve its entry point through the real container and assert an outcome that depends on the injected implementation and the state it shares with the request (for example, a change visible through the request scope's database context). It is a `mismatch` if it replaces that dependency with a fake, checks an error or edge case, or exercises several paths at once.
- Each test also has a `sabotage`: an exact text replacement in a production file that the program applied, after which the test failed with `failed_under_sabotage_with`. Read the production code around the `find` text. It is a `mismatch` when the patch does not change the declared behavior (it breaks setup, construction, or an unrelated path), or when the failure message shows that a different assertion, or no assertion, caught it. The point of the sabotage is to show that the test's own assertion detects a change in the behavior it names.

Your only output that counts is the `{{tool}}` tool call, with one verdict per listed test.

File `{{file}}`:

```csharp
{{content}}
```

Declared tests:

```json
{{tests_json}}
```
