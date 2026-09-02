/**
 * Automaton Wallet Management (EVM only)
 *
 * Adaptado de Conway-Research/automaton (MIT license). Cambios respecto
 * al original:
 * - Se quitó el soporte de Solana (solo EVM/Ethereum/Base).
 * - Se usa os.homedir() en vez de process.env.HOME || "/root", que en
 *   Windows resolvía siempre a una ruta inválida (bug confirmado en los
 *   issues #356/#376/#380 del repo original).
 * - La clave privada se cifra en reposo con AES-256-GCM usando una
 *   passphrase provista por variable de entorno (AUTOMATON_WALLET_PASSPHRASE),
 *   en vez de guardarse en texto plano.
 *
 * La clave privada ES la identidad soberana del agente — protegerla es
 * crítico.
 */

import crypto from "crypto";
import os from "os";
import fs from "fs";
import path from "path";
import type { PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EvmChainIdentity } from "./chain.js";
import type { ChainIdentity, ChainType } from "./chain.js";

const AUTOMATON_DIR = path.join(os.homedir(), ".automaton");
const WALLET_FILE = path.join(AUTOMATON_DIR, "wallet.json");

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

// ─── Cifrado en reposo ──────────────────────────────────────────

interface EncryptedPayload {
  encrypted: true;
  algorithm: "aes-256-gcm";
  salt: string; // hex
  iv: string; // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

function getPassphrase(): string {
  const passphrase = process.env.AUTOMATON_WALLET_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      "Falta la variable de entorno AUTOMATON_WALLET_PASSPHRASE. " +
        "Es la clave para cifrar/descifrar la wallet en disco — defínela " +
        "antes de generar o cargar la wallet, y guárdala en un lugar seguro " +
        "(no en el repositorio ni en el propio servidor sin cifrar).",
    );
  }
  return passphrase;
}

function encryptPrivateKey(privateKey: string): EncryptedPayload {
  const passphrase = getPassphrase();
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKey, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: true,
    algorithm: "aes-256-gcm",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

function decryptPrivateKey(payload: EncryptedPayload): string {
  const passphrase = getPassphrase();
  const salt = Buffer.from(payload.salt, "hex");
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = Buffer.from(payload.iv, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf-8");
}

interface WalletFile {
  chainType: ChainType;
  address: string;
  wallet: EncryptedPayload;
  createdAt: string;
}

// ─── API pública ─────────────────────────────────────────────────

/**
 * Obtiene la wallet existente, o crea una nueva si no existe todavía.
 * Requiere AUTOMATON_WALLET_PASSPHRASE en el entorno.
 */
export async function getWallet(): Promise<{
  account: PrivateKeyAccount;
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  isNew: boolean;
}> {
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(WALLET_FILE)) {
    const walletFile: WalletFile = JSON.parse(
      fs.readFileSync(WALLET_FILE, "utf-8"),
    );
    const privateKey = decryptPrivateKey(walletFile.wallet) as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    return {
      account,
      chainIdentity: new EvmChainIdentity(account),
      chainType: "evm",
      isNew: false,
    };
  }

  // Crear wallet nueva
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const walletFile: WalletFile = {
    chainType: "evm",
    address: account.address,
    wallet: encryptPrivateKey(privateKey),
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletFile, null, 2), {
    mode: 0o600,
  });

  return {
    account,
    chainIdentity: new EvmChainIdentity(account),
    chainType: "evm",
    isNew: true,
  };
}

/**
 * Devuelve la dirección pública sin necesidad de descifrar la clave privada
 * (no requiere passphrase). La dirección no es secreta.
 */
export function getWalletAddress(): string | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }
  const walletFile: WalletFile = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );
  return walletFile.address ?? null;
}

export function walletExists(): boolean {
  return fs.existsSync(WALLET_FILE);
}
