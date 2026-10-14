export interface PullRequest {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

/** Everything the harness needs from a git host. Add GitLab or Azure DevOps by implementing this. */
export interface Host {
  readonly name: string;
  /** "owner/repo" for a remote URL on this host, or undefined if the URL belongs elsewhere. */
  repoFromUrl(url: string): string | undefined;
  defaultBranch(repo: string): string;
  push(cwd: string, remote: string, branch: string): void;
  /** Returns the pull request URL. */
  createPullRequest(cwd: string, pr: PullRequest): string;
  /** Head branch names of the repo's open pull requests into `base`. */
  openPullRequestHeads(repo: string, base: string): string[];
}
