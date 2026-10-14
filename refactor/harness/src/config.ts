import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Role, Severity } from "./types.ts";
import { HarnessError, readJson } from "./util.ts";

export const HARNESS_DIR = path.resolve(import.meta.dirname, "..");
/** One folder per agent role holding its prompts and submission schemas; shared/ holds what several roles use. */
export const ROLES_DIR = path.resolve(HARNESS_DIR, "..", "roles");

export interface LensConfig {
  /** Folder holding the lens: its analyzer, guide, and criteria. Relative paths resolve from the harness folder. */
  dir: string;
  id_prefix: string;
  /** Files under dir inlined into the analyst's prompt: the lens guide first, then its criteria. */
  references: string[];
  analyze: string[];
  report: string[];
}

export interface RefactorConfig {
  /** Highest complexity level the refactor phase attempts (references/refactor-phase.md section 6). Not a cost cap. */
  complexity_limit: number;
  /** Parallel screener agents during selection. */
  screen_concurrency: number;
  max_tests_per_item: number;
  /** How many times new tests run on the old code; any variation rejects them. */
  determinism_runs: number;
  /** Test projects the tester may add files to and the baseline runs. */
  test_projects: string[];
  /** Folders hidden from the planner and implementer (every folder holding test code). */
  test_dirs: string[];
  /** Tester risk at or above this level pauses for a person's approval before production code changes. */
  approval_risk: "low" | "medium" | "high";
  /** How long the run waits for that approval before leaving the item for later. */
  approval_timeout_minutes: number;
  /** Implementation attempts per item before it is given up and its complexity raised. */
  implement_attempts: number;
  /** Files outside the plan that the change reaches, found by searching the code, above which the floor is 4 rather than 3. */
  caller_threshold: number;
  /** Appended to the run id and branch names, so runs with different settings on the same commit stay apart. */
  run_label: string;
  toolchain: {
    /** Folder holding the dotnet executable; null uses the one on PATH. */
    dotnet_root: string | null;
    /** SDK pinned through a global.json above the work trees; null pins nothing. */
    sdk: string | null;
    env: Record<string, string>;
    build_args: string[];
  };
}

export interface Config {
  models: Record<Role, string>;
  debate: { max_rounds: number; max_challenges_per_round: number; medium_low_sample_rate: number; material_severity: Severity };
  retries: { validation: number; startup: number; rejections_per_turn: number };
  timeouts_minutes: Record<Role, number>;
  heartbeat: { inactivity_minutes: number; restarts: number };
  git: { host: string; remote: string; base_branch: string | null; pr_repo: string | null };
  work_dir: string | null;
  analysis: string;
  lenses: Record<string, LensConfig>;
  refactor: RefactorConfig;
  /** USD per million tokens, for cost per agent turn. */
  pricing: Record<string, { input: number; cache_write: number; cache_read: number; output: number }>;
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

// Harness defaults, then the target repo's .tech-debt/config.json, then a --config file, then CLI overrides.
export function loadConfig(repoRoot: string, overrides: Json, configFile?: string): Config {
  let config = readJson<Json>(path.join(HARNESS_DIR, "harness.config.json"));
  const repoConfig = path.join(repoRoot, ".tech-debt", "config.json");
  if (fs.existsSync(repoConfig)) config = merge(config, readJson<Json>(repoConfig));
  if (configFile) config = merge(config, readJson<Json>(path.resolve(configFile)));
  config = merge(config, overrides);

  if ("analyzers" in config) throw new HarnessError("The 'analyzers' config section is now 'lenses', and each entry's 'skill' is now 'dir'; rename them in your config.");
  const result = config as unknown as Config;
  for (const lens of Object.values(result.lenses)) lens.dir = path.resolve(HARNESS_DIR, lens.dir);
  result.work_dir = path.resolve(result.work_dir ?? path.join(os.tmpdir(), "quality"));
  for (const section of ["models", "timeouts_minutes"] as const)
    if ("refactorer" in result[section]) throw new HarnessError(`${section}.refactorer is now ${section}.planner; rename it in your config.`);
  if (!result.lenses[result.analysis])
    throw new HarnessError(`No lens named '${result.analysis}'. Configured: ${Object.keys(result.lenses).join(", ")}`);
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
