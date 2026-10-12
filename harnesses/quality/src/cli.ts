import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseSet } from "./config.ts";
import { repoRoot } from "./git.ts";
import { resume, run, type RunOptions } from "./orchestrator.ts";
import { renderTechDebt } from "./register/render.ts";
import { loadItems, saveItem } from "./register/store.ts";
import type { ItemStatus, Manifest, RegisterItem } from "./types.ts";
import { HarnessError, now, readJson, writeText } from "./util.ts";

const USAGE = `Usage:
  npm run quality -- run --repo <path> [--no-push] [--keep-worktrees] [--verbose] [--set key=value ...]
  npm run quality -- resume <run-id> --repo <path> [same options]
  npm run quality -- claim <item-id> --repo <path> --agent <name> --branch <branch>
  npm run quality -- mark-fixed <item-id> --repo <path> --commit <sha>
  npm run quality -- accept <item-id> --repo <path> --reason <text>

--set overrides any config value, e.g. --set debate.max_rounds=1 --set models.doubter=composer-2.5`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" }, "no-push": { type: "boolean" }, "keep-worktrees": { type: "boolean" }, verbose: { type: "boolean" },
      set: { type: "string", multiple: true }, agent: { type: "string" }, branch: { type: "string" }, commit: { type: "string" },
      reason: { type: "string" }, help: { type: "boolean" },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) { console.log(USAGE); return command ? 0 : 1; }
  if (!values.repo) throw new HarnessError(`--repo is required.\n${USAGE}`);

  const opts: RunOptions = {
    repo: path.resolve(values.repo), overrides: parseSet(values.set ?? []), push: !values["no-push"],
    verbose: !!values.verbose, keepWorktrees: !!values["keep-worktrees"],
  };
  switch (command) {
    case "run": await run(opts); return 0;
    case "resume":
      if (!arg) throw new HarnessError("resume needs a run id.");
      await resume(arg, opts);
      return 0;
    case "claim": case "mark-fixed": case "accept":
      if (!arg) throw new HarnessError(`${command} needs an item id.`);
      changeItem(command, arg, opts.repo, values);
      return 0;
    default:
      throw new HarnessError(`Unknown command '${command}'.\n${USAGE}`);
  }
}

// The only way the fix phase (or a person) changes item status between analysis runs.
function changeItem(command: "claim" | "mark-fixed" | "accept", id: string, repo: string, values: Record<string, unknown>): void {
  const root = repoRoot(repo);
  const registerDir = path.join(root, ".tech-debt");
  const items = loadItems(registerDir);
  const item = items.get(id);
  if (!item) throw new HarnessError(`No register item '${id}' in ${registerDir}.`);
  const need = (key: string) => {
    const v = values[key];
    if (typeof v !== "string" || !v) throw new HarnessError(`${command} needs --${key}.`);
    return v;
  };
  const transition = (allowed: ItemStatus[], to: ItemStatus, note: string) => {
    if (!allowed.includes(item.status)) throw new HarnessError(`${id} is '${item.status}'; ${command} needs one of: ${allowed.join(", ")}.`);
    item.history.push({ at: now(), change: command, from: item.status, to, note });
    item.status = to;
  };
  if (command === "claim") {
    const agent = need("agent"), branch = need("branch");
    transition(["open", "reopened"], "in-progress", `Claimed by ${agent} on ${branch}`);
    item.claim = { agent, branch, at: now() };
  } else if (command === "mark-fixed") {
    const commit = need("commit");
    transition(["in-progress"], "fixed-pending-verification", `Fix in ${commit}`);
    item.fix = { commit, at: now() };
  } else {
    const reason = need("reason");
    transition(["open", "reopened"], "accepted", reason);
    item.reason = reason;
  }
  saveItem(registerDir, item);
  writeText(path.join(registerDir, "TECH-DEBT.md"), renderTechDebt([...items.values()] as RegisterItem[], latestRun(registerDir)));
  console.log(`${id}: ${item.status}. Commit .tech-debt/ to record the change.`);
}

function latestRun(registerDir: string): { runId?: string; commit?: string; ratings?: Record<string, string> } {
  const runsDir = path.join(registerDir, "runs");
  if (!fs.existsSync(runsDir)) return {};
  const manifests = fs.readdirSync(runsDir).flatMap((a) =>
    fs.readdirSync(path.join(runsDir, a)).map((r) => path.join(runsDir, a, r, "manifest.json"))).filter((f) => fs.existsSync(f)).sort();
  if (manifests.length === 0) return {};
  const m = readJson<Manifest>(manifests[manifests.length - 1]);
  return { runId: m.run_id, commit: m.commit, ratings: m.ratings };
}

main().then((code) => process.exit(code), (e) => {
  if (e instanceof HarnessError) {
    console.error(`ERROR: ${e.message}`);
    process.exit(e.exitCode);
  }
  console.error(e);
  process.exit(1);
});
