import fs from "node:fs";
import type { RunContext } from "./context.ts";
import { Decisions } from "./decisions.ts";
import type { Challenge, ChallengeResponse, Challenges, Metrics, Responses, Review, Verdicts } from "./types.ts";
import { readJson } from "./util.ts";
import { citationKeys } from "./validate.ts";

export interface AppliedResponse {
  challenge_id: string;
  target: string | null;
  response: ChallengeResponse["response"];
  effective: "concede" | "revise" | "defend";
  note?: string;
}

export interface RoundRecord {
  round: number;
  challenges: Challenges;
  responses: Responses;
  applied: AppliedResponse[];
}

export interface DebateState {
  decisions: Decisions;
  rounds: RoundRecord[];
  /** Challenges the analyst defended in the last completed round. */
  open: Challenge[];
  /** Citations the analyst has already made, per finding; a defense must add one. */
  cited: Map<string, Set<string>>;
}

export const roundFile = (ctx: RunContext, round: number, kind: "challenges" | "responses" | "outcomes") =>
  ctx.file(`debate/round-${round}.${kind}.json`);

const threadKey = (decisions: Decisions, c: Challenge) => (c.target ? decisions.resolve(c.target) ?? c.target : `missed:${c.challenge_id}`);

/** Applies one round's responses. A defense that cites nothing the analyst hasn't already cited counts as a concession. */
export function applyRound(decisions: Decisions, challenges: Challenges, responses: Responses, cited: Map<string, Set<string>>): { applied: AppliedResponse[]; open: Challenge[] } {
  const applied: AppliedResponse[] = [];
  const open: Challenge[] = [];
  const byId = new Map(responses.responses.map((r) => [r.challenge_id, r]));
  for (const c of challenges.challenges) {
    const r = byId.get(c.challenge_id);
    if (!r) continue;
    const key = threadKey(decisions, c);
    const before = cited.get(key) ?? new Set<string>();
    const fresh = citationKeys(r.evidence).filter((k) => !before.has(k));
    for (const k of citationKeys(r.evidence)) before.add(k);
    cited.set(key, before);

    let effective: AppliedResponse["effective"] = r.response;
    let note: string | undefined;
    if (r.response === "defend" && fresh.length === 0) {
      effective = "concede";
      note = "Defense cited no new evidence; treated as a concession.";
    }
    if (effective === "concede") decisions.apply(c.target, c.proposed_outcome, `Conceded to doubter (${c.challenge_id}): ${c.claim}`);
    else if (effective === "revise" && r.revised_outcome) decisions.apply(c.target, r.revised_outcome, `Revised after challenge ${c.challenge_id}: ${r.argument}`);
    else if (effective === "defend") open.push(c);
    applied.push({ challenge_id: c.challenge_id, target: c.target, response: r.response, effective, ...(note ? { note } : {}) });
  }
  return { applied, open };
}

/** Rebuilds the decisions from the files written so far: review, completed rounds, and verdicts if present. */
export function replay(ctx: RunContext): DebateState {
  const metrics = readJson<Metrics>(ctx.file("metrics.json"));
  const review = readJson<Review>(ctx.file("review.json"));
  const decisions = new Decisions(metrics, review, ctx.prefix);
  const cited = new Map<string, Set<string>>();
  for (const r of review.reviewed) cited.set(decisions.resolve(r.id) ?? r.id, new Set(citationKeys(r.evidence)));
  for (const a of decisions.added.values()) cited.set(a.id, new Set(citationKeys(a.evidence)));

  const rounds: RoundRecord[] = [];
  let open: Challenge[] = [];
  for (let round = 1; fs.existsSync(roundFile(ctx, round, "challenges")); round++) {
    const challenges = readJson<Challenges>(roundFile(ctx, round, "challenges"));
    if (challenges.challenges.length === 0) { rounds.push({ round, challenges, responses: { round, responses: [] }, applied: [] }); open = []; break; }
    if (!fs.existsSync(roundFile(ctx, round, "responses"))) break;
    const responses = readJson<Responses>(roundFile(ctx, round, "responses"));
    const result = applyRound(decisions, challenges, responses, cited);
    rounds.push({ round, challenges, responses, applied: result.applied });
    open = result.open;
  }

  if (fs.existsSync(ctx.file("verdicts.json"))) {
    const verdicts = readJson<Verdicts>(ctx.file("verdicts.json"));
    const challengeById = new Map(rounds.flatMap((r) => r.challenges.challenges).map((c) => [c.challenge_id, c]));
    for (const v of verdicts.verdicts) {
      const c = challengeById.get(v.challenge_id);
      if (!c) continue;
      if (v.ruling === "overturned") decisions.apply(c.target, c.proposed_outcome, `Judge overturned (${v.confidence} confidence): ${v.rationale}`);
      else if (v.ruling === "modified" && v.outcome) decisions.apply(c.target, v.outcome, `Judge modified (${v.confidence} confidence): ${v.rationale}`);
    }
  }
  return { decisions, rounds, open, cited };
}

/** Every challenge and response about the same finding, oldest first. */
export function thread(state: DebateState, c: Challenge) {
  const key = threadKey(state.decisions, c);
  return state.rounds.flatMap((r) => r.challenges.challenges
    .filter((x) => threadKey(state.decisions, x) === key)
    .map((x) => ({ round: r.round, challenge: x, response: r.responses.responses.find((y) => y.challenge_id === x.challenge_id) })));
}
