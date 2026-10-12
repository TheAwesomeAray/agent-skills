# Debate round {{round}}: answer the doubter

The doubter challenged {{count}} of your decisions. Answer every challenge through `submit_responses`, one response per `challenge_id`.

- Your current decisions (after earlier rounds): `{{decisions_path}}`
- Earlier rounds: {{history}}

## How to respond

- `concede`: the doubter is right. Its `proposed_outcome` is applied as written.
- `revise`: the doubter has a point, but a different change is right (e.g. lower the severity one level instead of dismissing). Put the change in `revised_outcome`, which has the same shape as `proposed_outcome`, and say what changed in `argument`.
- `defend`: your decision stands. Explain why in `argument` and cite evidence you have not cited for this finding before (at least one new file and line). A defense that repeats earlier citations is treated as a concession.

Defended challenges may go to an independent judge who reads the code and both arguments. Concede when the doubter is right; the goal is an accurate review, not winning.

## Challenges

```json
{{challenges_json}}
```
