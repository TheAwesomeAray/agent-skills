import type { AddedFinding, Evidence, ItemStatus, Metrics, RegisterItem, Review, Severity } from "../types.ts";
import { now } from "../util.ts";

export interface RegisterChange {
  id: string;
  change: "add" | "update" | "propose-resolved" | "reopen" | "carry";
  from?: ItemStatus;
  to: ItemStatus;
  severity: Severity;
  title: string;
  type: string;
  note?: string;
}

export interface ReconcileInput {
  analysis: string;
  runId: string;
  commit: string;
  metrics: Metrics;
  review: Review;
  /** Review-added finding id -> existing register item id, from the matcher. */
  matches: Map<string, string>;
  items: Map<string, RegisterItem>;
  /** True when the fix commit is part of the analyzed commit's history. */
  includesCommit: (sha: string) => boolean;
}

const ACTIVE: ItemStatus[] = ["open", "in-progress", "fixed-pending-verification", "reopened"];

interface Observation {
  id: string;
  source: "metric" | "review";
  dismissed: boolean;
  carried: boolean;
  fields: Pick<RegisterItem, "severity" | "principle" | "criterion" | "title" | "type" | "file" | "line" | "details"> &
    Partial<Pick<RegisterItem, "value" | "threshold" | "recommendation" | "reason" | "evidence">>;
}

// Applies the reconciliation rules in references/analysis.md section 7. Returns the plan and the updated items; writes nothing.
export function reconcile(input: ReconcileInput): { changes: RegisterChange[]; items: Map<string, RegisterItem> } {
  const at = now();
  const stamp = { run: input.runId, commit: input.commit };
  const items = new Map([...input.items].map(([id, item]) => [id, structuredClone(item)]));
  const changes: RegisterChange[] = [];
  const seen = new Set<string>();
  const reviewed = new Map(input.review.reviewed.map((r) => [r.id, r]));

  const observations: Observation[] = input.metrics.findings.map((f) => {
    const r = reviewed.get(f.id);
    return {
      id: f.id, source: "metric", dismissed: r?.action === "dismiss", carried: f.carried_forward === true,
      fields: {
        severity: r?.action === "adjust" && r.severity ? r.severity : f.severity,
        principle: f.principle, criterion: f.criterion, title: f.criterion, type: f.type, file: f.file, line: f.line,
        details: f.details, value: f.value, threshold: f.threshold,
        recommendation: r?.recommendation, reason: r?.reason, evidence: r?.evidence,
      },
    };
  });
  for (const a of input.review.added as (AddedFinding & { id: string })[]) {
    observations.push({
      id: input.matches.get(a.id) ?? a.id, source: "review", dismissed: false, carried: false,
      fields: {
        severity: a.severity, principle: a.principle, criterion: null, title: a.title, type: a.type, file: a.file,
        line: a.line ?? 0, details: a.details, recommendation: a.recommendation, evidence: a.evidence,
      },
    });
  }

  const record = (item: RegisterItem, change: RegisterChange["change"], from: ItemStatus | undefined, note?: string) => {
    if (change === "add" || from !== item.status)
      item.history.push({ at, run: input.runId, change, ...(from && from !== item.status ? { from, to: item.status } : {}), ...(note ? { note } : {}) });
    changes.push({ id: item.id, change, from, to: item.status, severity: item.severity, title: item.title, type: item.type, ...(note ? { note } : {}) });
  };

  for (const o of observations) {
    seen.add(o.id);
    const existing = items.get(o.id);
    if (!existing) {
      const item: RegisterItem = {
        schema_version: 1, id: o.id, analysis: input.analysis, source: o.source,
        status: o.dismissed ? "dismissed" : "open", ...o.fields, first_seen: stamp, last_seen: stamp, history: [],
      };
      items.set(o.id, item);
      record(item, "add", undefined);
      continue;
    }
    const from = existing.status;
    if (o.carried) {
      Object.assign(existing, { line: o.fields.line, file: o.fields.file, value: o.fields.value, details: o.fields.details, last_seen: stamp });
      record(existing, "carry", from);
      continue;
    }
    const defined = Object.fromEntries(Object.entries(o.fields).filter(([, v]) => v !== undefined));
    Object.assign(existing, defined, { last_seen: stamp });
    let change: RegisterChange["change"] = "update";
    let note: string | undefined;
    if (o.dismissed) existing.status = "dismissed";
    else if (from === "resolved") { existing.status = "reopened"; change = "reopen"; }
    else if (from === "accepted" || from === "dismissed") { existing.status = "open"; note = "Severity rose above the level it was settled at; review kept it."; }
    else if (from === "fixed-pending-verification" && existing.fix && (existing.fix.branch || input.includesCommit(existing.fix.commit))) {
      existing.status = "open";
      note = existing.fix.branch
        ? `Still present after the fix from ${existing.fix.branch} was merged.`
        : `Still present in code that includes fix commit ${existing.fix.commit.slice(0, 7)}.`;
    }
    record(existing, change, from, note);
  }

  for (const check of input.review.register_checks ?? []) {
    const item = items.get(check.id);
    if (!item || seen.has(check.id)) continue;
    seen.add(check.id);
    const from = item.status;
    item.evidence = check.evidence as Evidence[];
    item.last_seen = stamp;
    if (check.status === "fixed" && ACTIVE.includes(from)) {
      item.status = "resolved";
      record(item, "propose-resolved", from, "Analyst verified the problem is gone.");
    } else record(item, "update", from);
  }

  for (const item of items.values()) {
    if (seen.has(item.id) || item.source !== "metric") continue;
    if (ACTIVE.includes(item.status) || item.status === "accepted") {
      const from = item.status;
      item.status = "resolved";
      record(item, "propose-resolved", from, "No longer reported by the analyzer.");
    }
  }
  return { changes, items };
}
