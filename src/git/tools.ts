/**
 * Git Tools
 *
 * Built-in git operations for the automaton.
 * Used for both state versioning and code development.
 */

import type { LocalRuntime, GitStatus, GitLogEntry } from "../types.js";
import nodePath from "node:path";
import nodeOs from "node:os";

function resolveGitPath(p: string): string {
  if (p.startsWith("~")) {
    return nodePath.join(nodeOs.homedir(), p.slice(1));
  }
  return nodePath.resolve(p);
}

function escapeShellArg(arg: string): string {
  if (process.platform === "win32") {
    return `'${arg.replace(/'/g, "''")}'`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Get git status for a repository.
 */
export async function gitStatus(
  runtime: LocalRuntime,
  repoPath: string,
): Promise<GitStatus> {
  const resolved = resolveGitPath(repoPath);
  const result = await runtime.exec(
    `git -C ${escapeShellArg(resolved)} status --porcelain -b`,
    10000,
  );

  const lines = result.stdout.split("\n").filter(Boolean);
  let branch = "unknown";
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0].trim();
      continue;
    }

    const statusCode = line.slice(0, 2);
    const file = line.slice(3).trim();

    if (statusCode[0] !== " " && statusCode[0] !== "?") {
      staged.push(file);
    }
    if (statusCode[1] === "M" || statusCode[1] === "D") {
      modified.push(file);
    }
    if (statusCode === "??") {
      untracked.push(file);
    }
  }

  return {
    branch,
    staged,
    modified,
    untracked,
    clean:
      staged.length === 0 && modified.length === 0 && untracked.length === 0,
  };
}

/**
 * Get git diff output.
 */
export async function gitDiff(
  runtime: LocalRuntime,
  repoPath: string,
  staged: boolean = false,
): Promise<string> {
  const resolved = resolveGitPath(repoPath);
  const flag = staged ? "--cached" : "";
  const result = await runtime.exec(
    `git -C ${escapeShellArg(resolved)} diff ${flag}`.trim(),
    10000,
  );
  return result.stdout || "(no changes)";
}

/**
 * Create a git commit.
 */
export async function gitCommit(
  runtime: LocalRuntime,
  repoPath: string,
  message: string,
  addAll: boolean = true,
): Promise<string> {
  const resolved = resolveGitPath(repoPath);
  if (addAll) {
    await runtime.exec(`git -C ${escapeShellArg(resolved)} add -A`, 10000);
  }

  const result = await runtime.exec(
    `git -C ${escapeShellArg(resolved)} commit -m ${escapeShellArg(message)} --allow-empty`,
    10000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git commit failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

/**
 * Get git log.
 */
export async function gitLog(
  runtime: LocalRuntime,
  repoPath: string,
  limit: number = 10,
): Promise<GitLogEntry[]> {
  const resolved = resolveGitPath(repoPath);
  const safeLimit = Math.max(1, Math.floor(Number(limit))) || 10;
  const result = await runtime.exec(
    `git -C ${escapeShellArg(resolved)} log --format="%H|%s|%an|%ai" -n ${safeLimit}`,
    10000,
  );

  if (!result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, message, author, date] = line.split("|");
      return { hash, message, author, date };
    });
}

/**
 * Push to remote.
 */
export async function gitPush(
  runtime: LocalRuntime,
  repoPath: string,
  remote: string = "origin",
  branch?: string,
): Promise<string> {
  const resolved = resolveGitPath(repoPath);
  const branchArg = branch ? ` ${escapeShellArg(branch)}` : "";
  const result = await runtime.exec(
    `git -C ${escapeShellArg(resolved)} push ${escapeShellArg(remote)}${branchArg}`,
    30000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git push failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout || "Push successful";
}

/**
 * Manage branches.
 */
export async function gitBranch(
  runtime: LocalRuntime,
  repoPath: string,
  action: "list" | "create" | "checkout" | "delete",
  branchName?: string,
): Promise<string> {
  const resolved = resolveGitPath(repoPath);
  let cmd: string;

  switch (action) {
    case "list":
      cmd = `git -C ${escapeShellArg(resolved)} branch -a`;
      break;
    case "create":
      if (!branchName) throw new Error("Branch name required");
      cmd = `git -C ${escapeShellArg(resolved)} checkout -b ${escapeShellArg(branchName)}`;
      break;
    case "checkout":
      if (!branchName) throw new Error("Branch name required");
      cmd = `git -C ${escapeShellArg(resolved)} checkout ${escapeShellArg(branchName)}`;
      break;
    case "delete":
      if (!branchName) throw new Error("Branch name required");
      cmd = `git -C ${escapeShellArg(resolved)} branch -d ${escapeShellArg(branchName)}`;
      break;
    default:
      throw new Error(`Unknown branch action: ${action}`);
  }

  const result = await runtime.exec(cmd, 10000);
  return result.stdout || result.stderr || "Done";
}

/**
 * Clone a repository.
 */
export async function gitClone(
  runtime: LocalRuntime,
  url: string,
  targetPath: string,
  depth?: number,
): Promise<string> {
  const resolvedTarget = resolveGitPath(targetPath);
  const depthArg = depth
    ? ` --depth ${Math.max(1, Math.floor(Number(depth)))}`
    : "";
  const result = await runtime.exec(
    `git clone${depthArg} ${escapeShellArg(url)} ${escapeShellArg(resolvedTarget)}`,
    120000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git clone failed: ${result.stderr || result.stdout}`);
  }

  return `Cloned ${url} to ${resolvedTarget}`;
}

/**
 * Initialize a git repository.
 */
export async function gitInit(
  runtime: LocalRuntime,
  repoPath: string,
): Promise<string> {
  const resolved = resolveGitPath(repoPath);
  const result = await runtime.exec(
    `git -C ${escapeShellArg(resolved)} init`,
    10000,
  );
  return result.stdout || "Git initialized";
}
