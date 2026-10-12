import fs from "node:fs";
import type { RunContext } from "./context.ts";
import type { Metrics } from "./types.ts";
import { exec, HarnessError, readJson, toPosix, type ExecResult } from "./util.ts";

function command(ctx: RunContext, template: string[], values: Record<string, string>): [string, string[]] {
  const all = { skill: toPosix(ctx.analyzer.skill), worktree: ctx.paths.analysisDir, register: ctx.paths.registerDir, ...values };
  const [cmd, ...args] = template.map((part) => part.replace(/\{(\w+)\}/g, (m, key: string) => all[key as keyof typeof all] ?? m));
  return [cmd, args];
}

export function analyze(ctx: RunContext): Metrics {
  const metricsPath = ctx.file("metrics.json");
  fs.mkdirSync(ctx.paths.registerDir, { recursive: true });
  const [cmd, args] = command(ctx, ctx.analyzer.analyze, { metrics: metricsPath });
  const result = exec(cmd, args, { cwd: ctx.paths.analysisDir });
  ctx.log(result.stdout.split(/\r?\n/).filter((l) => /^(Analyzed|Findings|\d+ finding)/.test(l)).join(" | "));
  if (!fs.existsSync(metricsPath)) throw new HarnessError(`The analyzer did not write ${metricsPath}.`);
  const metrics = readJson<Metrics>(metricsPath);
  if (!Array.isArray(metrics.findings)) throw new HarnessError(`${metricsPath} has no 'findings' array.`);
  return metrics;
}

/** Runs the analyzer's report command; exit code 2 means the review was rejected and stderr lists why. */
export function report(ctx: RunContext, reviewPath: string, outPath: string): ExecResult {
  const [cmd, args] = command(ctx, ctx.analyzer.report, { metrics: ctx.file("metrics.json"), review: reviewPath, out: outPath });
  return exec(cmd, args, { cwd: ctx.paths.analysisDir, allowFail: true });
}

export function reportErrors(result: ExecResult): string[] {
  return result.stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2))
    .concat(result.code !== 0 && !result.stderr.includes("- ") ? [(result.stderr || result.stdout).trim()] : []);
}

export function parseRatings(stdout: string): Record<string, string> {
  const ratings: Record<string, string> = {};
  const overall = /Overall risk: (\w+)/.exec(stdout);
  if (overall) ratings.overall = overall[1].toLowerCase();
  for (const m of stdout.matchAll(/^\s+([A-Z]{3})\s+([A-Z]+)\s+density/gm)) ratings[m[1].toLowerCase()] = m[2].toLowerCase();
  return ratings;
}
