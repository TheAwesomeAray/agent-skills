import fs from "node:fs";
import { Cursor, CursorAgentError } from "@cursor/sdk";
import { loadConfig, merge, type Config } from "./config.ts";
import { RunContext, runPaths, STEPS, type StepName } from "./context.ts";
import { addWorktree, git, gitTry, isDisabledPushUrl, remoteHead, removeWorktree, repoRoot } from "./git.ts";
import { getHost } from "./hosts/index.ts";
import { debateStep, judgeStep } from "./steps/debate.ts";
import { assembleStep, proposeStep, reconcileStep } from "./steps/finish.ts";
import { analyzeStep, carryForwardStep, reviewStep } from "./steps/review.ts";
import type { Manifest, Role } from "./types.ts";
import { HarnessError, log, now, readJson } from "./util.ts";

export interface RunOptions {
  repo: string;
  overrides: Record<string, unknown>;
  push: boolean;
  verbose: boolean;
  keepWorktrees: boolean;
}

const apiKey = (): string | undefined => process.env.CURSOR_API_KEY?.trim() || undefined;

async function checkModels(config: Config): Promise<void> {
  let models;
  try {
    models = await Cursor.models.list({ apiKey: apiKey() });
  } catch (e) {
    if (e instanceof CursorAgentError) throw new HarnessError(`Could not reach Cursor (${e.message}). Set CURSOR_API_KEY to a user or service-account API key.`);
    throw e;
  }
  const known = new Set(models.flatMap((m) => [m.id, ...(m.aliases ?? [])]));
  const missing = Object.entries(config.models).filter(([, id]) => !known.has(id));
  if (missing.length > 0)
    throw new HarnessError(`Unknown model(s): ${missing.map(([role, id]) => `${role}=${id}`).join(", ")}.\nAvailable: ${models.map((m) => m.id).join(", ")}\nSet them in harness.config.json, .tech-debt/config.json, or with --set models.<role>=<id>.`);
}

async function preflight(opts: RunOptions): Promise<RunContext> {
  const root = repoRoot(opts.repo);
  const config = loadConfig(root, opts.overrides);
  const host = getHost(config.git.host);
  const remote = config.git.remote;

  const remoteUrl = gitTry(root, "remote", "get-url", remote);
  if (!remoteUrl) throw new HarnessError(`The repository has no '${remote}' remote.`);
  const originRepo = host.repoFromUrl(remoteUrl);
  if (!originRepo) throw new HarnessError(`'${remote}' (${remoteUrl}) is not a ${host.name} repository. Set git.host or git.remote.`);
  if (config.git.pr_repo && config.git.pr_repo.toLowerCase() !== originRepo.toLowerCase())
    throw new HarnessError(`'${remote}' points to ${originRepo} but git.pr_repo is ${config.git.pr_repo}; refusing to push somewhere unexpected.`);
  const upstreamPush = gitTry(root, "remote", "get-url", "--push", "upstream");
  if (upstreamPush !== undefined && !isDisabledPushUrl(upstreamPush))
    throw new HarnessError(`The 'upstream' remote is pushable (${upstreamPush}). Disable it first: git remote set-url --push upstream DISABLED`);

  await checkModels(config);

  log(`Fetching ${remote}...`);
  git(root, "fetch", remote);
  const baseBranch = config.git.base_branch ?? remoteHead(root, remote) ?? host.defaultBranch(originRepo);
  const commit = git(root, "rev-parse", `${remote}/${baseBranch}`);
  const iso = new Date().toISOString();
  const runId = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z-${commit.slice(0, 7)}`;
  const branch = `agent-runs/${config.analysis}/${runId}`;

  const paths = runPaths(config, runId);
  fs.mkdirSync(paths.workDir, { recursive: true });
  addWorktree(root, paths.analysisDir, commit);
  addWorktree(root, paths.branchDir, commit, branch);

  const manifest: Manifest = {
    schema_version: 1, run_id: runId, analysis: config.analysis, repo: originRepo, repo_root: root, commit, base_branch: baseBranch,
    branch, work_dir: paths.workDir, models: config.models as Record<Role, string>,
    steps: STEPS.map((name) => ({ name, status: "pending" })), turns: [], status: "running", push: opts.push, overrides: opts.overrides,
  };
  const ctx = new RunContext({ config, host, manifest, apiKey: apiKey(), verbose: opts.verbose });
  ctx.saveManifest();
  log(`Run ${runId}: ${originRepo} ${baseBranch} @ ${commit.slice(0, 7)} -> branch ${branch}`);
  log(`Work directory: ${paths.workDir}`);
  return ctx;
}

async function resumeContext(runId: string, opts: RunOptions): Promise<RunContext> {
  const root = repoRoot(opts.repo);
  const paths = runPaths(loadConfig(root, opts.overrides), runId);
  const manifestPath = `${paths.runDir}/manifest.json`;
  if (!fs.existsSync(manifestPath)) throw new HarnessError(`No manifest for run ${runId} at ${manifestPath}.`);
  const manifest = readJson<Manifest>(manifestPath);
  manifest.overrides = merge(manifest.overrides ?? {}, opts.overrides);
  const config = loadConfig(root, manifest.overrides);
  if (manifest.status !== "running" && manifest.status !== "failed") throw new HarnessError(`Run ${runId} is already ${manifest.status}.`);
  await checkModels(config);
  manifest.status = "running";
  log(`Resuming run ${runId} from step '${manifest.steps.find((s) => s.status !== "done")?.name}'.`);
  return new RunContext({ config, host: getHost(config.git.host), manifest, apiKey: apiKey(), verbose: opts.verbose });
}

const handlers: Record<StepName, (ctx: RunContext) => Promise<void>> = {
  "analyze": analyzeStep,
  "carry-forward": carryForwardStep,
  "review": reviewStep,
  "debate": debateStep,
  "judge": judgeStep,
  "assemble": assembleStep,
  "reconcile": reconcileStep,
  "propose": (ctx) => proposeStep(ctx, ctx.manifest.push),
};

async function execute(ctx: RunContext, keepWorktrees: boolean): Promise<void> {
  try {
    for (const name of STEPS) {
      const step = ctx.step(name);
      if (step.status === "done") continue;
      log(`== ${name}`);
      try {
        await handlers[name](ctx);
      } catch (e) {
        step.status = "failed";
        step.error = e instanceof Error ? e.message : String(e);
        ctx.manifest.status = "failed";
        ctx.saveManifest();
        throw e;
      }
      step.status = "done";
      step.finished_at = now();
      delete step.error;
      ctx.saveManifest();
    }
  } catch (e) {
    log(`Run failed. Fix the problem and continue with: npm run solid -- resume ${ctx.runId} --repo ${ctx.manifest.repo_root}`);
    throw e;
  } finally {
    await ctx.disposeAgents();
  }
  if (!keepWorktrees) {
    removeWorktree(ctx.manifest.repo_root, ctx.paths.analysisDir);
    removeWorktree(ctx.manifest.repo_root, ctx.paths.branchDir);
  }
  log(`Done. Branch ${ctx.manifest.branch}${ctx.manifest.pr ? `, PR ${ctx.manifest.pr}` : ""}. Agent event log: ${ctx.paths.workDir}`);
}

export async function run(opts: RunOptions): Promise<void> {
  await execute(await preflight(opts), opts.keepWorktrees);
}

export async function resume(runId: string, opts: RunOptions): Promise<void> {
  await execute(await resumeContext(runId, opts), opts.keepWorktrees);
}
