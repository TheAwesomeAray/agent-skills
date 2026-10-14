# Quality harness, refactor phase: the tester

Status: iteration 2 (implementation) in progress. Everything about tests in the refactor phase lives here: the tester's role, the test standards, the gates that accept or reject its tests, and the test auditor. The refactor phase design ([refactor-phase.md](refactor-phase.md)) treats the tester as a black box with one input and one output (section 1) and says nothing else about tests. The planner and the implementer never see this document, the tests, or anything derived from them except plain-language behavior names when a regression is found.

Prompt: `roles/tester/characterize.md`. Gates: `src/refactor/gates.ts`. Auditor prompts: `roles/auditor/names.md` (per test), `roles/coverage-reviewer/coverage.md` (per submission), and `roles/reviewer/relevance.md` (after the change, section 8). Each prompt's schema is the `.json` file of the same name beside it. Gates paths are under `harness/`.

**Scope is the change, not the code.** A test belongs only if a realistic mistake in carrying out the plan would make it fail. Logic the plan does not touch cannot be broken by it, so it is not tested, however central it is. This is checked twice: before the change, against the plan (sections 3.6 and 5), and after it, against the actual diff (section 8).

## 1. Contract with the refactor phase

| | |
|---|---|
| Input | The register item and the accepted plan (`plan.json`). Never the implementation |
| Output | Either tests that passed every gate (section 4), declared in `tests.json` with a coverage map and a risk assessment (section 3.7), or an escalation with a proposed complexity level and the reason |
| After acceptance | Test files are immutable. Verification copies them unchanged onto the refactored code and runs them; every one must still pass. A test that cannot survive a correct refactoring is useless and is not written |
| Risk | At or above `refactor.approval_risk`, a person approves before the implementer changes any code. A `proposed_complexity` above the item's rating raises it, and above the limit the item is escalated |
| On regression | The refactor phase tells the implementer the `behavior` text of each failing test, never the test name, code, or output |
| Boundary | The tester changes test code only. Production code, project files, and package references are always off limits |

## 2. The tester (Opus, one durable agent per item)

Specialty: getting legacy code under test without changing it, after *Working Effectively with Legacy Code*. Characterization tests, sensing and separation, seams, test points at the most stable boundary.

- Receives the plan, never the implementation, and the vocabulary entries for the plan's refactorings, each with its "Can break" notes. Chooses the test points itself from what the plan's steps could break.
- May create new files inside the configured test projects (`write_test_file`). May change an existing test file only when that test is a target of the refactor (section 7). May never edit production code, project files, or package references.
- Runs tests only through `run_tests`, which builds and runs a test project against the current production code.
- Writes tests that pass on the current code and that the plan's change should not break (section 3).
- Escalates instead of forcing it: if the change points cannot be tested without production changes, or the only stable boundary is one the plan changes, it submits `escalate` with a proposed complexity and the reason.

## 3. Test standards

These are rules the tester's prompt states and, where possible, the gates enforce.

### 3.1 What a test is for

1. **Every test catches a mistake this change could realistically make.** Each test is declared in `tests.json` with the behavior it pins, the mistake in which plan step it catches (`protects`), and why a regression there would matter. A test that would still pass if the plan were carried out wrongly, failing only when logic the plan leaves alone changes, is out of scope and is not written.
2. **A useless test is worse than no test.** It costs maintenance and gives false confidence. Rejected outright:
   - tests with no assertion, or whose only assertion is that no exception was thrown (unless that is the documented behavior);
   - tests that assert what the setup just arranged (tautologies) or only verify that a mock was called with what the test told it;
   - tests of the language, the framework, or trivial getters and setters;
   - duplicates of an existing test's behavior;
   - tests that reach private members through reflection.
3. **Coverage is a map, not a target.** It may be used to find change points that no test reaches. It is never reported as a success measure, and no test is written to raise it.

### 3.2 Characterization first

Following Feathers, tests for legacy code describe what the code *does*, not what someone thinks it should do. The tester writes the test, runs it against current code, and records the observed result. If the observed behavior looks like a bug, the test still pins it, is marked `characterizes_suspected_bug`, and the item notes it for a person. A refactoring must not fix bugs silently.

### 3.3 Scope: unit tests first

Tests that need a database, the container, or the mediator to reach a behavior are slow, and they break for reasons unrelated to that behavior. So:

1. **Unit tests by default:** the class or method being changed, with fakes only for dependencies it already receives. No database context, dependency injection container, mediator pipeline, or web host.
2. **At most one wiring test per item** (`wiring: true`), for breakages only the composition root shows: a missing registration, the wrong implementation behind an abstraction, or a lifetime that no longer shares the request's state (for example its database context). It builds the real container the way the application does, with the database swapped for the in-memory provider, resolves the entry point in a request scope, makes the smallest call that goes through the changed dependency, and asserts an outcome only the expected implementation sharing that scope's state produces, such as a change visible through the scope's own database context. It does not walk the handler's other paths. Reflection into private fields is rejected, so it proves the wiring through what the code does. For a "replace `new` with an injected interface" change, it is usually the only test needed. For a local change that unit tests fully reach, it is not written.
3. **Every test survives the refactoring.** A test that will not compile or will fail after a correct refactoring proves nothing about it, so it is not written: the gates reject any test that calls a constructor in the plan's change points, and verification runs the accepted files unchanged on the refactored code.
4. **Expensive but valid tests are allowed, flagged `needs_refactor`.** Legacy code under refactoring often has no seam: it creates its dependencies with `new` or reads infrastructure directly, which is usually the debt being fixed. A larger test (in-memory database, container, mediator) can still reach the behavior through a boundary the plan leaves alone and pass on both versions. Such a test serves the refactoring now but is a maintenance burden, so it carries the missing seam (`reason`) and the cheaper test that should replace it once the seam exists (`after_refactor`), and is rewritten after implementation (section 7, case C). Every integration test other than the wiring test must be flagged.
5. **Otherwise, the gap is recorded.** A behavior no surviving test can reach is marked not covered, and the risk assessment (3.7) reflects it.

### 3.4 Robust to the planned change

- **Test at the most stable boundary the plan leaves untouched:** the public members of the type being changed, or its callers when the type's own surface changes. Not the private methods the refactoring will move.
- **Assert outcomes, not interactions.** Prefer return values and state over mock verification. Verify a mock only where the interaction *is* the behavior (an email was sent, a record was saved).
- **No assumptions about structure the plan changes:** constructor shape, field names, call order between collaborators.
- **No red step:** a refactoring has no new behavior, so instead of "fails first" a test must be "green on the old code, proven able to go red" (the sabotage gate). Tests for units the plan will create are not written in iteration 1.
- **If robust tests are not possible**, the tester escalates and the complexity rises. Fragile tests are not an acceptable workaround.
- **Follow the repo's conventions:** its existing framework, assertion and mocking libraries, naming pattern, and project layout. No new packages (the tester cannot edit project files, so a new package fails the build gate).

### 3.5 Scope for iteration 1

Unit tests and in-process integration tests only. No UI, browser, HTTP-hosted, performance, or contract tests, and no health-check endpoints.

### 3.6 Sufficient coverage: what the change could break

The aim is the smallest set of tests that would catch a mistake in carrying out the plan. Before writing tests, the tester maps what the change could break and submits the map as `coverage`:

- **Breakages:** for each plan step, the vocabulary entry's "Can break" notes applied to this code: each realistic mistake, what a caller would observe, and the step it would come from (`steps[i]`). Mistakes the code makes impossible, and mistakes the build catches (a caller left on an old constructor), are left out. At least one is required. Each is covered by a test or given a `not_covered` reason.
- **Plan points:** one entry for every element of the plan's `change_points` and `risks`, mapped to tests or given a `not_covered` reason.
- **Every test is mapped** to at least one breakage or plan point; a test that catches nothing on the map is dropped.

Main scenarios are deliberately not on the map. The comparison runs of 2026-10-13 show why: for three "replace `new` with an injected interface" items, both model configurations wrote three or four tests each of calculations, PDF attachments, toggling, and null handling, none of which the change could affect, while the real risks (registration, implementation, shared database context) got one test at most, and only by accident. Before that, dry run 3 failed the other way, with no test through the container the plan rewired. A breakage map catches both: the wiring breakages must be listed and covered, and tests of untouched logic have nothing to map to.

### 3.7 Risk assessment and approval

Some items cannot be fully protected by tests that survive the refactoring: the seam the refactoring creates is exactly what a unit test would need. The tester does not hide that; it rates what it leaves behind in `risk`:

- `low`: every breakage and plan point is covered.
- `medium`: there are gaps, but a reviewer of the diff would likely catch a regression in them.
- `high`: an uncovered breakage would likely reach production.

It lists every gap in `uncovered`, explains the rating in `reasoning`, and may set `proposed_complexity` when the item is harder to protect than its rating suggests. The gates check consistency: every uncovered entry in the map must appear in the list, and the rating cannot be `low` while a breakage is uncovered. The coverage reviewer checks honesty, with a `risk-understated` finding when the rating claims more protection than the tests give.

At or above `refactor.approval_risk` (default `medium`), the run pauses before implementation. It writes `approval-request.json` beside the item's outputs (goal, risk, tests, gaps) and waits up to `refactor.approval_timeout_minutes` for `approval.json` with `{"approved": true}` or `{"approved": false, "note": "..."}`. No answer leaves the item `awaiting-approval`; a refusal records it as `declined`.

## 4. Gates (code)

`submit_tests` runs every gate before accepting. The first failing stage returns its problems to the tester, which fixes them and submits again.

| Gate | Rule |
|---|---|
| Static checks | Name format; the file was written by the tester; namespace, class, and method exist; `[Fact]` or `[Theory]` present; an assertion from the repo's libraries present; sabotage targets production code and its find text occurs exactly once |
| Scope | At most one test is `wiring`, and only an integration test. Every other integration test carries `needs_refactor`. Unit and integration tests live in separate files, and files with unit tests may not use a database context, container, mediator pipeline, or web host (static scan) |
| Survives the refactoring | No test file calls a constructor of a type whose constructor is in the plan's change points (static scan). After implementation, verification runs the files unchanged on the new code |
| Risk consistent | `risk` lists every uncovered map entry and is not `low` while a breakage is uncovered |
| Isolated | Unit tests: no network, file system, clock, environment, or database access, no sleeps, unseeded `Random`, or reflection (static scan for known APIs, and the auditor). Integration tests: in-process only, with in-memory or local test doubles for external systems |
| Builds | Test projects compile with no warnings in the new test files |
| Green on old code | Every new test passes on the base commit |
| Deterministic | New tests run `determinism_runs` times (default 3); any variation rejects the test |
| Proven able to fail | For each test, the tester supplies a small "sabotage" find-and-replace on production code that breaks the protected behavior. The orchestrator applies it, the test must fail, then the original file is restored. A test that still passes under its own sabotage protects nothing and is rejected. So is a test whose only failures are unrelated exceptions (for example a `NullReferenceException`) rather than an assertion: that shows the test runs the code, not that it checks the result. The test auditor then gets each sabotage patch and the failure it caused, and marks a mismatch when the patch does not break the declared behavior or when a different assertion caught it. This is the cheapest strong evidence that a test protects something |
| Coverage map complete | `coverage` lists at least one breakage, each naming a step the plan has; every breakage, plan change point, and risk has an entry with tests or a `not_covered` reason; every name refers to a declared test; every test is mapped (static check, section 3.6) |
| Name matches body | The test auditor's verdict for every test is `match` |
| Coverage sufficient | The coverage reviewer's verdict is `sufficient` |

## 5. Test auditor (cheap model)

**Per test file (one-shot each).** Reads each new test and answers, per test: what behavior does the body actually verify, and does the name and declared behavior say the same thing? Also rejects tests with no meaningful assertion, tautologies, and mock-only verification, and a `wiring` test that fakes the injected dependency, checks an error or edge case, or exercises several paths. Mismatches go back to the tester as gate errors. Cheap, narrow, and independent of the tester; a fresh agent for every file.

**Coverage review (one-shot per submission, last gate).** A fresh agent with the plan, the "Can break" notes for its refactorings, the tests, the coverage map, and read access to the code. It judges whether the tests are the right safety net for this change: every realistic breakage covered or honestly rated, and nothing beyond. Its findings come in five kinds:
- `missing-breakage`: a realistic way a step could break behavior that the map leaves out or leaves untested without a valid reason, such as a dependency change with no wiring test.
- `out-of-scope`: a test that guards logic no mistake in the plan's steps could change; it should be dropped.
- `mapping-wrong`: a test mapped to a breakage it would not catch.
- `reason-rejected`: a `not_covered` reason that does not hold ("hard to set up" does not hold).
- `risk-understated`: the risk rating or its `uncovered` list claims more protection than the tests give.

It asks for the wiring test when a step changes how a dependency is supplied, and does not ask for one when the change is local. Findings go back to the tester as gate errors. It reviews claims against code that it reads itself, rather than offering an open-ended opinion, which keeps it from repeating the tester's blind spots.

## 6. Configuration

| Key | Meaning |
|---|---|
| `refactor.test_projects` | Test projects the tester may add files to and the baseline runs |
| `refactor.test_dirs` | Every folder holding test code; hidden from the planner, the implementer, and the screener |
| `refactor.max_tests_per_item` | Upper bound on tests per item (default 10) |
| `refactor.determinism_runs` | Runs per new test for the determinism gate (default 3) |
| `refactor.approval_risk` | Tester risk at or above this level pauses for approval (default `medium`) |
| `refactor.approval_timeout_minutes` | How long the run waits for `approval.json` (default 240) |
| `models.tester`, `models.auditor` | Opus and a cheap model by default |

## 7. Changing existing tests

Status: cases A, B, and C are built. None has run against a real item yet.

**Rule.** The tester may change an existing test file only when that test is a target of the refactor, in one of the cases below. Never for any other reason: not to clean up, restyle, fix flakiness, raise coverage, or improve a test it happens to read. Code computes the files each case allows; a change to any other existing file rejects the submission, the same way a production change does.

### Case A: the refactoring breaks an existing test

The plan changes something an existing test uses (for example a constructor the test calls), so the test must be updated to keep protecting the same behavior.

- **Trigger:** verification finds compile errors in existing test code. A runtime failure of an existing test is not case A: it means the refactoring changed behavior, and goes back to the implementer as a regression.
- **Allowed files:** existing test files (tracked under `refactor.test_dirs`) that mention a type in the plan's `change_points`, computed by code. If a broken file is outside that set, or is one of the tester's own characterization tests (which must run unchanged), the item stops as `tests-need-adapting`.
- **When:** after implementation, as its own step, in the verify work tree (`roles/test-maintainer/adapt.md`). The tester reads the refactored code and edits with `build` and `run_tests` tools. The updated test has to compile against the refactored code, so it cannot be green on the old code like a characterization test.
- **Same behavior, adapted call** (checked by code before the reviewer runs): no file outside the allowed set changes; the test methods in each adapted file are the same set, with the same names; and every test's assertion lines are identical before and after. The test projects must build. Then the test-change reviewer (as in case B) compares the old and new body of every test in the adapted files and returns `changed` if what one verifies changed.
- **Must pass** on the refactored code. Verification runs again with the adapted files. If an adapted test fails, the implementer is told the behavior in plain words, as for any regression; it never sees the tests. If a test cannot be adapted without changing what it checks, the tester escalates and the item is `escalated` with its complexity raised.
- **Kept across attempts.** Each verification attempt starts from a clean work tree, so adaptations are stored and re-applied. If a later implementation attempt breaks more tests, the tester adapts again, always compared against the original version.
- **Records:** the adapted files under `adapted/` in the item's outputs, `verify-N-adapted.json`, and `adapted` (files, summary, reviewer verdicts) in the manifest. The PR lists the adapted files.

### Case C: tests flagged `needs_refactor`

The tester's own larger tests from this item (section 3.3). They pass before and after the refactoring; they are rewritten not because they fail, but because they are expensive to run or maintain (a database, the container, long setup), and the refactoring has created the seam a cheaper test needs.

- **When:** after implementation and verification pass, before the PR, in the verified work tree (the refactored code plus the accepted tests). The tester now reads the refactored production code: the point is to use the seam it created.
- **What:** for each flagged test, the tester writes one cheaper **unit** test in a new file (`roles/test-maintainer/replace.md`), or answers `not_possible` with an updated reason. Replacements pass the usual gates on the refactored code: static checks, build without warnings, green, determinism, sabotage, and the name audit. There is no coverage map or risk rating; the original submission carried those.
- **Comparison review:** the comparison reviewer (`roles/auditor/replacements.md`, auditor model) reads each flagged test and its replacement and returns `same` or `changed`. Fakes in place of a database are expected; a different scenario, outcome, or weaker assertion is `changed`, and the tester must fix it or answer `not_possible`.
- **Then:** the program removes each replaced test method from its file (a file left with no tests is deleted) and runs the affected test projects again. Every test that passed at baseline must pass, and every remaining tester test and replacement must run. If that fails, the removals and replacements are rolled back.
- **Never blocks the item.** If the step fails at any point, the flagged tests stay, `replace_note` says why, and the PR proceeds with them listed under "Tests still to rewrite".
- **Allowed files:** new files in the test projects. The program, not the tester, edits the flagged tests' files, and only to delete the replaced methods.
- **Records:** `replacements.json`, `replace-gates.json`, and the replacement files under `replacements/` in the item's outputs. `replaced` and the remaining `needs_refactor` go in the manifest and the outcomes log, and the PR lists each replacement.

### Case B: the register item is in test code

The register item's file is under `refactor.test_dirs`, so the test code is what gets refactored.

- **Where items come from:** the SOLID analyzer skips test projects by default, and its criteria misfire on tests (tests create objects on purpose, fixtures run long). Test-code items are added by hand, or later by a test-smell analysis with its own criteria. Case B takes any register item whose file is test code.
- **Who:** the tester does the refactoring, because the planner and the implementer have no access to test code. It plans with the same plan schema, rubric, vocabulary, and complexity gate as the planner (`roles/tester/test-code-plan.md`), in a full work tree, read-only. Screening uses a full work tree for these items too.
- **Allowed files:** the plan's `files`, all of which must be under `refactor.test_dirs` (shared helper projects such as `TestHelpers` included). Production code, project files, and package references are off limits; the implement step rejects any other change.
- **Renames:** the plan lists every test method whose fully qualified name changes in `renames`. A name change that is not listed counts as a removed test plus an added one.
- **No characterization tests.** Production code does not change, so pinning its behavior adds nothing; the existing tests are what must be preserved.
- **Implement:** the tester edits the plan's files with `build` and `run_tests` tools (`roles/implementer/test-code-implement.md`), up to `implement_attempts` times. On a failed verification it gets the full failure detail, since it can read the tests.
- **Verify** (in a clean work tree with the diff applied):
  1. Scope: only the plan's files changed.
  2. Inventory: the `[Fact]`/`[Theory]` methods in the plan's files are the same set before and after, with renames applied. None removed, none added.
  3. Every test that passed at baseline, in every test project, still runs and passes under its (possibly renamed) name. No new failures.
  4. A reviewer (the auditor model, `roles/auditor/test-changes.md`) compares the old and new version of every test in the plan's files. It also checks the tests in other test files that use a changed type, since an edited helper can change what an untouched test verifies. Each test is `same` or `changed`; any `changed` fails verification.
- **Assertion count is evidence, not a gate.** The count across the plan's files before and after goes to the reviewer and the PR. A hard "count must not drop" rule would reject a legitimate refactoring: extracting an assertion helper that three tests share turns three assertions into one.
- **No sabotage.** The sabotage gate proves a new test can fail. Moved or restructured tests already proved that; what needs proving is that they still check the same thing, which steps 2 to 4 do.
- **Propose:** same as production items: branch, commit only the plan's files, push to the sandbox origin, PR with the plan, renames, and verification.

## 8. After the change: relevance check

Before the change, the tester and the coverage reviewer can only judge scope against the plan. Once verification passes and case C has run, the real diff exists, so every test the pull request would add is checked against it.

- **Who:** a fresh agent on the reviewer model (`roles/reviewer/relevance.md`, step `relevance`), with the plan, the "Can break" notes, the production diff (the plan's files only), the final tests and their files, and read access to the refactored code.
- **The question, per test:** does this test meaningfully check something that could have broken because of this code change? A test is `relevant` only if a realistic mistake in a line the diff adds or removes would make it fail. A fake standing in for the changed dependency hides the change from the test, and mistakes the build catches do not count.
- **Grounded in the diff:** a `relevant` verdict must quote a line the diff adds or removes (`changed_line`, checked by code) and describe the mistake in it that the test would catch (`mistake`). A verdict that cannot do both is rejected and sent back.
- **Then:** the program removes every `irrelevant` test method from its file (a file left with no tests is deleted) and runs the affected test projects; every baseline-passing test must pass and every kept test must run, or all removals are rolled back. Helpers that only removed tests used stay in the file.
- **Never blocks the item.** If the check or the removal fails, every test stays and `relevance_note` says why. If every test is ruled irrelevant, the pull request carries none, and says so.
- **Records:** `relevance.json` in the item's outputs; `pruned` (name and reason) and `relevance_note` in the manifest. The final reviewer is told which tests were removed, and the PR lists them, with reasons, under "Removed after the change".
