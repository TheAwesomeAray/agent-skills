import path from "node:path";
import { analyze, report, reportErrors } from "../analyzer.ts";
import type { RunContext } from "../context.ts";
import { Decisions } from "../decisions.ts";
import { addedFindingId } from "../ids.ts";
import { json, prompt, skillReferences } from "../prompts.ts";
import { loadItems } from "../register/store.ts";
import type { Metrics, RegisterItem, Review } from "../types.ts";
import { readJson, writeJson } from "../util.ts";
import { checkEvidence } from "../validate.ts";

export async function analyzeStep(ctx: RunContext): Promise<void> {
  analyze(ctx);
}

export async function carryForwardStep(ctx: RunContext): Promise<void> {
  const metrics = readJson<Metrics>(ctx.file("metrics.json"));
  const carried = metrics.findings.filter((f) => f.carried_forward).map((f) => ({ id: f.id, status: f.register_status, severity: f.severity, type: f.type, criterion: f.criterion }));
  writeJson(ctx.file("carry-forward.json"), { schema_version: 1, carried, to_review: metrics.findings.length - carried.length });
  ctx.log(`${carried.length} finding(s) carried forward from the register; ${metrics.findings.length - carried.length} to review.`);
}

const ACTIVE_STATUSES = ["open", "in-progress", "fixed-pending-verification", "reopened", "accepted"];

/** Review-added register items the analyst must re-verify, since no metric tracks them. */
export function itemsToRecheck(ctx: RunContext): RegisterItem[] {
  return [...loadItems(ctx.paths.registerDir).values()].filter((i) => i.source === "review" && ACTIVE_STATUSES.includes(i.status));
}

export async function reviewStep(ctx: RunContext): Promise<void> {
  const metrics = readJson<Metrics>(ctx.file("metrics.json"));
  const carried = metrics.findings.filter((f) => f.carried_forward);
  const recheck = itemsToRecheck(ctx);
  const root = ctx.paths.analysisDir;
  const refs = skillReferences(ctx);
  const tool = "submit_review";

  const message = prompt(ctx, "analyst-review", tool, {
    metrics_path: ctx.file("metrics.json").replace(/\\/g, "/"),
    finding_count: metrics.findings.length,
    types_analyzed: metrics.stats.types_analyzed,
    carried: carried.length === 0 ? "none." : "\n\n```json\n" + json(carried.map((f) => f.id)) + "\n```",
    register_checks: recheck.length === 0 ? "none." : "\n\n```json\n" + json(recheck.map((i) => ({ id: i.id, title: i.title, type: i.type, file: i.file, details: i.details }))) + "\n```",
    skill: refs.skill,
    criteria: refs.criteria,
  });

  const analyst = await ctx.agent("analyst");
  const review = await analyst.turn<Review>("review", message, {
    tool,
    description: "Submit your complete review: executive_summary, reviewed decisions, added findings, recommendations, and register_checks.",
    schema: "review",
    check: (r) => checkReview(ctx, metrics, r, recheck, root),
  });
  writeJson(ctx.file("review.json"), normalize(ctx, metrics, review));
}

function checkReview(ctx: RunContext, metrics: Metrics, review: Review, recheck: RegisterItem[], root: string): string[] {
  const decisions = new Decisions(metrics, { ...review, reviewed: [], added: [] }, ctx.prefix);
  const errors: string[] = [];
  const seen = new Set<string>();
  review.reviewed.forEach((r, i) => {
    const where = `reviewed[${i}] (${r.id})`;
    const id = decisions.resolve(r.id);
    if (!id) { errors.push(`${where}: unknown finding id.`); return; }
    if (decisions.carried.has(id)) errors.push(`${where}: carried forward from the register; remove it.`);
    if (seen.has(id)) errors.push(`${where}: reviewed more than once.`);
    seen.add(id);
    if (r.action === "adjust" && !r.severity) errors.push(`${where}: 'adjust' needs 'severity'.`);
    if (r.action !== "keep" && !r.reason?.trim()) errors.push(`${where}: '${r.action}' needs a 'reason'.`);
    errors.push(...checkEvidence(root, r.evidence, where));
  });
  review.added.forEach((a, i) => {
    const where = `added[${i}]`;
    errors.push(...checkEvidence(root, [{ file: a.file, line: a.line }], where));
    errors.push(...checkEvidence(root, a.evidence, where));
  });
  (review.out_of_scope ?? []).forEach((o, i) => {
    const where = `out_of_scope[${i}]`;
    errors.push(...checkEvidence(root, [{ file: o.file, line: o.line }], where));
    errors.push(...checkEvidence(root, o.evidence, where));
  });
  const required = new Set(recheck.map((i) => i.id));
  for (const c of review.register_checks ?? []) {
    if (!required.delete(c.id)) errors.push(`register_checks: '${c.id}' was not listed for re-verification (or is listed twice).`);
    errors.push(...checkEvidence(root, c.evidence, `register_checks (${c.id})`));
  }
  for (const id of required) errors.push(`register_checks: missing an entry for '${id}'.`);
  if (errors.length > 0) return errors;

  // The analyzer's own validator is the final word on the review format.
  const draft = path.join(ctx.paths.scratchDir, "review-draft.json");
  writeJson(draft, normalize(ctx, metrics, review));
  const result = report(ctx, draft, path.join(ctx.paths.scratchDir, "review-draft.md"));
  return result.code === 0 ? [] : reportErrors(result);
}

/** Labels become stable ids and every added finding gets its id, so later files never depend on this run's labels. */
function normalize(ctx: RunContext, metrics: Metrics, review: Review): Review & { schema_version: number } {
  const decisions = new Decisions(metrics, { ...review, reviewed: [], added: [] }, ctx.prefix);
  return {
    schema_version: 1,
    ...review,
    reviewed: review.reviewed.map((r) => ({ ...r, id: decisions.resolve(r.id) ?? r.id, ...(r.related ? { related: r.related.map((x) => decisions.resolve(x) ?? x) } : {}) })),
    added: review.added.map((a) => ({ ...a, id: a.id ?? addedFindingId(ctx.prefix, a.principle, a.type, a.title), ...(a.related ? { related: a.related.map((x) => decisions.resolve(x) ?? x) } : {}) })),
  };
}
