/**
 * Automaton Tool System
 *
 * Adaptado de Conway-Research/automaton (MIT license). Define las
 * herramientas que el agente puede usar, con las mismas guardas de
 * auto-preservación del original. ctx.conway (sandbox remoto de
 * Conway) se reemplaza por ctx.runtime (ejecución en nuestro propio
 * servidor).
 */

import nodePath from "node:path";
import nodeOs from "node:os";
import { ulid } from "ulid";
import type {
  AutomatonTool,
  ToolContext,
  ToolCategory,
  InferenceToolDefinition,
  ToolCallResult,
  RiskLevel,
  PolicyRequest,
  InputSource,
  SpendTrackerInterface,
} from "../types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { sanitizeToolResult, sanitizeInput } from "./injection-defense.js";
import { createLogger } from "../observability/logger.js";
import { transferUsdc, getUsdcBalance, isValidBaseAddress } from "../identity/payments.js";
import { checkReplicationEligibility, validateGenesisParams } from "../replication/genesis.js";

const logger = createLogger("tools");

// ─── Path Confinement ─────────────────────────────────────────
// write_file está restringido al árbol de directorios del home del
// agente en el servidor (equivalente al SANDBOX_HOME del original).
// AGENT_HOME confina las escrituras del agente. Si no se define
// explícitamente, se usa el mismo HOME real del proceso (os.homedir()).
// index.ts ahora usa el shell nativo del sistema operativo para exec
// (PowerShell en Windows, bash en Linux/Mac), así exec y write_file/
// read_file operan sobre el mismo sistema de archivos — ya no hay
// discrepancia entre un exec en WSL/Linux y un os.homedir() de Windows.
function getAgentHome(): string {
  return process.env.AGENT_HOME || nodeOs.homedir();
}

/**
 * Validate that a file path resolves to within the allowed root directory.
 * Returns the resolved absolute path, or an error string if out of bounds.
 */
function confinePathToHome(filePath: string): string | { error: string } {
  const agentHome = getAgentHome();
  const expanded = filePath.startsWith("~")
    ? nodePath.join(agentHome, filePath.slice(1))
    : filePath;
  const resolved = nodePath.resolve(agentHome, expanded);
  if (resolved !== agentHome && !resolved.startsWith(agentHome + nodePath.sep)) {
    return {
      error: `Blocked: write_file path "${filePath}" resolves to "${resolved}" which is outside the allowed directory (${agentHome}). Writes are confined to the agent's home.`,
    };
  }
  return resolved;
}

// Tools whose results come from external sources and need sanitization
const EXTERNAL_SOURCE_TOOLS = new Set([
  "exec",
  "web_fetch",
]);

// ─── Self-Preservation Guard ───────────────────────────────────
// Defense-in-depth: policy engine (command.forbidden_patterns rule) is
// the primary guard. This inline check is a secondary safety net.

const FORBIDDEN_COMMAND_PATTERNS = [
  // Self-destruction
  /rm\s+(-rf?\s+)?.*\.automaton/,
  /rm\s+(-rf?\s+)?.*state\.db/,
  /rm\s+(-rf?\s+)?.*wallet\.json/,
  /rm\s+(-rf?\s+)?.*automaton\.json/,
  /rm\s+(-rf?\s+)?.*heartbeat\.yml/,
  /rm\s+(-rf?\s+)?.*SOUL\.md/,
  // Process killing
  /kill\s+.*automaton/,
  /pkill\s+.*automaton/,
  /systemctl\s+(stop|disable)\s+automaton/,
  // Killing node/node.exe by generic name: this runtime IS a node process,
  // a name-based kill can terminate itself along with whatever it meant
  // to stop. Target by specific PID instead.
  /Stop-Process\s+.*-Name\s+["']?node(\.exe)?["']?/i,
  /taskkill\s+.*\/im\s+["']?node(\.exe)?["']?/i,
  /\bpkill\s+(-[a-z]+\s+)*node\b/i,
  /\bkillall\s+(-[a-z]+\s+)*node(\.exe)?\b/i,
  // Database destruction
  /DROP\s+TABLE/i,
  /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children)/i,
  /TRUNCATE/i,
  // Safety infrastructure modification via shell
  /sed\s+.*injection-defense/,
  /sed\s+.*self-mod\/code/,
  /sed\s+.*audit-log/,
  />\s*.*injection-defense/,
  />\s*.*self-mod\/code/,
  />\s*.*audit-log/,
  // Credential harvesting
  /cat\s+.*\.ssh/,
  /cat\s+.*\.gnupg/,
  /cat\s+.*\.env/,
  /cat\s+.*wallet\.json/,
];

function isForbiddenCommand(command: string): string | null {
  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: Command matches self-harm pattern: ${pattern.source}`;
    }
  }
  return null;
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ─── Built-in Tools ────────────────────────────────────────────

export function createBuiltinTools(): AutomatonTool[] {
  return [
    // ── Ejecución local / archivos ──
    {
      name: "exec",
      description:
        "Execute a shell command on your server. Returns stdout, stderr, and exit code.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["command"],
      },
      execute: async (args, ctx) => {
        const command = args.command as string;
        const forbidden = isForbiddenCommand(command);
        if (forbidden) return forbidden;

        const result = await ctx.runtime.exec(
          command,
          (args.timeout as number) || 30000,
        );
        return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
      },
    },
    {
      name: "start_background_process",
      description:
        "Start a long-running process (e.g. a server) in the background and track it by PID. ALWAYS use this instead of exec+Start-Process/'&' for anything meant to keep running (servers, watchers) — it lets you cleanly stop the exact process later with stop_my_process, without ever touching processes you didn't start (including your own runtime). If a process is already registered for this label, it is stopped first, so re-running your server just replaces the old instance instead of piling up duplicates on new ports.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "A short name for this process, e.g. \"payment-api\". Reusing the same label for the same logical service replaces the previous instance.",
          },
          command: {
            type: "string",
            description: "Command to run, e.g. \"node server.js\"",
          },
        },
        required: ["label", "command"],
      },
      execute: async (args, ctx) => {
        const label = args.label as string;
        const command = args.command as string;
        const forbidden = isForbiddenCommand(command);
        if (forbidden) return forbidden;

        const registryRaw = ctx.db.getKV("background_processes") || "{}";
        let registry: Record<string, number>;
        try {
          registry = JSON.parse(registryRaw);
        } catch {
          registry = {};
        }

        // Si ya había un proceso con esta etiqueta, lo detenemos primero
        // — evita ir acumulando servidores duplicados en puertos nuevos.
        const previousPid = registry[label];
        if (previousPid) {
          const isWindows = process.platform === "win32";
          await ctx.runtime.exec(
            isWindows
              ? `Stop-Process -Id ${previousPid} -Force -ErrorAction SilentlyContinue`
              : `kill -9 ${previousPid} 2>/dev/null || true`,
            5000,
          );
        }

        const isWindows = process.platform === "win32";
        const [cmd, ...cmdArgs] = command.split(" ");
        const startCommand = isWindows
          ? `$p = Start-Process -FilePath "${cmd}" -ArgumentList "${cmdArgs.join(" ")}" -PassThru -WindowStyle Hidden; $p.Id`
          : `nohup ${command} > /dev/null 2>&1 & echo $!`;

        const result = await ctx.runtime.exec(startCommand, 10_000);
        const pid = parseInt(result.stdout.trim(), 10);
        if (!pid || isNaN(pid)) {
          return `Failed to start "${label}": ${result.stderr || result.stdout || "no PID returned"}`;
        }

        registry[label] = pid;
        ctx.db.setKV("background_processes", JSON.stringify(registry));

        return `Started "${label}" with PID ${pid}${previousPid ? ` (replaced previous instance, PID ${previousPid})` : ""}. Use stop_my_process("${label}") to stop it later.`;
      },
    },
    {
      name: "stop_my_process",
      description:
        "Stop a background process you started with start_background_process, by its label. Only affects processes YOU started and tracked this way — safe by design, since it never touches processes by generic name (which could include your own runtime).",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "The label used when starting the process with start_background_process",
          },
        },
        required: ["label"],
      },
      execute: async (args, ctx) => {
        const label = args.label as string;
        const registryRaw = ctx.db.getKV("background_processes") || "{}";
        let registry: Record<string, number>;
        try {
          registry = JSON.parse(registryRaw);
        } catch {
          registry = {};
        }

        const pid = registry[label];
        if (!pid) {
          return `No tracked process found for label "${label}". Use list_my_processes to see what's tracked.`;
        }

        const isWindows = process.platform === "win32";
        const result = await ctx.runtime.exec(
          isWindows
            ? `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`
            : `kill -9 ${pid} 2>/dev/null || true`,
          5000,
        );

        delete registry[label];
        ctx.db.setKV("background_processes", JSON.stringify(registry));

        return `Stopped "${label}" (PID ${pid}).`;
      },
    },
    {
      name: "list_my_processes",
      description: "List the background processes you've started and are currently tracking (label -> PID).",
      category: "vm",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const registryRaw = ctx.db.getKV("background_processes") || "{}";
        let registry: Record<string, number>;
        try {
          registry = JSON.parse(registryRaw);
        } catch {
          registry = {};
        }
        const entries = Object.entries(registry);
        if (entries.length === 0) return "No tracked background processes.";
        return entries.map(([label, pid]) => `${label}: PID ${pid}`).join("\n");
      },
    },
    {
      name: "write_file",
      description: "Write content to a file on your server.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        const confined = confinePathToHome(filePath);
        if (typeof confined === "object") return confined.error;
        const { isProtectedFile } = await import("../self-mod/code.js");
        if (isProtectedFile(confined)) {
          return "Blocked: Cannot overwrite protected file. This is a hard-coded safety invariant.";
        }
        await ctx.runtime.writeFile(confined, args.content as string);
        return `File written: ${confined}`;
      },
    },
    {
      name: "read_file",
      description: "Read content from a file on your server.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Block reads of sensitive files (wallet, env, config secrets)
        const basename = filePath.split("/").pop() || "";
        const sensitiveFiles = ["wallet.json", ".env", "automaton.json"];
        const sensitiveExtensions = [".key", ".pem"];
        if (
          sensitiveFiles.includes(basename) ||
          sensitiveExtensions.some((ext) => basename.endsWith(ext)) ||
          basename.startsWith("private-key")
        ) {
          return "Blocked: Cannot read sensitive file. This protects credentials and secrets.";
        }
        try {
          const confined = confinePathToHome(filePath);
          const resolvedPath = typeof confined === "string" ? confined : filePath;
          return await ctx.runtime.readFile(resolvedPath);
        } catch {
          const result = await ctx.runtime.exec(
            `cat ${escapeShellArg(filePath)}`,
            30_000,
          );
          if (result.exitCode !== 0) {
            return `ERROR: File not found or not readable: ${filePath}`;
          }
          return result.stdout;
        }
      },
    },
    {
      name: "edit_own_file",
      description:
        "Edit a file in your own codebase. Changes are audited, rate-limited, and safety-checked. Some files are protected.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit" },
          content: { type: "string", description: "New file content" },
          description: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["path", "content", "description"],
      },
      execute: async (args, ctx) => {
        const { editFile, validateModification } =
          await import("../self-mod/code.js");
        const filePath = args.path as string;
        const content = args.content as string;

        const validation = validateModification(
          ctx.db,
          filePath,
          content.length,
        );
        if (!validation.allowed) {
          return `BLOCKED: ${validation.reason}\nChecks: ${validation.checks.map((c) => `${c.name}: ${c.passed ? "PASS" : "FAIL"} (${c.detail})`).join(", ")}`;
        }

        const result = await editFile(
          ctx.runtime,
          ctx.db,
          filePath,
          content,
          args.description as string,
        );

        if (!result.success) {
          return result.error || "Unknown error during file edit";
        }

        const msg = `File edited: ${filePath} (audited + git-committed)`;
        return result.error ? `${msg}\nWarning: ${result.error}` : msg;
      },
    },
    {
      name: "revert_last_edit",
      description:
        "Revert the last self-modification. Uses git to undo the most recent code change and rebuild.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const repoRoot = process.cwd();

        const lastCommit = await ctx.runtime.exec(
          `cd '${repoRoot}' && git log -1 --oneline`,
          10_000,
        );

        const result = await ctx.runtime.exec(
          `cd '${repoRoot}' && git revert HEAD --no-edit`,
          30_000,
        );
        if (result.exitCode !== 0) {
          return `Revert failed: ${result.stderr}`;
        }

        const build = await ctx.runtime.exec(
          `cd '${repoRoot}' && npm run build`,
          60_000,
        );

        const { logModification } = await import("../self-mod/audit-log.js");
        logModification(ctx.db, "code_revert", `Reverted: ${lastCommit.stdout.trim()}`, {
          reversible: true,
        });

        return `Reverted: ${lastCommit.stdout.trim()}. ${build.exitCode === 0 ? "Rebuild succeeded." : "Rebuild failed: " + build.stderr}`;
      },
    },
    {
      name: "reset_to_upstream",
      description:
        "Reset your codebase to your own upstream release (your git remote). Use when self-modifications have broken things beyond repair.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const repoRoot = process.cwd();

        const fetch = await ctx.runtime.exec(
          `cd '${repoRoot}' && git fetch origin main`,
          30_000,
        );
        if (fetch.exitCode !== 0) {
          return `Failed to fetch upstream: ${fetch.stderr}`;
        }

        const localCommits = await ctx.runtime.exec(
          `cd '${repoRoot}' && git log origin/main..HEAD --oneline`,
          10_000,
        );

        const reset = await ctx.runtime.exec(
          `cd '${repoRoot}' && git reset --hard origin/main`,
          30_000,
        );
        if (reset.exitCode !== 0) {
          return `Reset failed: ${reset.stderr}`;
        }

        const build = await ctx.runtime.exec(
          `cd '${repoRoot}' && npm install && npm run build`,
          120_000,
        );

        const { logModification } = await import("../self-mod/audit-log.js");
        logModification(ctx.db, "upstream_reset", "Reset to upstream origin/main", {
          diff: localCommits.stdout.trim() || "(no local commits)",
          reversible: false,
        });

        const discarded = localCommits.stdout.trim();
        return `Reset to upstream. ${discarded ? "Discarded local commits:\n" + discarded : "No local commits lost."} ${build.exitCode === 0 ? "Rebuild succeeded." : "Rebuild failed: " + build.stderr}`;
      },
    },
    {
      name: "install_npm_package",
      description: "Install an npm package in your environment.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Package name (e.g., axios)",
          },
        },
        required: ["package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        if (!/^[@a-zA-Z0-9._\/-]+$/.test(pkg)) {
          return `Blocked: invalid package name "${pkg}"`;
        }
        const result = await ctx.runtime.exec(`npm install -g ${pkg}`, 60000);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "tool_install",
          description: `Installed npm package: ${pkg}`,
          reversible: true,
        });

        return result.exitCode === 0
          ? `Installed: ${pkg}`
          : `Failed to install ${pkg}: ${result.stderr}`;
      },
    },
    {
      name: "review_upstream_changes",
      description:
        "ALWAYS call this before pull_upstream. Shows every upstream commit with its full diff. Read each one carefully — decide per-commit whether to accept or skip. Use pull_upstream with a specific commit hash to cherry-pick only what you want.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _ctx) => {
        const { getUpstreamDiffs, checkUpstream } =
          await import("../self-mod/upstream.js");
        const status = checkUpstream();
        if (status.behind === 0) return "Already up to date with origin/main.";

        const diffs = getUpstreamDiffs();
        if (diffs.length === 0) return "No upstream diffs found.";

        const output = diffs
          .map(
            (d, i) =>
              `--- COMMIT ${i + 1}/${diffs.length} ---\nHash: ${d.hash}\nAuthor: ${d.author}\nMessage: ${d.message}\n\n${d.diff.slice(0, 4000)}${d.diff.length > 4000 ? "\n... (diff truncated)" : ""}\n--- END COMMIT ${i + 1} ---`,
          )
          .join("\n\n");

        return `${diffs.length} upstream commit(s) to review. Read each diff, then cherry-pick individually with pull_upstream(commit=<hash>).\n\n${output}`;
      },
    },
    {
      name: "pull_upstream",
      description:
        "Apply upstream changes and rebuild. You MUST call review_upstream_changes first. Prefer cherry-picking individual commits by hash over pulling everything — only pull all if you've reviewed every commit and want them all.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          commit: {
            type: "string",
            description:
              "Commit hash to cherry-pick (preferred). Omit ONLY if you reviewed all commits and want every one.",
          },
        },
      },
      execute: async (args, ctx) => {
        const commit = args.commit as string | undefined;

        const run = async (cmd: string) => {
          const result = await ctx.runtime.exec(cmd, 120_000);
          if (result.exitCode !== 0) {
            throw new Error(
              result.stderr ||
                `Command failed with exit code ${result.exitCode}`,
            );
          }
          return result.stdout.trim();
        };

        let appliedSummary: string;
        try {
          if (commit) {
            await run(`git cherry-pick ${commit}`);
            appliedSummary = `Cherry-picked ${commit}`;
          } else {
            await run("git pull origin main --ff-only");
            appliedSummary = "Pulled all of origin/main (fast-forward)";
          }
        } catch (err: any) {
          return `Git operation failed: ${err.message}. You may need to resolve conflicts manually.`;
        }

        try {
          await run("npm install --ignore-scripts && npm run build");
        } catch (err: any) {
          return `${appliedSummary} — but rebuild failed: ${err.message}. The code is applied but not compiled.`;
        }

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "upstream_pull",
          description: appliedSummary,
          reversible: true,
        });

        return `${appliedSummary}. Rebuild succeeded.`;
      },
    },

    // ── Git ──
    {
      name: "git_status",
      description: "Show git status for a repository.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { gitStatus } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const status = await gitStatus(ctx.runtime, repoPath);
        return `Branch: ${status.branch}\nStaged: ${status.staged.length}\nModified: ${status.modified.length}\nUntracked: ${status.untracked.length}\nClean: ${status.clean}`;
      },
    },
    {
      name: "git_diff",
      description: "Show git diff for a repository.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          staged: { type: "boolean", description: "Show staged changes only" },
        },
      },
      execute: async (args, ctx) => {
        const { gitDiff } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitDiff(
          ctx.runtime,
          repoPath,
          (args.staged as boolean) || false,
        );
      },
    },
    {
      name: "git_commit",
      description: "Create a git commit.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          message: { type: "string", description: "Commit message" },
          add_all: {
            type: "boolean",
            description: "Stage all changes first (default: true)",
          },
        },
        required: ["message"],
      },
      execute: async (args, ctx) => {
        const { gitCommit } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitCommit(
          ctx.runtime,
          repoPath,
          args.message as string,
          args.add_all !== false,
        );
      },
    },
    {
      name: "git_log",
      description: "View git commit history.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          limit: {
            type: "number",
            description: "Number of commits (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { gitLog } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const entries = await gitLog(
          ctx.runtime,
          repoPath,
          (args.limit as number) || 10,
        );
        if (entries.length === 0) return "No commits yet.";
        return entries
          .map((e) => `${e.hash.slice(0, 7)} ${e.date} ${e.message}`)
          .join("\n");
      },
    },
    {
      name: "git_push",
      description: "Push to a git remote.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          remote: {
            type: "string",
            description: "Remote name (default: origin)",
          },
          branch: { type: "string", description: "Branch name (optional)" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const { gitPush } = await import("../git/tools.js");
        return await gitPush(
          ctx.runtime,
          args.path as string,
          (args.remote as string) || "origin",
          args.branch as string | undefined,
        );
      },
    },
    {
      name: "git_branch",
      description: "Manage git branches (list, create, checkout, delete).",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          action: {
            type: "string",
            description: "list, create, checkout, or delete",
          },
          branch_name: {
            type: "string",
            description: "Branch name (for create/checkout/delete)",
          },
        },
        required: ["path", "action"],
      },
      execute: async (args, ctx) => {
        const { gitBranch } = await import("../git/tools.js");
        return await gitBranch(
          ctx.runtime,
          args.path as string,
          args.action as any,
          args.branch_name as string | undefined,
        );
      },
    },
    {
      name: "git_clone",
      description: "Clone a git repository.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Repository URL" },
          path: { type: "string", description: "Target directory" },
          depth: {
            type: "number",
            description: "Shallow clone depth (optional)",
          },
        },
        required: ["url", "path"],
      },
      execute: async (args, ctx) => {
        const { gitClone } = await import("../git/tools.js");
        return await gitClone(
          ctx.runtime,
          args.url as string,
          args.path as string,
          args.depth as number | undefined,
        );
      },
    },
    {
      name: "send_payment",
      description:
        "Send a USDC payment on Base to another address. Payments within your auto-approved limit execute immediately; anything above it is queued for the operator's approval and does NOT execute until approved.",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          to_address: { type: "string", description: "Recipient address (0x...)" },
          amount_usd: { type: "number", description: "Amount in US dollars, e.g. 0.50" },
          reason: { type: "string", description: "What this payment is for" },
        },
        required: ["to_address", "amount_usd", "reason"],
      },
      execute: async (args, ctx) => {
        const toAddress = args.to_address as string;
        const amountUsd = args.amount_usd as number;
        const reason = args.reason as string;

        if (!isValidBaseAddress(toAddress)) {
          return `Blocked: "${toAddress}" is not a valid address.`;
        }
        if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
          return `Blocked: amount_usd must be a positive number, got ${amountUsd}.`;
        }

        const amountCents = Math.round(amountUsd * 100);
        const policy = ctx.config.treasuryPolicy;
        if (!policy) {
          return "Blocked: no treasury policy configured. Cannot verify spending limits.";
        }

        // 1. Verificar límites hourly/daily agregados
        const limitCheck = ctx.spendTracker.checkLimit(amountCents, "transfer", policy);
        if (!limitCheck.allowed) {
          return `Blocked: ${limitCheck.reason}`;
        }

        // 2. Por encima del límite autoaprobado -> cola de aprobación, NO ejecuta
        if (amountCents > policy.requireConfirmationAboveCents) {
          const { insertPendingApproval } = await import("../state/database.js");
          const approvalId = ulid();
          insertPendingApproval(ctx.db.raw, {
            id: approvalId,
            kind: "spend",
            amountCents,
            recipient: toAddress,
            reason,
            metadata: JSON.stringify({}),
            status: "pending",
            createdAt: new Date().toISOString(),
            resolvedAt: null,
            resolvedBy: null,
          });
          return `PENDING APPROVAL: $${amountUsd.toFixed(2)} to ${toAddress} exceeds your auto-approved limit ($${(policy.requireConfirmationAboveCents / 100).toFixed(2)}). Request ${approvalId} queued — it will NOT execute until the operator approves it.`;
        }

        // 3. Dentro del límite autoaprobado -> verificar saldo y ejecutar de verdad
        const balance = await getUsdcBalance(ctx.identity.account.address);
        if (balance < amountUsd) {
          return `Blocked: insufficient USDC balance ($${balance.toFixed(2)} available, $${amountUsd.toFixed(2)} requested).`;
        }

        try {
          const { txHash } = await transferUsdc(
            ctx.identity.account,
            toAddress,
            amountUsd,
          );

          ctx.spendTracker.recordSpend({
            toolName: "send_payment",
            amountCents,
            recipient: toAddress,
            category: "transfer",
          });

          ctx.db.insertTransaction({
            id: ulid(),
            type: "transfer_out",
            amountCents,
            balanceAfterCents: Math.round((balance - amountUsd) * 100),
            description: `${reason} (tx: ${txHash})`,
            timestamp: new Date().toISOString(),
          });

          return `Payment sent: $${amountUsd.toFixed(2)} USDC to ${toAddress}. Tx: ${txHash}`;
        } catch (err: any) {
          return `Payment failed: ${err.message}`;
        }
      },
    },
    {
      name: "propose_replication",
      description:
        "Propose creating a child agent. Only works if your balance has reached the configured multiple (default 2x) of your initial investment. This does NOT create the child — it queues a proposal that the operator must explicitly approve first.",
      category: "replication",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name for the child agent (alphanumeric + dash, max 64 chars)",
          },
          specialization: {
            type: "string",
            description: "What the child should specialize in",
          },
          message: { type: "string", description: "Message/context for the child" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        try {
          validateGenesisParams({
            name: args.name as string,
            specialization: args.specialization as string | undefined,
          });
        } catch (err: any) {
          return `Blocked: ${err.message}`;
        }

        const eligibility = await checkReplicationEligibility(ctx.identity, ctx.db);
        if (!eligibility.eligible) {
          return `Not eligible to replicate yet. Current balance: $${eligibility.currentBalanceUsd.toFixed(2)}, required: $${eligibility.requiredBalanceUsd.toFixed(2)} (${eligibility.multiple}x of your initial $${eligibility.initialInvestmentUsd.toFixed(2)} investment).`;
        }

        const { insertPendingApproval } = await import("../state/database.js");
        const approvalId = ulid();
        insertPendingApproval(ctx.db.raw, {
          id: approvalId,
          kind: "replication",
          amountCents: null,
          recipient: null,
          reason: args.message as string || `Propose child "${args.name}"`,
          metadata: JSON.stringify({
            name: args.name,
            specialization: args.specialization,
            message: args.message,
            currentBalanceUsd: eligibility.currentBalanceUsd,
            initialInvestmentUsd: eligibility.initialInvestmentUsd,
          }),
          status: "pending",
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          resolvedBy: null,
        });

        return `PENDING APPROVAL: Replication proposal ${approvalId} queued (balance $${eligibility.currentBalanceUsd.toFixed(2)} reached ${eligibility.multiple}x of $${eligibility.initialInvestmentUsd.toFixed(2)}). This will NOT create a child until the operator approves it.`;
      },
    },
    {
      name: "list_children",
      description: "List all child agents and their status.",
      category: "replication",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const children = ctx.db.getChildren();
        if (children.length === 0) return "No children yet.";
        return children
          .map(
            (c) =>
              `${c.name} [${c.status}] funded:$${(c.fundedAmountCents / 100).toFixed(2)} last_check:${c.lastChecked || "never"}`,
          )
          .join("\n");
      },
    },
    {
      name: "remember_fact",
      description:
        "Store a semantic memory (fact). Provide a category, key, and value. Facts are upserted on category+key.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Fact category: self, environment, financial, agent, domain, procedural_ref, creator",
          },
          key: {
            type: "string",
            description: "Fact key (unique within category)",
          },
          value: { type: "string", description: "Fact value" },
          confidence: {
            type: "number",
            description: "Confidence 0.0-1.0 (default: 1.0)",
          },
          source: {
            type: "string",
            description: "Source of the fact (default: agent)",
          },
        },
        required: ["category", "key", "value"],
      },
      execute: async (args, ctx) => {
        const { rememberFact } = await import("../memory/tools.js");
        return rememberFact(ctx.db.raw, {
          category: args.category as string,
          key: args.key as string,
          value: args.value as string,
          confidence: args.confidence as number | undefined,
          source: args.source as string | undefined,
        });
      },
    },
    {
      name: "recall_facts",
      description:
        "Search semantic memory by category and/or query string. Returns matching facts.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Filter by category: self, environment, financial, agent, domain, procedural_ref, creator",
          },
          query: {
            type: "string",
            description: "Search query to match against fact keys and values",
          },
        },
      },
      execute: async (args, ctx) => {
        const { recallFacts } = await import("../memory/tools.js");
        return recallFacts(ctx.db.raw, {
          category: args.category as string | undefined,
          query: args.query as string | undefined,
        });
      },
    },
    {
      name: "set_goal",
      description:
        "Create a working memory goal. Goals persist in working memory and guide your behavior.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Goal description" },
          priority: {
            type: "number",
            description: "Priority 0.0-1.0 (default: 0.8)",
          },
        },
        required: ["content"],
      },
      execute: async (args, ctx) => {
        const { setGoal } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return setGoal(ctx.db.raw, {
          sessionId,
          content: args.content as string,
          priority: args.priority as number | undefined,
        });
      },
    },
    {
      name: "complete_goal",
      description:
        "Mark a goal as completed and archive it to episodic memory. Use review_memory to find goal IDs.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID to complete" },
          outcome: {
            type: "string",
            description: "Outcome description (optional)",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { completeGoal } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return completeGoal(ctx.db.raw, {
          goalId: args.goal_id as string,
          sessionId,
          outcome: args.outcome as string | undefined,
        });
      },
    },
    {
      name: "save_procedure",
      description:
        "Store a learned procedure with ordered steps. Procedures help you remember how to do things.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique procedure name" },
          description: {
            type: "string",
            description: "What this procedure does",
          },
          steps: {
            type: "string",
            description:
              'JSON array of steps: [{"order":1,"description":"...","tool":"...","argsTemplate":null,"expectedOutcome":null,"onFailure":null}]',
          },
        },
        required: ["name", "description", "steps"],
      },
      execute: async (args, ctx) => {
        const { saveProcedure } = await import("../memory/tools.js");
        return saveProcedure(ctx.db.raw, {
          name: args.name as string,
          description: args.description as string,
          steps: args.steps as string,
        });
      },
    },
    {
      name: "recall_procedure",
      description: "Retrieve a stored procedure by exact name or search query.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact procedure name" },
          query: {
            type: "string",
            description: "Search query to find matching procedures",
          },
        },
      },
      execute: async (args, ctx) => {
        const { recallProcedure } = await import("../memory/tools.js");
        return recallProcedure(ctx.db.raw, {
          name: args.name as string | undefined,
          query: args.query as string | undefined,
        });
      },
    },
    {
      name: "note_about_agent",
      description:
        "Record a relationship note about another agent or entity. Tracks trust score and interaction history.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          entity_address: {
            type: "string",
            description: "Entity wallet address (0x...)",
          },
          entity_name: {
            type: "string",
            description: "Human-readable name (optional)",
          },
          relationship_type: {
            type: "string",
            description:
              "Type of relationship: peer, service, creator, child, unknown",
          },
          notes: { type: "string", description: "Notes about this entity" },
          trust_score: {
            type: "number",
            description: "Trust score 0.0-1.0 (default: 0.5)",
          },
        },
        required: ["entity_address", "relationship_type"],
      },
      execute: async (args, ctx) => {
        const { noteAboutAgent } = await import("../memory/tools.js");
        return noteAboutAgent(ctx.db.raw, {
          entityAddress: args.entity_address as string,
          entityName: args.entity_name as string | undefined,
          relationshipType: args.relationship_type as string,
          notes: args.notes as string | undefined,
          trustScore: args.trust_score as number | undefined,
        });
      },
    },
    {
      name: "review_memory",
      description:
        "Review your current working memory (goals, tasks, observations) and recent episodic history.",
      category: "memory",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { reviewMemory } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return reviewMemory(ctx.db.raw, { sessionId });
      },
    },
    {
      name: "forget",
      description:
        "Remove a memory entry by ID and type. Cannot remove creator-protected semantic entries.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory entry ID" },
          memory_type: {
            type: "string",
            description:
              "Memory type: working, episodic, semantic, procedural, relationship",
          },
        },
        required: ["id", "memory_type"],
      },
      execute: async (args, ctx) => {
        const { forget } = await import("../memory/tools.js");
        return forget(ctx.db.raw, {
          id: args.id as string,
          memoryType: args.memory_type as string,
        });
      },
    },
  ];
}

// ─── Instalación de herramientas dinámicas / conversión / ejecución ──

export function loadInstalledTools(db: {
  getInstalledTools: () => {
    id: string;
    name: string;
    type: string;
    config?: Record<string, unknown>;
    installedAt: string;
    enabled: boolean;
  }[];
}): AutomatonTool[] {
  try {
    const installed = db.getInstalledTools();
    return installed.map((tool) => ({
      name: tool.name,
      description: `Installed tool: ${tool.name}`,
      category: "vm" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: (tool.config?.parameters as Record<string, unknown>) || {
        type: "object",
        properties: {},
      },
      execute: createInstalledToolExecutor(tool),
    }));
  } catch (error) {
    logger.error(
      "Failed to load installed tools",
      error instanceof Error ? error : undefined,
    );
    return [];
  }
}

function createInstalledToolExecutor(tool: {
  name: string;
  type: string;
  config?: Record<string, unknown>;
}): AutomatonTool["execute"] {
  return async (args, ctx) => {
    if (tool.type === "mcp") {
      return `MCP tool ${tool.name} invoked with args: ${JSON.stringify(args)}`;
    }
    const command = tool.config?.command as string | undefined;
    if (command) {
      const result = await ctx.runtime.exec(
        `${command} ${escapeShellArg(JSON.stringify(args))}`,
        30000,
      );
      return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    }
    return `Installed tool ${tool.name} has no executable command configured.`;
  };
}

/** Convierte AutomatonTool[] al formato que espera la API de inferencia. */
export function toolsToInferenceFormat(
  tools: AutomatonTool[],
): InferenceToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Ejecuta una tool call y devuelve el resultado. Evalúa contra el motor
 * de políticas si se provee. El registro de gasto real ocurre dentro de
 * cada herramienta financiera (send_payment) — aquí no se duplica.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  tools: AutomatonTool[],
  context: ToolContext,
  policyEngine?: PolicyEngine,
  turnContext?: {
    inputSource: InputSource | undefined;
    turnToolCallCount: number;
    sessionSpend: SpendTrackerInterface;
  },
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === toolName);
  const startTime = Date.now();

  if (!tool) {
    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result: "",
      durationMs: 0,
      error: `Unknown tool: ${toolName}`,
    };
  }

  if (policyEngine && turnContext) {
    const request: PolicyRequest = {
      tool,
      args,
      context,
      turnContext,
    };
    const decision = policyEngine.evaluate(request);
    policyEngine.logDecision(decision);

    if (decision.action !== "allow") {
      return {
        id: ulid(),
        name: toolName,
        arguments: args,
        result: "",
        durationMs: Date.now() - startTime,
        error: `Policy denied: ${decision.reasonCode} — ${decision.humanMessage}`,
      };
    }
  }

  try {
    let result = await tool.execute(args, context);

    if (EXTERNAL_SOURCE_TOOLS.has(toolName)) {
      result = sanitizeToolResult(result);
    }

    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result: "",
      durationMs: Date.now() - startTime,
      error: err.message || String(err),
    };
  }
}
