import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunContext } from "../context.ts";
import { applyRound, replay, roundFile, thread, type DebateState } from "../debate.ts";
import { isMaterial, type Decisions } from "../decisions.ts";
import { json, pathList, prompt, skillReferences } from "../prompts.ts";
import type { Challenge, Challenges, Responses, Severity, Verdicts } from "../types.ts";
import { sevRank, writeJson } from "../util.ts";
import { checkEvidence } from "../validate.ts";

function writeDecisions(ctx: RunContext, decisions: Decisions): string {
  const file = path.join(ctx.paths.scratchDir, "current-decisions.json");
  writeJson(file, decisions.snapshot());
  return file.replace(/\\/g, "/");
}

function history(ctx: RunContext, state: DebateState): string {
  return pathList(state.rounds.flatMap((r) => [roundFile(ctx, r.round, "challenges"), roundFile(ctx, r.round, "responses")]).filter((f) => fs.existsSync(f)));
}

/**
 * Round 1 must account for every Critical/High decision, every dismissal of a finding the metrics rated at the
 * materiality floor or above, and a deterministic sample of the rest.
 */
function coverage(ctx: RunContext, decisions: Decisions) {
  const { medium_low_sample_rate: rate, material_severity: floor } = ctx.config.debate;
  const sampled = (id: string) => parseInt(createHash("sha256").update(ctx.runId + id).digest("hex").slice(0, 8), 16) / 0xffffffff < rate;
  return decisions.debatable()
    .filter((d) => (d.dismissed && sevRank(d.metric_severity ?? d.severity) >= sevRank(floor)) || sevRank(d.severity) >= sevRank("high") || sampled(d.id))
    .map((d) => ({ id: d.id, label: d.label, decision: d.dismissed ? "dismissed" : d.severity, metric_severity: d.metric_severity, type: d.type, title: d.title }));
}

export async function debateStep(ctx: RunContext): Promise<void> {
  const { max_rounds: maxRounds, max_challenges_per_round: maxChallenges } = ctx.config.debate;
  let state = replay(ctx);
  const startRound = state.rounds.length + 1;
  const orphan = roundFile(ctx, startRound, "challenges");
  if (fs.existsSync(orphan)) fs.rmSync(orphan);

  const refs = skillReferences(ctx);
  const root = ctx.paths.analysisDir;
  const finished = state.rounds.length > 0 && (state.open.length === 0 || state.rounds.at(-1)!.challenges.challenges.length === 0);

  for (let round = startRound; round <= maxRounds && !finished; round++) {
    const decisions = state.decisions;
    const required = round === 1 ? coverage(ctx, decisions) : [];
    const previous = state.rounds.at(-1);
    const allowedRepeat = new Set(state.open.map((c) => c.target && decisions.resolve(c.target)).filter(Boolean) as string[]);
    const closed = new Set(state.rounds.flatMap((r) => r.challenges.challenges).map((c) => c.target && decisions.resolve(c.target)).filter((t): t is string => !!t && !allowedRepeat.has(t)));

    const roundInstructions = round === 1
      ? `Read the code for every finding in this coverage list and account for it: put its id in \`checked_and_sound\`, challenge it, or (when your objection is not material) write a note about it. You may also challenge findings outside the list and report missed violations.\n\n\`\`\`json\n${json(required)}\n\`\`\``
      : `The analyst answered your round ${round - 1} challenges (\`${roundFile(ctx, round - 1, "responses").replace(/\\/g, "/")}\`). Conceded and revised challenges are closed. These were defended:\n\n\`\`\`json\n${json(state.open.map((c) => ({ challenge: c, response: previous?.responses.responses.find((r) => r.challenge_id === c.challenge_id) })))}\n\`\`\`\n\nFor each, either press it again as a new challenge with the same target and new evidence, or let it go, which settles it in the analyst's favor. This round is only about these defended challenges: no new targets and no new missed violations (put anything new in \`notes\`). Submit an empty \`challenges\` list if nothing is left to dispute; \`checked_and_sound\` may be empty this round.`;

    const doubter = await ctx.agent("doubter");
    const challenges = await doubter.turn<Challenges>(`debate-${round}`, prompt(ctx, "doubter", "submit_challenges", {
      metrics_path: ctx.file("metrics.json").replace(/\\/g, "/"),
      decisions_path: writeDecisions(ctx, decisions),
      history: history(ctx, state),
      round, max_rounds: maxRounds, max_challenges: maxChallenges, material_severity: ctx.config.debate.material_severity,
      round_instructions: roundInstructions,
      criteria: refs.criteria,
    }), {
      tool: "submit_challenges",
      description: `Submit your round ${round} challenges and the ids you checked and found sound.`,
      schema: "challenges",
      check: (c) => checkChallenges(c, round, maxChallenges, decisions, required.map((r) => r.id), closed, root, ctx.config.debate.material_severity,
        round === 1 ? undefined : { targets: allowedRepeat, missed: state.open.some((o) => o.target === null) }),
    });
    writeJson(roundFile(ctx, round, "challenges"), { schema_version: 1, ...challenges });
    ctx.log(`Round ${round}: ${challenges.challenges.length} challenge(s), ${challenges.checked_and_sound.length} checked and sound.`);
    if (challenges.challenges.length === 0) break;

    const analyst = await ctx.agent("analyst");
    const responses = await analyst.turn<Responses>(`debate-${round}`, prompt(ctx, "analyst-respond", "submit_responses", {
      round, count: challenges.challenges.length,
      decisions_path: writeDecisions(ctx, decisions),
      history: history(ctx, state),
      challenges_json: json(challenges.challenges),
    }), {
      tool: "submit_responses",
      description: `Submit one response per round ${round} challenge.`,
      schema: "responses",
      check: (r) => checkResponses(r, round, challenges, decisions, root),
    });
    writeJson(roundFile(ctx, round, "responses"), { schema_version: 1, ...responses });
    const { applied, open } = applyRound(decisions, challenges, responses, state.cited);
    writeJson(roundFile(ctx, round, "outcomes"), { schema_version: 1, round, applied });
    const tally = (k: string) => applied.filter((a) => a.effective === k).length;
    ctx.log(`Round ${round}: ${tally("concede")} conceded, ${tally("revise")} revised, ${tally("defend")} defended.`);
    state = replay(ctx);
    if (open.length === 0) break;
  }

  state = replay(ctx);
  ctx.manifest.debate = { rounds: state.rounds.length, open_disputes: state.open.map((c) => c.challenge_id) };
}

/** Why a challenge is not worth debating, or undefined when it is. Rejected challenges belong in `notes`. */
export function immaterial(ch: Challenge, decisions: Decisions, floor: Severity): string | undefined {
  const toNotes = "Not material; record it in `notes` instead (notes are kept, not debated).";
  if (ch.target === null) {
    const sev = ch.proposed_outcome.finding?.severity;
    return sev && sevRank(sev) < sevRank(floor) ? `a missed violation at ${sev} is below the ${floor} floor. ${toNotes}` : undefined;
  }
  const id = decisions.resolve(ch.target);
  if (!id) return undefined;
  if (ch.type === "recommendation" && ch.proposed_outcome.action === "none") {
    return ch.proposed_outcome.recommendation ? undefined : "a recommendation challenge needs `proposed_outcome.recommendation`.";
  }
  const from = decisions.level(id)!;
  const to = decisions.levelAfter(id, ch.proposed_outcome)!;
  if (from === to) return `the proposed outcome leaves the decision at ${from}. ${toNotes}`;
  return isMaterial(from, to, floor) ? undefined : `moving ${from} to ${to} does not change the risk picture. ${toNotes}`;
}

/** After round 1, only challenges the analyst defended may be pressed again. */
interface Pressable { targets: Set<string>; missed: boolean }

export function checkChallenges(c: Challenges, round: number, max: number, decisions: Decisions, required: string[], closed: Set<string>, root: string, floor: Severity, pressable?: Pressable): string[] {
  const errors: string[] = [];
  if (c.round !== round) errors.push(`round must be ${round}.`);
  if (c.challenges.length > max) errors.push(`At most ${max} challenges per round; you sent ${c.challenges.length}. Keep the highest-risk ones.`);
  const ids = new Set<string>();
  const covered = new Set<string>();
  c.checked_and_sound.forEach((raw) => {
    const id = decisions.resolve(raw);
    if (!id) errors.push(`checked_and_sound: unknown id '${raw}'.`);
    else covered.add(id);
  });
  c.challenges.forEach((ch, i) => {
    const where = `challenges[${i}] (${ch.challenge_id})`;
    if (!ch.challenge_id.startsWith(`R${round}-`)) errors.push(`${where}: ids this round start with R${round}-.`);
    if (ids.has(ch.challenge_id)) errors.push(`${where}: duplicate challenge_id.`);
    ids.add(ch.challenge_id);
    if ((ch.type === "missed") !== (ch.target === null)) errors.push(`${where}: type 'missed' and target null go together.`);
    errors.push(...decisions.checkOutcome(ch.target, ch.proposed_outcome, `${where}.proposed_outcome`, root));
    errors.push(...checkEvidence(root, ch.evidence, where));
    const target = ch.target && decisions.resolve(ch.target);
    if (target) {
      covered.add(target);
      if (closed.has(target)) errors.push(`${where}: '${ch.target}' was settled in an earlier round.`);
    }
    const why = immaterial(ch, decisions, floor);
    if (why) errors.push(`${where}: ${why}`);
    if (pressable && (target ? !pressable.targets.has(target) : !pressable.missed))
      errors.push(`${where}: after round 1 you may only press challenges the analyst defended (${[...pressable.targets].join(", ") || "none with a target"}); put anything new in \`notes\`.`);
  });
  (c.notes ?? []).forEach((n, i) => {
    const where = `notes[${i}]`;
    const id = n.target && decisions.resolve(n.target);
    if (n.target && !id) errors.push(`${where}: unknown target '${n.target}'.`);
    if (id) covered.add(id);
    errors.push(...checkEvidence(root, n.evidence, where));
  });
  const missing = required.filter((id) => !covered.has(id));
  if (missing.length > 0) errors.push(`Coverage: these ids are not in checked_and_sound, a challenge, or a note: ${missing.join(", ")}.`);
  return errors;
}

function checkResponses(r: Responses, round: number, challenges: Challenges, decisions: Decisions, root: string): string[] {
  const errors: string[] = [];
  if (r.round !== round) errors.push(`round must be ${round}.`);
  const byId = new Map(challenges.challenges.map((c) => [c.challenge_id, c]));
  const answered = new Set<string>();
  r.responses.forEach((resp, i) => {
    const where = `responses[${i}] (${resp.challenge_id})`;
    const c = byId.get(resp.challenge_id);
    if (!c) { errors.push(`${where}: no such challenge this round.`); return; }
    if (answered.has(resp.challenge_id)) errors.push(`${where}: answered more than once.`);
    answered.add(resp.challenge_id);
    if (resp.response === "revise") {
      if (!resp.revised_outcome) errors.push(`${where}: 'revise' needs 'revised_outcome'.`);
      else errors.push(...decisions.checkOutcome(c.target, resp.revised_outcome, `${where}.revised_outcome`, root));
    }
    if (resp.evidence.length === 0) errors.push(`${where}: '${resp.response}' needs evidence: cite the code you read to verify the challenge.`);
    errors.push(...checkEvidence(root, resp.evidence, where));
  });
  const missing = challenges.challenges.map((c) => c.challenge_id).filter((id) => !answered.has(id));
  if (missing.length > 0) errors.push(`Missing responses for: ${missing.join(", ")}.`);
  return errors;
}

export async function judgeStep(ctx: RunContext): Promise<void> {
  const state = replay(ctx);
  if (state.open.length === 0) {
    ctx.log("No open disputes; the judge is not needed.");
    return;
  }
  const disputes = state.open.map((c: Challenge) => ({
    challenge_id: c.challenge_id,
    target: c.target,
    finding: c.target ? state.decisions.metrics.get(state.decisions.resolve(c.target) ?? "") ?? state.decisions.added.get(c.target) : c.proposed_outcome.finding,
    analyst_current_decision: c.target ? state.decisions.current(state.decisions.resolve(c.target) ?? c.target) : "not reported",
    exchange: thread(state, c),
  }));
  const refs = skillReferences(ctx);
  const judge = await ctx.newAgent("judge");
  try {
    const verdicts = await judge.turn<Verdicts>("judge", prompt(ctx, "judge", "submit_verdicts", {
      rounds: state.rounds.length,
      disputes_json: json(disputes),
      criteria: refs.criteria,
    }), {
      tool: "submit_verdicts",
      description: "Submit one verdict per open dispute.",
      schema: "verdicts",
      check: (v) => {
        const errors: string[] = [];
        const open = new Map(state.open.map((c) => [c.challenge_id, c]));
        const ruled = new Set<string>();
        v.verdicts.forEach((verdict, i) => {
          const where = `verdicts[${i}] (${verdict.challenge_id})`;
          const c = open.get(verdict.challenge_id);
          if (!c) { errors.push(`${where}: not an open dispute.`); return; }
          if (ruled.has(verdict.challenge_id)) errors.push(`${where}: ruled more than once.`);
          ruled.add(verdict.challenge_id);
          if (verdict.ruling === "modified") {
            if (!verdict.outcome) errors.push(`${where}: 'modified' needs 'outcome'.`);
            else errors.push(...state.decisions.checkOutcome(c.target, verdict.outcome, `${where}.outcome`, ctx.paths.analysisDir));
          }
        });
        const missing = [...open.keys()].filter((id) => !ruled.has(id));
        if (missing.length > 0) errors.push(`Missing verdicts for: ${missing.join(", ")}.`);
        return errors;
      },
    });
    writeJson(ctx.file("verdicts.json"), { schema_version: 1, ...verdicts });
    const tally = (k: string) => verdicts.verdicts.filter((x) => x.ruling === k).length;
    ctx.log(`Judge: ${tally("upheld")} upheld, ${tally("overturned")} overturned, ${tally("modified")} modified.`);
  } finally {
    await judge.dispose();
  }
}
