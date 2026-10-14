import fs from "node:fs";
import { Agent, CursorAgentError, type Run, type RunResult, type SDKAgent, type SDKCustomTool, type SDKJsonValue, type SDKMessage } from "@cursor/sdk";
import type { Config } from "./config.ts";
import type { Role, TurnRecord } from "./types.ts";
import { everyAwakeTick, HarnessError, log, now, sleep } from "./util.ts";
import { checkSchema, schemaFor, type SchemaName } from "./validate.ts";

// No edit, write, delete, or shell: analysis agents can read the code but never change it.
// "mcp" is required for the in-process submit tools.
export const READ_ONLY_TOOLS = ["read", "grep", "glob", "ls", "mcp"];

export interface Submission<T> {
  tool: string;
  description: string;
  schema: SchemaName;
  check: (value: T) => string[] | Promise<string[]>;
}

export interface AgentContext {
  apiKey: string | undefined;
  cwd: string;
  config: Config;
  runId: string;
  eventLog: string;
  verbose: boolean;
  onTurn: (record: TurnRecord) => void;
  afterRun: (role: Role) => void;
}

export class RoleAgent {
  readonly role: Role;
  private readonly agent: SDKAgent;
  private readonly ctx: AgentContext;
  private currentRun: Run | undefined;
  private acceptedInRun = false;
  step = "";

  private constructor(role: Role, agent: SDKAgent, ctx: AgentContext) {
    this.role = role;
    this.agent = agent;
    this.ctx = ctx;
  }

  static async create(role: Role, ctx: AgentContext, tools: string[] = READ_ONLY_TOOLS): Promise<RoleAgent> {
    const agent = await withStartupRetries(role, ctx.config.retries.startup, () =>
      Agent.create({
        apiKey: ctx.apiKey,
        model: { id: ctx.config.models[role] },
        name: `quality ${role} ${ctx.runId}`,
        tools,
        local: { cwd: ctx.cwd, settingSources: [] },
      }));
    log(`[${role}] agent ${agent.agentId} (${ctx.config.models[role]})`);
    return new RoleAgent(role, agent, ctx);
  }

  /**
   * Sends `message` and returns the first submission that passes schema and semantic checks.
   * `tools` are extra harness tools available during the turn (e.g. writing test files).
   */
  async turn<T>(step: string, message: string, submission: Submission<T>, tools: Record<string, SDKCustomTool> = {}): Promise<T> {
    this.step = step;
    let accepted: T | undefined;
    let rejections = 0;
    const limit = this.ctx.config.retries.rejections_per_turn;
    const tool: SDKCustomTool = {
      description: submission.description,
      inputSchema: schemaFor(submission.schema) as Record<string, SDKJsonValue>,
      execute: async (args) => {
        if (accepted !== undefined) return `Already accepted. Do not call ${submission.tool} again.`;
        if (rejections >= limit) return { isError: true, content: [{ type: "text", text: "Too many rejected submissions; stop now." }] };
        const value = args as unknown as T;
        const errors = checkSchema(submission.schema, value);
        if (errors.length === 0) errors.push(...(await submission.check(value)));
        if (errors.length > 0) {
          rejections++;
          log(`[${this.role}] ${submission.tool} rejected: ${errors.length} problem(s) (${rejections}/${limit})`);
          const shown = errors.slice(0, 40).map((e) => `- ${e}`).join("\n");
          const more = errors.length > 40 ? `\n- ...and ${errors.length - 40} more` : "";
          return { isError: true, content: [{ type: "text", text: `Rejected. Fix every problem below and call ${submission.tool} again with the complete corrected payload.\n${shown}${more}` }] };
        }
        accepted = value;
        log(`[${this.role}] ${submission.tool} accepted`);
        this.endRunSoon();
        return `Accepted. Your task is complete. Reply with one short line and stop. Do not read more files or call ${submission.tool} again.`;
      },
    };

    let prompt = message;
    for (let attempt = 0; attempt <= this.ctx.config.retries.validation; attempt++) {
      await this.send(prompt, { ...tools, [submission.tool]: tool });
      if (accepted !== undefined) return accepted;
      if (rejections >= limit) break;
      prompt = `You have not made an accepted ${submission.tool} call yet. Call ${submission.tool} now with the complete payload; earlier rejection messages list what to fix.`;
    }
    throw new HarnessError(`${this.role} did not produce an accepted ${submission.tool} submission in step '${step}'.`, 2);
  }

  // Agents sometimes keep exploring after their submission is accepted; nothing they do afterwards is used.
  private endRunSoon(): void {
    this.acceptedInRun = true;
    const run = this.currentRun;
    setTimeout(() => {
      if (run && run.status === "running" && run.supports("cancel")) {
        log(`[${this.role}] ending run ${run.id}: submission already accepted`);
        run.cancel().catch(() => undefined);
      }
    }, 20_000).unref();
  }

  // A run that streams nothing for `heartbeat.inactivity_minutes` is cancelled and the message re-sent,
  // so a stalled model request does not consume the whole run timeout.
  private async send(text: string, customTools: Record<string, SDKCustomTool>): Promise<void> {
    const { inactivity_minutes, restarts } = this.ctx.config.heartbeat;
    for (let attempt = 0; ; attempt++) {
      const message = attempt === 0 ? text
        : `Your previous attempt at this message stalled and was cancelled. Anything you did in it may be lost. Do the task below in full.\n\n${text}`;
      try {
        await this.sendOnce(message, customTools);
        return;
      } catch (e) {
        if (!(e instanceof StalledError)) throw e;
        if (this.acceptedInRun) return;
        if (attempt >= restarts)
          throw new HarnessError(`${this.role} run ${e.runId} sent nothing for ${inactivity_minutes} minutes, and ${restarts} restart(s) also stalled.`, 2);
        log(`[${this.role}] run ${e.runId} ${e.reason ? `failed (${e.reason})` : `sent nothing for ${inactivity_minutes} minutes`}; cancelled and re-sending (restart ${attempt + 1}/${restarts})`);
      }
    }
  }

  private async sendOnce(text: string, customTools: Record<string, SDKCustomTool>): Promise<RunResult> {
    // Time spent inside a harness tool (builds, test runs) is not inactivity. Both limits count only time the machine was awake.
    let awakeMs = 0;
    let lastActivity = 0;
    let toolsRunning = 0;
    const touch = () => { lastActivity = awakeMs; };
    // A run can end while a harness tool is mid-way (e.g. a sabotage patch applied); never check or re-send before it finishes.
    const inFlight = new Set<Promise<unknown>>();
    const settled = () => Promise.allSettled([...inFlight]);
    const tools = Object.fromEntries(Object.entries(customTools).map(([name, tool]) => [name, {
      ...tool,
      execute: async (...args: Parameters<SDKCustomTool["execute"]>) => {
        toolsRunning++;
        const call = Promise.resolve(tool.execute(...args));
        inFlight.add(call);
        try { return await call; } finally { inFlight.delete(call); toolsRunning--; touch(); }
      },
    }]));
    const run = await withStartupRetries(this.role, this.ctx.config.retries.startup, () =>
      this.agent.send(text, { local: { customTools: tools } }));
    this.currentRun = run;
    this.acceptedInRun = false;
    const started = Date.now();
    log(`[${this.role}] run ${run.id} started`);
    const streaming = this.pipe(run.stream(), touch).catch(() => undefined);
    const minutes = this.ctx.config.timeouts_minutes[this.role];
    const idleMs = this.ctx.config.heartbeat.inactivity_minutes * 60_000;
    let stopWatch: (() => void) | undefined;
    const watch = new Promise<never>((_, reject) => {
      stopWatch = everyAwakeTick((ms) => {
        awakeMs = ms;
        if (ms >= minutes * 60_000) reject(new HarnessError(`${this.role} run ${run.id} exceeded ${minutes} minutes.`, 2));
        else if (toolsRunning === 0 && ms - lastActivity > idleMs) reject(new StalledError(run.id));
      }, (slept) => log(`[${this.role}] machine was asleep for ${Math.round(slept / 60_000)} minute(s); not counted toward timeouts`));
    });
    let result: RunResult;
    try {
      result = await Promise.race([run.wait(), watch]);
    } catch (e) {
      if (run.supports("cancel")) await run.cancel().catch(() => undefined);
      await settled();
      // Failed runs still cost tokens; without a record a timed-out run disappears from the cost totals.
      const final = await Promise.race([run.wait().catch(() => undefined), sleep(10_000).then(() => undefined)]);
      this.ctx.onTurn({
        role: this.role, step: this.step, agent_id: this.agent.agentId, run_id: run.id,
        status: e instanceof StalledError ? "stalled" : /exceeded \d+ minutes/.test(String((e as Error)?.message)) ? "timeout" : "failed",
        duration_ms: Date.now() - started, usage: final?.usage, at: now(),
      });
      throw e;
    } finally {
      stopWatch?.();
    }
    await streaming;
    await settled();
    this.ctx.afterRun(this.role);
    this.ctx.onTurn({
      role: this.role, step: this.step, agent_id: this.agent.agentId, run_id: run.id, status: result.status,
      duration_ms: result.durationMs, usage: result.usage, at: now(),
    });
    log(`[${this.role}] run ${run.id} ${result.status}${result.durationMs ? ` in ${Math.round(result.durationMs / 1000)}s` : ""}`);
    if (result.status === "error" && !this.acceptedInRun) {
      const message = result.error?.message ?? "unknown error";
      if (/stall|connection|network|timed? ?out/i.test(message)) throw new StalledError(run.id, message);
      throw new HarnessError(`${this.role} run ${run.id} failed: ${message}`, 2);
    }
    if (result.status === "cancelled" && !this.acceptedInRun) throw new HarnessError(`${this.role} run ${run.id} was cancelled.`, 2);
    return result;
  }

  private async pipe(events: AsyncGenerator<SDKMessage, void>, onEvent: () => void): Promise<void> {
    for await (const event of events) {
      onEvent();
      fs.appendFileSync(this.ctx.eventLog, JSON.stringify({ at: now(), role: this.role, step: this.step, event }) + "\n");
      if (event.type === "tool_call" && event.status === "running") {
        const args = JSON.stringify(event.args ?? {});
        log(`[${this.role}]   ${event.name} ${args.length > 110 ? args.slice(0, 110) + "..." : args}`);
      } else if (this.ctx.verbose && event.type === "assistant") {
        for (const block of event.message.content) if (block.type === "text") process.stdout.write(block.text);
      }
    }
  }

  async dispose(): Promise<void> {
    await this.agent[Symbol.asyncDispose]().catch(() => undefined);
  }
}

class StalledError extends Error {
  readonly runId: string;
  readonly reason: string | undefined;
  constructor(runId: string, reason?: string) {
    super(`run ${runId} stalled`);
    this.runId = runId;
    this.reason = reason;
  }
}

async function withStartupRetries<T>(role: Role, attempts: number, start: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (e) {
      if (e instanceof CursorAgentError) {
        if (e.isRetryable && attempt < attempts) {
          log(`[${role}] startup failed (${e.message}); retrying`);
          await sleep(2 ** attempt * 1000);
          continue;
        }
        throw new HarnessError(`${role} agent could not start: ${e.message}`, 1);
      }
      throw e;
    }
  }
}
