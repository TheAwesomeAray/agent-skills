import path from "node:path";
import { parseArgs } from "node:util";
import { parseSet } from "./config.ts";
import { refactor } from "./refactor/run.ts";
import { repoRoot } from "./git.ts";
import { resume, run, type RunOptions } from "./orchestrator.ts";
import { loadItems } from "./register/store.ts";
import { accept, claim, markFixed, saveAndRender } from "./register/transitions.ts";
import { HarnessError } from "./util.ts";

const USAGE = `Usage:
  npm run quality -- run --repo <path> [--no-push] [--keep-worktrees] [--verbose] [--set key=value ...]
  npm run quality -- resume <run-id> --repo <path> [same options]
  npm run quality -- claim <item-id> --repo <path> --agent <name> --branch <branch>
  npm run quality -- mark-fixed <item-id> --repo <path> --commit <sha>
  npm run quality -- accept <item-id> --repo <path> --reason <text>
  npm run quality -- refactor --repo <path> --select [--items-ref <ref>] [--base <ref>] [--limit <n>] [--config <file>]
  npm run quality -- refactor --repo <path> [--dry-run | --no-push] [--items-ref <ref>] [--base <ref>] [--item <id>[,<id>...]] [--limit <n>] [--config <file>]
  npm run quality -- refactor --repo <path> --item <id> --plan <plan.json> [--dry-run | --no-push] [--config <file>]

--set overrides any config value, e.g. --set debate.max_rounds=1 --set models.doubter=composer-2.5
--config merges a JSON file over the config (after the target repo's .tech-debt/config.json)
refactor screens, plans, gates, and writes characterization tests for up to --limit items (default 1), pauses for approval when the tester's risk is at or above refactor.approval_risk, then implements, verifies, pushes a branch, and opens a PR
refactor --select stops after screening: it writes the ranked candidates to selection.json and prints an --item list to run next. No plans, tests, or code changes
refactor --item runs exactly the given items, in that order, without screening; repeat it or separate ids with commas
refactor --plan uses a saved plan.json for the one --item instead of running the planner (still checked against the code); for re-running later stages on a fixed plan
refactor --dry-run stops after the tests; production code is never changed. --no-push commits the refactoring on a local branch instead`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" }, "no-push": { type: "boolean" }, "keep-worktrees": { type: "boolean" }, verbose: { type: "boolean" },
      set: { type: "string", multiple: true }, agent: { type: "string" }, branch: { type: "string" }, commit: { type: "string" },
      reason: { type: "string" }, help: { type: "boolean" },
      "dry-run": { type: "boolean" }, "items-ref": { type: "string" }, base: { type: "string" }, item: { type: "string", multiple: true },
      limit: { type: "string" }, config: { type: "string" }, select: { type: "boolean" }, plan: { type: "string" },
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
    case "refactor": {
      const limit = Number(values.limit ?? 1);
      if (!Number.isInteger(limit) || limit < 1) throw new HarnessError("--limit must be a positive integer.");
      const items = [...new Set((values.item ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean))];
      if (values.select && items.length) throw new HarnessError("--select ranks the candidates; it cannot be combined with --item.");
      await refactor({
        repo: opts.repo, overrides: opts.overrides, configFile: values.config, itemsRef: values["items-ref"], base: values.base,
        items, limit, select: !!values.select, planFile: values.plan && path.resolve(values.plan), dryRun: !!values["dry-run"], push: opts.push, verbose: opts.verbose, keepWorktrees: opts.keepWorktrees,
      });
      return 0;
    }
    case "claim": case "mark-fixed": case "accept":
      if (!arg) throw new HarnessError(`${command} needs an item id.`);
      changeItem(command, arg, opts.repo, values);
      return 0;
    default:
      throw new HarnessError(`Unknown command '${command}'.\n${USAGE}`);
  }
}

function changeItem(command: "claim" | "mark-fixed" | "accept", id: string, repo: string, values: Record<string, unknown>): void {
  const registerDir = path.join(repoRoot(repo), ".tech-debt");
  const item = loadItems(registerDir).get(id);
  if (!item) throw new HarnessError(`No register item '${id}' in ${registerDir}.`);
  const need = (key: string) => {
    const v = values[key];
    if (typeof v !== "string" || !v) throw new HarnessError(`${command} needs --${key}.`);
    return v;
  };
  if (command === "claim") claim(item, need("agent"), need("branch"));
  else if (command === "mark-fixed") markFixed(item, need("commit"));
  else accept(item, need("reason"));
  saveAndRender(registerDir, item);
  console.log(`${id}: ${item.status}. Commit .tech-debt/ to record the change.`);
}

main().then((code) => process.exit(code), (e) => {
  if (e instanceof HarnessError) {
    console.error(`ERROR: ${e.message}`);
    process.exit(e.exitCode);
  }
  console.error(e);
  process.exit(1);
});
