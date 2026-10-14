import fs from "node:fs";
import path from "node:path";
import type { RefactorConfig } from "../config.ts";
import { execAsync, toPosix, writeText } from "../util.ts";

export interface Diagnostic {
  file: string;
  line: number;
  code: string;
  message: string;
}

export interface TestResult {
  name: string;
  outcome: string;
  message: string;
}

export interface TestRun {
  built: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  results: TestResult[];
  output: string;
}

const expand = (p: string): string => p.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m);

/** Runs builds and tests with the configured SDK, one command at a time per instance. */
export class Dotnet {
  private readonly tc: RefactorConfig["toolchain"];
  private readonly env: NodeJS.ProcessEnv;
  private readonly exe: string;
  private queue: Promise<unknown> = Promise.resolve();
  private counter = 0;

  constructor(tc: RefactorConfig["toolchain"]) {
    this.tc = tc;
    const root = tc.dotnet_root ? path.resolve(expand(tc.dotnet_root)) : undefined;
    this.exe = root ? path.join(root, process.platform === "win32" ? "dotnet.exe" : "dotnet") : "dotnet";
    this.env = {
      ...process.env,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      ...(root ? { DOTNET_ROOT: root, DOTNET_MULTILEVEL_LOOKUP: "0", PATH: `${root}${path.delimiter}${process.env.PATH}` } : {}),
      ...tc.env,
    };
  }

  /** dotnet finds global.json by walking up from the work tree, so pinning there keeps the target repo untouched. */
  pinSdk(parentDir: string): void {
    if (this.tc.sdk) writeText(path.join(parentDir, "global.json"), JSON.stringify({ sdk: { version: this.tc.sdk, rollForward: "latestPatch" } }, null, 2) + "\n");
  }

  async version(cwd: string): Promise<string> {
    const r = await this.run(cwd, ["--version"]);
    return r.stdout.trim();
  }

  build(cwd: string, project: string): Promise<{ built: boolean; errors: Diagnostic[]; warnings: Diagnostic[] }> {
    return this.serial(async () => {
      const r = await this.run(cwd, ["build", project, ...this.tc.build_args]);
      const output = `${r.stdout}\n${r.stderr}`;
      const errors = diagnostics(output, "error", cwd);
      return { built: errors.length === 0 && r.code === 0, errors, warnings: diagnostics(output, "warning", cwd) };
    });
  }

  /** Builds (unless `noBuild`) and runs `project`, limited to `tests` when given. */
  test(cwd: string, project: string, opts: { tests?: string[]; noBuild?: boolean; resultsDir: string }): Promise<TestRun> {
    return this.serial(async () => {
      const trx = `run-${++this.counter}.trx`;
      const args = ["test", project, ...this.tc.build_args, "--logger", `trx;LogFileName=${trx}`, "--results-directory", opts.resultsDir];
      if (opts.noBuild) args.push("--no-build");
      if (opts.tests?.length) args.push("--filter", opts.tests.map((t) => `FullyQualifiedName=${t}`).join("|"));
      const r = await this.run(cwd, args);
      const output = `${r.stdout}\n${r.stderr}`;
      const trxPath = path.join(opts.resultsDir, trx);
      const results = fs.existsSync(trxPath) ? parseTrx(fs.readFileSync(trxPath, "utf8")) : [];
      const errors = diagnostics(output, "error", cwd);
      return { built: errors.length === 0, errors, warnings: diagnostics(output, "warning", cwd), results, output };
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private run(cwd: string, args: string[]) {
    return execAsync(this.exe, args, { cwd, env: this.env, timeoutMs: 20 * 60_000 });
  }
}

/** Compiler and MSBuild diagnostics, de-duplicated, with paths relative to `root`. */
export function diagnostics(output: string, level: "error" | "warning", root: string): Diagnostic[] {
  const seen = new Set<string>();
  const found: Diagnostic[] = [];
  const re = new RegExp(String.raw`^\s*(.+?)\((\d+),\d+\): ${level} (\w+): (.+?)(?: \[[^\]]+\])?\s*$`, "gm");
  const base = toPosix(path.resolve(root)).toLowerCase() + "/";
  for (const m of output.matchAll(re)) {
    let file = toPosix(m[1]);
    if (file.toLowerCase().startsWith(base)) file = file.slice(base.length);
    const key = `${file}:${m[2]}:${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ file, line: Number(m[2]), code: m[3], message: m[4] });
  }
  if (level === "error" && found.length === 0) {
    for (const m of output.matchAll(/^\s*(?:.+?: )?error (\w+): (.+?)\s*$/gm)) found.push({ file: "", line: 0, code: m[1], message: m[2] });
  }
  return found;
}

function parseTrx(xml: string): TestResult[] {
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const results: TestResult[] = [];
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const attr = (name: string) => unescape(new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? "");
    const body = m[3] ?? "";
    const message = unescape(/<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1] ?? "");
    const stack = unescape(/<StackTrace>([\s\S]*?)<\/StackTrace>/.exec(body)?.[1] ?? "");
    results.push({ name: attr("testName"), outcome: attr("outcome"), message: [message, stack.split("\n").slice(0, 4).join("\n")].filter(Boolean).join("\n") });
  }
  return results;
}

/** Results for a fully qualified method name, including every case of a theory. */
export function resultsFor(results: TestResult[], name: string): TestResult[] {
  return results.filter((r) => r.name === name || r.name.startsWith(`${name}(`));
}
