import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Role, Severity } from "./types.ts";
import { HarnessError, readJson } from "./util.ts";

export const HARNESS_DIR = path.resolve(import.meta.dirname, "..");

export interface AnalyzerConfig {
  skill: string;
  id_prefix: string;
  references: string[];
  analyze: string[];
  report: string[];
}

export interface Config {
  models: Record<Role, string>;
  debate: { max_rounds: number; max_challenges_per_round: number; medium_low_sample_rate: number; material_severity: Severity };
  retries: { validation: number; startup: number; rejections_per_turn: number };
  timeouts_minutes: Record<Role, number>;
  git: { host: string; remote: string; base_branch: string | null; pr_repo: string | null };
  work_dir: string | null;
  analysis: string;
  analyzers: Record<string, AnalyzerConfig>;
}

type Json = Record<string, unknown>;

export function merge(base: Json, override: Json): Json {
  const result: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
        ? merge(current as Json, value as Json)
        : value;
  }
  return result;
}

// Harness defaults, then the target repo's .tech-debt/config.json, then CLI overrides.
export function loadConfig(repoRoot: string, overrides: Json): Config {
  let config = readJson<Json>(path.join(HARNESS_DIR, "harness.config.json"));
  const repoConfig = path.join(repoRoot, ".tech-debt", "config.json");
  if (fs.existsSync(repoConfig)) config = merge(config, readJson<Json>(repoConfig));
  config = merge(config, overrides);

  const result = config as unknown as Config;
  for (const analyzer of Object.values(result.analyzers)) analyzer.skill = path.resolve(HARNESS_DIR, analyzer.skill);
  result.work_dir = path.resolve(result.work_dir ?? path.join(os.tmpdir(), "solid-loop"));
  if (!result.analyzers[result.analysis])
    throw new HarnessError(`No analyzer named '${result.analysis}'. Configured: ${Object.keys(result.analyzers).join(", ")}`);
  return result;
}

// `--set debate.max_rounds=1` style overrides.
export function parseSet(assignments: string[]): Json {
  const result: Json = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf("=");
    if (eq < 0) throw new HarnessError(`--set needs key=value, got '${assignment}'`);
    const keys = assignment.slice(0, eq).split(".");
    const raw = assignment.slice(eq + 1);
    let value: unknown = raw;
    try { value = JSON.parse(raw); } catch { /* plain string */ }
    let target = result;
    for (const key of keys.slice(0, -1)) target = (target[key] ??= {}) as Json;
    target[keys[keys.length - 1]] = value;
  }
  return result;
}
