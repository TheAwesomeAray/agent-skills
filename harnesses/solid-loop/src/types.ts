export type Severity = "low" | "medium" | "high" | "critical";
export type Role = "analyst" | "doubter" | "judge" | "matcher";

export interface Evidence {
  file: string;
  line?: number;
  note?: string;
}

export interface MetricFinding {
  id: string;
  label: string;
  principle: string;
  criterion: string;
  type: string;
  file: string;
  line: number;
  value: number;
  severity: Severity;
  threshold: number;
  details: string;
  register_status?: string;
  carried_forward?: boolean;
}

export interface Metrics {
  repo_path: string;
  application: string;
  stats: { types_analyzed: number; [key: string]: unknown };
  findings: MetricFinding[];
}

export interface ReviewedEntry {
  id: string;
  action: "keep" | "dismiss" | "adjust";
  severity?: Severity;
  reason?: string;
  recommendation?: string;
  evidence?: Evidence[];
  related?: string[];
}

/** A doubter observation that is not worth a debate: recorded, never answered. */
export interface DoubterNote {
  target: string | null;
  note: string;
  evidence?: Evidence[];
}

export interface AddedFinding {
  id?: string;
  principle: string;
  severity: Severity;
  title: string;
  type: string;
  file: string;
  line?: number;
  details: string;
  recommendation?: string;
  evidence?: Evidence[];
  related?: string[];
}

export interface RegisterCheck {
  id: string;
  status: "present" | "fixed";
  evidence: Evidence[];
}

export interface Review {
  executive_summary: string;
  application?: string;
  reviewed: ReviewedEntry[];
  added: AddedFinding[];
  recommendations: string[];
  register_checks?: RegisterCheck[];
}

export interface Outcome {
  action: "keep" | "dismiss" | "adjust" | "add" | "none";
  severity?: Severity;
  reason?: string;
  recommendation?: string;
  finding?: AddedFinding;
}

export interface Challenge {
  challenge_id: string;
  target: string | null;
  type: "disposition" | "missed" | "severity" | "recommendation" | "process";
  claim: string;
  proposed_outcome: Outcome;
  evidence: Evidence[];
}

export interface Challenges {
  schema_version?: number;
  round: number;
  checked_and_sound: string[];
  challenges: Challenge[];
  notes?: DoubterNote[];
}

export interface ChallengeResponse {
  challenge_id: string;
  response: "concede" | "revise" | "defend";
  argument: string;
  revised_outcome?: Outcome | null;
  evidence: Evidence[];
}

export interface Responses {
  schema_version?: number;
  round: number;
  responses: ChallengeResponse[];
}

export interface Verdict {
  challenge_id: string;
  ruling: "upheld" | "overturned" | "modified";
  outcome?: Outcome | null;
  rationale: string;
  confidence: "high" | "medium" | "low";
}

export interface Verdicts {
  schema_version?: number;
  verdicts: Verdict[];
}

export interface Summary {
  executive_summary: string;
  recommendations: string[];
}

export interface Matches {
  matches: { finding_id: string; match: string; reason: string }[];
}

export type ItemStatus =
  | "open" | "accepted" | "dismissed" | "in-progress"
  | "fixed-pending-verification" | "resolved" | "reopened";

export interface HistoryEntry {
  at: string;
  run?: string;
  change: string;
  from?: string;
  to?: string;
  note?: string;
}

export interface RegisterItem {
  schema_version: 1;
  id: string;
  analysis: string;
  source: "metric" | "review";
  status: ItemStatus;
  severity: Severity;
  principle: string;
  criterion: string | null;
  title: string;
  type: string;
  file: string;
  line: number;
  value?: number;
  threshold?: number;
  details: string;
  recommendation?: string;
  reason?: string;
  evidence?: Evidence[];
  first_seen: { run: string; commit: string };
  last_seen: { run: string; commit: string };
  claim?: { agent: string; branch: string; at: string };
  fix?: { commit: string; at: string };
  history: HistoryEntry[];
}

export interface StepRecord {
  name: string;
  status: "pending" | "done" | "failed";
  finished_at?: string;
  error?: string;
}

export interface TurnRecord {
  role: Role;
  step: string;
  agent_id: string;
  run_id: string;
  status: string;
  duration_ms?: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };
  at: string;
}

export interface Manifest {
  schema_version: 1;
  run_id: string;
  analysis: string;
  repo: string;
  repo_root: string;
  commit: string;
  base_branch: string;
  branch: string;
  work_dir: string;
  models: Record<Role, string>;
  steps: StepRecord[];
  turns: TurnRecord[];
  debate?: { rounds: number; open_disputes: string[] };
  ratings?: Record<string, string>;
  status: "running" | "failed" | "proposed" | "completed";
  pr?: string;
  push: boolean;
  /** `--set` overrides from the original command, reapplied on resume. */
  overrides?: Record<string, unknown>;
}
