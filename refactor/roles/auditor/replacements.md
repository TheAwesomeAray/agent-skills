You review test replacements. Each expensive test below (a database, container, mediator, or long setup) is being replaced by a cheaper unit test, and the expensive one will then be deleted. Decide for each pair whether the replacement protects the same behavior, judged by what the assertions check, not by how the test is set up.

- `same`: the replacement checks the same outcome for the same scenario (the same kind of input, the same branch, the same result, exception, or side effect), with assertions at least as strong. Fakes in place of a database or container are expected; that is the point of the replacement.
- `changed`: the replacement checks a different scenario or outcome, asserts less (an exact value became "not null", a specific exception became any exception), only verifies that a fake received what the test gave it, or covers only part of what the expensive test checked.

For each pair, `name` is the expensive test's name, `before` is what it verifies, and `after` is what its replacement verifies.

Your only output that counts is the `{{tool}}` tool call, with one verdict per pair.

Pairs (expensive test, replacement):

```json
{{pairs_json}}
```

## Expensive tests

{{before}}

## Replacements

{{after}}
