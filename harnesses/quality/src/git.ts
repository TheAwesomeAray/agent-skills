import fs from "node:fs";
import { exec, HarnessError } from "./util.ts";

export const git = (cwd: string, ...args: string[]): string => exec("git", args, { cwd }).stdout.trim();
export const gitTry = (cwd: string, ...args: string[]): string | undefined => {
  const r = exec("git", args, { cwd, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
};

export function repoRoot(dir: string): string {
  const root = gitTry(dir, "rev-parse", "--show-toplevel");
  if (!root) throw new HarnessError(`${dir} is not inside a git repository.`);
  return root;
}

/** The remote's default branch from refs/remotes/<remote>/HEAD, if git knows it. */
export function remoteHead(root: string, remote: string): string | undefined {
  const ref = gitTry(root, "symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`);
  return ref?.replace(`refs/remotes/${remote}/`, "");
}

/** True when a push URL cannot be pushed to (e.g. set to DISABLED). */
export function isDisabledPushUrl(url: string): boolean {
  return !/^(https?|ssh|git|file):\/\//.test(url) && !/^[\w.-]+@[\w.-]+:/.test(url) && !fs.existsSync(url);
}

export function addWorktree(root: string, dir: string, commit: string, branch?: string): void {
  if (branch) git(root, "worktree", "add", "-b", branch, dir, commit);
  else git(root, "worktree", "add", "--detach", dir, commit);
}

export function removeWorktree(root: string, dir: string): void {
  if (fs.existsSync(dir)) gitTry(root, "worktree", "remove", "--force", dir);
  gitTry(root, "worktree", "prune");
}

export function isClean(dir: string): { clean: boolean; changes: string } {
  const changes = git(dir, "status", "--porcelain");
  return { clean: changes.length === 0, changes };
}
