A refactoring is done and verified: everything builds, and every test passes on the new code. Tests were written before it to catch mistakes in carrying it out. Now that the actual change exists, you decide which of those tests belong in the pull request. For each test, answer one question:

**Does this test meaningfully check something that could have broken because of this code change?**

A test belongs only if a realistic mistake in a line the diff adds or removes would make it fail. A test that would pass no matter how those lines were written guards code the change did not touch; it is `irrelevant`, however valuable that code is. For example, if the diff only changes how a handler gets its repository, a mistake there shows up as the handler not being created, getting the wrong implementation, or not sharing the request's database context. A test of the handler's calculations, filtering, or error paths, run with a fake repository, passes whichever way the constructor was written, so it is `irrelevant`. A test that resolves the handler from the real container and checks an effect through the real repository is `relevant`.

The refactored repository is checked out at `{{worktree}}`. Read whatever you need around the diff, such as the composition root (dependency injection registrations) or the implementation behind an abstraction. Your only output that counts is the `{{tool}}` tool call, with one verdict per test.

The plan:

```json
{{plan_json}}
```

The refactorings the plan's steps use, each with the ways a mistake in applying it changes behavior:

{{refactorings}}

The production diff against the base commit:

```diff
{{diff}}
```

The tests:

```json
{{tests_json}}
```

{{files}}

## How to decide

1. For each test, read its body. Work out what it drives (which entry point, real or fake collaborators) and what its assertions check.
2. Look for a line in the diff that the test depends on: if that line were written wrong in a realistic way (the wrong type registered, a parameter not stored, the wrong instance passed, a call dropped), would one of the test's assertions fail?
3. If yes, the test is `relevant`. Copy that line exactly into `changed_line`, and describe the mistake and why the test would catch it in `mistake`.
4. If no such line exists, the test is `irrelevant`. Mistakes the build would catch (a caller left on an old constructor) do not count: the build already guards them, not the test. Neither does "the test exercises the changed class": a fake replacing the changed dependency hides the change from the test.

Judge each test on its own; several tests can be relevant, and so can none. Your `reason` goes into the pull request, so write it for a developer reviewing the change.
