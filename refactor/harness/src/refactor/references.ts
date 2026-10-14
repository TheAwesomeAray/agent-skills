import fs from "node:fs";
import path from "node:path";
import { git } from "../git.ts";
import { toPosix } from "../util.ts";
import { isUnder, type Plan } from "./plan.ts";

/**
 * A line outside the plan's files that names a type the plan changes. `constructs` is a direct `new Type(...)`;
 * `registration` is a dependency injection registration, which the container satisfies without code changes.
 */
export interface Reference { file: string; line: number; test: boolean; kind: "constructs" | "registration" | "use" }

const norm = (f: string): string => toPosix(f).replace(/^\.\//, "");
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shortName = (type: string): string => type.replace(/<.*$/, "").split(".").at(-1)!;
const REGISTRATION = /\b(Try)?Add(Scoped|Transient|Singleton|Hosted\w*)\b|\bRegister(Type)?\b|\.As<|\.AsSelf\(/;

/** The item's type, which the register names, plus every type in the plan's change points. */
export function changedTypes(plan: Plan, itemType: string): string[] {
  return [...new Set([itemType, ...plan.change_points.map((c) => c.type)].map(shortName).filter(Boolean))];
}

export const changesConstructor = (plan: Plan): boolean => plan.change_points.some((c) => /constructor|\bctor\b/i.test(c.member));

/** Public surface changes other than a constructor change. */
export const changesOtherSurface = (plan: Plan): boolean => plan.public_surface_changes.some((s) => !/constructor|\bctor\b/i.test(s));

/**
 * Every line in the work tree's tracked C# files, outside `exclude`, that names one of `types` as a whole word.
 * A text search: it over-reports (comments, same-named types in other namespaces) rather than misses, except for
 * uses that never spell the type's name, such as `var` from a factory or calls through an interface.
 */
export function findReferences(root: string, types: string[], exclude: string[], testDirs: string[]): Reference[] {
  if (types.length === 0) return [];
  const skip = new Set(exclude.map((f) => norm(f).toLowerCase()));
  const names = types.map(escape).join("|");
  const word = new RegExp(String.raw`\b(?:${names})\b`);
  const declaration = new RegExp(String.raw`\b(?:class|interface|record|struct|enum)\s+(?:${names})\b`);
  const construction = new RegExp(String.raw`\bnew\s+(?:${names})\s*(?:<[^>]*>)?\s*\(`);
  const refs: Reference[] = [];
  for (const file of git(root, "ls-files", "-z", "--", "*.cs").split("\0").filter(Boolean).map(norm)) {
    if (skip.has(file.toLowerCase())) continue;
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const test = isUnder(file, testDirs);
    fs.readFileSync(full, "utf8").split(/\r?\n/).forEach((text, i) => {
      if (!word.test(text) || declaration.test(text)) return;
      const kind = construction.test(text) ? "constructs" : REGISTRATION.test(text) ? "registration" : "use";
      refs.push({ file, line: i + 1, test, kind });
    });
  }
  return refs;
}

/**
 * The files the change can break: sites that construct a type whose constructor changes, and, when other public
 * members change, every file that uses the type other than to register it.
 */
export function reachedFiles(refs: Reference[], plan: Plan): string[] {
  const ctor = changesConstructor(plan), other = changesOtherSurface(plan);
  return [...new Set(refs.filter((r) => (ctor && r.kind === "constructs") || (other && r.kind !== "registration")).map((r) => r.file))].sort();
}

/** References grouped by file for agent prompts, capped so a widely used type cannot flood the context. */
export function referenceSummary(refs: Reference[], types: string[], includeTests: boolean, maxFiles = 40) {
  const group = (list: Reference[]) => {
    const byFile = new Map<string, Reference[]>();
    for (const r of list) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
    const files = [...byFile].map(([file, rs]) => ({
      file, lines: rs.map((r) => r.line), ...(rs.some((r) => r.kind === "constructs") ? { constructs_at: rs.filter((r) => r.kind === "constructs").map((r) => r.line) } : {}),
      ...(rs.every((r) => r.kind === "registration") ? { registration_only: true } : {}),
    }));
    return { files: files.slice(0, maxFiles), ...(files.length > maxFiles ? { more_files: files.length - maxFiles } : {}) };
  };
  return { types, production: group(refs.filter((r) => !r.test)), ...(includeTests ? { tests: group(refs.filter((r) => r.test)) } : {}) };
}
