#!/usr/bin/env node
/**
 * Automaton Runtime — Entry Point
 *
 * Reescrito a partir de Conway-Research/automaton (MIT license). Sin
 * SIWE/provisioning contra Conway, sin bootstrap topup, sin cliente
 * social. Usa la wallet propia cifrada, inferencia directa con
 * Anthropic, y ejecución local en este mismo servidor.
 */

import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import { loadHeartbeatConfig, syncHeartbeatToDb } from "./heartbeat/config.js";
import { consumeNextWakeEvent, insertWakeEvent } from "./state/database.js";
import { runAgentLoop } from "./agent/loop.js";
import { loadSkills } from "./skills/loader.js";
import { PolicyEngine } from "./agent/policy-engine.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import { createDefaultRules } from "./agent/policy-rules/index.js";
import type { AutomatonIdentity, AutomatonConfig, AgentState, Skill, LocalRuntime } from "./types.js";
import { DEFAULT_TREASURY_POLICY } from "./types.js";
import { createLogger, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";

const logger = createLogger("main");
const VERSION = "0.1.0";
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    logger.info(`Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    logger.info(`
Automaton v${VERSION} — Your own autonomous agent, on your own infrastructure.

Usage:
  automaton --run              Start the automaton (first run triggers setup wizard)
  automaton --setup            Re-run the interactive setup wizard
  automaton --status           Show current status
  automaton --test-inference   Test AI model connectivity and tool calling
  automaton --version          Show version
  automaton --help             Show this help

Related:
  node dist/approvals-cli.js list|approve <id>|deny <id>   Manage pending approvals

Environment:
  Modelo configurado en automaton.json como "proveedor/modelo", ej.
  "anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro",
  "modelstudio/qwen-plus", "modelstudio/qwen-max".
  Define solo la key del proveedor que vayas a usar:
    ANTHROPIC_API_KEY | GOOGLE_API_KEY | OPENAI_API_KEY | GROQ_API_KEY
    OPENROUTER_API_KEY | GROK_API_KEY | MODELSTUDIO_API_KEY / DASHSCOPE_API_KEY
  (Ollama no requiere key; corre localmente)
  AUTOMATON_WALLET_PASSPHRASE    Required to encrypt/decrypt the wallet
  AUTOMATON_RPC_URL              Base RPC endpoint (optional, has a default)
`);
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--test-inference")) {
    await runTestInference();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  logger.info('Run "node dist/index.js --help" for usage information.');
  logger.info('Run "node dist/index.js --run" to start the automaton.');
}

function syncConfigEnv(config: AutomatonConfig): void {
  if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  if (config.openaiApiKey && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = config.openaiApiKey;
  }
  if (config.googleApiKey && !process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
    process.env.GOOGLE_API_KEY = config.googleApiKey;
  }
  if (
    config.modelStudioApiKey &&
    !process.env.MODELSTUDIO_API_KEY &&
    !process.env.DASHSCOPE_API_KEY &&
    !process.env.ALIBABA_API_KEY
  ) {
    process.env.MODELSTUDIO_API_KEY = config.modelStudioApiKey;
  }
  if (config.groqApiKey && !process.env.GROQ_API_KEY) {
    process.env.GROQ_API_KEY = config.groqApiKey;
  }
  if (config.openrouterApiKey && !process.env.OPENROUTER_API_KEY) {
    process.env.OPENROUTER_API_KEY = config.openrouterApiKey;
  }
  if (config.grokApiKey && !process.env.GROK_API_KEY) {
    process.env.GROK_API_KEY = config.grokApiKey;
  }
  if (config.apiKeys) {
    for (const [key, val] of Object.entries(config.apiKeys)) {
      if (!process.env[key] && val) {
        process.env[key] = String(val);
      }
    }
  }
}

async function runTestInference(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    logger.error("No configuration found. Run --setup first.");
    process.exit(1);
  }
  syncConfigEnv(config);
  logger.info(`Testing inference with model "${config.inferenceModel}"...`);
  const { testInferenceConnection } = await import("./inference/test-connection.js");
  const result = await testInferenceConnection(config.inferenceModel);
  if (result.success) {
    logger.info(`✅ Inference connection successful!`);
    logger.info(`   Provider: ${result.provider}`);
    logger.info(`   Model: ${result.model}`);
    logger.info(`   Latency: ${result.latencyMs}ms`);
    logger.info(
      `   Tool Calling: ${result.toolCallWorked ? "Supported & Verified" : "Direct response only"}`,
    );
    if (result.response) {
      logger.info(`   Response snippet: ${result.response.slice(0, 100)}`);
    }
  } else {
    logger.error(`❌ Inference test failed:`);
    logger.error(`   ${result.error}`);
    process.exit(1);
  }
}

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    logger.info("Not configured yet. Run --setup first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();

  logger.info(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Operator:   ${config.operatorId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead" && c.status !== "stopped").length} active / ${children.length} total
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

/** Ejecución local real, en este mismo servidor. */
function createLocalRuntime(): LocalRuntime {
  const isWindows = process.platform === "win32";
  // Mismo directorio base que usa write_file/read_file (AGENT_HOME en
  // agent/tools.ts) — sin esto, exec corre con el cwd del proceso (la
  // carpeta desde donde se lanzó npm start), que puede ser distinta de
  // AGENT_HOME, y una ruta relativa que Maxi escribe con write_file
  // termina en un lugar donde exec no la encuentra.
  const agentHome = process.env.AGENT_HOME || os.homedir();
  return {
    exec: async (command, timeout = 30000) => {
      try {
        // En Windows se usa PowerShell (no bash de WSL), para que exec
        // opere sobre el mismo sistema de archivos que ve Node con
        // os.homedir() — evita que write_file/read_file (Windows) y exec
        // (que antes iba a WSL/Linux) apunten a dos "hogares" distintos.
        const { stdout, stderr } = isWindows
          ? await execFileAsync(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", command],
              { timeout, maxBuffer: 10 * 1024 * 1024, cwd: agentHome },
            )
          : await execFileAsync("bash", ["-c", command], {
              timeout,
              maxBuffer: 10 * 1024 * 1024,
              cwd: agentHome,
            });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: any) {
        return {
          stdout: err.stdout || "",
          stderr: err.stderr || err.message || String(err),
          exitCode: typeof err.code === "number" ? err.code : 1,
          timedOut: !!err.killed,
        };
      }
    },
    writeFile: async (path, content) => {
      await fs.writeFile(path, content, "utf-8");
    },
    readFile: async (path) => {
      return fs.readFile(path, "utf-8");
    },
    listModels: async () => [],
  };
}

/**
 * Setup no interactivo para agentes hijo, spawneados por su padre tras
 * aprobación explícita del operador. Lee la configuración vía variables
 * de entorno (AUTOMATON_CHILD_*) en vez del wizard interactivo.
 */
async function autoSetupChild() {
  const { createConfig, saveConfig } = await import("./config.js");
  const { writeDefaultHeartbeatConfig } = await import("./heartbeat/config.js");
  const { generateSoulMd, installDefaultSkills } = await import("./setup/defaults.js");
  const path = await import("node:path");
  const fs = await import("node:fs");

  const name = process.env.AUTOMATON_CHILD_NAME!;
  const genesisPrompt = process.env.AUTOMATON_CHILD_GENESIS || "";
  const operatorId = process.env.AUTOMATON_CHILD_OPERATOR || "operator";

  const { chainIdentity } = await getWallet();

  const config = createConfig({
    name,
    genesisPrompt,
    operatorId,
    walletAddress: chainIdentity.address,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  });
  saveConfig(config);

  writeDefaultHeartbeatConfig();

  const soulPath = path.join(getAutomatonDir(), "SOUL.md");
  fs.writeFileSync(soulPath, generateSoulMd(name, chainIdentity.address, operatorId, genesisPrompt), {
    mode: 0o600,
  });

  installDefaultSkills(config.skillsDir || "~/.automaton/skills");

  logger.info(`[${new Date().toISOString()}] Child agent "${name}" auto-configured.`);
  return config;
}

async function run(): Promise<void> {
  logger.info(`[${new Date().toISOString()}] Automaton v${VERSION} starting...`);

  let config = loadConfig();
  if (!config) {
    if (process.env.AUTOMATON_CHILD_NAME) {
      // Auto-setup no interactivo para agentes hijo (spawneados por su
      // padre tras aprobación del operador — sin wizard interactivo).
      config = await autoSetupChild();
    } else {
      const { runSetupWizard } = await import("./setup/wizard.js");
      config = await runSetupWizard();
    }
  }

  syncConfigEnv(config);

  const { parseModelId } = await import("./inference/router.js");
  const { provider } = parseModelId(config.inferenceModel);
  const hasKey = (() => {
    switch (provider) {
      case "anthropic":
        return !!process.env.ANTHROPIC_API_KEY;
      case "google":
        return !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
      case "openai":
        return !!process.env.OPENAI_API_KEY;
      case "groq":
        return !!process.env.GROQ_API_KEY;
      case "openrouter":
        return !!process.env.OPENROUTER_API_KEY;
      case "grok":
        return !!process.env.GROK_API_KEY;
      case "modelstudio":
        return !!(
          process.env.MODELSTUDIO_API_KEY ||
          process.env.DASHSCOPE_API_KEY ||
          process.env.ALIBABA_API_KEY
        );
      case "ollama":
        return true;
      default:
        return true;
    }
  })();

  if (!hasKey) {
    logger.error(
      `Falta la API Key requerida para el proveedor "${provider}". Configúrala en automaton.json o defínela en las variables de entorno.`,
    );
    process.exit(1);
  }

  const { account, chainIdentity } = await getWallet();

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) {
    db.setIdentity("createdAt", createdAt);
    db.setKV("start_time", createdAt);
  }

  const identity: AutomatonIdentity = {
    name: config.name,
    address: chainIdentity.address,
    account,
    operatorId: config.operatorId,
    createdAt,
    chainType: "evm",
    chainIdentity,
  };

  db.setIdentity("name", config.name);
  db.setIdentity("address", chainIdentity.address);
  db.setIdentity("operator", config.operatorId);

  const runtime = createLocalRuntime();

  const treasuryPolicy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  const rules = createDefaultRules(treasuryPolicy);
  const policyEngine = new PolicyEngine(db.raw, rules);
  const spendTracker = new SpendTracker(db.raw);

  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    logger.info(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    heartbeatConfig,
    db,
    rawDb: db.raw,
    runtime,
    onWakeRequest: (reason) => {
      logger.info(`[HEARTBEAT] Wake request: ${reason}`);
      insertWakeEvent(db.raw, "heartbeat", reason);
    },
  });

  heartbeat.start();
  logger.info(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  const shutdown = () => {
    logger.info(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (true) {
    try {
      try {
        skills = loadSkills(skillsDir, db);
      } catch (error) {
        logger.error("Skills reload failed", error instanceof Error ? error : undefined);
      }

      await runAgentLoop({
        identity,
        config,
        db,
        runtime,
        skills,
        policyEngine,
        spendTracker,
        onStateChange: (state: AgentState) => {
          logger.info(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          logger.info(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      const state = db.getAgentState();

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr ? new Date(sleepUntilStr).getTime() : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        logger.info(`[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`);

        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          const wakeEvent = consumeNextWakeEvent(db.raw);
          if (wakeEvent) {
            logger.info(`[${new Date().toISOString()}] Woken by ${wakeEvent.source}: ${wakeEvent.reason}`);
            db.deleteKV("sleep_until");
            break;
          }
        }
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      logger.error(`[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`);
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
