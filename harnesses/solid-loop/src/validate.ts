import fs from "node:fs";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { HARNESS_DIR } from "./config.ts";
import type { Evidence } from "./types.ts";
import { readJson, toPosix } from "./util.ts";

export type SchemaName = "review" | "challenges" | "responses" | "verdicts" | "summary" | "matches" | "register-item";

type Node = Record<string, unknown>;
const schemaDir = path.join(HARNESS_DIR, "schemas");
const common = readJson<Node>(path.join(schemaDir, "common.json"));

// Inlines every $ref so the same schema works for Ajv and as a tool input schema (which may not resolve refs).
function deref(node: unknown, doc: Node): unknown {
  if (Array.isArray(node)) return node.map((n) => deref(n, doc));
  if (!node || typeof node !== "object") return node;
  const obj = node as Node;
  if (typeof obj.$ref === "string") {
    const [file, pointer] = obj.$ref.split("#");
    const target = file ? (file === "common.json" ? common : readJson<Node>(path.join(schemaDir, file))) : doc;
    const resolved = pointer.split("/").filter(Boolean).reduce<unknown>((n, key) => (n as Node)[key], target);
    return deref(resolved, target);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deref(v, doc)]));
}

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new Map<SchemaName, { schema: Node; validate: ValidateFunction }>();

function load(name: SchemaName) {
  let entry = cache.get(name);
  if (!entry) {
    const raw = readJson<Node>(path.join(schemaDir, `${name}.json`));
    const schema = deref(raw, raw) as Node;
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
