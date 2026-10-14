## Refactoring vocabulary

Every plan step names one refactoring from this list, spelled exactly as in bold. Each is behavior-preserving when applied as described. **Can break** lists the realistic ways a mistake in applying it changes behavior; those, and only those, are what tests for a step need to catch. Sources: Fowler, *Refactoring* (2nd ed.), and Feathers, *Working Effectively with Legacy Code*.

### Composing and moving code (Fowler)

- **Extract Function**: move a fragment into a new private method and call it. Safe when the fragment's inputs become parameters and its outputs a return value. Can break: an input or output the fragment used is dropped or passed wrong; a local the rest of the method reads is no longer updated; an early return or exception inside the fragment no longer exits the caller.
- **Inline Function**: replace calls to a trivial method with its body. Safe when the method is not overridden and has no other callers. Can break: an override is bypassed; an argument expression with side effects is evaluated a different number of times.
- **Extract Variable**: name a subexpression. Safe when the expression has no side effects. Can break: the expression is evaluated earlier or once instead of each time, when its inputs change in between.
- **Inline Variable**: replace a variable with its expression. Safe when the expression has no side effects and is evaluated once. Can break: the expression is now evaluated several times or later, after its inputs changed.
- **Replace Temp with Query**: turn a local computed from fields into a method. Safe when the computation has no side effects. Can break: the query is evaluated after the fields it reads changed, so it returns a different value than the temp held.
- **Slide Statements**: move statements together. Safe only when they do not depend on or affect each other. Can break: a statement now reads state before or after another statement changes it.
- **Split Phase**: separate one computation into two sequential stages with a data structure between them. Can break: a value the second stage needs is not carried in the intermediate structure; the stages run in a different order relative to side effects.
- **Move Function**: move a method to the type whose data it uses. Callers change; behavior does not. Can break: a caller still calls the old location or an overload that behaves differently; the moved method reads the wrong instance's data.
- **Move Field**: move a field to the type that uses it most. Can break: a writer or reader still uses the old field; a value that was shared by instances is now per instance, or the reverse.
- **Extract Class**: move a cohesive group of fields and methods into a new class the original delegates to. Can break: a delegated call is missing or wired to the wrong member; state that both parts used is now duplicated and diverges; the new instance is shared or recreated when it was not before.
- **Inline Class**: fold a class that no longer does enough back into its user. Can break: an instance that several users shared is now duplicated per user.
- **Hide Delegate**: add a method that forwards to a collaborator, so callers stop reaching through. Can break: the forwarding method calls a different member or passes different arguments than callers did.
- **Encapsulate Variable**: route access to a field or global through a property or method. Can break: a direct access is missed; the accessor adds a side effect, copy, or default the field did not have.
- **Introduce Parameter Object**: replace a group of parameters that travel together with one type. Can break: values are swapped or dropped when packing or unpacking; a caller that mutated a parameter no longer affects the callee, or the reverse.
- **Change Function Declaration**: rename a method or change its parameters, updating every caller. Can break: a caller passes arguments in the wrong order or relies on a new default; a reflection, serialization, or framework binding still uses the old name.
- **Rename Field**: rename a field or property, updating every use. Can break: serialization, data binding, an ORM mapping, or a view still uses the old name.
- **Replace Magic Literal**: replace a literal with a named constant. Can break: the constant's value differs from one of the literals it replaced.
- **Replace Constructor with Factory Function**: route construction through a factory method. Can break: the factory initializes differently, or returns a shared instance where callers expected a new one.
- **Replace Conditional with Polymorphism**: move each branch of a type-switch into an override on the matching subtype. Can break: a case lands on the wrong subtype or falls to the default; the order in which conditions were checked mattered.
- **Replace Type Code with Subclasses**: replace an enum that selects behavior with subtypes. Can break: a stored or serialized type code no longer maps to the right subtype; a branch still reads the code.
- **Pull Up Method**: move identical methods from subtypes to their base type. Can break: the methods were not quite identical, so one subtype changes behavior; a subtype's override is hidden.
- **Push Down Method**: move a method used by one subtype from the base type into it. Can break: another caller, through the base type, still used it.
- **Extract Superclass**: move shared members of two classes into a new base class. Can break: members that differed slightly are merged; construction order or initialization of the shared members changes.

### Breaking dependencies (Feathers)

- **Parameterize Constructor**: pass a dependency into the constructor instead of creating it inside. Callers (or the dependency injection container) supply it. Can break: the container has no registration for the parameter's type, so the class cannot be created; the container supplies a different implementation than the one the class used to create; the dependency's lifetime changes, so it no longer shares state the class relied on (for example, the request's database context or unit of work); a caller that constructs the class directly passes the wrong instance.
- **Parameterize Method**: pass a dependency into a method instead of creating it inside. Can break: a caller passes a different implementation or a shared instance where a fresh one was created.
- **Extract Interface**: create an interface from the members a consumer uses, implement it on the concrete class, and depend on the interface. Can break: the interface leaves out a member the consumer needs, or the consumer now calls a different overload or explicit implementation; whatever supplies the interface supplies a different implementation.
- **Extract and Override Factory Method**: move creation of a dependency into a protected virtual method. Can break: the factory runs at a different time, or is called during construction before fields it reads are set.
- **Extract and Override Call**: move a call to a hard dependency into a protected virtual method. Can break: arguments or the return value are passed through differently.
- **Introduce Instance Delegator**: add instance methods that forward to static methods, so callers can depend on an instance. Can break: a forwarder calls a different static method or overload.
- **Adapt Parameter**: wrap a hard-to-use parameter type behind a narrow interface. Can break: the adapter maps a member to the wrong underlying member, or drops one the code needed.
- **Break Out Method Object**: move a long method into a new class whose fields are its locals and parameters. Can break: a local is not initialized or copied back; the object is reused across calls and carries state over.
- **Encapsulate Global References**: gather references to globals or statics into a class that can be passed in. Can break: code that wrote the global now writes a copy, so other readers stop seeing the change.
- **Replace Global Reference with Getter**: route each use of a global through a virtual getter. Can break: a use is missed, or the getter returns a cached value where the global changed.
- **Push Down Dependency**: move code that touches a problem dependency into a subclass, leaving the base class free of it. Can break: code that created the base class directly no longer gets the dependency behavior.

### Composition root

- **Register Existing Implementation**: add a dependency injection registration for an implementation and abstraction that already exist. No other code changes. Can break: the wrong implementation is registered; the lifetime differs from what consumers need (a singleton holding a request-scoped database context); an earlier registration of the same abstraction is overridden.
