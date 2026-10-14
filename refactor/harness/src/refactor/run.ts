import fs from "node:fs";
import path from "node:path";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import { READ_ONLY_TOOLS, RoleAgent, type AgentContext } from "../agents.ts";
import { runAnalyzer } from "../analyzer.ts";
import { loadConfig, type Config } from "../config.ts";
import { git, gitTry, isClean, isDisabledPushUrl, remoteHead, removeWorktree, repoRoot } from "../git.ts";
import { getHost } from "../hosts/index.ts";
import { loadItems, saveItem } from "../register/store.ts";
import { claim, markFixed } from "../register/transitions.ts";
import { apiKey, checkModels } from "../orchestrator.ts";
import { readPrompt } from "../prompts.ts";
import type { RegisterItem, Role, TurnRecord } from "../types.ts";
import { fill, HarnessError, log, now, sevRank, sleep, toPosix, writeJson, writeText } from "../util.ts";
import { Dotnet, resultsFor, type Diagnostic, type TestResult } from "./dotnet.ts";
import { assertionLines, countAssertions, existsAt, methodSource, projectDir, projectFor, RISK_LEVELS, runGates, testMethods, type AuditVerdict, type CoverageReview, type DeclaredTest, type GateReport, type RiskAssessment, type TestSubmission } from "./gates.ts";
import { checkPlan, complexity, isUnder, projectFile, vocabularyFor, vocabularyNames, type Complexity, type Plan, type PlanScope } from "./plan.ts";
import { changedTypes, findReferences, reachedFiles, referenceSummary, type Reference } from "./references.ts";

export interface RefactorOptions {
  repo: string;
  overrides: Record<string, unknown>;
  configFile?: string;
  itemsRef?: string;
  base?: string;
  /** Exactly these items, in this order, without screening. */
  items: string[];
  limit: number;
  /** Screen and rank the candidates, write selection.json, and stop. */
  select: boolean;
  /** A saved plan.json used instead of running the planner; needs exactly one --item. */
  planFile?: string;
  dryRun: boolean;
  push: boolean;
  verbose: boolean;
  keepWorktrees: boolean;
}

type Outcome = "deferred" | "escalated" | "planned" | "tests-accepted" | "tests-rejected" | "awaiting-approval" | "declined"
  | "plan-wrong" | "implementation-failed" | "tests-need-adapting" | "review-rejected" | "committed" | "proposed" | "failed";

interface ChangeReview {
  verdict: "approve" | "reject";
  resolved: { verdict: "yes" | "no"; evidence: string };
  findings: { kind: string; blocking: boolean; file: string; line?: number; detail: string }[];
  summary: string;
}

type Implementation = { outcome: "implemented" | "plan-wrong"; summary: string; deviations?: string[]; plan_problem?: string };

interface Approval { approved: boolean; note?: string; at: string }

interface VerifyReport {
  passed: boolean;
  attempt: number;
  build_errors: Diagnostic[];
  /** Tests that passed at baseline (or are the tester's) and fail now. */
  regressions: { name: string; project: string; tester: boolean; message: string }[];
  resolved: boolean;
  analyzer: string;
  scope_errors: string[];
  projects: { project: string; passed: number; failed: number }[];
}

interface CostedTurn extends TurnRecord { cost_usd?: number }

interface TestAuditVerdict { name: string; before: string; after: string; verdict: "same" | "changed"; reason: string }

interface RelevanceVerdict { name: string; verdict: "relevant" | "irrelevant"; changed_line?: string; mistake?: string; reason: string }

/** Verification of a test-code refactoring (references/tests.md section 7, case B). */
interface TestRefactorReport {
  passed: boolean;
  attempt: number;
  build_errors: Diagnostic[];
  /** Tests that passed at baseline and now fail, or no longer exist under their (possibly renamed) name. */
  regressions: { name: string; project: string; message: string }[];
  /** The test methods in the plan's files differ from before, beyond the declared renames. */
  inventory_errors: string[];
  scope_errors: string[];
  assertions: { before: number; after: number };
  audit: TestAuditVerdict[];
  projects: { project: string; passed: number; failed: number }[];
}

interface ItemRecord {
  id: string;
  title: string;
  severity: string;
  /** test-code: the item's file is test code, so the tester refactors it (references/tests.md section 7, case B). */
  target?: "production" | "test-code";
  outcome?: Outcome;
  reason?: string;
  complexity?: Complexity;
  tests?: number;
  risk?: RiskAssessment;
  /** Valid but expensive tests still in the change: flagged, and not replaced after implementation (references/tests.md section 7, case C). */
  needs_refactor?: { name: string; reason: string; after_refactor: string }[];
  /** Flagged tests removed after implementation, each replaced by a cheaper test that passed the gates (case C). */
  replaced?: { name: string; by: DeclaredTest }[];
  /** Why case C left the flagged tests in place, when it did. */
  replace_note?: string;
  /** Tests removed after the change because they guard nothing the final diff changed. */
  pruned?: { name: string; reason: string }[];
  /** Why the relevance check left every test in place, when it did. */
  relevance_note?: string;
  /** Existing test files adapted to the refactored surface (case A). */
  adapted?: { files: string[]; summary: string; audit: TestAuditVerdict[] };
  approval?: Approval;
  implementation?: { summary: string; deviations?: string[] };
  verify?: VerifyReport | TestRefactorReport;
  /** The fresh reviewer's verdict on the final diff, before the pull request. */
  review?: ChangeReview;
  branch?: string;
  pr?: string;
  turns: CostedTurn[];
  cost_usd: number;
  seconds: number;
}

interface Screen {
  item_id: string;
  level: number;
  approach: string;
  files: string[];
  reasons: string[];
}

interface ScreenRecord extends Screen {
  commit: string;
  model: string;
  cached: boolean;
  cost_usd?: number;
  usage?: { input: number; output: number; cache_read: number; cache_write: number };
  seconds: number;
}

interface RefactorManifest {
  schema_version: 1;
  run_id: string;
  mode: "select" | "dry-run" | "implement";
  repo_root: string;
  commit: string;
  items_ref: string;
  complexity_limit: number;
  models: Partial<Record<Role, string>>;
  dotnet: string;
  baseline?: { projects: { project: string; passed: number; failed: string[] }[] };
  screening?: ScreenRecord[];
  items: ItemRecord[];
  started_at: string;
  finished_at?: string;
}

const norm = (f: string): string => toPosix(f).replace(/^\.\//, "");

function loadItemsAt(root: string, ref: string): RegisterItem[] {
  const names = gitTry(root, "ls-tree", "--name-only", `${ref}:.tech-debt/items`);
  if (!names) throw new HarnessError(`No .tech-debt/items at '${ref}'. Pass --items-ref with a branch or commit that has the register.`);
  return names.split(/\r?\n/).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(git(root, "show", `${ref}:.tech-debt/items/${n}`)) as RegisterItem);
}

function promptItem(item: RegisterItem) {
  const { id, principle, criterion, severity, title, type, file, line, value, threshold, details, recommendation, evidence } = item;
  return { id, principle, criterion, severity, title, type, file, line, value, threshold, details, recommendation, evidence };
}

function cost(config: Config, role: Role, usage: TurnRecord["usage"]): number | undefined {
  const p = config.pricing[config.models[role]];
  if (!p || !usage) return undefined;
  const fresh = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  return +((fresh * p.input + usage.cacheWriteTokens * p.cache_write + usage.cacheReadTokens * p.cache_read + usage.outputTokens * p.output) / 1e6).toFixed(4);
}

export async function refactor(opts: RefactorOptions): Promise<void> {
  const root = repoRoot(opts.repo);
  const config = loadConfig(root, opts.overrides, opts.configFile);
  const fx = config.refactor;
  if (fx.test_projects.length === 0) throw new HarnessError("refactor.test_projects is empty. Set it in .tech-debt/config.json, a --config file, or with --set.");
  for (const p of fx.test_projects) if (!fs.existsSync(path.join(root, p))) throw new HarnessError(`Test project '${p}' does not exist in ${root}.`);
  if (!RISK_LEVELS.includes(fx.approval_risk)) throw new HarnessError(`refactor.approval_risk must be one of ${RISK_LEVELS.join(", ")}.`);
  const remote = config.git.remote;
  if (opts.planFile && (opts.select || opts.items.length !== 1)) throw new HarnessError("--plan needs exactly one --item and cannot be combined with --select.");
  const host = getHost(config.git.host);
  let originRepo = "";
  if (!opts.dryRun && !opts.select && opts.push) {
    const url = gitTry(root, "remote", "get-url", remote);
    originRepo = (url && host.repoFromUrl(url)) || "";
    if (!originRepo) throw new HarnessError(`'${remote}' (${url ?? "missing"}) is not a ${host.name} repository. Set git.host or git.remote, or pass --no-push.`);
    if (config.git.pr_repo && config.git.pr_repo.toLowerCase() !== originRepo.toLowerCase())
      throw new HarnessError(`'${remote}' points to ${originRepo} but git.pr_repo is ${config.git.pr_repo}; refusing to push somewhere unexpected.`);
    const upstreamPush = gitTry(root, "remote", "get-url", "--push", "upstream");
    if (upstreamPush !== undefined && !isDisabledPushUrl(upstreamPush))
      throw new HarnessError(`The 'upstream' remote is pushable (${upstreamPush}). Disable it first: git remote set-url --push upstream DISABLED`);
  }
  await checkModels(config);
  if (fx.run_label && !/^[a-z0-9][a-z0-9-]{0,19}$/.test(fx.run_label))
    throw new HarnessError(`refactor.run_label '${fx.run_label}' must be up to 20 lowercase letters, digits, or hyphens.`);
  const unpriced = [...new Set(Object.values(config.models).filter((m) => !config.pricing[m]))];
  if (unpriced.length) log(`Warning: no price in 'pricing' for ${unpriced.join(", ")}; their turns record tokens but no cost.`);

  log(`Fetching ${remote}...`);
  git(root, "fetch", remote);
  const base = opts.base ?? `${remote}/${config.git.base_branch ?? remoteHead(root, remote) ?? "main"}`;
  const commit = git(root, "rev-parse", `${base}^{commit}`);
  const itemsRef = opts.itemsRef ?? base;
  const items = loadItemsAt(root, itemsRef);

  const iso = new Date().toISOString();
  const runId = `refactor-${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z-${commit.slice(0, 7)}${fx.run_label ? `-${fx.run_label}` : ""}`;
  const workDir = path.join(config.work_dir!, runId);
  const outDir = path.join(workDir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outcomesLog = path.join(config.work_dir!, "refactor-outcomes.jsonl");
  const screensLog = path.join(config.work_dir!, "refactor-screens.jsonl");
  const dotnet = new Dotnet(fx.toolchain);
  dotnet.pinSdk(workDir);
  const worktrees: string[] = [];
  const addWorktree = (dir: string) => { git(root, "worktree", "add", "--detach", dir, commit); worktrees.push(dir); };
  // Production code only: the test folders are left out of the checkout, so read and search tools cannot reach them.
  const addSparseWorktree = (dir: string) => {
    git(root, "worktree", "add", "--no-checkout", "--detach", dir, commit);
    worktrees.push(dir);
    git(dir, "sparse-checkout", "set", "--no-cone", "/*", ...fx.test_dirs.map((d) => `!/${norm(d).replace(/\/$/, "")}/`));
    git(dir, "read-tree", "-mu", "HEAD");
  };
  const context = (cwd: string, onTurn: (t: TurnRecord) => void, afterRun: (role: string) => void = () => undefined): AgentContext => ({
    apiKey: apiKey(), cwd, config, runId, verbose: opts.verbose, eventLog: path.join(workDir, "events.jsonl"), onTurn, afterRun,
  });
  const rubric = readPrompt("shared/complexity-rubric");
  // The baseline work tree is a full checkout at the base commit, so this search sees the test code the planner cannot.
  const references = (plan: Plan, item: RegisterItem): Reference[] =>
    findReferences(path.join(workDir, "baseline"), changedTypes(plan, item.type), plan.files, fx.test_dirs);
  /** Production projects holding a file the change reaches; built with the implementer's tool and in verification. */
  const reachedProjects = (plan: Plan, refs: Reference[], cwd: string): string[] =>
    [...new Set(reachedFiles(refs.filter((r) => !r.test), plan).map((f) => projectFile(f, cwd)).filter((p): p is string => !!p))];

  const buildAll = async (cwd: string, projects: string[]): Promise<Diagnostic[]> => {
    const errors: Diagnostic[] = [];
    for (const p of projects) errors.push(...(await dotnet.build(cwd, p)).errors);
    return errors;
  };
  const describeBuild = (e: Diagnostic[]) => e.slice(0, 30).map((d) => `Build error ${d.code} at ${d.file}:${d.line}: ${d.message}`);
  const buildTool = (cwd: string, projects: string[]): SDKCustomTool => ({
    description: `Build ${projects.join(", ")} and return the compiler errors.`,
    inputSchema: { type: "object", properties: {} } as Record<string, SDKJsonValue>,
    execute: async () => { const e = await buildAll(cwd, projects); return e.length ? `Build failed:\n${describeBuild(e).join("\n")}` : "Build succeeded."; },
  });
  const runTestsTool = (cwd: string, resultsDir: string, against: string): SDKCustomTool => ({
    description: `Build a test project and run tests against ${against}. project: one of ${fx.test_projects.join(", ")}. tests: fully qualified method names (Namespace.Class.Method); omit to run the whole project.`,
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" }, tests: { type: "array", items: { type: "string" } } } } as Record<string, SDKJsonValue>,
    execute: async (args) => {
      const { project, tests } = args as { project: string; tests?: string[] };
      if (!fx.test_projects.includes(project)) return { isError: true, content: [{ type: "text" as const, text: `project must be one of: ${fx.test_projects.join(", ")}` }] };
      const r = await dotnet.test(cwd, project, { tests, resultsDir });
      if (!r.built) return `Build failed:\n${r.errors.slice(0, 30).map((e) => `${e.file}:${e.line} ${e.code} ${e.message}`).join("\n")}`;
      return formatResults(r.results, tests);
    },
  });
  /** Writes new test files only: `taken` says whether a path not yet written by this tool already exists. */
  const writeTestFileTool = (cwd: string, written: Set<string>, taken: (file: string) => boolean): SDKCustomTool => {
    const writable = fx.test_projects.map(projectDir);
    return {
      description: `Create or overwrite one of your new test files. Path relative to the repository root, ending in .cs, inside one of: ${writable.join(", ")}. Existing repository files cannot be changed.`,
      inputSchema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } as Record<string, SDKJsonValue>,
      execute: async (args) => {
        const { path: rel, content } = args as { path: string; content: string };
        const file = norm(rel ?? "");
        const full = path.resolve(cwd, file);
        const error = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
        if (!file.endsWith(".cs") || path.isAbsolute(file) || file.includes("..") || !full.startsWith(path.resolve(cwd))) return error("Path must be relative to the repository root and end in .cs.");
        if (!projectFor(file, fx.test_projects)) return error(`'${file}' is not inside a test project you may write to: ${writable.join(", ")}.`);
        if (!written.has(file) && taken(file)) return error(`'${file}' already exists; write a new file instead.`);
        if (typeof content !== "string" || content.length > 200_000) return error("content must be a string under 200 KB.");
        writeText(full, content);
        written.add(file);
        return `Wrote ${file} (${content.split("\n").length} lines).`;
      },
    };
  };
  /** Accepts an implementation only when it changed something, stayed within the plan's files, and builds. */
  const implementationSubmission = (role: string, cwd: string, projects: string[], outOfScope: () => string[]) => ({
    tool: "submit_implementation", description: "Submit when the plan is applied and the build succeeds, or report that the plan is wrong.", schema: "implementer/implement" as const,
    check: async (r: Implementation): Promise<string[]> => {
      if (r.outcome === "plan-wrong") return r.plan_problem?.trim() ? [] : ["plan_problem is required when outcome is plan-wrong."];
      const errors = outOfScope().map((f) => `'${f}' is not in the plan's files; revert your change to it.`);
      if (changedFiles(cwd).length === 0) errors.push("Nothing has changed. Apply the plan before submitting.");
      if (errors.length > 0) return errors;
      log(`[${role}] building ${projects.join(", ")}...`);
      return describeBuild(await buildAll(cwd, projects));
    },
  });
  /** The complexity gate: returns undefined, recording the item as deferred, when the effective level is above the limit. */
  const complexityGate = (plan: Plan, item: RegisterItem, cwd: string, record: ItemRecord, dir: string, refs: Reference[], scope: PlanScope["kind"]): Complexity | undefined => {
    const c = record.complexity = complexity(plan, item, cwd, refs, scope, fx.caller_threshold);
    writeJson(path.join(dir, "gate.json"), { ...c, complexity_limit: fx.complexity_limit });
    writeJson(path.join(dir, "references.json"), { types: changedTypes(plan, item.type), references: refs });
    log(`Complexity: agent ${c.agent}, floor ${c.floor}${c.floor_reasons.length ? ` (${c.floor_reasons.join("; ")})` : ""}, effective ${c.effective}.`);
    if (c.effective <= fx.complexity_limit) return c;
    record.outcome = "deferred";
    record.reason = `Effective complexity ${c.effective} is above the complexity limit of ${fx.complexity_limit}.`;
    return undefined;
  };

  const inFlight = refactorsInFlight();
  const busy = opts.items.filter((id) => inFlight.has(id));
  if (busy.length)
    throw new HarnessError(`Already in review: ${busy.map((id) => `${id} (${inFlight.get(id)})`).join("; ")}. Close the pull request or delete the branch to release it, or leave it out of --item.`);
  const open = openItems(items, opts.items, outcomesLog, fx.complexity_limit).filter((i) => {
    if (!inFlight.has(i.id)) return true;
    log(`Skipping ${i.id}: ${inFlight.get(i.id)}.`);
    return false;
  });
  if (open.length === 0) throw new HarnessError("No open items to attempt.");
  log(`Refactor ${opts.select ? "selection" : opts.dryRun ? "dry run" : `run (implement${opts.push ? ", push and open a PR" : ", commit without pushing"})`} ${runId}: ${items.length} register items from ${itemsRef}; base ${base} @ ${commit.slice(0, 7)}; complexity limit ${fx.complexity_limit}.`);
  log(`Work directory: ${workDir}`);

  const manifest: RefactorManifest = {
    schema_version: 1, run_id: runId, mode: opts.select ? "select" : opts.dryRun ? "dry-run" : "implement", repo_root: root, commit, items_ref: itemsRef, complexity_limit: fx.complexity_limit,
    models: { screener: config.models.screener, planner: config.models.planner, tester: config.models.tester, auditor: config.models.auditor, reviewer: config.models.reviewer,
      implementer: config.models.implementer, test_maintainer: config.models.test_maintainer, coverage_reviewer: config.models.coverage_reviewer },
    dotnet: "", items: [], started_at: now(),
  };
  const save = () => writeJson(path.join(outDir, "manifest.json"), manifest);
  const present = new Set<string>();
  const baselinePassed = new Map<string, Set<string>>();

  try {
    // 1. Baseline health: build and run every configured test project; pre-existing failures never block, new ones do.
    log("== baseline");
    const baselineDir = path.join(workDir, "baseline");
    addWorktree(baselineDir);
    manifest.dotnet = await dotnet.version(baselineDir);
    manifest.baseline = { projects: [] };
    // Selection only needs the analyzer's view of the code; test health matters once an item is attempted.
    for (const project of opts.select ? [] : fx.test_projects) {
      const r = await dotnet.test(baselineDir, project, { resultsDir: path.join(outDir, "baseline-results") });
      if (!r.built) throw new HarnessError(`Baseline build of ${project} failed with SDK ${manifest.dotnet}:\n${r.errors.slice(0, 10).map((e) => `${e.file}:${e.line} ${e.code} ${e.message}`).join("\n")}`);
      const failed = r.results.filter((t) => t.outcome !== "Passed").map((t) => t.name);
      baselinePassed.set(project, new Set(r.results.filter((t) => t.outcome === "Passed").map((t) => t.name)));
      manifest.baseline.projects.push({ project, passed: r.results.length - failed.length, failed });
      log(`${project}: ${r.results.length - failed.length} passed, ${failed.length} failing before any change${failed.length ? ` (${failed.join(", ")})` : ""}`);
    }
    const metrics = await runAnalyzer(config.lenses[config.analysis], baselineDir, path.join(outDir, "baseline-metrics.json"), path.join(workDir, "empty-register"));
    for (const f of metrics.findings) present.add(f.id);
    save();

    const stillThere = open.filter((i) => i.source !== "metric" || present.has(i.id));
    if (stillThere.length < open.length) log(`${open.length - stillThere.length} open item(s) are no longer reported by the analyzer at ${commit.slice(0, 7)}; skipped.`);
    let candidates: RegisterItem[];
    if (opts.items.length) candidates = stillThere;
    else {
      log(`== screening ${stillThere.length} item(s)`);
      manifest.screening = await screen(stillThere);
      save();
      const level = new Map(manifest.screening.map((s) => [s.item_id, s.level]));
      candidates = stillThere.filter((i) => (level.get(i.id) ?? Infinity) <= fx.complexity_limit).sort((a, b) =>
        level.get(a.id)! - level.get(b.id)! || sevRank(b.severity) - sevRank(a.severity)
        || Number(a.source !== "metric") - Number(b.source !== "metric") || a.id.localeCompare(b.id));
      const counts = [1, 2, 3, 4, 5].map((n) => `${n}: ${manifest.screening!.filter((s) => s.level === n).length}`).join(", ");
      log(`Screened levels (${counts}); ${candidates.length} within the limit of ${fx.complexity_limit}.`);
      if (opts.select) {
        writeSelection(stillThere, candidates);
        return;
      }
    }
    if (!opts.items.length) candidates = candidates.slice(0, opts.limit);
    if (candidates.length === 0) throw new HarnessError(`No items screened within the complexity limit of ${fx.complexity_limit}.`);
    log(`Attempting: ${candidates.map((c) => `${c.id} (${c.severity} ${c.principle}/${c.criterion ?? "review"} ${c.type.split(".").at(-1)})`).join(", ")}`);

    for (const item of candidates) {
      const record: ItemRecord = { id: item.id, title: item.title, severity: item.severity, turns: [], cost_usd: 0, seconds: 0 };
      manifest.items.push(record);
      log(`== ${item.id}: ${item.title}`);
      try {
        await attempt(item, record);
      } catch (e) {
        record.outcome = "failed";
        record.reason = e instanceof Error ? e.message : String(e);
        log(`${item.id} failed: ${record.reason}`);
      }
      record.cost_usd = +record.turns.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0).toFixed(2);
      record.seconds = Math.round(record.turns.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0) / 1000);
      fs.appendFileSync(outcomesLog, JSON.stringify({ at: now(), run: runId, item: item.id, target: record.target, outcome: record.outcome, complexity_limit: fx.complexity_limit, complexity: record.complexity, tests: record.tests, needs_refactor: record.needs_refactor?.length, replaced: record.replaced?.length, risk: record.risk?.level, branch: record.branch, pr: record.pr, cost_usd: record.cost_usd, tokens: tokenTotals(record.turns), seconds: record.seconds, by_role: byRole(record.turns, config.models), review: record.review?.verdict, label: fx.run_label || undefined, reason: record.reason }) + "\n");
      save();
    }
  } finally {
    manifest.finished_at = now();
    save();
    if (!opts.keepWorktrees) for (const dir of worktrees) removeWorktree(root, dir);
  }

  log("== summary");
  for (const r of manifest.items)
    log(`${r.id} ${r.outcome}${r.complexity ? ` (complexity: agent ${r.complexity.agent}, floor ${r.complexity.floor}, effective ${r.complexity.effective})` : ""}${r.tests ? `, ${r.tests} tests` : ""}${r.risk ? `, risk ${r.risk.level}` : ""}${r.pr ? `, PR ${r.pr}` : r.branch ? `, branch ${r.branch}` : ""}; $${r.cost_usd}, ${r.seconds}s${r.reason ? `: ${r.reason.split("\n")[0]}` : ""}`);
  log(`Outputs: ${outDir}`);

  /**
   * --select: the ranked candidates, for a person to choose which items to run (for example the same items under
   * different settings). Written as selection.json and printed with an --item list for the top --limit.
   */
  function writeSelection(screened: RegisterItem[], within: RegisterItem[]): void {
    const screens = new Map(manifest.screening!.map((s) => [s.item_id, s]));
    const row = (i: RegisterItem, rank?: number) => {
      const s = screens.get(i.id);
      return {
        ...(rank ? { rank } : {}), id: i.id, level: s?.level, severity: i.severity, principle: i.principle, criterion: i.criterion ?? null,
        type: i.type, source: i.source, title: i.title, file: i.file, approach: s?.approach, files: s?.files,
      };
    };
    const inside = new Set(within.map((i) => i.id));
    const file = path.join(outDir, "selection.json");
    writeJson(file, {
      run_id: runId, base, commit, items_ref: itemsRef, complexity_limit: fx.complexity_limit, screener: config.models.screener,
      candidates: within.map((i, n) => row(i, n + 1)),
      above_limit: screened.filter((i) => !inside.has(i.id) && screens.has(i.id)).map((i) => row(i)),
      not_screened: screened.filter((i) => !screens.has(i.id)).map((i) => i.id),
    });
    log("== selection");
    for (const [n, i] of within.entries()) {
      const s = screens.get(i.id)!;
      log(`${String(n + 1).padStart(3)}. ${i.id}  level ${s.level}  ${i.severity.padEnd(8)} ${i.principle}/${i.criterion ?? "review"} ${i.type.split(".").at(-1)}  ${i.file}`);
      log(`       ${i.title}`);
    }
    log(`Candidates, with each screener's approach and files: ${file}`);
    log(`Next, run the same items under each configuration, for example: --item ${within.slice(0, opts.limit).map((i) => i.id).join(",")}`);
  }

  /** A cheap model estimates each item's complexity so only items likely within the limit get a full plan. Cached per item and commit. */
  async function screen(pending: RegisterItem[]): Promise<ScreenRecord[]> {
    const model = config.models.screener;
    const cached = new Map<string, ScreenRecord>();
    if (fs.existsSync(screensLog))
      for (const line of fs.readFileSync(screensLog, "utf8").split(/\r?\n/).filter(Boolean)) {
        const s = JSON.parse(line) as ScreenRecord;
        if (s.commit === commit && s.model === model) cached.set(s.item_id, { ...s, cached: true });
      }
    const todo = pending.filter((i) => !cached.has(i.id));
    log(`${pending.length - todo.length} cached, ${todo.length} to screen with ${model}.`);
    const results: ScreenRecord[] = pending.flatMap((i) => cached.get(i.id) ?? []);
    if (todo.length === 0) return results;

    // Production items are screened without the test folders; test-code items need them.
    const screenDirs = new Map<boolean, string>();
    const dirFor = (item: RegisterItem) => {
      const tests = isUnder(item.file, fx.test_dirs);
      let dir = screenDirs.get(tests);
      if (!dir) {
        dir = path.join(workDir, tests ? "screen-tests" : "screen");
        if (tests) addWorktree(dir); else addSparseWorktree(dir);
        screenDirs.set(tests, dir);
      }
      return dir;
    };
    const queue = [...todo];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const screenDir = dirFor(item);
        const turns: CostedTurn[] = [];
        const screener = await RoleAgent.create("screener", context(screenDir, (t) => turns.push({ ...t, cost_usd: cost(config, t.role, t.usage) }), (role) => {
          const { clean, changes } = isClean(screenDir);
          if (!clean) throw new HarnessError(`The ${role} changed files:\n${changes}`, 2);
        }));
        const current = item;
        try {
          const s = await screener.turn<Screen>("screen", fill(readPrompt("screener/screen"), {
            tool: "submit_screen", worktree: toPosix(screenDir), item_json: JSON.stringify(promptItem(current), null, 2), complexity_limit: fx.complexity_limit, rubric,
          }), {
            tool: "submit_screen", description: "Submit the complexity estimate for this item.", schema: "screener/screen",
            check: (r) => (r.item_id === current.id ? [] : [`item_id must be '${current.id}'.`]),
          });
          const priced = turns.filter((t) => t.cost_usd !== undefined);
          const record: ScreenRecord = {
            ...s, commit, model, cached: false,
            cost_usd: priced.length ? +priced.reduce((sum, t) => sum + t.cost_usd!, 0).toFixed(4) : undefined,
            usage: tokenTotals(turns),
            seconds: Math.round(turns.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0) / 1000),
          };
          results.push(record);
          fs.appendFileSync(screensLog, JSON.stringify({ at: now(), run: runId, ...record }) + "\n");
          log(`[screener] ${current.id} (${current.severity} ${current.principle}/${current.criterion ?? "review"} ${current.type.split(".").at(-1)}): level ${s.level}. ${s.approach}`);
        } catch (e) {
          log(`[screener] ${current.id} failed; left out of this run: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        } finally {
          await screener.dispose();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(fx.screen_concurrency, todo.length)) }, worker));
    return results;
  }

  async function attempt(item: RegisterItem, record: ItemRecord): Promise<void> {
    const dir = path.join(outDir, "items", item.id);
    const agentContext = (cwd: string, afterRun: (role: string) => void): AgentContext =>
      context(cwd, (t) => { record.turns.push({ ...t, cost_usd: cost(config, t.role, t.usage) }); save(); }, afterRun);
    if (isUnder(item.file, fx.test_dirs)) {
      record.target = "test-code";
      return refactorTestCode(item, record, dir, agentContext);
    }
    record.target = "production";

    // 2. Plan, in a sparse work tree that holds no test code.
    const refactorDir = path.join(workDir, "items", item.id, "refactor");
    addSparseWorktree(refactorDir);
    const vocabularyText = readPrompt("shared/refactoring-vocabulary");
    const vocabulary = vocabularyNames(vocabularyText);
    const criteria = fs.readFileSync(path.join(config.lenses[config.analysis].dir, "references", "criteria.md"), "utf8");
    const checkThisPlan = (p: Plan) => checkPlan(p, item, refactorDir, vocabulary, { kind: "production", testDirs: fx.test_dirs }, references(p, item));
    let plan: Plan;
    if (opts.planFile) {
      plan = JSON.parse(fs.readFileSync(opts.planFile, "utf8")) as Plan;
      const problems = plan.item_id === item.id ? checkThisPlan(plan) : [`item_id is '${plan.item_id}', not '${item.id}'.`];
      if (problems.length > 0) throw new HarnessError(`The saved plan ${opts.planFile} does not fit this commit:\n- ${problems.join("\n- ")}`);
      log(`[planner] skipped; using the saved plan ${opts.planFile}`);
    } else {
      const planner = await RoleAgent.create("planner", agentContext(refactorDir, (role) => {
        const { clean, changes } = isClean(refactorDir);
        if (!clean) throw new HarnessError(`The ${role} changed files while planning:\n${changes}`, 2);
      }));
      try {
        plan = await planner.turn<Plan>("plan", fill(readPrompt("planner/plan"), {
          tool: "submit_plan", worktree: toPosix(refactorDir), item_json: JSON.stringify(promptItem(item), null, 2),
          criteria, vocabulary: vocabularyText, rubric, complexity_limit: fx.complexity_limit,
        }), {
          tool: "submit_plan", description: "Submit the refactoring plan for this item.", schema: "planner/plan",
          check: checkThisPlan,
        });
      } finally {
        await planner.dispose();
      }
    }
    writeJson(path.join(dir, "plan.json"), plan);

    // 3. Gate.
    const refs = references(plan, item);
    const gated = complexityGate(plan, item, refactorDir, record, dir, refs, "production");
    if (!gated) return;
    record.complexity = gated;

    // 4-5. Characterization tests, accepted only when they pass every gate.
    const testsDir = path.join(workDir, "items", item.id, "tests");
    addWorktree(testsDir);
    const written = new Set<string>();
    const resultsDir = path.join(dir, "test-results");
    let lastReport: GateReport | undefined;
    const tester = await RoleAgent.create("tester", agentContext(testsDir, (role) => {
      const changes = git(testsDir, "status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean);
      const bad = changes.filter((l) => !l.startsWith("?? ") || !written.has(norm(l.slice(3))));
      if (bad.length > 0) throw new HarnessError(`The ${role} changed files outside its own new test files:\n${bad.join("\n")}`, 2);
    }));
    const tools: Record<string, SDKCustomTool> = {
      write_test_file: writeTestFileTool(testsDir, written, (file) => existsAt(testsDir, commit, file)),
      run_tests: runTestsTool(testsDir, resultsDir, "the current production code"),
    };
    let submission: TestSubmission;
    try {
      submission = await tester.turn<TestSubmission>("tests", fill(readPrompt("tester/characterize"), {
        tool: "submit_tests", worktree: toPosix(testsDir), item_json: JSON.stringify(promptItem(item), null, 2), plan_json: JSON.stringify(plan, null, 2),
        refactorings: vocabularyFor(readPrompt("shared/refactoring-vocabulary"), plan),
        references_json: JSON.stringify(referenceSummary(refs, changedTypes(plan, item.type), true), null, 2),
        test_projects: fx.test_projects.map((p) => `\`${p}\``).join(", "), max_tests: fx.max_tests_per_item, determinism_runs: fx.determinism_runs,
      }), {
        tool: "submit_tests", description: "Submit your characterization tests (or an escalation). The program runs every gate before accepting.", schema: "tester/characterize",
        check: async (sub) => {
          log(`[tester] running gates on ${sub.outcome === "escalate" ? "an escalation" : `${sub.tests?.length ?? 0} test(s)`}...`);
          lastReport = await runGates(sub, {
            worktree: testsDir, testProjects: fx.test_projects, testDirs: fx.test_dirs, maxTests: fx.max_tests_per_item,
            determinismRuns: fx.determinism_runs, dotnet, resultsDir, written,
            planPoints: { steps: plan.steps.length, change_points: plan.change_points.length, risks: plan.risks.length },
            changedConstructors: [...new Set(plan.change_points.filter((c) => /constructor|\bctor\b/i.test(c.member)).map((c) => c.type.split(".").at(-1)!))],
            audit, reviewCoverage,
          });
          log(`[tester] gates: ${lastReport.passed ? "passed" : `failed at ${lastReport.stage} (${lastReport.errors.length} problem(s))`}`);
          return lastReport.errors;
        },
      }, tools);
    } catch (e) {
      if (lastReport) writeJson(path.join(dir, "test-gates.json"), lastReport);
      copyTests(testsDir, written, dir);
      record.outcome = "tests-rejected";
      record.reason = `${e instanceof Error ? e.message : String(e)}${lastReport ? ` Last gate failure (${lastReport.stage}): ${lastReport.errors[0] ?? ""}` : ""}`;
      return;
    } finally {
      await tester.dispose();
    }
    writeJson(path.join(dir, "tests.json"), submission);
    if (lastReport) writeJson(path.join(dir, "test-gates.json"), lastReport);
    copyTests(testsDir, written, dir);
    if (submission.outcome === "escalate") {
      const proposed = submission.escalation!.proposed_complexity;
      record.complexity = { ...record.complexity, effective: Math.max(record.complexity.effective, proposed), floor_reasons: [...record.complexity.floor_reasons, `${proposed}: tester escalated`] };
      record.outcome = "escalated";
      record.reason = submission.escalation!.reason;
      return;
    }
    record.outcome = "tests-accepted";
    record.tests = submission.tests!.length;
    const risk = record.risk = submission.risk!;
    log(`Tester risk: ${risk.level}${risk.uncovered.length ? `; not covered: ${risk.uncovered.join("; ")}` : ""}`);
    const flagged = submission.tests!.filter((t) => t.needs_refactor);
    if (flagged.length > 0) {
      record.needs_refactor = flagged.map((t) => ({ name: t.name, ...t.needs_refactor! }));
      log(`${flagged.length} test(s) flagged needs_refactor, to rewrite after implementation: ${flagged.map((t) => t.name.split(".").at(-1)).join(", ")}`);
    }
    if (risk.proposed_complexity && risk.proposed_complexity > record.complexity.effective) {
      record.complexity = { ...record.complexity, effective: risk.proposed_complexity, floor_reasons: [...record.complexity.floor_reasons, `${risk.proposed_complexity}: tester risk assessment`] };
      log(`Complexity raised to ${risk.proposed_complexity} by the tester's risk assessment.`);
      if (risk.proposed_complexity > fx.complexity_limit) {
        record.outcome = "escalated";
        record.reason = `The tester rated the item complexity ${risk.proposed_complexity}, above the limit of ${fx.complexity_limit}: ${risk.reasoning}`;
        return;
      }
    }
    if (opts.dryRun) return;

    // Approval: a person decides whether the tests protect enough to let the implementer change code.
    if (RISK_LEVELS.indexOf(risk.level) >= RISK_LEVELS.indexOf(fx.approval_risk)) {
      const approval = await awaitApproval(item, plan, submission, dir);
      if (!approval) {
        record.outcome = "awaiting-approval";
        record.reason = `Risk ${risk.level} needs approval (threshold ${fx.approval_risk}); none arrived within ${fx.approval_timeout_minutes} minutes. Write approval.json in ${dir} and re-run.`;
        return;
      }
      record.approval = approval;
      if (!approval.approved) {
        record.outcome = "declined";
        record.reason = `Declined at approval${approval.note ? `: ${approval.note}` : ""}.`;
        return;
      }
      log(`[approval] approved${approval.note ? `: ${approval.note}` : ""}`);
    }

    // 6-7. Implement in the sparse work tree, then verify in a full one.
    const implemented = await implementAndVerify(item, record, plan, submission, refactorDir, testsDir, written, dir, reachedProjects(plan, refs, refactorDir), agentContext);
    if (!implemented) return;

    // Case C: the refactoring created the seams the flagged tests were waiting for.
    if (record.needs_refactor?.length) await replaceFlagged(item, record, plan, submission, implemented, written, dir, agentContext);

    // Every test the pull request keeps must guard something the final diff changed.
    await pruneIrrelevant(record, plan, submission, implemented, written, dir, agentContext);

    // 8. Review the final diff, then propose.
    const reviewed = await reviewChange(item, record, plan, implemented, dir, agentContext, [
      "- Every configured test project builds and passes, except tests that already failed before the change.",
      "- The tester's characterization tests, written before the change, run unchanged and pass.",
      `- Analyzer: ${(record.verify as VerifyReport).analyzer}`,
      "- The diff touches only the plan's files and the test files listed below.",
    ], [
      `The tester's risk rating, including what its tests do not cover:\n\n\`\`\`json\n${JSON.stringify(record.risk, null, 2)}\n\`\`\``,
      record.adapted ? `Existing tests adapted to the new surface (calls and construction only; a reviewer confirmed each verifies the same behavior): ${record.adapted.files.join(", ")}.` : "",
      record.replaced?.length ? `Expensive tests replaced after the change by cheaper ones a reviewer confirmed protect the same behavior: ${record.replaced.map((r) => `${r.name} by ${r.by.name}`).join("; ")}.` : "",
      record.pruned?.length ? `Tests removed before this review because they guard nothing this diff changed (they passed on both versions): ${record.pruned.map((p) => p.name).join("; ")}.` : "",
    ]);
    if (!reviewed) return;
    await propose(item, record, implemented, [...plan.files, ...written, ...(record.adapted?.files ?? [])], `${plan.goal}\n\nCharacterization tests by the tester agent.`, () => prBody(item, record, plan, submission));

    function audit(file: string, content: string, tests: DeclaredTest[], failures: Map<string, string>): Promise<AuditVerdict[]> {
      return auditNames(testsDir, file, content, tests, failures, agentContext);
    }

    async function reviewCoverage(sub: TestSubmission): Promise<CoverageReview> {
      const reviewer = await RoleAgent.create("coverage_reviewer", agentContext(testsDir, () => undefined));
      try {
        const tests = sub.tests!.map((t) => ({ name: t.name, file: t.file, kind: t.kind, behavior: t.behavior, protects: t.protects, ...(t.wiring ? { wiring: true } : {}), ...(t.needs_refactor ? { needs_refactor: t.needs_refactor } : {}) }));
        const review = await reviewer.turn<CoverageReview>("coverage", fill(readPrompt("coverage-reviewer/coverage"), {
          tool: "submit_coverage", worktree: toPosix(testsDir), plan_json: JSON.stringify(plan, null, 2),
          refactorings: vocabularyFor(readPrompt("shared/refactoring-vocabulary"), plan),
          references_json: JSON.stringify(referenceSummary(refs, changedTypes(plan, item.type), true), null, 2),
          coverage_json: JSON.stringify(sub.coverage, null, 2), tests_json: JSON.stringify(tests, null, 2), risk_json: JSON.stringify(sub.risk, null, 2),
        }), {
          tool: "submit_coverage", description: "Submit your coverage verdict and every gap you found.", schema: "coverage-reviewer/coverage",
          check: (r) => r.verdict === "insufficient" && r.findings.length === 0 ? ["An insufficient verdict must name at least one gap in findings."] : [],
        });
        log(`[coverage] ${review.verdict}${review.findings.length ? `: ${review.findings.map((f) => `${f.kind} ${f.subject}`).join("; ")}` : ""}`);
        return review;
      } finally {
        await reviewer.dispose();
      }
    }
  }

  /** The test auditor: does each test's name and declared behavior match what its assertions check, and does its sabotage break that behavior? */
  async function auditNames(
    cwd: string, file: string, content: string, tests: DeclaredTest[], failures: Map<string, string>,
    agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext,
  ): Promise<AuditVerdict[]> {
    const auditor = await RoleAgent.create("auditor", agentContext(cwd, () => undefined));
    try {
      const declared = tests.map((t) => ({
        name: t.name, behavior: t.behavior, ...(t.wiring ? { wiring: true } : {}),
        sabotage: t.sabotage, failed_under_sabotage_with: failures.get(t.name) ?? "",
      }));
      const result = await auditor.turn<{ verdicts: AuditVerdict[] }>("audit", fill(readPrompt("auditor/names"), {
        tool: "submit_audit", file, content, tests_json: JSON.stringify(declared, null, 2),
      }), {
        tool: "submit_audit", description: "Submit one verdict per declared test.", schema: "auditor/names",
        check: (r) => {
          const names = new Set(r.verdicts.map((v) => v.name));
          return tests.filter((t) => !names.has(t.name)).map((t) => `Missing a verdict for ${t.name}.`);
        },
      });
      return result.verdicts;
    } finally {
      await auditor.dispose();
    }
  }

  /**
   * references/tests.md section 7, case C: after verification, replace each needs_refactor test with the cheaper test the refactoring made possible.
   * A flagged test is removed only once its replacement passes the gates, the comparison review, and a final run. Never fails the item: on any problem the flagged tests stay.
   */
  async function replaceFlagged(
    item: RegisterItem, record: ItemRecord, plan: Plan, sub: TestSubmission, verifyDir: string, written: Set<string>, dir: string,
    agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext,
  ): Promise<void> {
    const flagged = record.needs_refactor!;
    const declared = new Map(sub.tests!.map((t) => [t.name, t]));
    log(`== replace ${flagged.length} needs_refactor test(s)`);
    const added = new Set<string>();
    const resultsDir = path.join(dir, "replace-results");
    const dropAdded = () => { for (const f of added) fs.rmSync(path.join(verifyDir, f), { force: true }); };
    const allowed = () => new Set([...plan.files, ...written, ...added, ...(record.adapted?.files ?? [])].map((f) => norm(f).toLowerCase()));
    const tester = await RoleAgent.create("test_maintainer", agentContext(verifyDir, (role) => {
      const bad = changedFiles(verifyDir).filter((f) => !allowed().has(f.toLowerCase()));
      if (bad.length > 0) throw new HarnessError(`The ${role} changed files outside its new test files:\n${bad.join("\n")}`, 2);
    }));
    type Entry = { replaces: string; test?: DeclaredTest; not_possible?: { reason: string; after_refactor: string } };
    let lastReport: GateReport | undefined;
    let comparison: TestAuditVerdict[] = [];
    let entries: Entry[];
    try {
      ({ replacements: entries } = await tester.turn<{ replacements: Entry[] }>("replace", fill(readPrompt("test-maintainer/replace"), {
        tool: "submit_replacements", worktree: toPosix(verifyDir), test_projects: fx.test_projects.map((p) => `\`${p}\``).join(", "),
        item_json: JSON.stringify(promptItem(item), null, 2), plan_json: JSON.stringify(plan, null, 2), determinism_runs: fx.determinism_runs,
        flagged_json: JSON.stringify(flagged.map((f) => ({ name: f.name, file: declared.get(f.name)?.file, behavior: declared.get(f.name)?.behavior, reason: f.reason, after_refactor: f.after_refactor })), null, 2),
      }), {
        tool: "submit_replacements", description: "Submit one entry per flagged test: its replacement, or why one is still not possible.", schema: "test-maintainer/replace",
        check: async (r) => {
          const errors: string[] = [];
          for (const f of flagged) {
            const n = r.replacements.filter((e) => e.replaces === f.name).length;
            if (n !== 1) errors.push(`${f.name}: needs exactly one entry; found ${n}.`);
          }
          for (const e of r.replacements) {
            if (!flagged.some((f) => f.name === e.replaces)) errors.push(`'${e.replaces}' is not a flagged test.`);
            if (!e.test === !e.not_possible) errors.push(`${e.replaces}: give either test or not_possible.`);
          }
          if (errors.length > 0) return errors;
          const tests = r.replacements.flatMap((e) => (e.test ? [e.test] : []));
          if (tests.length === 0) return [];
          log(`[tester] running gates on ${tests.length} replacement(s)...`);
          lastReport = await runGates({ outcome: "tests", tests }, {
            worktree: verifyDir, testProjects: fx.test_projects, testDirs: fx.test_dirs, maxTests: flagged.length, determinismRuns: fx.determinism_runs, dotnet, resultsDir,
            written: added, planPoints: { steps: 0, change_points: 0, risks: 0 }, changedConstructors: [], mode: "replace",
            audit: (file, content, group, failures) => auditNames(verifyDir, file, content, group, failures, agentContext),
            reviewCoverage: () => Promise.reject(new HarnessError("Replacements have no coverage review.")),
          });
          log(`[tester] gates: ${lastReport.passed ? "passed" : `failed at ${lastReport.stage} (${lastReport.errors.length} problem(s))`}`);
          if (!lastReport.passed) return lastReport.errors;
          comparison = await compareReplacements(verifyDir, r.replacements.filter((e) => e.test).map((e) => ({ flagged: declared.get(e.replaces)!, replacement: e.test! })), agentContext);
          return comparison.filter((v) => v.verdict === "changed").map((v) =>
            `${v.name}: the reviewer says the replacement verifies "${v.after}", but the flagged test verifies "${v.before}" (${v.reason}). Make it pin the same behavior, or submit not_possible.`);
        },
      }, {
        write_test_file: writeTestFileTool(verifyDir, added, (f) => fs.existsSync(path.join(verifyDir, f))),
        run_tests: runTestsTool(verifyDir, resultsDir, "the refactored code"),
      }));
    } catch (e) {
      dropAdded();
      record.replace_note = `The replacement step failed, so the flagged tests stay: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      log(record.replace_note);
      return;
    } finally {
      await tester.dispose();
      if (lastReport) writeJson(path.join(dir, "replace-gates.json"), lastReport);
    }
    writeJson(path.join(dir, "replacements.json"), { replacements: entries, comparison });
    copyTests(verifyDir, added, path.join(dir, "replacements"));
    const stays = (e: Entry) => ({ name: e.replaces, ...e.not_possible! });
    const replacing = entries.filter((e) => e.test);
    if (replacing.length === 0) {
      record.needs_refactor = entries.map(stays);
      record.replace_note = "No cheaper test is possible yet for any flagged test; reasons updated.";
      log(record.replace_note);
      return;
    }

    const remaining = [...sub.tests!.filter((t) => !replacing.some((e) => e.replaces === t.name)), ...replacing.map((e) => e.test!)];
    const { problems, emptied } = await removeTests(verifyDir, replacing.map((e) => declared.get(e.replaces)!), remaining, [...added], resultsDir);
    if (problems.length > 0) {
      dropAdded();
      record.replace_note = `The replacements passed their gates, but removing the flagged tests failed, so nothing was replaced: ${problems.slice(0, 3).join("; ")}`;
      log(record.replace_note);
      return;
    }
    for (const f of emptied) written.delete(f);
    for (const f of added) written.add(f);
    record.replaced = replacing.map((e) => ({ name: e.replaces, by: e.test! }));
    record.needs_refactor = entries.filter((e) => e.not_possible).map(stays);
    if (record.needs_refactor.length === 0) delete record.needs_refactor;
    log(`Replaced ${record.replaced.length} flagged test(s): ${record.replaced.map((r) => `${r.name.split(".").at(-1)} -> ${r.by.name.split(".").at(-1)}`).join(", ")}${record.needs_refactor ? `; ${record.needs_refactor.length} stay` : ""}.`);
  }

  /**
   * Removes each test method from its file, deleting files left with no tests, then runs the affected test projects
   * (and those of `alsoRun`). If anything fails to build, fails, or a remaining test did not run, every file is restored.
   */
  async function removeTests(
    cwd: string, remove: DeclaredTest[], remaining: DeclaredTest[], alsoRun: string[], resultsDir: string,
  ): Promise<{ problems: string[]; emptied: string[] }> {
    const snapshots = new Map<string, string>();
    const problems: string[] = [];
    for (const t of remove) {
      const file = norm(t.file);
      const full = path.join(cwd, file);
      if (!snapshots.has(file)) snapshots.set(file, fs.readFileSync(full, "utf8"));
      const source = fs.readFileSync(full, "utf8");
      const block = methodSource(source, t.name.split(".").at(-1)!);
      if (!block) { problems.push(`could not find ${t.name} in ${file}`); continue; }
      fs.writeFileSync(full, removeBlock(source, block));
    }
    const emptied = [...snapshots.keys()].filter((f) => testMethods(fs.readFileSync(path.join(cwd, f), "utf8")).length === 0);
    for (const f of emptied) fs.rmSync(path.join(cwd, f));

    const baselineFailed = new Set(manifest.baseline!.projects.flatMap((p) => p.failed));
    for (const project of [...new Set([...snapshots.keys(), ...alsoRun].map((f) => projectFor(f, fx.test_projects)!))]) {
      if (problems.length > 0) break;
      const r = await dotnet.test(cwd, project, { resultsDir });
      if (!r.built) { problems.push(...describeBuild(r.errors).slice(0, 5)); continue; }
      for (const t of r.results) if (t.outcome !== "Passed" && !baselineFailed.has(t.name)) problems.push(`${t.name} ${t.outcome.toLowerCase()}: ${t.message.slice(0, 300)}`);
      for (const t of remaining.filter((t) => projectFor(t.file, fx.test_projects) === project))
        if (resultsFor(r.results, t.name).length === 0) problems.push(`${t.name} did not run`);
    }
    if (problems.length > 0) for (const [f, content] of snapshots) fs.writeFileSync(path.join(cwd, f), content);
    return { problems, emptied };
  }

  /**
   * After the change, every test the pull request adds must guard something the actual diff changed. A fresh reviewer asks
   * of each: does it meaningfully check something that could have broken because of this change? Those that do not are removed.
   * Never fails the item: on any problem every test stays.
   */
  async function pruneIrrelevant(
    record: ItemRecord, plan: Plan, sub: TestSubmission, verifyDir: string, written: Set<string>, dir: string,
    agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext,
  ): Promise<void> {
    const replacedBy = new Map((record.replaced ?? []).map((r) => [r.name, r.by]));
    const tests = sub.tests!.map((t) => replacedBy.get(t.name) ?? t);
    log(`== relevance (${tests.length} test(s))`);
    git(verifyDir, "add", "-A");
    let diff: string;
    try { diff = git(verifyDir, "diff", "--cached", "--", ...plan.files); } finally { git(verifyDir, "reset", "-q"); }
    const quotesChange = diffQuotes(diff);
    const files = [...new Set(tests.map((t) => norm(t.file)))]
      .map((f) => `File \`${f}\`:\n\n\`\`\`csharp\n${fs.readFileSync(path.join(verifyDir, f), "utf8")}\n\`\`\``).join("\n\n");

    const judge = await RoleAgent.create("reviewer", agentContext(verifyDir, () => undefined));
    let verdicts: RelevanceVerdict[];
    try {
      ({ verdicts } = await judge.turn<{ verdicts: RelevanceVerdict[] }>("relevance", fill(readPrompt("reviewer/relevance"), {
        tool: "submit_relevance", worktree: toPosix(verifyDir), plan_json: JSON.stringify(plan, null, 2),
        refactorings: vocabularyFor(readPrompt("shared/refactoring-vocabulary"), plan), diff, files,
        tests_json: JSON.stringify(tests.map((t) => ({ name: t.name, file: t.file, behavior: t.behavior, protects: t.protects, ...(t.wiring ? { wiring: true } : {}) })), null, 2),
      }), {
        tool: "submit_relevance", description: "Submit one verdict per test: does it guard something this diff could have broken?", schema: "reviewer/relevance",
        check: (r) => {
          const errors: string[] = [];
          for (const t of tests) {
            const n = r.verdicts.filter((v) => v.name === t.name).length;
            if (n !== 1) errors.push(`${t.name}: needs exactly one verdict; found ${n}.`);
          }
          for (const v of r.verdicts) {
            if (!tests.some((t) => t.name === v.name)) errors.push(`'${v.name}' is not one of the tests.`);
            else if (v.verdict === "relevant" && (!v.changed_line?.trim() || !v.mistake?.trim())) errors.push(`${v.name}: a relevant test needs changed_line and mistake.`);
            else if (v.verdict === "relevant" && !quotesChange(v.changed_line!))
              errors.push(`${v.name}: changed_line '${v.changed_line}' is not a line the diff adds or removes. Copy one from the diff exactly, or rule the test irrelevant.`);
          }
          return errors;
        },
      }));
    } catch (e) {
      record.relevance_note = `The relevance check failed, so every test stays: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      log(record.relevance_note);
      return;
    } finally {
      await judge.dispose();
    }
    writeJson(path.join(dir, "relevance.json"), { verdicts });
    const irrelevant = verdicts.filter((v) => v.verdict === "irrelevant");
    const short = (name: string) => name.split(".").at(-1);
    log(`[relevance] ${tests.length - irrelevant.length} of ${tests.length} test(s) guard the change${irrelevant.length ? `; removing ${irrelevant.map((v) => short(v.name)).join(", ")}` : ""}`);
    if (irrelevant.length === 0) return;

    const drop = new Set(irrelevant.map((v) => v.name));
    const { problems, emptied } = await removeTests(verifyDir, tests.filter((t) => drop.has(t.name)), tests.filter((t) => !drop.has(t.name)), [], path.join(dir, "relevance-results"));
    if (problems.length > 0) {
      record.relevance_note = `Removing the tests ruled irrelevant failed, so every test stays: ${problems.slice(0, 3).join("; ")}`;
      log(record.relevance_note);
      return;
    }
    for (const f of emptied) written.delete(f);
    record.pruned = irrelevant.map((v) => ({ name: v.name, reason: v.reason }));
    record.tests = tests.length - irrelevant.length;
    if (record.needs_refactor) record.needs_refactor = record.needs_refactor.filter((n) => !drop.has(n.name));
    if (record.needs_refactor?.length === 0) delete record.needs_refactor;
    log(`Removed ${irrelevant.length} test(s) that do not guard the change; ${record.tests} remain.`);
  }

  /** The comparison reviewer: does each replacement protect the same behavior as the expensive test it replaces? */
  async function compareReplacements(
    cwd: string, pairs: { flagged: DeclaredTest; replacement: DeclaredTest }[], agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext,
  ): Promise<TestAuditVerdict[]> {
    const files = (list: DeclaredTest[]) => [...new Set(list.map((t) => norm(t.file)))]
      .map((f) => `File \`${f}\`:\n\n\`\`\`csharp\n${fs.readFileSync(path.join(cwd, f), "utf8")}\n\`\`\``).join("\n\n");
    const auditor = await RoleAgent.create("auditor", agentContext(cwd, () => undefined));
    try {
      const result = await auditor.turn<{ verdicts: TestAuditVerdict[] }>("replace-audit", fill(readPrompt("auditor/replacements"), {
        tool: "submit_test_audit", pairs_json: JSON.stringify(pairs.map((p) => ({ expensive: p.flagged.name, replacement: p.replacement.name, declared_behavior: p.flagged.behavior })), null, 2),
        before: files(pairs.map((p) => p.flagged)), after: files(pairs.map((p) => p.replacement)),
      }), {
        tool: "submit_test_audit", description: "Submit one verdict per pair.", schema: "auditor/test-changes",
        check: (r) => {
          const names = new Set(r.verdicts.map((v) => v.name));
          return pairs.filter((p) => !names.has(p.flagged.name)).map((p) => `Missing a verdict for ${p.flagged.name}.`);
        },
      });
      log(`[replace-audit] ${result.verdicts.filter((v) => v.verdict === "same").length}/${result.verdicts.length} same`);
      return result.verdicts;
    } finally {
      await auditor.dispose();
    }
  }

  /**
   * references/tests.md section 7, case B: the item is in test code, which the planner and implementer cannot see, so the tester plans and implements it.
   * No new tests are written; the existing ones are what must be preserved.
   */
  async function refactorTestCode(item: RegisterItem, record: ItemRecord, dir: string, agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext): Promise<void> {
    const workTree = path.join(workDir, "items", item.id, "test-code");
    addWorktree(workTree);
    const vocabularyText = readPrompt("shared/refactoring-vocabulary");
    const vocabulary = vocabularyNames(vocabularyText);
    const criteria = fs.readFileSync(path.join(config.lenses[config.analysis].dir, "references", "criteria.md"), "utf8");
    const testsIn = (file: string) => { const full = path.join(workTree, norm(file)); return fs.existsSync(full) ? testMethods(fs.readFileSync(full, "utf8")) : []; };

    const planner = await RoleAgent.create("tester", agentContext(workTree, (role) => {
      const { clean, changes } = isClean(workTree);
      if (!clean) throw new HarnessError(`The ${role} changed files while planning:\n${changes}`, 2);
    }));
    let plan: Plan;
    try {
      plan = await planner.turn<Plan>("plan", fill(readPrompt("tester/test-code-plan"), {
        tool: "submit_plan", worktree: toPosix(workTree), item_json: JSON.stringify(promptItem(item), null, 2), criteria, vocabulary: vocabularyText, rubric,
        complexity_limit: fx.complexity_limit, test_dirs: fx.test_dirs.map((d) => `\`${d}\``).join(", "),
      }), {
        tool: "submit_plan", description: "Submit the refactoring plan for this test-code item.", schema: "planner/plan",
        check: (p) => {
          const errors = checkPlan(p, item, workTree, vocabulary, { kind: "tests", testDirs: fx.test_dirs });
          const before = new Set(p.files.flatMap(testsIn));
          for (const r of p.renames ?? []) if (!before.has(r.from)) errors.push(`renames: '${r.from}' is not a test method in the plan's files.`);
          return errors;
        },
      });
    } finally {
      await planner.dispose();
    }
    writeJson(path.join(dir, "plan.json"), plan);
    if (!complexityGate(plan, item, workTree, record, dir, references(plan, item), "tests")) return;
    if (opts.dryRun) { record.outcome = "planned"; return; }

    const allowed = new Set(plan.files.map((f) => norm(f).toLowerCase()));
    const projects = [...new Set([...plan.files, ...plan.callers.map((c) => c.file)].map((f) => projectFile(f, workTree)).filter((p): p is string => !!p))];
    const outOfScope = () => changedFiles(workTree).filter((f) => !allowed.has(f.toLowerCase()));
    const rootBefore = git(root, "status", "--porcelain");
    const tester = await RoleAgent.create("implementer", agentContext(workTree, (role) => {
      if (git(root, "status", "--porcelain") !== rootBefore) throw new HarnessError(`The ${role} changed files outside its own work tree.`, 2);
      const bad = outOfScope();
      if (bad.length > 0) throw new HarnessError(`The ${role} changed files outside the plan:\n${bad.join("\n")}`, 2);
    }), [...READ_ONLY_TOOLS, "edit"]);
    const tools = { build: buildTool(workTree, projects), run_tests: runTestsTool(workTree, path.join(dir, "test-results"), "your changed test code") };
    const submission = implementationSubmission("tester", workTree, projects, outOfScope);
    let verified: string | undefined;
    try {
      let message = fill(readPrompt("implementer/test-code-implement"), {
        tool: "submit_implementation", worktree: toPosix(workTree), item_json: JSON.stringify(promptItem(item), null, 2), plan_json: JSON.stringify(plan, null, 2),
        files: plan.files.map((f) => `\`${f}\``).join(", "), build_projects: projects.map((p) => `\`${p}\``).join(", "),
      });
      let last: TestRefactorReport | undefined;
      for (let attempt = 1; attempt <= fx.implement_attempts && !verified; attempt++) {
        const r = await tester.turn<Implementation>(attempt === 1 ? "implement" : `implement-${attempt}`, message, submission, tools);
        if (r.outcome === "plan-wrong") {
          record.outcome = "plan-wrong";
          record.reason = r.plan_problem;
          raiseComplexity(record, "the plan could not be implemented as written");
          return;
        }
        record.implementation = { summary: r.summary, deviations: r.deviations };
        log(`[tester] implemented: ${r.summary}`);
        const patch = path.join(dir, `implementation-${attempt}.diff`);
        stagedDiff(workTree, patch);
        log(`== verify (attempt ${attempt})`);
        last = record.verify = await verifyTestRefactor(item, plan, dir, patch, attempt, agentContext);
        writeJson(path.join(dir, `verify-${attempt}.json`), last);
        log(`Verify: ${last.passed ? "passed" : "failed"}; ${last.projects.map((p) => `${p.project} ${p.passed} passed, ${p.failed} failed`).join("; ")}; assertions ${last.assertions.before} -> ${last.assertions.after}${last.audit.length ? `; reviewer: ${last.audit.filter((v) => v.verdict === "same").length}/${last.audit.length} same` : ""}`);
        if (last.passed) verified = path.join(workDir, "items", item.id, "verify");
        else message = testFeedback(last);
      }
      if (!verified) {
        record.outcome = "implementation-failed";
        record.reason = `Verification still failed after ${fx.implement_attempts} attempt(s): ${testFailureSummary(last!)}`;
        raiseComplexity(record, "failed implementation attempts");
        return;
      }
    } finally {
      await tester.dispose();
    }
    const reviewed = await reviewChange(item, record, plan, verified, dir, agentContext, [
      "- Every test project builds; every test that passed before passes now, under its declared name or rename.",
      "- The test methods in the plan's files are the same set as before, apart from the declared renames.",
      `- Assertions in the changed files: ${(record.verify as TestRefactorReport).assertions.before} before, ${(record.verify as TestRefactorReport).assertions.after} after.`,
      "- A reviewer compared each changed test before and after and found it verifies the same behavior.",
    ], ["Only test code changes in this item: the problem is in the tests themselves, and production code must not change."]);
    if (!reviewed) return;
    await propose(item, record, verified, plan.files, `${plan.goal}\n\nTest-code refactoring by the tester agent; no test added, removed, or changed in what it verifies.`, () => testPrBody(item, record, plan));
  }

  /** Applies the tester's diff to a clean work tree, then proves the same tests exist, pass, and verify what they verified before. */
  async function verifyTestRefactor(
    item: RegisterItem, plan: Plan, dir: string, patch: string, attempt: number, agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext,
  ): Promise<TestRefactorReport> {
    const verifyDir = path.join(workDir, "items", item.id, "verify");
    if (!fs.existsSync(verifyDir)) addWorktree(verifyDir);
    else { git(verifyDir, "reset", "--hard", commit); git(verifyDir, "clean", "-fd"); }
    if (fs.statSync(patch).size > 0) git(verifyDir, "apply", "--whitespace=nowarn", patch);
    const report: TestRefactorReport = { passed: false, attempt, build_errors: [], regressions: [], inventory_errors: [], scope_errors: [], assertions: { before: 0, after: 0 }, audit: [], projects: [] };
    const allowed = new Set(plan.files.map((f) => norm(f).toLowerCase()));
    report.scope_errors = changedFiles(verifyDir).filter((f) => !allowed.has(f.toLowerCase())).map((f) => `'${f}' changed but is not in the plan.`);

    const renames = new Map((plan.renames ?? []).map((r) => [r.from, r.to]));
    const renamed = (name: string) => { const i = name.indexOf("("); const method = i < 0 ? name : name.slice(0, i); return (renames.get(method) ?? method) + (i < 0 ? "" : name.slice(i)); };
    const before = new Map<string, string>(), after = new Map<string, string>();
    for (const f of plan.files.map(norm)) {
      if (existsAt(verifyDir, commit, f)) before.set(f, git(verifyDir, "show", `${commit}:${f}`));
      if (fs.existsSync(path.join(verifyDir, f))) after.set(f, fs.readFileSync(path.join(verifyDir, f), "utf8"));
    }
    const oldTests = [...new Set([...before.values()].flatMap(testMethods))];
    const newTests = new Set([...after.values()].flatMap(testMethods));
    const expected = new Set(oldTests.map((n) => renames.get(n) ?? n));
    for (const n of expected) if (!newTests.has(n)) report.inventory_errors.push(`${n} no longer exists in the plan's files${renames.size ? " (renames are applied)" : ""}. No test may be removed; declare a rename if it moved.`);
    for (const n of newTests) if (!expected.has(n)) report.inventory_errors.push(`${n} is a new test. A test-code refactoring adds no tests; if it is a moved test, the plan must declare the rename.`);
    const sum = (m: Map<string, string>) => [...m.values()].reduce((n, s) => n + countAssertions(s), 0);
    report.assertions = { before: sum(before), after: sum(after) };

    const baselineFailed = new Set(manifest.baseline!.projects.flatMap((p) => p.failed));
    for (const project of fx.test_projects) {
      const r = await dotnet.test(verifyDir, project, { resultsDir: path.join(dir, `verify-results-${attempt}`) });
      if (!r.built) { report.build_errors.push(...r.errors); continue; }
      const byName = new Map(r.results.map((t) => [t.name, t]));
      const failed = r.results.filter((t) => t.outcome !== "Passed");
      report.projects.push({ project, passed: r.results.length - failed.length, failed: failed.length });
      for (const name of baselinePassed.get(project) ?? []) {
        const result = byName.get(renamed(name));
        if (!result) report.regressions.push({ name: renamed(name), project, message: "no longer runs" });
        else if (result.outcome !== "Passed") report.regressions.push({ name: result.name, project, message: result.message.slice(0, 800) });
      }
      for (const t of failed) if (!baselineFailed.has(t.name) && !report.regressions.some((g) => g.name === t.name)) report.regressions.push({ name: t.name, project, message: t.message.slice(0, 800) });
    }

    const clean = !report.build_errors.length && !report.regressions.length && !report.inventory_errors.length && !report.scope_errors.length;
    if (clean) {
      // Tests whose own body did not change can still change meaning through a helper in the plan's files, so callers' tests are reviewed too.
      const types = [...new Set(plan.change_points.map((c) => c.type.split(".").at(-1)!))];
      const mentioning = git(verifyDir, "ls-files", "-z", "--", ...fx.test_dirs.map(norm)).split("\0").filter((f) => f.endsWith(".cs"))
        .filter((f) => types.some((t) => new RegExp(String.raw`\b${t}\b`).test(fs.readFileSync(path.join(verifyDir, f), "utf8"))));
      const callerFiles = [...new Set([...plan.callers.map((c) => norm(c.file)), ...mentioning])]
        .filter((f) => !before.has(f) && !after.has(f) && isUnder(f, fx.test_dirs) && fs.existsSync(path.join(verifyDir, f))).slice(0, 12);
      const unchanged = new Map(callerFiles.map((f) => [f, fs.readFileSync(path.join(verifyDir, f), "utf8")]));
      const reviewed = [...new Set([...oldTests, ...[...unchanged.values()].flatMap(testMethods)])];
      if (reviewed.length > 0) report.audit = await auditTestChanges(verifyDir, reviewed, before, after, unchanged, plan, report.assertions, agentContext);
    }
    const changed = report.audit.filter((v) => v.verdict === "changed");
    report.passed = clean && changed.length === 0;
    return report;
  }

  async function auditTestChanges(
    cwd: string, tests: string[], before: Map<string, string>, after: Map<string, string>, unchanged: Map<string, string>, plan: Plan,
    assertions: TestRefactorReport["assertions"], agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext,
  ): Promise<TestAuditVerdict[]> {
    const show = (files: Map<string, string>, note = "") => [...files].map(([f, c]) => `File \`${f}\`${note}:\n\n\`\`\`csharp\n${c}\n\`\`\``).join("\n\n");
    const removed = [...before.keys()].filter((f) => !after.has(f)).map((f) => `File \`${f}\`: deleted.`).join("\n");
    const added = [...after.keys()].filter((f) => !before.has(f));
    const auditor = await RoleAgent.create("auditor", agentContext(cwd, () => undefined));
    try {
      const result = await auditor.turn<{ verdicts: TestAuditVerdict[] }>("test-audit", fill(readPrompt("auditor/test-changes"), {
        tool: "submit_test_audit", tests_json: JSON.stringify(tests, null, 2), renames_json: JSON.stringify(plan.renames ?? []),
        assertions_before: assertions.before, assertions_after: assertions.after,
        before: [show(before), unchanged.size ? `The files below use code from the files above and were not edited:\n\n${show(unchanged)}` : ""].filter(Boolean).join("\n\n") || "(no files)",
        after: [show(after, ""), removed, added.length ? `New files: ${added.map((f) => `\`${f}\``).join(", ")}.` : "", unchanged.size ? `Not edited: ${[...unchanged.keys()].map((f) => `\`${f}\``).join(", ")} (as shown under Before).` : ""].filter(Boolean).join("\n\n"),
      }), {
        tool: "submit_test_audit", description: "Submit one verdict per listed test.", schema: "auditor/test-changes",
        check: (r) => {
          const names = new Set(r.verdicts.map((v) => v.name));
          return tests.filter((t) => !names.has(t)).map((t) => `Missing a verdict for ${t}.`);
        },
      });
      log(`[test-audit] ${result.verdicts.filter((v) => v.verdict === "same").length}/${result.verdicts.length} same${result.verdicts.some((v) => v.verdict === "changed") ? `; changed: ${result.verdicts.filter((v) => v.verdict === "changed").map((v) => v.name.split(".").at(-1)).join(", ")}` : ""}`);
      return result.verdicts;
    } finally {
      await auditor.dispose();
    }
  }

  /** The tester can read test code, so it gets the full failure detail. */
  function testFeedback(r: TestRefactorReport): string {
    const lines = ["Verification of your test-code refactoring failed. Fix it, staying within the plan's files, and call submit_implementation again."];
    if (r.build_errors.length) lines.push("", "The build fails:", ...r.build_errors.slice(0, 20).map((d) => `- ${d.file}:${d.line} ${d.code} ${d.message}`));
    if (r.regressions.length) lines.push("", "Tests that passed before and do not pass now:", ...r.regressions.slice(0, 20).map((g) => `- ${g.name} (${g.project}): ${g.message}`));
    if (r.inventory_errors.length) lines.push("", ...r.inventory_errors.map((e) => `- ${e}`));
    if (r.scope_errors.length) lines.push("", ...r.scope_errors.map((e) => `- ${e}`));
    const changed = r.audit.filter((v) => v.verdict === "changed");
    if (changed.length) lines.push("", "The reviewer says these tests no longer verify what they did:", ...changed.map((v) => `- ${v.name}: before, ${v.before}; now, ${v.after}. ${v.reason}`));
    return lines.join("\n");
  }

  function testPrBody(item: RegisterItem, record: ItemRecord, plan: Plan): string {
    const out: string[] = [];
    const L = (s = "") => out.push(s);
    const v = record.verify as TestRefactorReport;
    L(`Resolves register item \`${item.id}\` (${item.severity} ${item.principle}${item.criterion ? `/${item.criterion}` : ""}) in test code: ${item.title}`);
    L();
    L(`**Goal:** ${plan.goal}`);
    L();
    L("Only test code changes. No test is added or removed, and each one still verifies what it did before.");
    L();
    L("## Plan");
    for (const [i, s] of plan.steps.entries()) L(`${i + 1}. **${s.refactoring}** (${s.files.map((f) => `\`${f}\``).join(", ")}): ${s.detail}`);
    L();
    L(`**Why the tests still verify the same behavior:** ${plan.behavior_notes}`);
    if (plan.renames?.length) { L(); L("**Renamed or moved tests:**"); for (const r of plan.renames) L(`- \`${r.from}\` is now \`${r.to}\``); }
    if (record.implementation?.deviations?.length) { L(); L("**Deviations from the plan:**"); for (const d of record.implementation.deviations) L(`- ${d}`); }
    L();
    L("## Verification");
    for (const p of v.projects) L(`- \`${p.project}\`: ${p.passed} passed, ${p.failed} failed (failures, if any, also failed before the change)`);
    L(`- Every test that passed before passes now, under its declared name.`);
    L(`- Assertions in the changed files: ${v.assertions.before} before, ${v.assertions.after} after.`);
    L(`- A reviewer compared the old and new version of ${v.audit.length} test(s) and found each verifies the same behavior.`);
    L(`- Complexity: ${record.complexity!.effective} (limit ${fx.complexity_limit})`);
    if (record.review) reviewSection(L, record.review);
    L();
    L(`Generated by the quality harness refactor phase, run \`${runId}\`.`);
    return out.join("\n");
  }

  /**
   * references/refactor-phase.md step 8: a fresh agent reads the finding, the plan, and the final diff, and decides whether the
   * problem is actually gone. Verification cannot tell a real fix from one that only moves the measured value.
   * A rejection stops the item before anything is committed.
   */
  async function reviewChange(
    item: RegisterItem, record: ItemRecord, plan: Plan, verifyDir: string, dir: string,
    agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext, checks: string[], context: string[],
  ): Promise<boolean> {
    log("== review");
    const patch = path.join(dir, "review.diff");
    stagedDiff(verifyDir, patch);
    const full = fs.readFileSync(patch, "utf8");
    const limit = 80_000;
    const diff = full.length > limit ? full.slice(0, limit) : full;
    const diffNote = full.length > limit
      ? ` (the first ${limit} of ${full.length} characters; read the remaining changed files in the work tree: ${changedFiles(verifyDir).join(", ")})`
      : "";
    const reviewer = await RoleAgent.create("reviewer", agentContext(verifyDir, () => undefined));
    let review: ChangeReview;
    try {
      review = await reviewer.turn<ChangeReview>("review", fill(readPrompt("reviewer/review"), {
        tool: "submit_review", worktree: toPosix(verifyDir), item_json: JSON.stringify(promptItem(item), null, 2), plan_json: JSON.stringify(plan, null, 2),
        checks: checks.join("\n"), implementation_json: JSON.stringify(record.implementation ?? {}, null, 2),
        context: context.filter(Boolean).join("\n\n"), diff, diff_note: diffNote,
      }), {
        tool: "submit_review", description: "Submit your verdict on whether this change resolves the item, with every finding.", schema: "reviewer/review",
        check: (r) => {
          const blocking = r.findings.filter((f) => f.blocking);
          const errors: string[] = [];
          if (r.verdict === "reject" && blocking.length === 0) errors.push("A reject verdict needs at least one blocking finding.");
          if (r.verdict === "approve" && blocking.length > 0) errors.push("An approve verdict cannot have blocking findings; reject, or mark them non-blocking if they should not stop the pull request.");
          if (r.verdict === "approve" && r.resolved.verdict === "no") errors.push("You cannot approve a change that does not resolve the item.");
          for (const f of r.findings)
            if (!fs.existsSync(path.join(verifyDir, f.file)) && !full.includes(norm(f.file))) errors.push(`${f.file}: not in the repository or the diff. Use a repository-relative path.`);
          return errors;
        },
      });
    } finally {
      await reviewer.dispose();
    }
    record.review = review;
    writeJson(path.join(dir, "review.json"), review);
    log(`[review] ${review.verdict}; resolved: ${review.resolved.verdict}${review.findings.length ? `; ${review.findings.map((f) => `${f.blocking ? "blocking " : ""}${f.kind} ${f.file}`).join("; ")}` : ""}`);
    if (review.verdict === "approve") return true;
    record.outcome = "review-rejected";
    record.reason = `The reviewer rejected the change: ${review.findings.filter((f) => f.blocking).map((f) => `${f.kind} in ${f.file}${f.line ? `:${f.line}` : ""}: ${f.detail}`).join(" ")}`;
    raiseComplexity(record, "rejected by the reviewer");
    return false;
  }

  function reviewSection(L: (s?: string) => void, review: ChangeReview): void {
    L();
    L("## Review");
    L(`A fresh reviewer read the finding, the plan, and this diff, and approved it. ${review.summary}`);
    L();
    L(`**Where the problem is resolved:** ${review.resolved.evidence}`);
    if (review.findings.length) {
      L();
      L("**For the human reviewer:**");
      for (const f of review.findings) L(`- ${f.kind}, \`${f.file}${f.line ? `:${f.line}` : ""}\`: ${f.detail}`);
    }
  }

  /** Waits for approval.json beside the item's outputs. The deadline is wall-clock time, so a sleeping machine does not extend it. */
  async function awaitApproval(item: RegisterItem, plan: Plan, sub: TestSubmission, dir: string): Promise<Approval | undefined> {
    const file = path.join(dir, "approval.json");
    const gaps = [...sub.coverage!.breakages.map((b) => ({ what: b.name, ...b })), ...sub.coverage!.plan_points.map((p) => ({ what: p.ref, ...p }))]
      .filter((e) => e.tests.length === 0).map((e) => ({ what: e.what, why: e.not_covered }));
    writeJson(path.join(dir, "approval-request.json"), {
      item: { id: item.id, title: item.title, severity: item.severity }, goal: plan.goal, risk: sub.risk, approval_risk: fx.approval_risk,
      tests: sub.tests!.map((t) => ({ name: t.name, kind: t.kind, behavior: t.behavior })), not_covered: gaps,
      respond: `Write {"approved": true} or {"approved": false, "note": "..."} to ${file}`,
    });
    log(`[approval] ${item.id}: tester risk is ${sub.risk!.level} (approval needed at ${fx.approval_risk} or above). Waiting up to ${fx.approval_timeout_minutes} minutes for ${file}`);
    const deadline = Date.now() + fx.approval_timeout_minutes * 60_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) {
        try {
          const a = JSON.parse(fs.readFileSync(file, "utf8")) as { approved?: unknown; note?: unknown };
          if (typeof a.approved === "boolean") return { approved: a.approved, note: typeof a.note === "string" ? a.note : undefined, at: now() };
        } catch { /* still being written */ }
      }
      await sleep(10_000);
    }
    return undefined;
  }

  /**
   * references/tests.md section 7, case A: the refactoring changed a surface existing tests use, so they no longer compile.
   * The tester adapts how they reach the code, in the files that mention a changed type only; names and assertion lines stay. Returns false, with the outcome recorded, when it cannot.
   */
  async function adaptTests(
    item: RegisterItem, record: ItemRecord, plan: Plan, written: Set<string>, adapted: Map<string, string>, errors: Diagnostic[], dir: string,
    agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext,
  ): Promise<boolean> {
    const verifyDir = path.join(workDir, "items", item.id, "verify");
    const baselineDir = path.join(workDir, "baseline");
    const read = (cwd: string, f: string) => (fs.existsSync(path.join(cwd, f)) ? fs.readFileSync(path.join(cwd, f), "utf8") : undefined);
    const types = [...new Set(plan.change_points.map((c) => c.type.split(".").at(-1)!))];
    const files = git(baselineDir, "ls-files", "-z", "--", ...fx.test_dirs.map(norm)).split("\0")
      .filter((f) => f.endsWith(".cs") && !written.has(f) && types.some((t) => new RegExp(String.raw`\b${t}\b`).test(read(baselineDir, f) ?? "")));
    const allowed = new Set(files.map((f) => f.toLowerCase()));
    const broken = [...new Set(errors.map((d) => norm(d.file)))];
    const stop = (reason: string) => { record.outcome = "tests-need-adapting"; record.reason = reason; log(reason); return false; };
    const own = broken.filter((f) => written.has(f));
    if (own.length > 0) return stop(`The refactoring breaks the tester's own characterization tests, which must run unchanged: ${own.join(", ")}`);
    const outside = broken.filter((f) => !allowed.has(f.toLowerCase()));
    if (outside.length > 0) return stop(`The refactoring breaks test files that do not mention a type the plan changes, which case A does not allow adapting: ${outside.join(", ")}`);
    log(`== adapt existing tests (${broken.length} file(s) do not build)`);

    const snapshot = new Map(changedFiles(verifyDir).filter((f) => !allowed.has(f.toLowerCase())).map((f) => [f, read(verifyDir, f)]));
    const outOfScope = () => {
      const now = changedFiles(verifyDir).filter((f) => !allowed.has(f.toLowerCase()));
      return [...now.filter((f) => !snapshot.has(f) || snapshot.get(f) !== read(verifyDir, f)), ...[...snapshot.keys()].filter((f) => !now.includes(f))];
    };
    const tester = await RoleAgent.create("test_maintainer", agentContext(verifyDir, (role) => {
      const bad = outOfScope();
      if (bad.length > 0) throw new HarnessError(`The ${role} changed files it may not adapt:\n${bad.join("\n")}`, 2);
    }), [...READ_ONLY_TOOLS, "edit"]);
    type Adaptation = { outcome: "adapted" | "escalate"; summary: string; reason?: string };
    let audit: TestAuditVerdict[] = [];
    let changed: string[] = [];
    let r: Adaptation;
    try {
      r = await tester.turn<Adaptation>("adapt", fill(readPrompt("test-maintainer/adapt"), {
        tool: "submit_adaptation", worktree: toPosix(verifyDir), plan_json: JSON.stringify(plan, null, 2),
        errors: errors.slice(0, 30).map((d) => `- ${d.file}:${d.line} ${d.code} ${d.message}`).join("\n"), files: files.map((f) => `\`${f}\``).join(", "),
      }), {
        tool: "submit_adaptation", description: "Submit when the test projects build with the adapted tests, or escalate.", schema: "test-maintainer/adapt",
        check: async (a) => {
          if (a.outcome === "escalate") return a.reason?.trim() ? [] : ["reason is required when outcome is escalate."];
          const problems = outOfScope().map((f) => `'${f}' is not a test file you may adapt; revert your change to it.`);
          changed = changedFiles(verifyDir).filter((f) => allowed.has(f.toLowerCase()));
          if (changed.length === 0) problems.push("No test file changed.");
          const before = new Map<string, string>(), after = new Map<string, string>();
          for (const f of changed) {
            before.set(f, read(baselineDir, f)!);
            const now = read(verifyDir, f);
            if (now === undefined) problems.push(`'${f}' was deleted; no test may be removed.`);
            else after.set(f, now);
          }
          for (const [f, old] of before) {
            const now = after.get(f);
            if (now === undefined) continue;
            const was = testMethods(old), is = new Set(testMethods(now));
            for (const n of was) if (!is.has(n)) problems.push(`${n} is missing from '${f}'; keep every test and its name.`);
            for (const n of is) if (!was.includes(n)) problems.push(`${n} is new in '${f}'; adapting adds no tests.`);
            for (const n of was.filter((n) => is.has(n))) {
              const m = n.split(".").at(-1)!;
              if (JSON.stringify(assertionLines(old, m)) !== JSON.stringify(assertionLines(now, m)))
                problems.push(`${n}: its assertion lines changed. Adapt only how the test builds and calls the code; keep every assertion line exactly as it was.`);
            }
          }
          if (problems.length > 0) return problems;
          log("[tester] building the test projects with adapted tests...");
          const build = describeBuild(await buildAll(verifyDir, fx.test_projects));
          if (build.length > 0) return build;
          const sum = (m: Map<string, string>) => [...m.values()].reduce((n, s) => n + countAssertions(s), 0);
          audit = await auditTestChanges(verifyDir, [...before.values()].flatMap(testMethods), before, after, new Map(), { ...plan, renames: [] }, { before: sum(before), after: sum(after) }, agentContext);
          return audit.filter((v) => v.verdict === "changed").map((v) => `${v.name}: the reviewer says it now verifies "${v.after}" instead of "${v.before}" (${v.reason}). Adapt the call only.`);
        },
      }, { build: buildTool(verifyDir, fx.test_projects), run_tests: runTestsTool(verifyDir, path.join(dir, "adapt-results"), "the refactored code") });
    } catch (e) {
      return stop(`Adapting existing tests failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    } finally {
      await tester.dispose();
    }
    if (r.outcome === "escalate") {
      record.outcome = "escalated";
      record.reason = `Existing tests cannot be adapted to the refactored code without changing what they check: ${r.reason}`;
      raiseComplexity(record, "existing tests cannot be adapted");
      return false;
    }
    for (const f of changed) adapted.set(f, read(verifyDir, f)!);
    record.adapted = { files: [...adapted.keys()], summary: r.summary, audit: [...(record.adapted?.audit ?? []).filter((v) => !audit.some((a) => a.name === v.name)), ...audit] };
    for (const f of changed) writeText(path.join(dir, "adapted", f), adapted.get(f)!);
    log(`[tester] adapted ${changed.join(", ")}: ${r.summary}`);
    return true;
  }

  /** Returns the verify work tree once the refactoring builds, passes every test, and resolves the item; otherwise records why not. */
  async function implementAndVerify(
    item: RegisterItem, record: ItemRecord, plan: Plan, sub: TestSubmission, refactorDir: string, testsDir: string, written: Set<string>, dir: string,
    reached: string[], agentContext: (cwd: string, afterRun: (role: string) => void) => AgentContext,
  ): Promise<string | undefined> {
    const allowed = new Set(plan.files.map((f) => norm(f).toLowerCase()));
    const projects = [...new Set([...[...plan.files, ...plan.callers.map((c) => c.file)].map((f) => projectFile(f, refactorDir)).filter((p): p is string => !!p), ...reached])];
    const outOfScope = () => changedFiles(refactorDir).filter((f) => !allowed.has(f.toLowerCase()));
    const rootBefore = git(root, "status", "--porcelain");
    const testsBefore = git(testsDir, "status", "--porcelain", "--untracked-files=all");
    const implementer = await RoleAgent.create("implementer", agentContext(refactorDir, (role) => {
      if (git(root, "status", "--porcelain") !== rootBefore || git(testsDir, "status", "--porcelain", "--untracked-files=all") !== testsBefore)
        throw new HarnessError(`The ${role} changed files outside its own work tree.`, 2);
      const bad = outOfScope();
      if (bad.length > 0) throw new HarnessError(`The ${role} changed files outside the plan:\n${bad.join("\n")}`, 2);
    }), [...READ_ONLY_TOOLS, "edit"]);
    const tools = { build: buildTool(refactorDir, projects) };
    const submission = implementationSubmission("implementer", refactorDir, projects, outOfScope);
    const raise = (reason: string) => raiseComplexity(record, reason);
    const adapted = new Map<string, string>();
    const verifyDir = path.join(workDir, "items", item.id, "verify");
    const isTestCode = (d: Diagnostic) => isUnder(d.file, fx.test_dirs);

    try {
      let message = fill(readPrompt("implementer/implement"), {
        tool: "submit_implementation", worktree: toPosix(refactorDir), item_json: JSON.stringify(promptItem(item), null, 2), plan_json: JSON.stringify(plan, null, 2),
        files: plan.files.map((f) => `\`${f}\``).join(", "), build_projects: projects.map((p) => `\`${p}\``).join(", "),
      });
      let last: VerifyReport | undefined;
      for (let attempt = 1; attempt <= fx.implement_attempts; attempt++) {
        const r = await implementer.turn<Implementation>(attempt === 1 ? "implement" : `implement-${attempt}`, message, submission, tools);
        if (r.outcome === "plan-wrong") {
          record.outcome = "plan-wrong";
          record.reason = r.plan_problem;
          raise("the plan could not be implemented as written");
          return undefined;
        }
        record.implementation = { summary: r.summary, deviations: r.deviations };
        log(`[implementer] implemented: ${r.summary}`);
        const patch = path.join(dir, `implementation-${attempt}.diff`);
        stagedDiff(refactorDir, patch);
        log(`== verify (attempt ${attempt})`);
        const check = async (label: string) => {
          last = record.verify = await verify(item, plan, sub, testsDir, written, adapted, dir, patch, attempt, projects);
          writeJson(path.join(dir, `verify-${label}.json`), last);
          log(`Verify: ${last.passed ? "passed" : "failed"}; ${last.projects.map((p) => `${p.project} ${p.passed} passed, ${p.failed} failed`).join("; ")}; analyzer: ${last.analyzer}`);
          return last;
        };
        let v = await check(`${attempt}`);
        // Case A: the refactoring changed a surface existing tests use; the tester adapts them, then verification runs again.
        if (!v.passed && v.build_errors.some(isTestCode)) {
          if (!await adaptTests(item, record, plan, written, adapted, v.build_errors.filter(isTestCode), dir, agentContext)) return undefined;
          log(`== verify (attempt ${attempt}, with adapted tests)`);
          v = await check(`${attempt}-adapted`);
          if (!v.passed && v.build_errors.some(isTestCode)) {
            record.outcome = "tests-need-adapting";
            record.reason = `Test code still does not build after adapting: ${v.build_errors.filter(isTestCode).slice(0, 5).map((d) => `${d.file}:${d.line} ${d.message}`).join("; ")}`;
            return undefined;
          }
        }
        if (v.passed) return verifyDir;
        message = feedback(v, sub);
      }
      record.outcome = "implementation-failed";
      record.reason = `Verification still failed after ${fx.implement_attempts} attempt(s): ${failureSummary(last!)}`;
      raise("failed implementation attempts");
      return undefined;
    } finally {
      await implementer.dispose();
    }
  }

  /**
   * Applies the implementer's diff to a full work tree with the tester's files copied in unchanged, then builds, tests, and re-runs the analyzer.
   * `production` are the production projects the change reaches; test projects alone may not reference them.
   */
  async function verify(
    item: RegisterItem, plan: Plan, sub: TestSubmission, testsDir: string, written: Set<string>, adapted: Map<string, string>, dir: string, patch: string, attempt: number,
    production: string[],
  ): Promise<VerifyReport> {
    const verifyDir = path.join(workDir, "items", item.id, "verify");
    if (!fs.existsSync(verifyDir)) addWorktree(verifyDir);
    else { git(verifyDir, "reset", "--hard", commit); git(verifyDir, "clean", "-fd"); }
    if (fs.statSync(patch).size > 0) git(verifyDir, "apply", "--whitespace=nowarn", patch);
    for (const f of written) {
      fs.mkdirSync(path.dirname(path.join(verifyDir, f)), { recursive: true });
      fs.copyFileSync(path.join(testsDir, f), path.join(verifyDir, f));
    }
    for (const [f, content] of adapted) fs.writeFileSync(path.join(verifyDir, f), content);
    const report: VerifyReport = { passed: false, attempt, build_errors: [], regressions: [], resolved: false, analyzer: "", scope_errors: [], projects: [] };
    const allowed = new Set([...plan.files, ...written, ...adapted.keys()].map((f) => norm(f).toLowerCase()));
    report.scope_errors = changedFiles(verifyDir).filter((f) => !allowed.has(f.toLowerCase())).map((f) => `'${f}' changed but is not in the plan.`);

    for (const project of production.filter((p) => !fx.test_projects.includes(p))) report.build_errors.push(...(await dotnet.build(verifyDir, project)).errors);
    const baselineFailed = new Set(manifest.baseline!.projects.flatMap((p) => p.failed));
    const testerNames = new Set(sub.tests!.map((t) => t.name));
    for (const project of fx.test_projects) {
      const r = await dotnet.test(verifyDir, project, { resultsDir: path.join(dir, `verify-results-${attempt}`) });
      if (!r.built) { report.build_errors.push(...r.errors); continue; }
      const failed = r.results.filter((t) => t.outcome !== "Passed");
      report.projects.push({ project, passed: r.results.length - failed.length, failed: failed.length });
      for (const t of failed) {
        const tester = testerNames.has(t.name.replace(/\(.*$/, ""));
        if (!tester && baselineFailed.has(t.name)) continue;
        report.regressions.push({ name: t.name, project, tester, message: t.message.slice(0, 800) });
      }
      for (const t of sub.tests!.filter((t) => projectFor(t.file, fx.test_projects) === project))
        if (resultsFor(r.results, t.name).length === 0) report.regressions.push({ name: t.name, project, tester: true, message: "did not run" });
    }

    if (item.source !== "metric") { report.resolved = true; report.analyzer = "review item; not checked by the analyzer"; }
    else {
      const metrics = await runAnalyzer(config.lenses[config.analysis], verifyDir, path.join(dir, `verify-metrics-${attempt}.json`), path.join(workDir, "empty-register"));
      const still = metrics.findings.find((f) => f.id === item.id);
      if (!still) { report.resolved = true; report.analyzer = "no longer reported"; }
      else if (plan.resolution.expected === "lower_severity" && plan.resolution.expected_severity && sevRank(still.severity) <= sevRank(plan.resolution.expected_severity)) {
        report.resolved = true; report.analyzer = `reported at ${still.severity}, as planned`;
      } else report.analyzer = `still reported: ${still.details} (value ${still.value}, threshold ${still.threshold}, ${still.severity})`;
    }
    report.passed = report.build_errors.length === 0 && report.regressions.length === 0 && report.resolved && report.scope_errors.length === 0;
    return report;
  }

  /** What the implementer may learn from a failed verification: production build errors, behaviors in plain words, and the analyzer's verdict. Never test code. */
  function feedback(r: VerifyReport, sub: TestSubmission): string {
    const lines = ["Verification of your implementation failed. Fix it, staying within the plan's files, and call submit_implementation again."];
    if (r.build_errors.length) lines.push("", "The solution does not build:", ...r.build_errors.slice(0, 20).map((d) => `- ${d.file}:${d.line} ${d.code} ${d.message}`));
    if (r.regressions.length) {
      lines.push("", "These behaviors no longer hold:");
      for (const g of r.regressions) {
        const declared = sub.tests!.find((t) => g.name.replace(/\(.*$/, "") === t.name);
        lines.push(`- ${declared ? declared.behavior : humanize(g.name)}`);
      }
    }
    if (!r.resolved) lines.push("", `The analyzer ${r.analyzer}. The plan's resolution is not reached yet.`);
    if (r.scope_errors.length) lines.push("", ...r.scope_errors.map((e) => `- ${e}`));
    return lines.join("\n");
  }

  /**
   * Commits the item's move to fixed-pending-verification on the fix branch, separately from the fix, so the register
   * changes on the base branch only when a person merges the fix. Returns false when the base branch has no such item.
   */
  function markFixedOnBranch(item: RegisterItem, verifyDir: string, branch: string): boolean {
    const registerDir = path.join(verifyDir, ".tech-debt");
    const onBase = fs.existsSync(path.join(registerDir, "items")) ? loadItems(registerDir).get(item.id) : undefined;
    if (!onBase) {
      log(`Warning: ${item.id} is not in the register on ${base}, so this branch does not update its status.`);
      return false;
    }
    const fixCommit = git(verifyDir, "rev-parse", "HEAD");
    claim(onBase, `quality refactor ${runId}`, branch);
    markFixed(onBase, fixCommit, branch);
    // TECH-DEBT.md is shared by every item, so regenerating it here would make each refactor PR conflict with the
    // others once one merges. The next analysis run regenerates it.
    saveItem(registerDir, onBase);
    git(verifyDir, "add", "--", `.tech-debt/items/${item.id}.json`);
    git(verifyDir, "commit", "-m", `Register: ${item.id} fixed, pending verification`, "-m", `Fix in ${fixCommit.slice(0, 7)}. Refactor phase run ${runId}.`);
    return true;
  }

  /** Items with an open refactor pull request, or a refactor branch committed locally and never pushed. Closing a pull request without merging releases its item. */
  function refactorsInFlight(): Map<string, string> {
    const found = new Map<string, string>();
    const idOf = (branch: string) => /^refactor\/(.+)-\d{4}-\d{2}-\d{2}T\d{4}Z-[0-9a-f]{7}(-[a-z0-9-]+)?$/.exec(branch)?.[1];
    for (const line of (gitTry(root, "for-each-ref", "--format=%(refname:short)|%(upstream)", "refs/heads/refactor/") ?? "").split(/\r?\n/).filter(Boolean)) {
      const [branch, upstream] = line.split("|");
      const id = idOf(branch);
      if (id && !upstream) found.set(id, `local branch ${branch}, not pushed`);
    }
    const url = gitTry(root, "remote", "get-url", remote);
    const repo = originRepo || (url && host.repoFromUrl(url)) || "";
    if (!repo) return found;
    try {
      for (const head of host.openPullRequestHeads(repo, base.replace(new RegExp(`^${remote}/`), ""))) {
        const id = idOf(head);
        if (id) found.set(id, `open pull request from ${head}`);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (originRepo) throw new HarnessError(`Could not list open pull requests on ${repo}, so items already in review cannot be skipped: ${reason}`);
      log(`Warning: could not list open pull requests on ${repo}; items already in review may be attempted again. ${reason}`);
    }
    return found;
  }

  /** Commits exactly `files` from the verify work tree on a new branch, then pushes it and opens a pull request unless --no-push. */
  async function propose(item: RegisterItem, record: ItemRecord, verifyDir: string, files: string[], commitNote: string, body: () => string): Promise<void> {
    const branch = `refactor/${item.id}-${runId.replace(/^refactor-/, "")}`;
    git(verifyDir, "checkout", "-b", branch);
    git(verifyDir, "add", "-A");
    const staged = git(verifyDir, "diff", "--cached", "--name-only").split(/\r?\n/).filter(Boolean).map(norm);
    const expected = new Set(files.map((f) => norm(f).toLowerCase()));
    const extra = staged.filter((f) => !expected.has(f.toLowerCase()));
    if (extra.length > 0) throw new HarnessError(`Refusing to commit files outside the plan and the accepted tests:\n${extra.join("\n")}`);
    git(verifyDir, "commit", "-m", `Refactor ${item.id}: ${item.title}`, "-m", `${commitNote}\n\nRefactor phase run ${runId}.`);
    record.branch = branch;
    const registered = markFixedOnBranch(item, verifyDir, branch);
    if (!opts.push) {
      record.outcome = "committed";
      log(`Committed on local branch ${branch}; not pushed (--no-push).`);
      return;
    }
    const registerNote = registered
      ? `\n\n---\nThis pull request also marks \`${item.id}\` as fixed, pending verification, in \`.tech-debt/\`. The next analysis run after the merge resolves it, or reopens it if the finding is still there. If this pull request is closed without merging, the item is released for another attempt.`
      : "";
    host.push(verifyDir, remote, branch);
    record.pr = host.createPullRequest(verifyDir, { repo: originRepo, base: base.replace(new RegExp(`^${remote}/`), ""), head: branch, title: `Refactor ${item.id}: ${item.title}`, body: body() + registerNote });
    record.outcome = "proposed";
    log(`Pull request: ${record.pr}`);
  }

  function prBody(item: RegisterItem, record: ItemRecord, plan: Plan, sub: TestSubmission): string {
    const out: string[] = [];
    const L = (s = "") => out.push(s);
    const risk = sub.risk!;
    L(`Resolves register item \`${item.id}\` (${item.severity} ${item.principle}${item.criterion ? `/${item.criterion}` : ""}): ${item.title}`);
    L();
    L(`**Goal:** ${plan.goal}`);
    L();
    L("## Plan");
    for (const [i, s] of plan.steps.entries()) L(`${i + 1}. **${s.refactoring}** (${s.files.map((f) => `\`${f}\``).join(", ")}): ${s.detail}`);
    L();
    L(`**Behavior notes:** ${plan.behavior_notes}`);
    if (record.implementation?.deviations?.length) { L(); L("**Deviations from the plan:**"); for (const d of record.implementation.deviations) L(`- ${d}`); }
    L();
    L("## Characterization tests");
    const short = (name: string) => `\`${name.split(".").slice(-2).join(".")}\``;
    const pruned = new Set((record.pruned ?? []).map((p) => p.name));
    const replaced = new Map((record.replaced ?? []).map((r) => [r.name, r.by]));
    const kept = sub.tests!.map((t) => ({ t: replaced.get(t.name) ?? t, replacement: replaced.has(t.name) })).filter((k) => !pruned.has(k.t.name));
    if (kept.length === 0) L("None remain: every test written for this change was removed after it, as guarding nothing the final diff changed (see below).");
    else {
      L("Written and accepted before the change, run unchanged on it, and checked against the final diff.");
      L();
      L("| Test | Kind | Behavior |");
      L("|---|---|---|");
      for (const { t, replacement } of kept) {
        const note = replacement ? " (replacement, written after the change)" : t.wiring ? " (wiring)" : t.needs_refactor ? " (needs refactor)" : "";
        L(`| ${short(t.name)} | ${t.kind}${note} | ${t.behavior.replace(/\|/g, "\\|")}${t.characterizes_suspected_bug ? " **(pins a suspected bug)**" : ""} |`);
      }
    }
    const replacedKept = (record.replaced ?? []).filter((r) => !pruned.has(r.by.name));
    if (replacedKept.length) {
      L();
      L("**Replaced after the change.** These tests were valid on both versions but costly to keep (a database, the container, or long setup). The refactoring created the seam for a cheaper unit test, which passed the same gates on the new code and was reviewed as protecting the same behavior; the original was then removed:");
      for (const r of replacedKept) L(`- ${short(r.name)} replaced by ${short(r.by.name)}`);
    }
    if (record.pruned?.length) {
      L();
      L("**Removed after the change.** A reviewer checked every test against the final diff, asking whether it meaningfully checks something this change could have broken. These passed before and after, but guard nothing the diff changed, so they are not part of this pull request:");
      for (const p of record.pruned) L(`- ${short(p.name)}: ${p.reason}`);
    }
    if (record.relevance_note) { L(); L(`_${record.relevance_note}_`); }
    if (record.needs_refactor?.length) {
      L();
      L("**Tests still to rewrite.** Valid on both versions, but costly to keep; no cheaper test was possible yet:");
      for (const n of record.needs_refactor) L(`- \`${n.name.split(".").at(-1)}\`: ${n.after_refactor} (why not yet: ${n.reason})`);
    }
    if (record.replace_note) { L(); L(`_${record.replace_note}_`); }
    if (record.adapted) {
      L();
      L("**Existing tests adapted to the new surface.** The refactoring changed how these tests reach the code. Only construction and calls changed: every test kept its name and its assertion lines, and a reviewer compared the old and new body of each.");
      for (const f of record.adapted.files) L(`- \`${f}\``);
      L(`- ${record.adapted.summary}`);
    }
    L();
    L(`## Risk: ${risk.level}`);
    L(risk.reasoning);
    if (risk.uncovered.length) { L(); L("Not covered by tests:"); for (const u of risk.uncovered) L(`- ${u}`); }
    if (record.approval) { L(); L(`Approved before implementation${record.approval.note ? `: ${record.approval.note}` : ""}.`); }
    L();
    L("## Verification");
    const v = record.verify as VerifyReport;
    for (const p of v.projects) L(`- \`${p.project}\`: ${p.passed} passed, ${p.failed} failed (failures, if any, also failed before the change)`);
    L(`- Analyzer: ${v.analyzer}`);
    L(`- Complexity: ${record.complexity!.effective} (limit ${fx.complexity_limit})`);
    if (record.review) reviewSection(L, record.review);
    L();
    L(`Generated by the quality harness refactor phase, run \`${runId}\`.`);
    return out.join("\n");
  }
}

/** `source` without `block` and the rest of its lines, and without the blank line that would be left doubled. */
/** Whether a quoted line is (part of) a line the unified diff adds or removes, ignoring whitespace and a leading +/-. */
export function diffQuotes(diff: string): (line: string) => boolean {
  const flat = (s: string) => s.trim().replace(/\s+/g, " ");
  const changed = diff.split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).map((l) => flat(l.slice(1))).filter(Boolean);
  return (line) => { const q = flat(line.replace(/^\s*[+-]/, "")); return q.length >= 6 && changed.some((c) => c.includes(q)); };
}

function removeBlock(source: string, block: string): string {
  const start = source.indexOf(block);
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nl = source.indexOf("\n", start + block.length);
  const before = source.slice(0, lineStart);
  let after = nl < 0 ? "" : source.slice(nl + 1);
  if (/\n[ \t]*\r?\n$/.test(before) && /^[ \t]*\r?\n/.test(after)) after = after.replace(/^[ \t]*\r?\n/, "");
  return before + after;
}

function tokenTotals(turns: TurnRecord[]): { input: number; output: number; cache_read: number; cache_write: number } {
  const sum = (k: keyof NonNullable<TurnRecord["usage"]>) => turns.reduce((s, t) => s + (t.usage?.[k] ?? 0), 0);
  return { input: sum("inputTokens"), output: sum("outputTokens"), cache_read: sum("cacheReadTokens"), cache_write: sum("cacheWriteTokens") };
}

/** Cost, tokens, and time per role and model, so runs with different model choices can be compared. */
function byRole(turns: CostedTurn[], models: Record<Role, string>): Record<string, { model: string; turns: number; cost_usd?: number; tokens: ReturnType<typeof tokenTotals>; seconds: number }> {
  const out: ReturnType<typeof byRole> = {};
  for (const role of [...new Set(turns.map((t) => t.role))]) {
    const mine = turns.filter((t) => t.role === role);
    const priced = mine.filter((t) => t.cost_usd !== undefined);
    out[role] = {
      model: models[role], turns: mine.length,
      cost_usd: priced.length ? +priced.reduce((s, t) => s + t.cost_usd!, 0).toFixed(4) : undefined,
      tokens: tokenTotals(mine), seconds: Math.round(mine.reduce((s, t) => s + (t.duration_ms ?? 0), 0) / 1000),
    };
  }
  return out;
}

function raiseComplexity(record: ItemRecord, reason: string): void {
  const level = record.complexity!.effective + 1;
  record.complexity = { ...record.complexity!, effective: level, floor_reasons: [...record.complexity!.floor_reasons, `${level}: ${reason}`] };
}

function testFailureSummary(r: TestRefactorReport): string {
  const changed = r.audit.filter((v) => v.verdict === "changed");
  return [
    r.build_errors.length ? `${r.build_errors.length} build error(s)` : "",
    r.regressions.length ? `${r.regressions.length} failing or missing test(s)` : "",
    ...r.inventory_errors.slice(0, 3),
    changed.length ? `reviewer: ${changed.length} test(s) changed what they verify` : "",
    ...r.scope_errors,
  ].filter(Boolean).join("; ");
}

/** Modified, deleted, and new files relative to HEAD (ignored files excluded). */
function changedFiles(cwd: string): string[] {
  const list = (...args: string[]) => git(cwd, ...args).split("\0").filter(Boolean).map(norm);
  return [...new Set([...list("diff", "--name-only", "-z", "HEAD"), ...list("ls-files", "--others", "--exclude-standard", "-z")])];
}

/** The work tree's changes, new files included, as a patch file; the index is left as it was. */
function stagedDiff(cwd: string, file: string): void {
  git(cwd, "add", "-A");
  try { git(cwd, "diff", "--cached", "--binary", `--output=${file}`); } finally { git(cwd, "reset", "-q"); }
}

function humanize(test: string): string {
  return test.replace(/\(.*$/, "").split(".").at(-1)!.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function failureSummary(r: VerifyReport): string {
  return [
    r.build_errors.length ? `${r.build_errors.length} build error(s)` : "",
    r.regressions.length ? `${r.regressions.length} failing test(s)` : "",
    r.resolved ? "" : `analyzer ${r.analyzer}`,
    ...r.scope_errors,
  ].filter(Boolean).join("; ");
}

/** Open items, minus those already deferred, escalated, or rejected by the reviewer at this complexity limit or a higher one. */
function openItems(items: RegisterItem[], only: string[], outcomesLog: string, limit: number): RegisterItem[] {
  const open = items.filter((i) => i.status === "open" || i.status === "reopened");
  if (only.length) {
    const byId = new Map(open.map((i) => [i.id, i]));
    const missing = only.filter((id) => !byId.has(id));
    if (missing.length) throw new HarnessError(`Not open register items: ${missing.join(", ")}.`);
    return only.map((id) => byId.get(id)!);
  }
  const deferred = new Set(fs.existsSync(outcomesLog)
    ? fs.readFileSync(outcomesLog, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => JSON.parse(l) as { item: string; outcome: string; complexity_limit?: number; max_complexity?: number })
      .filter((o) => ["deferred", "escalated", "review-rejected"].includes(o.outcome) && (o.complexity_limit ?? o.max_complexity ?? 0) >= limit).map((o) => o.item)
    : []);
  return open.filter((i) => !deferred.has(i.id));
}

function formatResults(results: TestResult[], requested?: string[]): string {
  if (results.length === 0) return requested?.length ? `No tests matched: ${requested.join(", ")}. Check namespace, class, and method names.` : "No tests ran.";
  const passed = results.filter((r) => r.outcome === "Passed").length;
  const lines = results.map((r) => `${r.outcome} ${r.name}${r.outcome === "Passed" ? "" : `\n  ${r.message.slice(0, 600).replace(/\n/g, "\n  ")}`}`);
  const text = `${passed} passed, ${results.length - passed} not passed.\n${lines.join("\n")}`;
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n...truncated` : text;
}

function copyTests(worktree: string, written: Set<string>, dir: string): void {
  for (const file of written) {
    const src = path.join(worktree, file);
    if (fs.existsSync(src)) writeText(path.join(dir, "tests", file), fs.readFileSync(src, "utf8"));
  }
}