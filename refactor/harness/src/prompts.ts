import fs from "node:fs";
import path from "node:path";
import { ROLES_DIR } from "./config.ts";
import type { RunContext } from "./context.ts";
import { fill, toPosix } from "./util.ts";

/** Reads a role prompt by its path under roles/, e.g. "planner/plan". */
export const readPrompt = (name: string): string => fs.readFileSync(path.join(ROLES_DIR, `${name}.md`), "utf8");

// The SDK loads no skills by default, so the lens guide and criteria are inlined into the prompt.
export function skillReferences(ctx: RunContext): { skill: string; criteria: string } {
  const [guide, ...rest] = ctx.lens.references;
  const load = (rel: string) => fs.readFileSync(path.join(ctx.lens.dir, rel), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  return { skill: load(guide), criteria: rest.map(load).join("\n\n") };
}

export function prompt(ctx: RunContext, name: string, tool: string, values: Record<string, string | number>): string {
  const shared = fill(readPrompt("shared/analysis-rules"), { worktree: toPosix(ctx.paths.analysisDir), tool, prefix: ctx.prefix });
  return fill(readPrompt(name), { shared_rules: shared, ...values });
}

export const json = (value: unknown): string => JSON.stringify(value, null, 2);
export const pathList = (paths: string[]): string => (paths.length === 0 ? "none" : paths.map((p) => `\`${toPosix(p)}\``).join(", "));
