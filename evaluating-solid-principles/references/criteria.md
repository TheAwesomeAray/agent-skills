# SOLID criteria: review guide

How to judge each metric finding, which false positives to dismiss, and what to look for that the metrics cannot see.

## Contents
- Severity rubric (for adjusted and added findings)
- SRP: class_lines, public_methods, constructor_dependencies, lcom, judgment checks
- OCP: max_switch_arms, type_checks, else_if_chain, judgment checks
- LSP: not_implemented_overrides, hidden_members, empty_overrides, judgment checks
- ISP: interface_members, not_implemented_interface_members, judgment checks
- DIP: concrete_instantiations, concrete_constructor_dependencies, hard_coded_infrastructure, judgment checks

---

## Severity rubric

Use this when adjusting a metric finding or assigning severity to a finding you add. Severity is about *risk to change and correctness*, not style.

| Severity | Meaning |
|---|---|
| Critical | Actively causes or will cause defects, or blocks change in a central part of the system: a god class every feature touches, a subtype that throws on a base-class call the code really makes, business logic welded to infrastructure in a core flow. |
| High | A clear violation in code that changes often or sits on an important path. Fixing it later will cost noticeably more than fixing it now. |
| Medium | A real violation with limited blast radius: a peripheral class, a stable area, or a pattern that hurts testability more than correctness. |
| Low | A smell worth knowing about. Acceptable in context, or cheap to fix when the code is next touched. |

Adjust a metric finding by one level when context clearly warrants it (how central the type is, how often it changes, whether the violation is actually exercised). Move more than one level only with concrete evidence, and say what it is in the reason.

---

## SRP: Single Responsibility

**class_lines.** Size is a proxy for responsibility count. Confirm by naming the distinct reasons the class would change (e.g. "pricing rules", "PDF layout", "email delivery"). Two or more unrelated reasons means keep.
- Dismiss or lower: generated-looking code the exclude globs missed, large but cohesive algorithms (a parser, a state machine), lookup tables or mapping profiles that are long but trivially simple.

**public_methods.** A wide surface often means several roles in one type.
- Dismiss or lower: fluent builders, facades whose stated purpose is aggregation, extension-method holders, controllers whose actions all serve one resource.

**constructor_dependencies.** Many collaborators usually means many responsibilities. Only parameters typed as interfaces or repo services count; data parameters (ids, strings, DTOs, value objects) do not.
- Dismiss or lower: `ILogger<T>`, `IOptions<T>`, and similar plumbing inflate the count. Recount without them; if the remainder is under the medium threshold, lower or dismiss. MediatR-style handlers with many dependencies are still a real signal.

**lcom.** 1.0 means no field is shared by two methods: the class is several classes sharing a name. Group methods by the fields they touch; each group is a candidate class. Use those groups in the recommendation. State includes fields, auto-properties that some method uses, and primary constructor parameters; a method that reads a computed property is credited with the state behind it.
- Dismiss or lower: classes whose fields are all used through one private helper (the metric only sees direct references), stateless "service" classes whose single dependency is used once per method, and domain entities whose methods are small per-property mutators (`Rename`, `ChangeAddress`) guarding one invariant each.

**Judgment checks** (add findings when you see these in hotspots):
- Mixed abstraction levels in one class: business rules next to SQL, HTTP, or file formatting.
- "Manager", "Helper", "Utils", "Common" classes that collect unrelated operations.
- Methods that change for different stakeholders (e.g. one for finance rules, one for UI formatting).

## OCP: Open/Closed

**max_switch_arms.** Ask: does a new variant (product type, payment method, status) require editing this switch? If yes, and the same switch logic appears in more than one place, keep or raise.
- Dismiss or lower: a single switch at a boundary that maps external input to internal types (a parser or factory is the right place for it), switches over a closed set that will not grow (days of week, HTTP verbs), and generated mapping code.

**type_checks.** Branching on concrete types is the textbook OCP violation when the types are your own domain types.
- Dismiss or lower: type checks in serializers, exception filters (`catch` + `is`), framework adapters, `IEquatable`/`Equals`-style code, and pattern matching over closed discriminated hierarchies (sealed records with a fixed set of cases). Note that `as` followed by a null check is often just a safe cast.

**else_if_chain.** Same question as switches: does adding a case mean editing this chain?
- Dismiss or lower: validation sequences where each branch checks a different condition rather than a different variant of the same thing.

**Judgment checks:**
- The same switch over a type code or enum duplicated in several classes (shotgun surgery on every new variant).
- Behavior selected by string or enum flags passed through several layers.
- Classes that must be edited (not extended) to add a new rule, format, or provider.

## LSP: Liskov Substitution

**not_implemented_overrides.** The subtype refuses part of the base contract. Check whether callers invoke that member through the base type. If they do, keep or raise to High/Critical; this is a runtime failure waiting to happen.
- Dismiss or lower: framework conventions where the base type documents optional members (`Stream.Seek` when `CanSeek` is false, `ICollection.Add` on read-only collections that report `IsReadOnly`), and test doubles that slipped past the exclude globs.

**hidden_members.** `new` makes behavior depend on the static type of the reference.
- Dismiss or lower: covariant-return workarounds that delegate to the base member and return a narrower type, when the behavior is identical.

**empty_overrides.** Check what the base implementation does. If the base does real work that callers rely on and the override silently drops it, keep or raise.
- Dismiss: the base member is itself empty or documented as an optional hook, or the override is `Dispose(bool)` in a type with nothing to dispose.

**Judgment checks:**
- Overrides that strengthen preconditions (throw `ArgumentException` for inputs the base accepts) or weaken postconditions (return null where the base never does).
- Subtypes that callers have to special-case with `is` checks (cross-reference OCP type_checks findings that test for subtypes of the same base).
- Square/Rectangle-style hierarchies where a setter on the subtype breaks an invariant the base promises.

## ISP: Interface Segregation

**interface_members.** Check how many members typical implementers and callers actually use. If most callers use a small slice, keep and recommend role interfaces split along those slices.
- Dismiss or lower: interfaces mirroring a cohesive external API (a repository over one aggregate, a typed HTTP client), and interfaces with a single implementation used as one whole unit.

**not_implemented_interface_members.** Direct evidence the interface is too broad for this implementer. Usually keep; recommend the split that would let this implementer drop the members.
- Dismiss or lower: the same framework conventions as LSP above (read-only collections and similar).

**Judgment checks:**
- Clients that depend on a wide interface but call one or two members (look at constructor parameters of hotspot classes).
- "Marker plus everything" interfaces like `IService` or `IManager` that many unrelated classes implement.

## DIP: Dependency Inversion

**concrete_instantiations.** A class creating its own collaborators cannot be tested or reconfigured without editing it.
- Dismiss or lower: value objects and DTOs the heuristic misclassified as services (rename-worthy, but not a DIP problem), creation inside a type that is effectively a factory or composition root despite its name, and `new` of a private nested helper.

**concrete_constructor_dependencies.** High-level code depending on concrete low-level classes.
- Dismiss or lower: dependencies on concrete classes that are themselves pure logic with no I/O (a calculator, a mapper). DIP matters most at I/O and policy boundaries.

**hard_coded_infrastructure.** Direct clock, file system, environment, console, or connection access.
- Dismiss or lower: the code *is* the infrastructure adapter (a `FileSystemStore` calling `File.*` is fine), CLI entry points writing to the console, and logging-setup code. Keep or raise when business logic reads `DateTime.Now` or touches the file system directly, since that logic becomes untestable.

**Judgment checks:**
- Domain or application projects referencing infrastructure packages (EF Core, HTTP clients, cloud SDKs) directly. Check the `.csproj` references of core projects.
- Static service locators (`ServiceLocator.Get<T>()`, `IServiceProvider` injected into business classes and resolved at runtime).
- Abstractions owned by the low-level module rather than the consumer (the interface sits next to its single implementation in the infrastructure project).
