import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PullRequestContext = {
  repo: string;
  pr: Record<string, unknown>;
  linkedIssue: Record<string, unknown> | null;
  promptContext: string;
};

export class GitHubFlowService {
  private readonly ghCommand: string;
  private readonly maxDiffChars: number;

  constructor(options: { ghCommand?: string; maxDiffChars?: number } = {}) {
    this.ghCommand = options.ghCommand ?? "gh";
    this.maxDiffChars = options.maxDiffChars ?? 30_000;
  }

  async loadPullRequestContext(options: {
    repo: string;
    prNumber: number;
  }): Promise<PullRequestContext> {
    const pr = await this.readJson([
      "pr",
      "view",
      String(options.prNumber),
      "-R",
      options.repo,
      "--json",
      "number,title,body,author,url,additions,deletions,changedFiles,files,baseRefName,headRefName",
    ]);

    const linkedIssueNumber = findLinkedIssueNumber(typeof pr.body === "string" ? pr.body : "");
    const linkedIssue = linkedIssueNumber
      ? await this.readJson([
          "issue",
          "view",
          String(linkedIssueNumber),
          "-R",
          options.repo,
          "--json",
          "number,title,body,url",
        ])
      : null;

    const diff = await this.readText(["pr", "diff", String(options.prNumber), "-R", options.repo]);
    const truncatedDiff =
      diff.length > this.maxDiffChars
        ? `${diff.slice(0, this.maxDiffChars)}\n\n[diff truncated at ${this.maxDiffChars} characters]`
        : diff;

    return {
      repo: options.repo,
      pr,
      linkedIssue,
      promptContext: formatPromptContext({
        repo: options.repo,
        pr,
        linkedIssue,
        diff: truncatedDiff,
      }),
    };
  }

  private async readJson(args: string[]): Promise<Record<string, unknown>> {
    const stdout = await this.readText(args);
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  private async readText(args: string[]): Promise<string> {
    const result = await execFileAsync(this.ghCommand, args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  }
}

function findLinkedIssueNumber(body: string): number | null {
  const match = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function formatPromptContext(options: {
  repo: string;
  pr: Record<string, unknown>;
  linkedIssue: Record<string, unknown> | null;
  diff: string;
}): string {
  const files = Array.isArray(options.pr.files)
    ? options.pr.files
        .map((file) => {
          if (!file || typeof file !== "object") {
            return null;
          }
          const record = file as Record<string, unknown>;
          return `- ${asString(record.path, "unknown")} (+${asNumber(record.additions, 0)} / -${asNumber(record.deletions, 0)})`;
        })
        .filter((line): line is string => Boolean(line))
        .join("\n")
    : "";

  const issueSection = options.linkedIssue
    ? `Linked issue #${asNumber(options.linkedIssue.number, 0)}: ${asString(options.linkedIssue.title)}\n${asString(options.linkedIssue.body)}`
    : "No linked issue was found in the PR body.";

  return [
    `Repository: ${options.repo}`,
    `PR #${asNumber(options.pr.number, 0)}: ${asString(options.pr.title)}`,
    `URL: ${asString(options.pr.url)}`,
    `Author: ${asAuthorLogin(options.pr.author)}`,
    `Base: ${asString(options.pr.baseRefName)}`,
    `Head: ${asString(options.pr.headRefName)}`,
    `Changed files: ${asNumber(options.pr.changedFiles, 0)}`,
    `Additions: ${asNumber(options.pr.additions, 0)}`,
    `Deletions: ${asNumber(options.pr.deletions, 0)}`,
    "",
    "PR body:",
    asString(options.pr.body, "(empty)"),
    "",
    "Changed files:",
    files || "(none)",
    "",
    "Underlying issue:",
    issueSection,
    "",
    "Diff:",
    options.diff || "(empty diff)",
  ].join("\n");
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asAuthorLogin(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "unknown";
  }

  return asString((value as { login?: unknown }).login, "unknown");
}
