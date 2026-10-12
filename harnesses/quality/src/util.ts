import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Severity } from "./types.ts";

export class HarnessError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(cmd: string, args: string[], opts: { cwd?: string; allowFail?: boolean } = {}): ExecResult {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new HarnessError(`Could not run ${cmd}: ${r.error.message}`);
  const result = { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (result.code !== 0 && !opts.allowFail)
    throw new HarnessError(`${cmd} ${args.join(" ")} failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`);
  return result;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function log(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

export const now = (): string => new Date().toISOString();

export const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
export const sevRank = (s: string | undefined): number => SEVERITIES.indexOf(s as Severity);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
