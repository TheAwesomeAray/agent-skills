import fs from "node:fs";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { ROLES_DIR } from "./config.ts";
import type { Evidence } from "./types.ts";
import { readJson, toPosix } from "./util.ts";

/** A submission schema by its path under roles/, without ".json". */
export type SchemaName = "analyst/review" | "analyst/respond" | "analyst/summary" | "doubter/challenge" | "judge/rule" | "matcher/match" | "shared/register-item"
  | "screener/screen" | "planner/plan" | "tester/characterize" | "auditor/names" | "auditor/test-changes" | "coverage-reviewer/coverage"
  | "implementer/implement" | "test-maintainer/replace" | "test-maintainer/adapt" | "reviewer/review" | "reviewer/relevance";

type Node = Record<string, unknown>;
const docs = new Map<string, Node>();
const readDoc = (file: string): Node => {
  let doc = docs.get(file);
  if (!doc) docs.set(file, (doc = readJson<Node>(file)));
  return doc;
};

// Inlines every $ref so the same schema works for Ajv and as a tool input schema (which may not resolve refs).
// A file in a $ref is relative to the schema that holds it.
function deref(node: unknown, doc: Node, file: string): unknown {
  if (Array.isArray(node)) return node.map((n) => deref(n, doc, file));
  if (!node || typeof node !== "object") return node;
  const obj = node as Node;
  if (typeof obj.$ref === "string") {
    const [ref, pointer] = obj.$ref.split("#");
    const targetFile = ref ? path.resolve(path.dirname(file), ref) : file;
    const target = ref ? readDoc(targetFile) : doc;
    const resolved = pointer.split("/").filter(Boolean).reduce<unknown>((n, key) => (n as Node)[key], target);
    return deref(resolved, target, targetFile);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deref(v, doc, file)]));
}

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new Map<SchemaName, { schema: Node; validate: ValidateFunction }>();

function load(name: SchemaName) {
  let entry = cache.get(name);
  if (!entry) {
    const file = path.join(ROLES_DIR, `${name}.json`);
    const raw = readDoc(file);
    const schema = deref(raw, raw, file) as Node;
    entry = { schema, validate: ajv.compile(schema) };
    cache.set(name, entry);
  }
  return entry;
}

export function schemaFor(name: SchemaName): Node {
  return load(name).schema;
}

export function checkSchema(name: SchemaName, value: unknown): string[] {
  const { validate } = load(name);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => {
    const extra = e.keyword === "enum" ? ` (${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")})` : "";
    return `${e.instancePath || "(root)"} ${e.message}${extra}`;
  });
}

const lineCounts = new Map<string, number>();

// Every cited file must exist under root and every cited line must be inside the file.
export function checkEvidence(root: string, evidence: Evidence[] | undefined, where: string): string[] {
  const errors: string[] = [];
  (evidence ?? []).forEach((e, i) => {
    const rel = toPosix(e.file).replace(/^\.\//, "");
    const full = path.resolve(root, rel);
    if (path.isAbsolute(e.file) || !full.startsWith(path.resolve(root))) {
      errors.push(`${where}.evidence[${i}]: '${e.file}' must be relative to the repository root.`);
      return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      errors.push(`${where}.evidence[${i}]: file '${e.file}' does not exist.`);
      return;
    }
    if (e.line !== undefined) {
      let count = lineCounts.get(full);
      if (count === undefined) {
        count = fs.readFileSync(full, "utf8").split(/\r?\n/).length;
        lineCounts.set(full, count);
      }
      if (e.line > count) errors.push(`${where}.evidence[${i}]: line ${e.line} is past the end of '${e.file}' (${count} lines).`);
    }
  });
  return errors;
}

export function citationKeys(evidence: Evidence[] | undefined): string[] {
  return (evidence ?? []).filter((e) => e.line !== undefined).map((e) => `${toPosix(e.file).replace(/^\.\//, "")}:${e.line}`);
}
