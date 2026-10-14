import fs from "node:fs";
import path from "node:path";
import type { RegisterItem } from "../types.ts";
import { toPosix } from "../util.ts";
import { checkEvidence } from "../validate.ts";
import { changesConstructor, reachedFiles, type Reference } from "./references.ts";

export interface Plan {
  item_id: string;
  goal: string;
  resolution: { criterion: string; expected: "absent" | "lower_severity"; expected_severity?: string };
  steps: { refactoring: string; files: string[]; detail: string }[];
  files: string[];
  new_types: string[];
  public_surface_changes: string[];
  callers: { file: string; line: number; kind: "call" | "di"; note: string }[];
  behavior_notes: string;
  change_points: { type: string; member: string; note: string }[];
  touches: { async: boolean; threading: boolean; static_state: boolean; persistence: boolean };
  complexity: { level: number; reasons: string[] };
  risks: string[];
  /** Test-code plans only: test methods whose fully qualified name changes. */
  renames?: { from: string; to: string }[];
}

/** Production plans must stay out of test code; test-code plans (references/tests.md section 7, case B) must stay inside the test projects. */
export type PlanScope = { kind: "production" | "tests"; testDirs: string[] };

export interface Complexity {
  agent: number;
  floor: number;
  floor_reasons: string[];
  effective: number;
}

const norm = (f: string): string => toPosix(f).replace(/^\.\//, "");

/** Bold names in the vocabulary file are the only refactorings a plan may name. */
export function vocabularyNames(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]));
}

/** The vocabulary entries, with their "Can break" notes, for the refactorings a plan's steps name. */
export function vocabularyFor(markdown: string, plan: Pick<Plan, "steps">): string {
  const named = new Set(plan.steps.map((s) => s.refactoring));
  return [...markdown.matchAll(/^- \*\*(.+?)\*\*.*$/gm)].filter((m) => named.has(m[1])).map((m) => m[0]).join("\n");
}

export const isUnder = (file: string, dirs: string[]): boolean => dirs.some((d) => norm(file).toLowerCase().startsWith(norm(d).replace(/\/?$/, "/").toLowerCase()));

/** `refs` are the code's own references to the changed types, from a full work tree; only production ones are reported back. */
export function checkPlan(plan: Plan, item: RegisterItem, root: string, vocabulary: Set<string>, scope: PlanScope, refs: Reference[] = []): string[] {
  const errors: string[] = [];
  if (plan.item_id !== item.id) errors.push(`item_id must be '${item.id}'.`);
  if (item.criterion && plan.resolution.criterion !== item.criterion) errors.push(`resolution.criterion must be '${item.criterion}'.`);
  if (plan.resolution.expected === "lower_severity" && !plan.resolution.expected_severity) errors.push("resolution.expected_severity is required when expected is lower_severity.");

  const files = new Set(plan.files.map(norm));
  for (const f of files) {
    const full = path.resolve(root, f);
    if (path.isAbsolute(f) || !full.startsWith(path.resolve(root))) errors.push(`files: '${f}' must be relative to the repository root.`);
    else if (!fs.existsSync(full) && plan.new_types.length === 0)
      errors.push(`files: '${f}' does not exist. If the plan creates it, declare the type it adds in new_types.`);
    else if (!fs.existsSync(full) && !projectOf(f, root)) errors.push(`files: new file '${f}' is not inside any project.`);
    if (scope.kind === "production" && isUnder(f, scope.testDirs)) errors.push(`files: '${f}' is test code; plans cover production code only.`);
    if (scope.kind === "tests" && !isUnder(f, scope.testDirs))
      errors.push(`files: '${f}' is not test code (${scope.testDirs.join(", ")}); a test-code refactoring changes test code only.`);  }
  if (!files.has(norm(item.file))) errors.push(`files must include the item's file '${item.file}'.`);
  plan.steps.forEach((s, i) => {
    if (!vocabulary.has(s.refactoring)) errors.push(`steps[${i}].refactoring '${s.refactoring}' is not in the vocabulary; use a name exactly as written there.`);
    for (const f of s.files) if (!files.has(norm(f))) errors.push(`steps[${i}].files: '${f}' is not in the plan's files.`);
  });
  errors.push(...checkEvidence(root, plan.callers.map((c) => ({ file: c.file, line: c.line })), "callers"));

  if (scope.kind === "tests") {
    const fq = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/;
    for (const [i, r] of (plan.renames ?? []).entries()) {
      if (!fq.test(r.from) || !fq.test(r.to)) errors.push(`renames[${i}]: from and to must be Namespace.Class.Method (Class.Method when the class has no namespace).`);
      if (r.from === r.to) errors.push(`renames[${i}]: from and to are the same.`);
    }
    const froms = (plan.renames ?? []).map((r) => r.from);
    if (new Set(froms).size < froms.length) errors.push("renames: a test is renamed more than once.");
    return errors;
  }
  if (plan.renames?.length) errors.push("renames apply to test-code plans only; leave it out.");
  const listed = new Set(plan.callers.map((c) => norm(c.file).toLowerCase()));
  if (changesConstructor(plan)) {
    const unlisted = refs.filter((r) => !r.test && r.kind === "constructs" && !listed.has(r.file.toLowerCase()));
    for (const r of unlisted.slice(0, 10))
      errors.push(`callers: ${r.file}:${r.line} constructs a type whose constructor the plan changes, but is not listed. Add it to callers with kind "call", and to files if the plan must change it.`);
    if (unlisted.length > 10) errors.push(`callers: ${unlisted.length - 10} more construction sites are not listed.`);
  }
  for (const c of plan.callers.filter((c) => c.kind === "di")) {
    const site = refs.find((r) => r.kind === "constructs" && r.file.toLowerCase() === norm(c.file).toLowerCase() && r.line === c.line);
    if (site) errors.push(`callers: ${c.file}:${c.line} is labeled "di" but constructs the type directly with new; label it "call".`);
  }
  const text = JSON.stringify({ goal: plan.goal, steps: plan.steps, behavior_notes: plan.behavior_notes, risks: plan.risks, change_points: plan.change_points, reasons: plan.complexity.reasons });
  if (/\b(unit ?tests?|tests?|testing|testable|xunit|mocks?)\b/i.test(text))
    errors.push("The plan mentions testing. Testing is handled by someone else; describe production code changes only.");
  return errors;
}

/** The .csproj that owns `file`, relative to `root`. */
export function projectFile(file: string, root: string): string | undefined {
  const dir = projectOf(file, root);
  const csproj = dir && fs.readdirSync(dir).find((f) => f.endsWith(".csproj"));
  return csproj ? toPosix(path.relative(root, path.join(dir, csproj))) : undefined;
}

function projectOf(file: string, root: string): string | undefined {
  let dir = path.dirname(path.resolve(root, file));
  while (dir.startsWith(path.resolve(root))) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".csproj"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const PERSISTENCE = /:\s*DbContext\b|IEntityTypeConfiguration<|\bOnModelCreating\b/;

/**
 * references/refactor-phase.md section 4: a minimum level computed from the plan and the code. Agents can raise it, never lower it.
 * `refs` come from searching a full work tree, so callers the planner did not list (or could not see) still count.
 */
export function complexity(plan: Plan, item: RegisterItem, root: string, refs: Reference[], scope: PlanScope["kind"], callerThreshold: number): Complexity {
  const reasons: string[] = [];
  let floor = 1;
  const raise = (level: number, reason: string) => { reasons.push(`${level}: ${reason}`); floor = Math.max(floor, level); };

  const files = [...new Set(plan.files.map(norm))];
  if (files.length > 1) raise(2, `${files.length} files`);
  const home = projectOf(item.file, root);
  const others = files.filter((f) => projectOf(f, root) !== home);
  if (others.length > 0) raise(3, `files in another project: ${others.join(", ")}`);
  if (plan.new_types.length > 0) raise(3, `new types: ${plan.new_types.join(", ")}`);
  // A listed caller counts only if its file names a changed type; one that reaches it indirectly (e.g. through a mediator) is unaffected.
  const changedTypes = [...new Set(plan.change_points.map((c) => c.type.split(".").at(-1)!))];
  const mentions = (file: string) => {
    const full = path.resolve(root, file);
    return !fs.existsSync(full) || changedTypes.length === 0 || changedTypes.some((t) => new RegExp(String.raw`\b${t}\b`).test(fs.readFileSync(full, "utf8")));
  };
  const outside = plan.public_surface_changes.length > 0
    ? plan.callers.filter((c) => c.kind === "call" && !files.includes(norm(c.file)) && mentions(c.file)).map((c) => norm(c.file)) : [];
  const reachable = scope === "tests" ? refs : refs.filter((r) => !r.test);
  const reached = [...new Set([...outside, ...reachedFiles(reachable, plan)])];
  if (reached.length > 0) {
    const listed = new Set(plan.callers.map((c) => norm(c.file).toLowerCase()));
    const unlisted = reached.filter((f) => !listed.has(f.toLowerCase())).length;
    raise(reached.length > callerThreshold ? 4 : 3,
      `the change reaches ${reached.length} file(s) outside the plan${unlisted ? `, ${unlisted} not listed as callers` : ""}: ${reached.slice(0, 5).join(", ")}${reached.length > 5 ? ", ..." : ""}`);
  }
  if (scope === "production") {
    const tests = new Set(reachedFiles(refs.filter((r) => r.test), plan));
    if (tests.size > 0) raise(2, `${tests.size} existing test file(s) use what the plan changes and will need adapting`);
  }
  const persistence = files.filter((f) => /(^|\/)Migrations\//i.test(f) || (fs.existsSync(path.resolve(root, f)) && PERSISTENCE.test(fs.readFileSync(path.resolve(root, f), "utf8"))));
  if (persistence.length > 0 || plan.touches.persistence) raise(4, `persistence code${persistence.length ? `: ${persistence.join(", ")}` : " (declared)"}`);
  if (plan.touches.async) raise(4, "async code paths (declared)");
  if (plan.touches.threading) raise(4, "threading (declared)");
  if (plan.touches.static_state) raise(4, "static mutable state (declared)");

  return { agent: plan.complexity.level, floor, floor_reasons: reasons, effective: Math.max(plan.complexity.level, floor) };
}
