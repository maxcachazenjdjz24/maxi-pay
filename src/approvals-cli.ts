/**
 * Approvals CLI
 *
 * Herramienta para que el operador (tú) revise y decida sobre las
 * solicitudes que el agente dejó pendientes de aprobación — pagos por
 * encima del límite autoaprobado, y propuestas de replicación.
 *
 * Uso:
 *   node dist/approvals-cli.js list
 *   node dist/approvals-cli.js approve <id>
 *   node dist/approvals-cli.js deny <id>
 */

import chalk from "chalk";
import {
  createDatabase,
  getPendingApprovals,
  getPendingApprovalById,
  resolvePendingApproval,
} from "./state/database.js";
import { loadConfig } from "./config.js";
import { getWallet } from "./identity/wallet.js";
import { transferUsdc, getUsdcBalance } from "./identity/payments.js";
import { resolvePath } from "./config.js";
import { ulid } from "ulid";

async function main(): Promise<void> {
  const [, , command, id] = process.argv;

  const config = loadConfig();
  if (!config) {
    console.log(chalk.red("No hay configuración. Corre el wizard primero (--setup)."));
    process.exit(1);
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);
  const rawDb = db.raw;

  if (command === "list" || !command) {
    const pending = getPendingApprovals(rawDb);
    if (pending.length === 0) {
      console.log(chalk.green("No hay solicitudes pendientes."));
      return;
    }
    console.log(chalk.cyan(`${pending.length} solicitud(es) pendiente(s):\n`));
    for (const p of pending) {
      console.log(chalk.white(`  [${p.id}] ${p.kind.toUpperCase()}`));
      if (p.kind === "spend") {
        console.log(`    Monto: $${((p.amountCents ?? 0) / 100).toFixed(2)}`);
        console.log(`    Destinatario: ${p.recipient}`);
      }
      console.log(`    Motivo: ${p.reason}`);
      console.log(`    Creado: ${p.createdAt}`);
      console.log("");
    }
    console.log(chalk.dim("Para aprobar:  node dist/approvals-cli.js approve <id>"));
    console.log(chalk.dim("Para rechazar: node dist/approvals-cli.js deny <id>"));
    return;
  }

  if (command === "approve" || command === "deny") {
    if (!id) {
      console.log(chalk.red("Falta el id. Uso: approve <id> | deny <id>"));
      process.exit(1);
    }

    const approval = getPendingApprovalById(rawDb, id);
    if (!approval) {
      console.log(chalk.red(`No se encontró la solicitud ${id}.`));
      process.exit(1);
    }
    if (approval.status !== "pending") {
      console.log(chalk.yellow(`Esta solicitud ya fue resuelta (estado: ${approval.status}).`));
      return;
    }

    const operatorId = config.operatorId || "operator";

    if (command === "deny") {
      resolvePendingApproval(rawDb, id, "denied", operatorId);
      console.log(chalk.yellow(`Solicitud ${id} rechazada.`));
      return;
    }

    // approve
    if (approval.kind === "spend") {
      const { account } = await getWallet();
      const amountUsd = (approval.amountCents ?? 0) / 100;
      const balance = await getUsdcBalance(account.address);

      if (balance < amountUsd) {
        console.log(chalk.red(`Saldo insuficiente: $${balance.toFixed(2)} disponible, $${amountUsd.toFixed(2)} requerido. No se ejecuta el pago.`));
        return;
      }

      console.log(chalk.cyan(`Ejecutando pago de $${amountUsd.toFixed(2)} a ${approval.recipient}...`));
      const { txHash } = await transferUsdc(account, approval.recipient as `0x${string}`, amountUsd);

      db.insertTransaction({
        id: ulid(),
        type: "transfer_out",
        amountCents: approval.amountCents ?? 0,
        balanceAfterCents: Math.round((balance - amountUsd) * 100),
        description: `${approval.reason} (aprobado manualmente, tx: ${txHash})`,
        timestamp: new Date().toISOString(),
      });

      resolvePendingApproval(rawDb, id, "approved", operatorId);
      console.log(chalk.green(`Pago enviado. Tx: ${txHash}`));
      return;
    }

    if (approval.kind === "replication") {
      const metadata = JSON.parse(approval.metadata || "{}");
      const { spawnChild } = await import("./replication/genesis.js");
      const { getAutomatonDir } = await import("./identity/wallet.js");
      const path = await import("node:path");

      try {
        const { childHome, pid } = await spawnChild({
          parentAutomatonDir: getAutomatonDir(),
          parentGenesisPrompt: config.genesisPrompt,
          parentOperatorId: operatorId,
          childName: metadata.name || `child-${id.slice(0, 8)}`,
          specialization: metadata.specialization,
          message: metadata.message,
          entryPointPath: path.resolve(process.argv[1], "..", "index.js"),
          walletPassphrase: process.env.AUTOMATON_WALLET_PASSPHRASE || "",
          anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        });

        resolvePendingApproval(rawDb, id, "approved", operatorId);
        console.log(chalk.green(`Replicación ${id} aprobada. Hijo "${metadata.name}" iniciado (PID ${pid}).`));
        console.log(chalk.dim(`Carpeta del hijo: ${childHome}`));
      } catch (err: any) {
        console.log(chalk.red(`Error al crear el hijo: ${err.message}`));
      }
      return;
    }
  }

  console.log(chalk.red(`Comando desconocido: ${command}`));
  console.log("Uso: list | approve <id> | deny <id>");
  process.exit(1);
}

main().catch((err) => {
  console.error(chalk.red("Error:"), err.message);
  process.exit(1);
});
