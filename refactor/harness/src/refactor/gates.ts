import fs from "node:fs";
import path from "node:path";
import { git } from "../git.ts";
import { toPosix } from "../util.ts";
import { resultsFor, type Dotnet, type TestRun } from "./dotnet.ts";

export interface DeclaredTest {
  name: string;
  file: string;
  kind: "unit" | "integration";
  wiring?: boolean;
  /** Valid before and after the refactoring, but expensive to keep; rewritten after implementation. */
  needs_refactor?: { reason: string; after_refactor: string };
  behavior: string;
  protects: string;
  why: string;
  characterizes_suspected_bug: boolean;
  sabotage: { file: string; find: string; replace: string };
}

export type RiskLevel = "low" | "medium" | "high";
export const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];
export interface RiskAssessment { level: RiskLevel; uncovered: string[]; reasoning: string; proposed_complexity?: number }

export interface CoverageEntry { tests: string[]; not_covered?: string }
export interface Coverage {
  breakages: (CoverageEntry & { name: string; step: string })[];
  plan_points: (CoverageEntry & { ref: string })[];
}

export interface TestSubmission {
  outcome: "tests" | "escalate";
  escalation?: { proposed_complexity: number; reason: string };
  risk?: RiskAssessment;
  coverage?: Coverage;
  tests?: DeclaredTest[];
}

export interface CoverageReview {
  verdict: "sufficient" | "insufficient";
  findings: { kind: "missing-breakage" | "out-of-scope" | "mapping-wrong" | "reason-rejected" | "risk-understated"; subject: string; detail: string }[];
}

export interface AuditVerdict {
  name: string;
  verifies: string;
  verdict: "match" | "mismatch";
  reason: string;
}

export interface GateReport {
  passed: boolean;
  stage: string;
  errors: string[];
  runs: { stage: string; test?: string; outcome: string; detail?: string }[];
  audit: AuditVerdict[];
  coverage?: CoverageReview;
}

export interface GateContext {
  worktree: string;
  testProjects: string[];
  testDirs: string[];
  maxTests: number;
  determinismRuns: number;
  dotnet: Dotnet;
  resultsDir: string;
  /** Files the tester wrote this turn. */
  written: Set<string>;
  /** How many steps, change_points, and risks the plan lists; coverage must account for each change point and risk, and breakages name a step. */
  planPoints: { steps: number; change_points: number; risks: number };
  /** Types whose constructor the plan changes; a test that calls it will not compile after the refactoring. */
  changedConstructors: string[];
  /** `failures` holds each test's failure message under its own sabotage. */
  audit: (file: string, content: string, tests: DeclaredTest[], failures: Map<string, string>) => Promise<AuditVerdict[]>;
  reviewCoverage: (sub: TestSubmission) => Promise<CoverageReview>;
  /** replace: cheaper tests replacing needs_refactor tests after the refactoring (case C); no coverage map or risk, which the original submission carried. */
  mode?: "characterize" | "replace";
}

const norm = (f: string): string => toPosix(f).replace(/^\.\//, "");
const under = (file: string, dir: string): boolean => norm(file).toLowerCase().startsWith(norm(dir).replace(/\/?$/, "/").toLowerCase());
export const projectDir = (project: string): string => norm(path.posix.dirname(norm(project)));

/** The project whose folder contains `file`. */
export function projectFor(file: string, projects: string[]): string | undefined {
  return projects.find((p) => under(file, projectDir(p)));
}

const ISOLATION: [RegExp, string][] = [
  [/\b(File|Directory|Path)\.(Read|Write|Open|Create|Delete|Exists|Get(Files|Directories)|Copy|Move|Append)/, "file system access"],
  [/\bHttpClient\b|\bWebRequest\b|\bWebClient\b|\bSocket\b/, "network access"],
  [/\bDateTime(Offset)?\.(Now|UtcNow|Today)\b/, "reads the clock"],
  [/\bEnvironment\.(GetEnvironmentVariable|CurrentDirectory|MachineName|UserName)\b/, "reads the environment"],
  [/\bSqlConnection\b|\bUseSqlServer\b|\bUseSqlite\b|ConnectionString/, "uses a real database"],
  [/\bThread\.Sleep\b|\bTask\.Delay\b/, "sleeps"],
  [/\bnew Random\(\s*\)/, "unseeded randomness"],
  [/BindingFlags\.NonPublic|\.GetField\(|\.GetMethod\(|\bInvokeMember\(/, "reflection into private members"],
];
const ASSERTION = /\bAssert\.\w+|\.Should\(|\.Should[A-Z]\w*\(|\.Verify\(|\.VerifyAll\(/;
/** Failure messages raised by xUnit, NUnit, MSTest, FluentAssertions, Shouldly, Moq, and NSubstitute when an assertion fails. */
const ASSERTION_FAILURE = /^\s*(Assert\.\w+(\(\))?\s*(Failure|failed)|Expected\b|Xunit\.Sdk\.|NUnit\.Framework\.|Microsoft\.VisualStudio\.TestTools\.UnitTesting\.|FluentAssertions\.|Shouldly\.|Moq\.MockException|NSubstitute\.Exceptions\.)/;
const EXCEPTION_FAILURE = /^\s*((?:[A-Za-z_]\w*\.)+\w*Exception)\s*:/;

/** The exception type when a test failed because the code threw, rather than because an assertion failed; undefined otherwise, including unrecognized formats. */
export function thrownInsteadOfAsserted(message: string): string | undefined {
  if (ASSERTION_FAILURE.test(message)) return undefined;
  return EXCEPTION_FAILURE.exec(message)?.[1];
}
/** Scaffolding that makes a test an integration test, whatever it is declared as. */
const SCAFFOLDING: [RegExp, string][] = [
  [/\bDbContext\b|\bUseInMemoryDatabase\b|\bDbContextOptions/, "a database context"],
  [/\bServiceCollection\b|\bServiceProvider\b|\bIServiceScope|\bBuildServiceProvider\b/, "a dependency injection container"],
  [/Get(Required)?Service<IMediator>|\bnew Mediator\(/, "the mediator pipeline"],
  [/\bTestServer\b|\bWebApplicationFactory\b|\bWebHost\b|\bStartup\b/, "the web host"],
];

/** Fully qualified names of the [Fact] and [Theory] methods a C# file declares: namespace (when there is one), class, method. */
export function testMethods(source: string): string[] {
  const names: string[] = [];
  const scopes = [...source.matchAll(/\bnamespace\s+([\w.]+)|\bclass\s+(\w+)/g)];
  for (const m of source.matchAll(/\[\s*(?:Fact|Theory)\b[^\]]*\](?:\s*\[[^\]]*\])*\s*public\s+(?:async\s+)?(?:void|Task)\s+(\w+)\s*\(/g)) {
    const before = scopes.filter((s) => s.index! < m.index!);
    const ns = before.findLast((s) => s[1])?.[1];
    const cls = before.findLast((s) => s[2])?.[2];
    if (cls) names.push(`${ns ? `${ns}.` : ""}${cls}.${m[1]}`);
  }
  return names;
}

export const countAssertions = (source: string): number => source.split(new RegExp(ASSERTION.source, "g")).length - 1;

/** The trimmed lines of a test method that hold an assertion, in order. */
export function assertionLines(source: string, method: string): string[] {
  return (methodSource(source, method) ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => ASSERTION.test(l));
}

/** The method's attributes, signature, and body, found by brace matching. */
export function methodSource(source: string, method: string): string | undefined {
  const sig = new RegExp(String.raw`(?:\[[^\]]*\]\s*)*public\s+(?:async\s+)?(?:void|Task)\s+${method}\s*\(`, "m").exec(source);
  if (!sig) return undefined;
  const open = source.indexOf("{", sig.index + sig[0].length);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(sig.index, i + 1);
  }
  return undefined;
}

/** Checks that need no build: declarations, files, attributes, assertions, isolation, sabotage patches. */
export function staticChecks(sub: TestSubmission, g: GateContext): string[] {
  const errors: string[] = [];
  if (sub.outcome === "escalate") {
    if (!sub.escalation) errors.push("escalation is required when outcome is escalate.");
    return errors;
  }
  const tests = sub.tests ?? [];
  if (tests.length === 0) return ["tests is empty. Submit at least one test, or escalate."];
  if (tests.length > g.maxTests) errors.push(`At most ${g.maxTests} tests; you submitted ${tests.length}.`);
  const names = new Set<string>();
  const scanned = new Set<string>();
  const wiring = tests.filter((t) => t.wiring);
  if (wiring.length > 1) errors.push(`Only one wiring test is allowed per item; ${wiring.map((t) => t.name).join(", ")} are all marked wiring.`);
  const kindByFile = new Map<string, Set<string>>();
  for (const t of tests) kindByFile.set(norm(t.file), (kindByFile.get(norm(t.file)) ?? new Set()).add(t.kind));
  for (const [file, kinds] of kindByFile)
    if (kinds.size > 1) errors.push(`'${file}' mixes unit and integration tests; put each kind in its own file.`);

  for (const [i, t] of tests.entries()) {
    const at = `tests[${i}] (${t.name})`;
    if (names.has(t.name)) errors.push(`${at}: declared twice.`);
    names.add(t.name);
    if (t.kind === "unit" && (t.wiring || t.needs_refactor)) errors.push(`${at}: wiring and needs_refactor apply only to integration tests.`);
    if (t.kind === "integration" && t.wiring && t.needs_refactor) errors.push(`${at}: the wiring test is not flagged needs_refactor; mark it one or the other.`);
    if (t.kind === "integration" && !t.wiring && !t.needs_refactor)
      errors.push(`${at}: an integration test that is not the single wiring test must set needs_refactor, saying why a cheaper test is not possible today and what test replaces it after the refactoring. Prefer a unit test.`);
    const parts = t.name.split(".");
    if (parts.length < 3 || !parts.every((p) => /^[A-Za-z_]\w*$/.test(p))) { errors.push(`${at}: name must be Namespace.Class.Method.`); continue; }
    const file = norm(t.file);
    if (!g.written.has(file)) { errors.push(`${at}: '${file}' is not a file you wrote with write_test_file.`); continue; }
    const source = fs.readFileSync(path.join(g.worktree, file), "utf8");
    const method = parts.at(-1)!, cls = parts.at(-2)!, ns = parts.slice(0, -2).join(".");
    if (!new RegExp(String.raw`\bnamespace\s+${ns.replace(/\./g, "\\.")}\b`).test(source)) errors.push(`${at}: '${file}' does not declare namespace ${ns}.`);
    if (!new RegExp(String.raw`\bclass\s+${cls}\b`).test(source)) errors.push(`${at}: '${file}' does not declare class ${cls}.`);
    const body = methodSource(source, method);
    if (!body) { errors.push(`${at}: no public void or Task method ${method} in '${file}'.`); continue; }
    if (!/\[\s*(Fact|Theory)\b/.test(body)) errors.push(`${at}: needs a [Fact] or [Theory] attribute.`);
    if (!ASSERTION.test(body)) errors.push(`${at}: has no assertion.`);

    const s = t.sabotage;
    const sabFile = norm(s.file);
    const full = path.join(g.worktree, sabFile);
    if (g.testDirs.some((d) => under(sabFile, d))) errors.push(`${at}: sabotage must change production code, not '${sabFile}'.`);
    else if (!fs.existsSync(full)) errors.push(`${at}: sabotage file '${sabFile}' does not exist.`);
    else {
      const count = fs.readFileSync(full, "utf8").split(s.find).length - 1;
      if (count !== 1) errors.push(`${at}: sabotage 'find' text occurs ${count} times in '${sabFile}'; it must occur exactly once.`);
      if (s.find === s.replace) errors.push(`${at}: sabotage 'replace' is the same as 'find'.`);
    }
  }
  for (const file of g.written) {
    if (scanned.has(file)) continue;
    scanned.add(file);
    const source = fs.readFileSync(path.join(g.worktree, file), "utf8");
    for (const [re, what] of ISOLATION) if (re.test(source)) errors.push(`'${file}': ${what} is not allowed in tests (${re.exec(source)![0]}).`);
    if (kindByFile.get(file)?.has("unit"))
      for (const [re, what] of SCAFFOLDING)
        if (re.test(source)) errors.push(`'${file}' holds unit tests but uses ${what} (${re.exec(source)![0]}). Unit tests use fakes for injectable dependencies only; if that is not possible, declare the test as integration with needs_refactor.`);
    for (const type of g.changedConstructors) {
      const call = new RegExp(String.raw`\bnew\s+${type}\s*(<[^>]*>)?\s*\(`).exec(source);
      if (call) errors.push(`'${file}' calls the ${type} constructor (${call[0]}), which the plan changes, so it will not compile after the refactoring. Every test must run unchanged before and after: reach ${type} through a boundary the plan leaves alone, or record the behavior as not covered.`);
    }
  }
  if (g.mode === "replace") return errors;
  errors.push(...coverageChecks(sub.coverage, names, g.planPoints));
  errors.push(...riskChecks(sub.risk, sub.coverage));
  return errors;
}

/** The risk level cannot claim more protection than the coverage map shows. */
function riskChecks(risk: RiskAssessment | undefined, coverage: Coverage | undefined): string[] {
  if (!risk) return ["risk is required: rate how much of what the refactoring could break your tests protect."];
  if (!coverage) return [];
  const gaps = [...coverage.breakages, ...coverage.plan_points].filter((e) => e.tests.length === 0);
  const errors: string[] = [];
  if (gaps.length > 0 && risk.uncovered.length === 0) errors.push("risk.uncovered is empty, but the coverage map leaves entries not covered; list them.");
  const breakageGap = coverage.breakages.find((b) => b.tests.length === 0);
  if (breakageGap && risk.level === "low") errors.push(`risk.level cannot be low while the breakage '${breakageGap.name}' is not covered.`);
  return errors;
}

/** The coverage map is complete and refers only to declared tests. Whether it is honest is the reviewer's call. */
function coverageChecks(coverage: Coverage | undefined, declared: Set<string>, points: GateContext["planPoints"]): string[] {
  if (!coverage) return ["coverage is required: list every way the change could break behavior and every plan change point and risk, each with the tests that cover it."];
  const errors: string[] = [];
  const mapped = new Set<string>();
  const entry = (at: string, e: CoverageEntry) => {
    for (const name of e.tests) {
      if (!declared.has(name)) errors.push(`coverage ${at}: '${name}' is not a declared test.`);
      mapped.add(name);
    }
    if (e.tests.length === 0 && !e.not_covered?.trim()) errors.push(`coverage ${at}: list the tests that cover it, or say why none does in not_covered.`);
    if (e.tests.length > 0 && e.not_covered) errors.push(`coverage ${at}: has tests and not_covered; keep one.`);
  };
  if (coverage.breakages.length === 0) errors.push("coverage.breakages: list at least one way a mistake in the plan's steps would change behavior.");
  for (const b of coverage.breakages) {
    const step = Number(/^steps\[(\d+)\]$/.exec(b.step)?.[1] ?? NaN);
    if (!(step < points.steps)) errors.push(`coverage breakage '${b.name}': '${b.step}' is not a step in the plan.`);
    entry(`breakage '${b.name}'`, b);
  }
  const refs = new Map(coverage.plan_points.map((p) => [p.ref, p]));
  for (const [list, count] of [["change_points", points.change_points], ["risks", points.risks]] as const)
    for (let i = 0; i < count; i++) {
      const p = refs.get(`${list}[${i}]`);
      if (!p) errors.push(`coverage.plan_points: no entry for ${list}[${i}].`);
      else entry(p.ref, p);
    }
  for (const ref of refs.keys()) {
    const [, list, i] = /^(\w+)\[(\d+)\]$/.exec(ref) ?? [];
    if (!list || list === "steps" || Number(i) >= points[list as keyof typeof points]) errors.push(`coverage.plan_points: '${ref}' is not in the plan.`);
  }
  for (const name of declared)
    if (!mapped.has(name)) errors.push(`${name} is not mapped to any breakage or plan point. Map it, or drop it: every test must catch something the change could break.`);
  return errors;
}

/** Build, green on the current code, determinism, sabotage, then the name audit. Stops at the first failing stage. */
export async function runGates(sub: TestSubmission, g: GateContext): Promise<GateReport> {
  const report: GateReport = { passed: false, stage: "static", errors: staticChecks(sub, g), runs: [], audit: [] };
  if (report.errors.length > 0 || sub.outcome === "escalate") { report.passed = report.errors.length === 0; return report; }
  const tests = sub.tests!;
  const byProject = new Map<string, DeclaredTest[]>();
  for (const t of tests) {
    const project = projectFor(t.file, g.testProjects)!;
    byProject.set(project, [...(byProject.get(project) ?? []), t]);
  }
  const fail = (stage: string, errors: string[]) => { report.stage = stage; report.errors = errors; return report; };
  const run = (project: string, names: string[], noBuild = false) => g.dotnet.test(g.worktree, project, { tests: names, noBuild, resultsDir: g.resultsDir });

  for (const [project, group] of byProject) {
    const names = group.map((t) => t.name);
    const first = await run(project, names);
    const written = [...g.written];
    if (!first.built) return fail("build", first.errors.slice(0, 30).map((e) => `Build error ${e.code} at ${e.file}:${e.line}: ${e.message}`));
    const warnings = first.warnings.filter((w) => written.includes(norm(w.file)));
    if (warnings.length > 0) return fail("build", warnings.map((w) => `Warning ${w.code} at ${w.file}:${w.line}: ${w.message}`));
    const green = outcomeErrors(first, group, "on the current code");
    for (const t of group) report.runs.push({ stage: "green", test: t.name, outcome: green.some((e) => e.includes(t.name)) ? "failed" : "passed" });
    if (green.length > 0) return fail("green", green);

    for (let i = 2; i <= g.determinismRuns; i++) {
      const again = await run(project, names, true);
      const flaky = outcomeErrors(again, group, `on repeat run ${i}`);
      report.runs.push({ stage: "determinism", outcome: flaky.length ? "varied" : "stable", detail: `run ${i}` });
      if (flaky.length > 0) return fail("determinism", flaky.map((e) => `Not deterministic: ${e}`));
    }
  }

  const sabotageErrors: string[] = [];
  const failures = new Map<string, string>();
  for (const t of tests) {
    const project = projectFor(t.file, g.testProjects)!;
    const file = path.join(g.worktree, norm(t.sabotage.file));
    const original = fs.readFileSync(file, "utf8");
    try {
      fs.writeFileSync(file, original.replace(t.sabotage.find, () => t.sabotage.replace));
      const r = await run(project, [t.name]);
      if (!r.built) {
        sabotageErrors.push(`${t.name}: the sabotage patch does not compile (${r.errors[0]?.message ?? "build failed"}). It must compile and break the behavior.`);
        report.runs.push({ stage: "sabotage", test: t.name, outcome: "patch did not compile" });
        continue;
      }
      const cases = resultsFor(r.results, t.name);
      const failed = cases.filter((c) => c.outcome !== "Passed");
      const asserted = failed.filter((c) => !thrownInsteadOfAsserted(c.message));
      if (failed.length > 0) failures.set(t.name, (asserted[0] ?? failed[0]).message.slice(0, 600));
      const outcome = failed.length === 0 ? "test still passed" : asserted.length === 0 ? "test threw instead of failing an assertion" : "assertion failed (good)";
      report.runs.push({ stage: "sabotage", test: t.name, outcome, detail: failed[0]?.message.split("\n")[0] });
      if (cases.length === 0) sabotageErrors.push(`${t.name}: did not run under its sabotage.`);
      else if (failed.length === 0) sabotageErrors.push(`${t.name}: still passes with its sabotage applied, so it does not protect that behavior. Strengthen the assertions or choose a sabotage that breaks what the test claims to protect.`);
      else if (asserted.length === 0)
        sabotageErrors.push(`${t.name}: under its sabotage it fails with ${thrownInsteadOfAsserted(failed[0].message)}, not an assertion. A sabotage that makes the code throw shows only that the test runs that code. Choose one that changes the behavior the test asserts, so its assertion is what fails.`);
    } finally {
      fs.writeFileSync(file, original);
    }
  }
  if (sabotageErrors.length > 0) return fail("sabotage", sabotageErrors);

  const byFile = new Map<string, DeclaredTest[]>();
  for (const t of tests) byFile.set(norm(t.file), [...(byFile.get(norm(t.file)) ?? []), t]);
  for (const [file, group] of byFile) report.audit.push(...await g.audit(file, fs.readFileSync(path.join(g.worktree, file), "utf8"), group, failures));
  const mismatches = report.audit.filter((v) => v.verdict === "mismatch");
  const missing = tests.filter((t) => !report.audit.some((v) => v.name === t.name));
  if (mismatches.length > 0 || missing.length > 0)
    return fail("audit", [
      ...mismatches.map((v) => `${v.name}: the reviewer says the body verifies "${v.verifies}", which the name, the declared behavior, or the sabotage does not match (${v.reason}). Rename it, fix 'behavior', change the assertions, or choose a sabotage that breaks the declared behavior.`),
      ...missing.map((t) => `${t.name}: the reviewer returned no verdict; resubmit.`),
    ]);

  if (g.mode === "replace") { report.stage = "passed"; report.passed = true; return report; }
  report.coverage = await g.reviewCoverage(sub);
  if (report.coverage.verdict === "insufficient")
    return fail("coverage", report.coverage.findings.length > 0
      ? report.coverage.findings.map((f) => `Coverage (${f.kind}) ${f.subject}: ${f.detail}`)
      : ["The coverage reviewer judged coverage insufficient without naming a gap; resubmit."]);

  report.stage = "passed";
  report.passed = true;
  return report;
}

function outcomeErrors(run: TestRun, tests: DeclaredTest[], when: string): string[] {
  const errors: string[] = [];
  for (const t of tests) {
    const cases = resultsFor(run.results, t.name);
    if (cases.length === 0) errors.push(`${t.name} did not run ${when}; check the declared name matches namespace, class, and method.`);
    for (const c of cases.filter((c) => c.outcome !== "Passed")) errors.push(`${c.name} ${c.outcome.toLowerCase()} ${when}: ${c.message.slice(0, 800)}`);
  }
  return errors;
}

/** True when `file` exists at `commit` (the tester may only create new files). */
export function existsAt(worktree: string, commit: string, file: string): boolean {
  try { git(worktree, "cat-file", "-e", `${commit}:${norm(file)}`); return true; } catch { return false; }
}
