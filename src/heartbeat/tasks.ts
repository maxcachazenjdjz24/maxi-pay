/**
 * Built-in Heartbeat Tasks (versión simplificada)
 *
 * Reescrito a partir de Conway-Research/automaton (MIT license). Solo
 * se conservan las tareas genéricas: heartbeat_ping (sin la lógica de
 * "distress" atada a créditos de Conway), check_for_updates, y
 * health_check (adaptada a LocalRuntime). Se quitaron check_credits,
 * check_usdc_balance, colony_health_check y todo lo relacionado a
 * salud/limpieza de una colonia multi-agente.
 */

import type { TickContext, HeartbeatLegacyContext, HeartbeatTaskFn } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("heartbeat.tasks");

export const BUILTIN_TASKS: Record<string, HeartbeatTaskFn> = {
  heartbeat_ping: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    const state = taskCtx.db.getAgentState();
    const startTime = taskCtx.db.getKV("start_time") || new Date().toISOString();
    const uptimeMs = Date.now() - new Date(startTime).getTime();

    const payload = {
      name: taskCtx.config.name,
      address: taskCtx.identity.address,
      state,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      version: taskCtx.config.version,
      timestamp: new Date().toISOString(),
    };

    taskCtx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));
    return { shouldWake: false };
  },

  check_for_updates: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { checkUpstream, getRepoInfo } = await import("../self-mod/upstream.js");
      const repo = getRepoInfo();
      const upstream = checkUpstream();
      taskCtx.db.setKV(
        "upstream_status",
        JSON.stringify({ ...upstream, ...repo, checkedAt: new Date().toISOString() }),
      );
      if (upstream.behind > 0) {
        const prevBehind = taskCtx.db.getKV("upstream_prev_behind");
        const behindStr = String(upstream.behind);
        if (prevBehind !== behindStr) {
          taskCtx.db.setKV("upstream_prev_behind", behindStr);
          return {
            shouldWake: true,
            message: `${upstream.behind} new commit(s) on origin/main. Review with review_upstream_changes, then cherry-pick with pull_upstream.`,
          };
        }
      } else {
        taskCtx.db.deleteKV("upstream_prev_behind");
      }
      return { shouldWake: false };
    } catch (err: any) {
      taskCtx.db.setKV(
        "upstream_status",
        JSON.stringify({ error: err.message, checkedAt: new Date().toISOString() }),
      );
      return { shouldWake: false };
    }
  },

  health_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const result = await taskCtx.runtime.exec("echo alive", 5000);
      if (result.exitCode !== 0) {
        const prevStatus = taskCtx.db.getKV("health_check_status");
        if (prevStatus !== "failing") {
          taskCtx.db.setKV("health_check_status", "failing");
          return { shouldWake: true, message: "Health check failed: exec returned non-zero" };
        }
        return { shouldWake: false };
      }
    } catch (err: any) {
      const prevStatus = taskCtx.db.getKV("health_check_status");
      if (prevStatus !== "failing") {
        taskCtx.db.setKV("health_check_status", "failing");
        return { shouldWake: true, message: `Health check failed: ${err.message}` };
      }
      return { shouldWake: false };
    }

    taskCtx.db.setKV("health_check_status", "ok");
    taskCtx.db.setKV("last_health_check", new Date().toISOString());
    return { shouldWake: false };
  },
};
