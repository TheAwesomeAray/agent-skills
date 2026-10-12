import { addedFindingId } from "./ids.ts";
import type { AddedFinding, MetricFinding, Metrics, Outcome, Review, ReviewedEntry, Severity, Summary } from "./types.ts";
import { sevRank } from "./util.ts";
import { checkEvidence } from "./validate.ts";

/** Where a finding stands: dismissed, or kept at a severity. */
export type Level = "dismissed" | Severity;

/**
 * Whether moving a finding from one level to another is worth a debate: it crosses into or out of high/critical,
 * touches critical, or flips keep/dismiss on a finding kept at `floor` or above. Moves among dismissed, low and
 * (with the default floor) medium are not.
 */
export function isMaterial(from: Level, to: Level, floor: Severity): boolean {
  if (from === to) return false;
  const high = (l: Level) => l === "high" || l === "critical";
  if (high(from) !== high(to) || from === "critical" || to === "critical") return true;
  const kept = from === "dismissed" ? to : to === "dismissed" ? from : undefined;
  return kept !== undefined && kept !== "dismissed" && sevRank(kept) >= sevRank(floor);
}

export interface CurrentDecision {
  id: string;
  label: string;
  source: "metric" | "review";
  principle: string;
  type: string;
  file: string;
  line?: number;
  title: string;
  metric_severity?: Severity;
  severity: Severity;
  dismissed: boolean;
  reason?: string;
  recommendation?: string;
}

// The analyst's current position on every finding. Concessions, revisions, and verdicts change it; nothing else does.
export class Decisions {
  readonly metrics: Map<string, MetricFinding>;
  readonly reviewed = new Map<string, ReviewedEntry>();
  readonly added = new Map<string, AddedFinding & { id: string }>();
  readonly carried: Set<string>;
  private readonly byLabel: Map<string, string>;
  private readonly prefix: string;
  summary: Summary;
  readonly registerChecks: Review["register_checks"];

  constructor(metrics: Metrics, review: Review, prefix: string) {
    this.prefix = prefix;
    this.registerChecks = review.register_checks;
    this.metrics = new Map(metrics.findings.map((f) => [f.id, f]));
    this.byLabel = new Map(metrics.findings.map((f) => [f.label.toUpperCase(), f.id]));
    this.carried = new Set(metrics.findings.filter((f) => f.carried_forward).map((f) => f.id));
    this.summary = { executive_summary: review.executive_summary, recommendations: review.recommendations };
    for (const r of review.reviewed) {
      const id = this.resolve(r.id);
      if (id) this.reviewed.set(id, { ...r, id });
    }
    for (const a of review.added) this.addFinding(a);
  }

  resolve(idOrLabel: string): string | undefined {
    if (this.metrics.has(idOrLabel) || this.added.has(idOrLabel)) return idOrLabel;
    return this.byLabel.get(idOrLabel.toUpperCase());
  }

  addedId(finding: AddedFinding): string {
    return finding.id ?? addedFindingId(this.prefix, finding.principle, finding.type, finding.title);
  }

  /** The finding's current level, or undefined for an unknown id. */
  level(id: string): Level | undefined {
    const d = this.current(id);
    return d && (d.dismissed ? "dismissed" : d.severity);
  }

  /** The level `outcome` would put the finding at. */
  levelAfter(id: string, outcome: Outcome): Level | undefined {
    const d = this.current(id);
    if (!d) return undefined;
    switch (outcome.action) {
      case "dismiss": return "dismissed";
      case "keep": return d.metric_severity ?? d.severity;
      case "adjust": return outcome.severity ?? (d.dismissed ? "dismissed" : d.severity);
      default: return d.dismissed ? "dismissed" : d.severity;
    }
  }

  private addFinding(finding: AddedFinding): string {
    const id = this.addedId(finding);
    this.added.set(id, { ...finding, id });
    return id;
  }

  current(id: string): CurrentDecision | undefined {
    const m = this.metrics.get(id);
    if (m) {
      const r = this.reviewed.get(id);
      return {
        id, label: m.label, source: "metric", principle: m.principle, type: m.type, file: m.file, line: m.line,
        title: m.criterion, metric_severity: m.severity,
        severity: r?.action === "adjust" && r.severity ? r.severity : m.severity,
        dismissed: r?.action === "dismiss" || (this.carried.has(id) && m.register_status === "dismissed"),
        reason: r?.reason, recommendation: r?.recommendation,
      };
    }
    const a = this.added.get(id);
    if (!a) return undefined;
    return {
      id, label: id, source: "review", principle: a.principle, type: a.type, file: a.file, line: a.line, title: a.title,
      severity: a.severity, dismissed: false, recommendation: a.recommendation,
    };
  }

  /** Findings open to debate: everything except carried-forward ones. */
  debatable(): CurrentDecision[] {
    return [...this.metrics.keys(), ...this.added.keys()].filter((id) => !this.carried.has(id)).map((id) => this.current(id)!);
  }

  /** Problems with applying `outcome` to `target`; empty when it is applicable. */
  checkOutcome(target: string | null, outcome: Outcome, where: string, root: string): string[] {
    const errors: string[] = [];
    if (target === null) {
      if (outcome.action === "add") {
        if (!outcome.finding) errors.push(`${where}: action 'add' needs 'finding'.`);
        else {
          errors.push(...checkEvidence(root, [{ file: outcome.finding.file, line: outcome.finding.line }], `${where}.finding`));
          errors.push(...checkEvidence(root, outcome.finding.evidence, `${where}.finding`));
        }
      } else if (outcome.action !== "none") errors.push(`${where}: with target null the action must be 'add' (or 'none').`);
      return errors;
    }
    const id = this.resolve(target);
    if (!id) return [`${where}: unknown target '${target}'. Use a finding id from the metrics or an added finding's id.`];
    if (this.carried.has(id)) return [`${where}: '${target}' is carried forward from the register and is not under review.`];
    if (outcome.action === "add") errors.push(`${where}: 'add' is only for missed violations (target null).`);
    if (outcome.action === "adjust" && !outcome.severity) errors.push(`${where}: 'adjust' needs 'severity'.`);
    if (outcome.action === "keep" && this.added.has(id)) errors.push(`${where}: added findings have no metric severity to keep; use 'adjust' or 'none'.`);
    return errors;
  }

  apply(target: string | null, outcome: Outcome, fallbackReason: string): void {
    if (target === null) {
      if (outcome.action === "add" && outcome.finding) this.addFinding(outcome.finding);
      return;
    }
    const id = this.resolve(target);
    if (!id) return;
    const reason = outcome.reason ?? fallbackReason;
    const added = this.added.get(id);
    if (added) {
      if (outcome.action === "dismiss") this.added.delete(id);
      else if (outcome.action === "adjust" && outcome.severity) added.severity = outcome.severity;
      if (outcome.recommendation) added.recommendation = outcome.recommendation;
      return;
    }
    const metric = this.metrics.get(id)!;
    const previous = this.reviewed.get(id);
    const evidence = previous?.evidence;
    const related = previous?.related ? { related: previous.related } : {};
    const recommendation = outcome.recommendation ?? previous?.recommendation;
    switch (outcome.action) {
      case "keep":
        this.reviewed.set(id, { id, action: "keep", reason: previous?.action === "keep" ? previous.reason : reason, recommendation, evidence, ...related });
        break;
      case "dismiss":
        this.reviewed.set(id, { id, action: "dismiss", reason, evidence, ...related });
        break;
      case "adjust":
        this.reviewed.set(id, outcome.severity === metric.severity
          ? { id, action: "keep", reason, recommendation, evidence, ...related }
          : { id, action: "adjust", severity: outcome.severity, reason, recommendation, evidence, ...related });
        break;
      case "none":
        if (outcome.recommendation) this.reviewed.set(id, { ...(previous ?? { id, action: "keep", evidence }), recommendation });
        break;
    }
  }

  toReview(): Review {
    return {
      executive_summary: this.summary.executive_summary,
      reviewed: [...this.reviewed.values()].filter((r) => !this.carried.has(r.id)),
      added: [...this.added.values()],
      recommendations: this.summary.recommendations,
      ...(this.registerChecks ? { register_checks: this.registerChecks } : {}),    };
  }

  snapshot(): { reviewed: ReviewedEntry[]; added: (AddedFinding & { id: string })[]; carried_forward: string[] } {
    return { reviewed: [...this.reviewed.values()], added: [...this.added.values()], carried_forward: [...this.carried] };
  }
}
