/**
 * The Agent Loop (versión simplificada)
 *
 * Reescrito a partir de Conway-Research/automaton (MIT license). El
 * ciclo central Think -> Act -> Observe se conserva, pero se quitó:
 * - Todo lo relacionado a créditos/auto-topup de Conway
 * - Orquestación multi-worker paralela (no necesaria para la v1)
 * - Mensajería inter-agente ("colonia")
 * Se agregó: inferencia directa con Anthropic, e integración con el
 * flujo de aprobación humana (pending_approvals) para gasto y
 * replicación.
 */

import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  LocalRuntime,
  AgentState,
  AgentTurn,
  ToolContext,
  AutomatonTool,
  Skill,
  SpendTrackerInterface,
  ChatMessage,
} from "../types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  loadInstalledTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { chat as chatWithInference } from "../inference/router.js";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("loop");
const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_REPETITIVE_TURNS = 3;
const MAX_REPETITIVE_FAILURES = 4;
const MAX_IDLE_TURNS = 10;

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  runtime: LocalRuntime;
  skills?: Skill[];
  policyEngine?: PolicyEngine;
  spendTracker: SpendTrackerInterface;
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep, or after too many errors.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const { identity, config, db, runtime, skills, policyEngine, spendTracker, onStateChange, onTurnComplete } =
    options;

  const builtinTools = createBuiltinTools();
  const installedTools = loadInstalledTools(db);
  const tools: AutomatonTool[] = [...builtinTools, ...installedTools];
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    runtime,
    inference: {} as any, // no usado directamente por las tools; el loop llama a Anthropic
    spendTracker,
  };

  let consecutiveErrors = 0;
  let running = true;
  let lastToolPatterns: string[] = [];
  let lastFailingToolNames: string[] = [];
  let idleTurnCount = 0;

  db.deleteKV("sleep_until");
  db.setAgentState("waking");
  onStateChange?.("waking");

  const isFirstRun = db.getTurnCount() === 0;

  const wakeupInput = buildWakeupPrompt({ identity, config, db });

  db.setAgentState("running");
  onStateChange?.("running");

  log(config, `[WAKE UP] ${config.name} is alive.`);

  const maxCycleTurns = config.maxTurnsPerCycle ?? 25;
  let cycleTurnCount = 0;

  let pendingInput: { content: string; source: string } | undefined = {
    content: wakeupInput,
    source: "wakeup",
  };

  while (running) {
    try {
      // ── Sleep check ──
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── Cycle turn cap ──
      cycleTurnCount++;
      if (cycleTurnCount > maxCycleTurns) {
        log(config, `[LOOP] Max turns per cycle reached (${maxCycleTurns}). Sleeping.`);
        db.setKV("sleep_until", new Date(Date.now() + 150_000).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      const currentInput = pendingInput;
      pendingInput = undefined;

      // ── Build context ──
      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        db,
        state: db.getAgentState(),
        tools,
        skills,
        isFirstRun,
      });
      const messages: ChatMessage[] = buildContextMessages(
        systemPrompt,
        trimContext(db.getRecentTurns(10), 8),
        currentInput,
      );

      // ── Think: call Anthropic ──
      log(config, `[THINK] Calling ${config.inferenceModel}...`);
      const inferenceTools = toolsToInferenceFormat(tools);
      const result = await chatWithInference({
        modelId: config.inferenceModel,
        messages,
        maxTokens: config.maxTokensPerTurn ?? 4096,
        tools: inferenceTools,
      });

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: result.content || "",
        toolCalls: [],
        tokenUsage: {
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        } as any,
        costCents: Math.round(result.cost.totalCostCredits * 100),
      };

      // ── Act: execute tool calls ──
      const toolCalls = (result.toolCalls || []) as {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];

      if (toolCalls.length > 0) {
        let callCount = 0;
        for (const tc of toolCalls) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log(config, `[TOOLS] Max tool calls per turn reached (${MAX_TOOL_CALLS_PER_TURN})`);
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);

          const toolResult = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
            policyEngine,
            {
              inputSource: currentInput?.source as any,
              turnToolCallCount: turn.toolCalls.filter((t) => t.name === "send_payment").length,
              sessionSpend: spendTracker,
            },
          );

          toolResult.id = tc.id;
          turn.toolCalls.push(toolResult);

          log(
            config,
            `[TOOL RESULT] ${tc.function.name}: ${toolResult.error ? `ERROR: ${toolResult.error}` : toolResult.result.slice(0, 200)}`,
          );

          callCount++;
        }
      }

      // ── Observe: persist turn ──
      db.runTransaction(() => {
        db.insertTurn(turn);
        for (const tc of turn.toolCalls) {
          db.insertToolCall(turn.id, tc);
        }
      });
      onTurnComplete?.(turn);

      consecutiveErrors = 0;

      // ── Loop detection ──
      // Dos señales complementarias:
      // 1) Patrón EXACTO repetido (mismo nombre + mismos argumentos) — un
      //    reintento idéntico es la señal más clara de bucle real.
      // 2) Misma herramienta fallando varias veces seguidas (aunque con
      //    argumentos distintos) — señal de estar atascado intentando
      //    variaciones de algo que no funciona, no de progreso legítimo.
      // Ninguna de las dos se activa solo por usar la misma herramienta
      // con éxito y argumentos distintos (ej. leer varios archivos
      // distintos, instalar varios paquetes distintos).
      if (turn.toolCalls.length > 0) {
        const pattern = turn.toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .sort()
          .join(",");
        lastToolPatterns.push(pattern);
        if (lastToolPatterns.length > MAX_REPETITIVE_TURNS) {
          lastToolPatterns = lastToolPatterns.slice(-MAX_REPETITIVE_TURNS);
        }
        const exactPatternRepeated =
          lastToolPatterns.length === MAX_REPETITIVE_TURNS &&
          lastToolPatterns.every((p) => p === lastToolPatterns[0]);

        const allFailed = turn.toolCalls.every((tc) => !!tc.error);
        const soleToolName = turn.toolCalls.length === 1 ? turn.toolCalls[0].name : null;
        if (allFailed && soleToolName) {
          lastFailingToolNames.push(soleToolName);
          if (lastFailingToolNames.length > MAX_REPETITIVE_FAILURES) {
            lastFailingToolNames = lastFailingToolNames.slice(-MAX_REPETITIVE_FAILURES);
          }
        } else {
          lastFailingToolNames = [];
        }
        const sameToolFailingRepeatedly =
          lastFailingToolNames.length === MAX_REPETITIVE_FAILURES &&
          lastFailingToolNames.every((n) => n === lastFailingToolNames[0]);

        if (exactPatternRepeated || sameToolFailingRepeatedly) {
          const reason = exactPatternRepeated
            ? `identical repeated call (${lastToolPatterns[0]})`
            : `"${lastFailingToolNames[0]}" failing ${MAX_REPETITIVE_FAILURES} times in a row`;
          log(config, `[LOOP] Repetitive pattern detected: ${reason}. Sleeping to avoid runaway loop.`);
          db.setKV("sleep_until", new Date(Date.now() + 300_000).toISOString());
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
          break;
        }
        idleTurnCount = 0;
      } else {
        // No tool calls -- the agent just "thought" without acting.
        idleTurnCount++;
        if (idleTurnCount >= MAX_IDLE_TURNS) {
          log(config, `[LOOP] ${MAX_IDLE_TURNS} idle turns with no action. Sleeping.`);
          db.setKV("sleep_until", new Date(Date.now() + 150_000).toISOString());
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
          break;
        }
      }

      // ── sleep tool called explicitly? ──
      const sleepCall = turn.toolCalls.find((tc) => tc.name === "sleep" && !tc.error);
      if (sleepCall) {
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }
    } catch (error: any) {
      consecutiveErrors++;
      logger.error("Agent loop turn failed", error instanceof Error ? error : undefined);
      log(config, `[ERROR] Turn failed: ${error?.message || error}`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(config, `[LOOP] ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Sleeping to avoid runaway failure loop.`);
        db.setKV("sleep_until", new Date(Date.now() + 450_000).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }
    }
  }
}

function log(config: AutomatonConfig, message: string): void {
  if (config.logLevel === "debug" || config.logLevel === "info") {
    console.log(message);
  }
}
