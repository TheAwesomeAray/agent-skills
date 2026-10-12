import fs from "node:fs";
import path from "node:path";
import { parseRatings, report, reportErrors } from "../analyzer.ts";
import type { RunContext } from "../context.ts";
import { replay } from "../debate.ts";
import { git, gitTry } from "../git.ts";
import { json, prompt } from "../prompts.ts";
import { reconcile, type RegisterChange } from "../register/reconcile.ts";
import { renderTechDebt } from "../register/render.ts";
import { loadItems, saveItem } from "../register/store.ts";
import type { AddedFinding, Matches, Metrics, Review, Summary, Verdicts } from "../types.ts";
import { HarnessError, readJson, sevRank, writeJson, writeText } from "../util.ts";

export async function assembleStep(ctx: RunContext): Promise<void> {
  const state = replay(ctx);
  const decisionsPath = path.join(ctx.paths.scratchDir, "final-decisions.json");
  writeJson(decisionsPath, state.decisions.snapshot());
  const judged = fs.existsSync(ctx.file("verdicts.json"));

  const analyst = await ctx.agent("analyst");
  const summary = await analyst.turn<Summary>("assemble", prompt(ctx, "analyst-summary", "submit_summary", {
    decisions_path: decisionsPath.replace(/\\/g, "/"),
    verdict_note: judged ? `, including the judge's rulings in \`${ctx.file("verdicts.json").replace(/\\/g, "/")}\`` : "",
  }), {
    tool: "submit_summary",
    description: "Submit the final executive summary and prioritized recommendations.",
    schema: "summary",
    check: () => [],
  });
  state.decisions.summary = summary;

  const finalReview = { schema_version: 1, ...state.decisions.toReview() };
  writeJson(ctx.file("final-review.json"), finalReview);
  const result = report(ctx, ctx.file("final-review.json"), ctx.file("SOLID-RISK-PROFILE.md"));
  if (result.code !== 0) throw new HarnessError(`The assembled review was rejected by the analyzer:\n- ${reportErrors(result).join("\n- ")}`, 2);
  ctx.manifest.ratings = parseRatings(result.stdout);
  ctx.log(result.stdout.split(/\r?\n/).find((l) => l.startsWith("Overall risk")) ?? "Report written.");
}

export async function reconcileStep(ctx: RunContext): Promise<void> {
  const metrics = readJson<Metrics>(ctx.file("metrics.json"));
  const review = readJson<Review>(ctx.file("final-review.json"));
  const items = loadItems(ctx.paths.registerDir);
  const matches = await matchAdded(ctx, review.added as (AddedFinding & { id: string })[], items);

  const { changes, items: updated } = reconcile({
    analysis: ctx.config.analysis, runId: ctx.runId, commit: ctx.manifest.commit, metrics, review, matches, items,
    includesCommit: (sha) => gitTry(ctx.manifest.repo_root, "merge-base", "--is-ancestor", sha, ctx.manifest.commit) !== undefined,
  });
  for (const item of updated.values()) saveItem(ctx.paths.registerDir, item);
  writeJson(ctx.file("register-changes.json"), { schema_version: 1, run_id: ctx.runId, matches: Object.fromEntries(matches), changes });
  writeText(path.join(ctx.paths.registerDir, "TECH-DEBT.md"),
    renderTechDebt([...updated.values()], { runId: ctx.runId, commit: ctx.manifest.commit, ratings: ctx.manifest.ratings, changes }));
  const tally = (k: string) => changes.filter((c) => c.change === k).length;
  ctx.log(`Register: ${tally("add")} added, ${tally("update")} updated, ${tally("propose-resolved")} resolved, ${tally("reopen")} reopened, ${tally("carry")} carried.`);
}

const MATCHABLE = ["open", "accepted", "in-progress", "fixed-pending-verification", "reopened"];

/** Review-added findings have no fixed shape, so a cheap model decides whether each is an existing item reworded. */
async function matchAdded(ctx: RunContext, added: (AddedFinding & { id: string })[], items: Map<string, import("../types.ts").RegisterItem>): Promise<Map<string, string>> {
  const fresh = added.filter((a) => !items.has(a.id));
  const candidates = [...items.values()].filter((i) => i.source === "review" && MATCHABLE.includes(i.status));
  if (fresh.length === 0 || candidates.length === 0) return new Map();

  const matcher = await ctx.newAgent("matcher", ["mcp"]);
  try {
    const result = await matcher.turn<Matches>("reconcile", prompt(ctx, "matcher", "submit_matches", {
      findings_json: json(fresh.map((a) => ({ finding_id: a.id, principle: a.principle, title: a.title, type: a.type, file: a.file, details: a.details }))),
      items_json: json(candidates.map((i) => ({ id: i.id, principle: i.principle, title: i.title, type: i.type, file: i.file, details: i.details }))),
    }), {
      tool: "submit_matches",
      description: "Submit one match decision per new finding.",
      schema: "matches",
      check: (m) => {
        const errors: string[] = [];
        const ids = new Set(fresh.map((a) => a.id));
        const allowed = new Set(candidates.map((i) => i.id));
        const used = new Set<string>();
        for (const x of m.matches) {
          if (!ids.delete(x.finding_id)) errors.push(`'${x.finding_id}' is not a new finding or is listed twice.`);
          if (x.match !== "new" && !allowed.has(x.match)) errors.push(`'${x.match}' is not an existing item id.`);
          if (x.match !== "new" && used.has(x.match)) errors.push(`'${x.match}' is matched more than once.`);
          used.add(x.match);
        }
        for (const id of ids) errors.push(`Missing a decision for '${id}'.`);
        return errors;
      },
    });
    return new Map(result.matches.filter((x) => x.match !== "new").map((x) => [x.finding_id, x.match]));
  } finally {
    await matcher.dispose();
  }
}

export async function proposeStep(ctx: RunContext, push: boolean): Promise<void> {
  const dir = ctx.paths.branchDir;
  const step = ctx.step("propose");
  step.status = "done";
  step.finished_at = new Date().toISOString();
  ctx.manifest.status = push ? "proposed" : "completed";
  ctx.saveManifest();
  git(dir, "add", ".tech-debt");
  if (gitTry(dir, "diff", "--cached", "--quiet") === undefined)
    git(dir, "commit", "-m", `${ctx.config.analysis.toUpperCase()} analysis run ${ctx.runId}`, "-m", `Analyzed commit ${ctx.manifest.commit} on ${ctx.manifest.base_branch}.`);
  if (!push) {
    ctx.log(`Committed on branch ${ctx.manifest.branch}; not pushed (--no-push).`);
    return;
  }
  ctx.host.push(dir, ctx.config.git.remote, ctx.manifest.branch);
  ctx.manifest.pr = ctx.host.createPullRequest(dir, {
    repo: ctx.manifest.repo,
    base: ctx.manifest.base_branch,
    head: ctx.manifest.branch,
    title: `${ctx.config.analysis.toUpperCase()} analysis ${ctx.runId}: ${ctx.manifest.ratings?.overall ?? "unrated"} risk`,
    body: prBody(ctx),
  });
  ctx.log(`Pull request: ${ctx.manifest.pr}`);
}

function prBody(ctx: RunContext): string {
  const changes = readJson<{ changes: RegisterChange[] }>(ctx.file("register-changes.json")).changes;
  const state = replay(ctx);
  const verdicts = fs.existsSync(ctx.file("verdicts.json")) ? readJson<Verdicts>(ctx.file("verdicts.json")).verdicts : [];
  const applied = state.rounds.flatMap((r) => r.applied);
  const tally = (k: string) => applied.filter((a) => a.effective === k).length;
  const runRel = path.relative(ctx.paths.branchDir, ctx.paths.runDir).replace(/\\/g, "/");
  const r = ctx.manifest.ratings ?? {};
  const out: string[] = [];
  const L = (s = "") => out.push(s);

  L(`Analysis of \`${ctx.manifest.commit.slice(0, 7)}\` on \`${ctx.manifest.base_branch}\`. Merging this PR approves the register changes; the execution loop only reads the base branch.`);
  L();
  L(`**Overall risk: ${(r.overall ?? "?").toUpperCase()}** (${["srp", "ocp", "lsp", "isp", "dip"].map((p) => `${p.toUpperCase()} ${r[p] ?? "?"}`).join(", ")})`);
  L();
  L("### Debate");
  L();
  L(`${state.rounds.length} round(s), ${applied.length} challenge(s): ${tally("concede")} conceded, ${tally("revise")} revised, ${tally("defend")} defended. ${verdicts.length} went to the judge.`);
  for (const v of verdicts) L(`- \`${v.challenge_id}\` **${v.ruling}** (${v.confidence} confidence): ${v.rationale.replace(/\r?\n/g, " ").slice(0, 300)}`);
  L();
  L("### Register changes");
  L();
  const count = (k: string) => changes.filter((c) => c.change === k).length;
  L(`${count("add")} added, ${count("update")} updated, ${count("propose-resolved")} resolved, ${count("reopen")} reopened, ${count("carry")} carried forward.`);
  const newOpen = changes.filter((c) => c.change === "add" && c.to === "open").sort((a, b) => sevRank(b.severity) - sevRank(a.severity)).slice(0, 25);
  if (newOpen.length > 0) {
    L();
    L("| New item | Severity | Type | Issue |");
    L("|---|---|---|---|");
    for (const c of newOpen) L(`| \`${c.id}\` | ${c.severity} | \`${c.type.split(".").pop()}\` | ${c.title} |`);
  }
  for (const k of ["propose-resolved", "reopen"] as const) {
    const list = changes.filter((c) => c.change === k);
    if (list.length > 0) { L(); L(`**${k === "reopen" ? "Reopened" : "Resolved"}:** ${list.map((c) => `\`${c.id}\``).join(", ")}`); }
  }
  L();
  L(`Full report: \`${runRel}/SOLID-RISK-PROFILE.md\`. Register: \`.tech-debt/TECH-DEBT.md\`.`);
  return out.join("\n");
}
