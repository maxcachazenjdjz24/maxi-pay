/**
 * Tick Context (versión simplificada)
 *
 * Reescrito a partir de Conway-Research/automaton (MIT license). Se
 * quitó el fetch de "credit balance" / survival tier de Conway. Se
 * conserva el fetch de balance USDC real, usando nuestro propio
 * identity/payments.ts.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { HeartbeatConfig, TickContext } from "../types.js";
import { getUsdcBalance } from "../identity/payments.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.tick");

let counter = 0;
function generateTickId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  counter++;
  return `${timestamp}-${random}-${counter.toString(36)}`;
}

export async function buildTickContext(
  db: DatabaseType,
  config: HeartbeatConfig,
  walletAddress?: string,
): Promise<TickContext> {
  const tickId = generateTickId();
  const startedAt = new Date();

  let usdcBalanceUsd = 0;
  if (walletAddress) {
    try {
      usdcBalanceUsd = await getUsdcBalance(walletAddress as `0x${string}`);
    } catch (err: any) {
      logger.error("Failed to fetch USDC balance", err instanceof Error ? err : undefined);
    }
  }

  const lowComputeMultiplier = config.lowComputeMultiplier ?? 4;

  return {
    tickId,
    startedAt,
    usdcBalanceUsd,
    lowComputeMultiplier,
    config,
    db,
  };
}
