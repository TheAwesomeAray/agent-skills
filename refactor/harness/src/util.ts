import { spawn, spawnSync } from "node:child_process";
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

/** Like `exec` but does not block the event loop, so agents keep streaming while long commands run. */
export function execAsync(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const limit = opts.timeoutMs;
    const stop = limit ? everyAwakeTick((awake) => { if (awake >= limit) { stop?.(); child.kill(); } }) : undefined;
    child.on("error", (e) => { stop?.(); reject(new HarnessError(`Could not run ${cmd}: ${e.message}`)); });
    child.on("close", (code) => { stop?.(); resolve({ code: code ?? -1, stdout, stderr }); });
  });
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

const TICK_MS = 5_000;
// While the machine sleeps (including Modern Standby) nothing runs but the wall clock keeps moving, so a tick this late
// is counted as sleep. A synchronous command blocking the event loop this long is also not counted.
const SLEEP_GAP_MS = 60_000;

/**
 * Calls `onTick` every few seconds with the total time the machine has been awake since the call, so timeouts do not
 * expire because the PC slept. `onSleep` gets the length of each sleep. Returns a function that stops the ticks.
 */
export function everyAwakeTick(onTick: (awakeMs: number) => void, onSleep?: (sleptMs: number) => void): () => void {
  let awake = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const t = Date.now();
    const gap = t - last;
    last = t;
    if (gap > SLEEP_GAP_MS) onSleep?.(gap);
    else awake += gap;
    onTick(awake);
  }, TICK_MS);
  return () => clearInterval(timer);
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
