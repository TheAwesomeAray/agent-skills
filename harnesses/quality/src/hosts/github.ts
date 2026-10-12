import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { exec } from "../util.ts";
import type { Host, PullRequest } from "./host.ts";

export const github: Host = {
  name: "github",

  repoFromUrl(url) {
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : undefined;
  },

  defaultBranch(repo) {
    return exec("gh", ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]).stdout.trim();
  },

  push(cwd, remote, branch) {
    exec("git", ["push", "--set-upstream", remote, branch], { cwd });
  },

  // --repo and --base are always explicit: for a fork, gh would otherwise target the upstream repo.
  createPullRequest(cwd, pr: PullRequest) {
    const bodyFile = path.join(os.tmpdir(), `quality-pr-${process.pid}.md`);
    fs.writeFileSync(bodyFile, pr.body);
    try {
      return exec("gh", ["pr", "create", "--repo", pr.repo, "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body-file", bodyFile], { cwd })
        .stdout.trim().split(/\r?\n/).pop()!;
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
  },
};
