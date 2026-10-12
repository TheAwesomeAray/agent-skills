import fs from "node:fs";
import path from "node:path";
import { HARNESS_DIR } from "./config.ts";
import type { RunContext } from "./context.ts";
import { fill, toPosix } from "./util.ts";

const read = (name: string): string => fs.readFileSync(path.join(HARNESS_DIR, "prompts", `${name}.md`), "utf8");

// The SDK loads no skills by default, so the skill's own files are inlined into the prompt.
export function skillReferences(ctx: RunContext): { skill: string; criteria: string } {
  const [skillFile, ...rest] = ctx.analyzer.references;
  const load = (rel: string) => fs.readFileSync(path.join(ctx.analyzer.skill, rel), "utf8").replace(/^---[\s\S]*?---\s*/, "");
  return { skill: load(skillFile), criteria: rest.map(load).join("\n\n") };
}

export function prompt(ctx: RunContext, name: string, tool: string, values: Record<string, string | number>): string {
  const shared = fill(read("shared-rules"), { worktree: toPosix(ctx.paths.analysisDir), tool, prefix: ctx.prefix });
  return fill(read(name), { shared_rules: shared, ...values });
}

export const json = (value: unknown): string => JSON.stringify(value, null, 2);
export const pathList = (paths: string[]): string => (paths.length === 0 ? "none" : paths.map((p) => `\`${toPosix(p)}\``).join(", "));
