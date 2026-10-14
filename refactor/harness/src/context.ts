import fs from "node:fs";
import path from "node:path";
import { RoleAgent } from "./agents.ts";
import type { Config, LensConfig } from "./config.ts";
import { git, isClean } from "./git.ts";
import type { Host } from "./hosts/host.ts";
import type { Manifest, Role } from "./types.ts";
import { HarnessError, log, writeJson } from "./util.ts";

export const STEPS = ["analyze", "carry-forward", "review", "debate", "judge", "assemble", "reconcile", "propose"] as const;
export type StepName = (typeof STEPS)[number];

export interface RunPaths {
  workDir: string;
  analysisDir: string;
  branchDir: string;
  registerDir: string;
  runDir: string;
  scratchDir: string;
}

export function runPaths(config: Config, runId: string): RunPaths {
  const workDir = path.join(config.work_dir!, runId);
  const branchDir = path.join(workDir, "branch");
  const registerDir = path.join(branchDir, ".tech-debt");
  return {
    workDir,
    analysisDir: path.join(workDir, "analysis"),
    branchDir,
    registerDir,
    runDir: path.join(registerDir, "runs", config.analysis, runId),
    scratchDir: path.join(workDir, "scratch"),
  };
}

export class RunContext {
  readonly config: Config;
  readonly lens: LensConfig;
  readonly host: Host;
  readonly manifest: Manifest;
  readonly paths: RunPaths;
  readonly apiKey: string | undefined;
  readonly verbose: boolean;
  private readonly agents: Partial<Record<Role, RoleAgent>> = {};

  constructor(init: { config: Config; host: Host; manifest: Manifest; apiKey: string | undefined; verbose: boolean }) {
    this.config = init.config;
    this.lens = init.config.lenses[init.config.analysis];
    this.host = init.host;
    this.manifest = init.manifest;
    this.apiKey = init.apiKey;
    this.verbose = init.verbose;
    this.paths = runPaths(init.config, init.manifest.run_id);
    fs.mkdirSync(this.paths.scratchDir, { recursive: true });
  }

  get runId(): string { return this.manifest.run_id; }
  get prefix(): string { return this.lens.id_prefix; }

  file(name: string): string {
    return path.join(this.paths.runDir, name);
  }

  saveManifest(): void {
    writeJson(this.file("manifest.json"), this.manifest);
  }

  async agent(role: Role, tools?: string[]): Promise<RoleAgent> {
    return (this.agents[role] ??= await this.newAgent(role, tools));
  }

  /** A fresh agent that shares nothing with earlier ones; the caller disposes it. */
  newAgent(role: Role, tools?: string[]): Promise<RoleAgent> {
    return RoleAgent.create(role, {
      apiKey: this.apiKey,
      cwd: this.paths.analysisDir,
      config: this.config,
      runId: this.runId,
      eventLog: path.join(this.paths.workDir, "events.jsonl"),
      verbose: this.verbose,
      onTurn: (record) => { this.manifest.turns.push(record); this.saveManifest(); },
      afterRun: (r) => this.assertWorktreeUnchanged(r),
    }, tools);
  }

  // Defense in depth: agents have no write tools, but any change to the analyzed code fails the step.
  private assertWorktreeUnchanged(role: Role): void {
    const { clean, changes } = isClean(this.paths.analysisDir);
    if (clean) return;
    git(this.paths.analysisDir, "checkout", "--", ".");
    git(this.paths.analysisDir, "clean", "-fd");
    throw new HarnessError(`The ${role} agent changed files in the analysis worktree; changes were discarded:\n${changes}`, 2);
  }

  async disposeAgents(): Promise<void> {
    for (const agent of Object.values(this.agents)) await agent?.dispose();
  }

  step(name: StepName) {
    return this.manifest.steps.find((s) => s.name === name)!;
  }

  log(message: string): void {
    log(message);
  }
}
