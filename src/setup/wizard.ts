/**
 * Setup Wizard
 *
 * Adaptado de Conway-Research/automaton (MIT license). Cambios respecto
 * al original:
 * - Sin provisioning SIWE (no hay servidor de terceros que "aprovisione"
 *   nada — el agente corre en infraestructura propia).
 * - Sin panel de fondeo vía Conway Cloud / USDC — en su lugar, se
 *   muestra la dirección de la wallet para que el operador la fondee
 *   como prefiera.
 * - "Creator address" renombrado a "operatorId": ya no es una dirección
 *   on-chain requerida para registro, es solo un identificador de quién
 *   opera el agente (para logs y para saber a quién notificar).
 */

import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { AutomatonConfig, TreasuryPolicy } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { createConfig, saveConfig, resolvePath } from "../config.js";
import { createDatabase } from "../state/database.js";
import { showBanner } from "./banner.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import {
  promptRequired,
  promptMultiline,
  promptOptional,
  promptWithDefault,
  closePrompts,
} from "./prompts.js";

export async function runSetupWizard(): Promise<AutomatonConfig> {
  showBanner();

  console.log(chalk.white("  Primera vez. Vamos a configurar tu agente.\n"));

  // ─── 1. Passphrase de la wallet + creación ────────────────────
  console.log(chalk.cyan("  [1/5] Identidad (wallet)..."));

  if (!process.env.AUTOMATON_WALLET_PASSPHRASE) {
    console.log(
      chalk.yellow(
        "  Falta la variable de entorno AUTOMATON_WALLET_PASSPHRASE.",
      ),
    );
    console.log(
      chalk.yellow(
        "  Es la clave para cifrar la wallet en disco. Defínela antes de continuar, por ejemplo:",
      ),
    );
    console.log(chalk.dim("    export AUTOMATON_WALLET_PASSPHRASE=\"una-frase-larga-y-unica\"\n"));
    closePrompts();
    throw new Error("AUTOMATON_WALLET_PASSPHRASE no está definida");
  }

  const { chainIdentity, isNew } = await getWallet();
  const walletAddress = chainIdentity.address;
  if (isNew) {
    console.log(chalk.green(`  Wallet creada: ${walletAddress}`));
  } else {
    console.log(chalk.green(`  Wallet cargada: ${walletAddress}`));
  }
  console.log(chalk.dim(`  Clave privada cifrada en: ${getAutomatonDir()}/wallet.json\n`));

  // ─── 2. Preguntas de identidad del agente ─────────────────────
  console.log(chalk.cyan("  [2/5] Preguntas de configuración\n"));

  const name = await promptRequired("¿Cómo quieres llamar a tu agente?");
  console.log(chalk.green(`  Nombre: ${name}\n`));

  const genesisPrompt = await promptMultiline(
    "Escribe el genesis prompt (instrucción inicial / misión) de tu agente.",
  );
  console.log(chalk.green(`  Genesis prompt definido (${genesisPrompt.length} caracteres)\n`));

  const operatorId = await promptRequired(
    "Tu identificador como operador (nombre, email, o lo que prefieras usar para tus registros)",
  );
  console.log(chalk.green(`  Operador: ${operatorId}\n`));

  // ─── 3. Proveedor de inferencia ─────────────────────────────────
  console.log(chalk.white("  ¿Qué proveedor de inferencia vas a usar?"));
  console.log(chalk.dim("  Selecciona una opción escribiendo el número o nombre:\n"));
  console.log(chalk.cyan("    1) anthropic   ") + chalk.dim("- Claude (ej. claude-sonnet-4-5, claude-3-5-haiku)"));
  console.log(chalk.cyan("    2) google      ") + chalk.dim("- Gemini (ej. gemini-2.5-pro, gemini-2.0-flash)"));
  console.log(chalk.cyan("    3) modelstudio ") + chalk.dim("- Alibaba Cloud / Qwen (ej. qwen-plus, qwen-max)"));
  console.log(chalk.cyan("    4) openai      ") + chalk.dim("- GPT (ej. gpt-4o, gpt-5)"));
  console.log(chalk.cyan("    5) groq        ") + chalk.dim("- Llama / ultra-rápido (ej. llama-3.3-70b-versatile)"));
  console.log(chalk.cyan("    6) openrouter  ") + chalk.dim("- Multi-proveedor unificado"));
  console.log(chalk.cyan("    7) grok        ") + chalk.dim("- xAI Grok (ej. grok-4)"));
  console.log(chalk.cyan("    8) ollama      ") + chalk.dim("- Local / offline (ej. qwen2.5-coder:7b)\n"));

  const PROVIDER_MAP: Record<string, string> = {
    "1": "anthropic",
    "anthropic": "anthropic",
    "2": "google",
    "google": "google",
    "gemini": "google",
    "3": "modelstudio",
    "modelstudio": "modelstudio",
    "alibaba": "modelstudio",
    "dashscope": "modelstudio",
    "qwen": "modelstudio",
    "4": "openai",
    "openai": "openai",
    "gpt": "openai",
    "5": "groq",
    "groq": "groq",
    "6": "openrouter",
    "openrouter": "openrouter",
    "7": "grok",
    "grok": "grok",
    "xai": "grok",
    "8": "ollama",
    "ollama": "ollama",
  };

  let provider = "anthropic";
  while (true) {
    const input = await promptOptional("Proveedor [anthropic]");
    if (!input) {
      provider = "anthropic";
      break;
    }
    const normalized = input.trim().toLowerCase();
    if (PROVIDER_MAP[normalized]) {
      provider = PROVIDER_MAP[normalized];
      break;
    }
    console.log(
      chalk.yellow(
        `  Opción no reconocida. Elige 1-8 o escribe el nombre (anthropic, google, modelstudio, openai, etc.)`,
      ),
    );
  }

  const DEFAULT_MODELS: Record<string, string> = {
    modelstudio: "modelstudio/qwen-plus",
    anthropic: "anthropic/claude-sonnet-4-5",
    google: "google/gemini-2.5-pro",
    openai: "openai/gpt-5",
    groq: "groq/llama-3.3-70b-versatile",
    openrouter: "openrouter/anthropic/claude-sonnet-4-5",
    grok: "grok/grok-4",
    ollama: "ollama/qwen2.5-coder:7b",
  };

  const defaultModel = DEFAULT_MODELS[provider] || "anthropic/claude-sonnet-4-5";
  const modelIdInput = await promptOptional(
    `Modelo de ${provider} a usar [${defaultModel}] (Enter para default)`,
  );
  const inferenceModel = modelIdInput
    ? (modelIdInput.includes("/") ? modelIdInput : `${provider}/${modelIdInput}`)
    : defaultModel;

  let anthropicApiKey: string | undefined;
  let openaiApiKey: string | undefined;
  let googleApiKey: string | undefined;
  let modelStudioApiKey: string | undefined;
  let groqApiKey: string | undefined;
  let openrouterApiKey: string | undefined;
  let grokApiKey: string | undefined;
  let ollamaBaseUrl: string | undefined;

  if (provider === "modelstudio") {
    modelStudioApiKey = (await promptOptional("Alibaba Cloud ModelStudio / DashScope API Key (opcional)")) || undefined;
  } else if (provider === "anthropic") {
    anthropicApiKey = (await promptOptional("Anthropic API key (sk-ant-..., opcional)")) || undefined;
  } else if (provider === "google") {
    googleApiKey = (await promptOptional("Google Gemini API key (AIza..., opcional)")) || undefined;
  } else if (provider === "openai") {
    openaiApiKey = (await promptOptional("OpenAI API key (sk-..., opcional)")) || undefined;
  } else if (provider === "groq") {
    groqApiKey = (await promptOptional("Groq API key (gsk_..., opcional)")) || undefined;
  } else if (provider === "openrouter") {
    openrouterApiKey = (await promptOptional("OpenRouter API key (sk-or-..., opcional)")) || undefined;
  } else if (provider === "grok") {
    grokApiKey = (await promptOptional("xAI Grok API key (xai-..., opcional)")) || undefined;
  } else if (provider === "ollama") {
    const ollamaInput = await promptOptional("URL base de Ollama (http://localhost:11434, opcional)");
    ollamaBaseUrl = ollamaInput || undefined;
  }

  console.log(chalk.green(`  Modelo configurado: ${inferenceModel}\n`));

  // ─── 4. Política de gasto (treasury) ──────────────────────────
  console.log(chalk.cyan("  Política de gasto"));
  console.log(
    chalk.dim(
      "  Estos límites protegen contra gasto no controlado. Enter para usar los valores por defecto.\n",
    ),
  );

  const treasuryPolicy: TreasuryPolicy = {
    maxSingleTransferCents: await promptWithDefault(
      "Máximo por transacción autoaprobada (centavos)", DEFAULT_TREASURY_POLICY.maxSingleTransferCents),
    maxHourlyTransferCents: await promptWithDefault(
      "Máximo de gasto por hora (centavos)", DEFAULT_TREASURY_POLICY.maxHourlyTransferCents),
    maxDailyTransferCents: await promptWithDefault(
      "Máximo de gasto por día (centavos)", DEFAULT_TREASURY_POLICY.maxDailyTransferCents),
    minimumReserveCents: DEFAULT_TREASURY_POLICY.minimumReserveCents,
    maxX402PaymentCents: await promptWithDefault(
      "Máximo por pago x402 a APIs de terceros (centavos)", DEFAULT_TREASURY_POLICY.maxX402PaymentCents),
    x402AllowedDomains: DEFAULT_TREASURY_POLICY.x402AllowedDomains,
    transferCooldownMs: DEFAULT_TREASURY_POLICY.transferCooldownMs,
    maxTransfersPerTurn: DEFAULT_TREASURY_POLICY.maxTransfersPerTurn,
    maxInferenceDailyCents: await promptWithDefault(
      "Máximo de gasto diario en inferencia (centavos)", DEFAULT_TREASURY_POLICY.maxInferenceDailyCents),
    requireConfirmationAboveCents: await promptWithDefault(
      "Requerir tu aprobación por encima de (centavos)", DEFAULT_TREASURY_POLICY.requireConfirmationAboveCents),
  };

  console.log(chalk.green("  Política de gasto configurada.\n"));

  // ─── 4.5 Inversión inicial (para la condición de replicación 2x) ──
  console.log(chalk.cyan("  Inversión inicial"));
  console.log(
    chalk.dim(
      "  ¿Cuántos dólares planeas fondear en la wallet para empezar? Este número\n  se guarda de forma fija y se usa para calcular cuándo el agente puede\n  proponer reproducirse (2x esta cifra). No se puede editar después desde el propio agente.\n",
    ),
  );
  const initialInvestmentUsd = await promptWithDefault("Inversión inicial (USD)", 20);

  // ─── 5. Escribir configuración ─────────────────────────────────
  console.log(chalk.cyan("  [5/5] Escribiendo configuración..."));

  const config = createConfig({
    name,
    genesisPrompt,
    operatorId,
    walletAddress,
    openaiApiKey,
    anthropicApiKey,
    googleApiKey,
    modelStudioApiKey,
    groqApiKey,
    openrouterApiKey,
    grokApiKey,
    ollamaBaseUrl,
    inferenceModel,
    treasuryPolicy,
  });

  saveConfig(config);
  console.log(chalk.green("  automaton.json escrito"));

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);
  db.setKV("initial_investment_usd", String(initialInvestmentUsd));
  db.close();
  console.log(chalk.green(`  Inversión inicial registrada: $${initialInvestmentUsd.toFixed(2)}`));

  writeDefaultHeartbeatConfig();
  console.log(chalk.green("  heartbeat.yml escrito"));

  const automatonDir = getAutomatonDir();
  const soulPath = path.join(automatonDir, "SOUL.md");
  fs.writeFileSync(
    soulPath,
    generateSoulMd(name, walletAddress, operatorId, genesisPrompt),
    { mode: 0o600 },
  );
  console.log(chalk.green("  SOUL.md escrito"));

  const skillsDir = config.skillsDir || "~/.automaton/skills";
  installDefaultSkills(skillsDir);
  console.log(chalk.green("  Skills por defecto instalados (local-runtime, payments, growth)\n"));

  console.log("");
  showFundingPanel(walletAddress);

  closePrompts();

  return config;
}

function showFundingPanel(address: string): void {
  const short = `${address.slice(0, 6)}...${address.slice(-5)}`;
  const w = 58;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));

  console.log(chalk.cyan(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.cyan(`  │${pad("  Fondea tu agente", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Dirección: ${short}`, w)}│`));
  console.log(chalk.cyan(`  │${pad("  Red: EVM (Base recomendado, más económico en gas)", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  Envía USDC a la dirección de arriba cuando quieras", w)}│`));
  console.log(chalk.cyan(`  │${pad("  que el agente pueda empezar a gastar/pagar por su cuenta.", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  Recuerda: solo gasta hasta los límites que configuraste", w)}│`));
  console.log(chalk.cyan(`  │${pad("  arriba, y te pedirá aprobación por encima de esos montos.", w)}│`));
  console.log(chalk.cyan(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}
