## Complexity rubric

| Level | Meaning | Typical examples |
|---|---|---|
| 1 Trivial | One type. No signature change visible outside it, or only a constructor change whose only caller is dependency injection or the framework. The abstraction already exists and is registered | Inject an existing registered interface instead of `new`; replace `DateTime.Now` with an existing clock abstraction |
| 2 Simple | One type plus its composition root, or a split inside one file. Callers are few and mechanical | Extract Function or a small private Extract Class; register an existing implementation |
| 3 Moderate | A new abstraction, or several types in one project | Extract Interface on a concrete dependency and inject it into its consumers |
| 4 Complex | Crosses projects, changes a widely used interface, needs dependency-breaking before the code can be exercised in isolation, or touches persistence mapping | Interface consumers in several projects; EF model changes |
| 5 Major | Reshapes a design across many types | Replace Conditional with Polymorphism across a duplicated switch |

The program also computes a minimum level from a plan: more than one file (2), a file in another project (3), a new type (3), a change that reaches files outside the plan's files, found by searching the whole repository rather than from your list of callers (3, or 4 above a threshold), existing tests that use what the plan changes (2), persistence code, async code paths, threading, or static mutable state (4). The effective level is the higher of the agent's rating and that minimum.
