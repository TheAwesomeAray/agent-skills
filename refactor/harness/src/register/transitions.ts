import fs from "node:fs";
import path from "node:path";
import type { ItemStatus, Manifest, RegisterItem } from "../types.ts";
import { HarnessError, now, readJson, writeText } from "../util.ts";
import { renderTechDebt } from "./render.ts";
import { loadItems, saveItem } from "./store.ts";

// The only ways the refactor phase (or a person) changes an item's status between analysis runs.

function transition(item: RegisterItem, change: string, allowed: ItemStatus[], to: ItemStatus, note: string): void {
  if (!allowed.includes(item.status)) throw new HarnessError(`${item.id} is '${item.status}'; ${change} needs one of: ${allowed.join(", ")}.`);
  item.history.push({ at: now(), change, from: item.status, to, note });
  item.status = to;
}

export function claim(item: RegisterItem, agent: string, branch: string): void {
  transition(item, "claim", ["open", "reopened"], "in-progress", `Claimed by ${agent} on ${branch}`);
  item.claim = { agent, branch, at: now() };
}

/**
 * `branch` is set when this change is committed on the fix's own branch: the status then reaches the base branch
 * only by merging the fix, so an analysis run can treat it as merged even when squash or rebase changed the commit.
 */
export function markFixed(item: RegisterItem, commit: string, branch?: string): void {
  transition(item, "mark-fixed", ["in-progress"], "fixed-pending-verification", `Fix in ${commit}${branch ? ` on ${branch}` : ""}`);
  item.fix = { commit, at: now(), ...(branch ? { branch } : {}) };
}

export function accept(item: RegisterItem, reason: string): void {
  transition(item, "accept", ["open", "reopened"], "accepted", reason);
  item.reason = reason;
}

/** Saves the item and regenerates TECH-DEBT.md from every item in the register. */
export function saveAndRender(registerDir: string, item: RegisterItem): void {
  saveItem(registerDir, item);
  const items = loadItems(registerDir);
  writeText(path.join(registerDir, "TECH-DEBT.md"), renderTechDebt([...items.values()], latestRun(registerDir)));
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
