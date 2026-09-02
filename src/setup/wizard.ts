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

  // ─── 3. Claves de inferencia ───────────────────────────────────
  console.log(chalk.white("  Claves de los proveedores de inferencia (Enter para omitir)."));
  const anthropicApiKey = await promptOptional("Anthropic API key (sk-ant-..., opcional)");
  if (anthropicApiKey && !anthropicApiKey.startsWith("sk-ant-")) {
    console.log(chalk.yellow("  Aviso: las claves de Anthropic normalmente empiezan con sk-ant-. Se guarda igual."));
  }

  const openaiApiKey = await promptOptional("OpenAI API key (sk-..., opcional)");
  if (openaiApiKey && !openaiApiKey.startsWith("sk-")) {
    console.log(chalk.yellow("  Aviso: las claves de OpenAI normalmente empiezan con sk-. Se guarda igual."));
  }

  const ollamaInput = await promptOptional("URL base de Ollama (http://localhost:11434, opcional)");
  const ollamaBaseUrl = ollamaInput || undefined;

  if (anthropicApiKey || openaiApiKey || ollamaBaseUrl) {
    const providers = [
      anthropicApiKey ? "Anthropic" : null,
      openaiApiKey ? "OpenAI" : null,
      ollamaBaseUrl ? "Ollama" : null,
    ].filter(Boolean).join(", ");
    console.log(chalk.green(`  Proveedores configurados: ${providers}\n`));
  } else {
    console.log(
      chalk.yellow(
        "  Sin ninguna clave configurada, el agente no podrá razonar. Puedes agregarlas después en automaton.json.\n",
      ),
    );
  }

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
      "Máximo de gasto diario en inferencia -Anthropic/OpenAI- (centavos)", DEFAULT_TREASURY_POLICY.maxInferenceDailyCents),
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
    openaiApiKey: openaiApiKey || undefined,
    anthropicApiKey: anthropicApiKey || undefined,
    ollamaBaseUrl,
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
