/**
 * Replicación condicionada (módulo nuevo, no existía en el original).
 *
 * El agente solo puede proponer crear un hijo cuando su balance alcanzó
 * el múltiplo configurado (por defecto 2x) de su inversión inicial, Y
 * solo después de que el operador apruebe esa propuesta específica.
 * Nunca se ejecuta automáticamente.
 */

import type { AutomatonDatabase, AutomatonIdentity } from "../types.js";
import { getUsdcBalance } from "../identity/payments.js";

/** Múltiplo de la inversión inicial requerido para poder proponer un hijo. */
const DEFAULT_REPLICATION_MULTIPLE = 2;

export interface ReplicationEligibility {
  eligible: boolean;
  currentBalanceUsd: number;
  initialInvestmentUsd: number;
  requiredBalanceUsd: number;
  multiple: number;
}

/**
 * Verifica si el agente cumple la condición para proponer una replicación.
 * initialInvestmentUsd debe venir de un valor conocido y fijo (guardado en
 * kv al momento del primer fondeo) — nunca de un cálculo que el propio
 * agente pueda inflar.
 */
export async function checkReplicationEligibility(
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  multiple: number = DEFAULT_REPLICATION_MULTIPLE,
): Promise<ReplicationEligibility> {
  const initialInvestmentRaw = db.getKV("initial_investment_usd");
  const initialInvestmentUsd = initialInvestmentRaw
    ? parseFloat(initialInvestmentRaw)
    : 0;

  const currentBalanceUsd = await getUsdcBalance(identity.account.address);
  const requiredBalanceUsd = initialInvestmentUsd * multiple;

  return {
    eligible:
      initialInvestmentUsd > 0 && currentBalanceUsd >= requiredBalanceUsd,
    currentBalanceUsd,
    initialInvestmentUsd,
    requiredBalanceUsd,
    multiple,
  };
}

export interface GenesisProposal {
  name: string;
  specialization?: string;
  message?: string;
  parentAddress: string;
  operatorId: string;
}

export function validateGenesisParams(params: {
  name: string;
  specialization?: string;
}): void {
  if (!params.name || !/^[a-zA-Z0-9-]{1,64}$/.test(params.name)) {
    throw new Error(
      "Invalid child name: must be alphanumeric + dash, max 64 characters.",
    );
  }
}

/**
 * Crea el proceso de un agente hijo, una vez la replicación fue aprobada
 * por el operador. Cada hijo es un proceso Node independiente con su
 * propio $HOME (y por lo tanto su propia carpeta ~/.automaton, wallet,
 * y base de datos) — no comparte estado con el padre.
 */
export async function spawnChild(params: {
  parentAutomatonDir: string;
  parentGenesisPrompt: string;
  parentOperatorId: string;
  childName: string;
  specialization?: string;
  message?: string;
  entryPointPath: string; // ruta a dist/index.js
  walletPassphrase: string;
  anthropicApiKey?: string;
}): Promise<{ childHome: string; pid: number }> {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const fs = await import("node:fs");

  const childrenRoot = path.join(params.parentAutomatonDir, "children");
  const childHome = path.join(childrenRoot, params.childName);
  fs.mkdirSync(childHome, { recursive: true, mode: 0o700 });

  const childGenesisPrompt = params.specialization
    ? `${params.parentGenesisPrompt}\n\nSpecialization for this child agent: ${params.specialization}${
        params.message ? `\n\nMessage from parent: ${params.message}` : ""
      }`
    : params.parentGenesisPrompt;

  // El hijo corre con su propio HOME -> su propio ~/.automaton, wallet,
  // config y base de datos. Primero necesita --setup para generar todo
  // eso; se lo dejamos automatizado pasando las respuestas por variables
  // de entorno que el wizard puede leer si están presentes, o el
  // operador puede correr el setup manualmente en esa carpeta.
  const child = spawn(
    process.execPath,
    [params.entryPointPath, "--run"],
    {
      env: {
        ...process.env,
        HOME: childHome,
        AUTOMATON_WALLET_PASSPHRASE: params.walletPassphrase,
        ANTHROPIC_API_KEY: params.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
        AUTOMATON_CHILD_NAME: params.childName,
        AUTOMATON_CHILD_GENESIS: childGenesisPrompt,
        AUTOMATON_CHILD_OPERATOR: params.parentOperatorId,
      },
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  return { childHome, pid: child.pid || -1 };
}
