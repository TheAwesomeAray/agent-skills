// Recovers one item's plan and the tester's last submission (tests.json plus test files) from a refactor run's events.jsonl.
// Usage: node extract-tester-run.mjs --events <events.jsonl> --item <id> [--plan-out <file>] [--tests-out <dir>]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { events: { type: "string" }, item: { type: "string" }, "plan-out": { type: "string" }, "tests-out": { type: "string" } } });
if (!values.events || !values.item) throw new Error("--events and --item are required.");

const calls = [];
for (const line of fs.readFileSync(values.events, "utf8").split(/\r?\n/)) {
  if (!line) continue;
  const e = JSON.parse(line);
  const ev = e.event ?? {};
  if (ev.type !== "tool_call" || ev.status !== "completed") continue;
  calls.push({ at: e.at, role: e.role, agent: ev.agent_id, tool: ev.args?.toolName ?? ev.name, args: ev.args?.args ?? ev.args });
}

const plans = calls.filter((c) => c.tool === "submit_plan" && c.args?.item_id === values.item);
if (plans.length === 0) throw new Error(`No submit_plan for ${values.item}.`);
const plan = plans.at(-1);
if (values["plan-out"]) {
  fs.mkdirSync(path.dirname(values["plan-out"]), { recursive: true });
  fs.writeFileSync(values["plan-out"], JSON.stringify(plan.args, null, 2) + "\n");
  console.log(`plan: ${values["plan-out"]} (submitted ${plan.at})`);
}

if (values["tests-out"]) {
  // The item's tester is the first tester agent to act after its plan; items run one at a time.
  const tester = calls.find((c) => c.role === "tester" && c.at > plan.at)?.agent;
  if (!tester) throw new Error(`No tester ran after the plan for ${values.item}.`);
  const mine = calls.filter((c) => c.agent === tester);
  const submissions = mine.filter((c) => c.tool === "submit_tests");
  if (submissions.length === 0) throw new Error(`Tester ${tester} never submitted.`);
  const last = submissions.at(-1);
  fs.mkdirSync(values["tests-out"], { recursive: true });
  fs.writeFileSync(path.join(values["tests-out"], "tests.json"), JSON.stringify(last.args, null, 2) + "\n");
  const files = new Map();
  for (const c of mine) if (c.tool === "write_test_file" && c.at <= last.at) files.set(c.args.path, c.args.content);
  for (const [file, content] of files) {
    const out = path.join(values["tests-out"], "tests", file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, content);
  }
  console.log(`tests: ${submissions.length} submission(s) by ${tester}; last at ${last.at} with ${last.args.tests?.length ?? 0} test(s); files: ${[...files.keys()].join(", ")}`);
}
