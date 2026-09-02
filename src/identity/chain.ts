/**
 * Chain Abstraction Layer (EVM only)
 *
 * Adaptado de Conway-Research/automaton (MIT license), simplificado para
 * usar solo EVM (Ethereum/Base) — se quitó el soporte dual EVM/Solana del
 * original ya que este agente no lo necesita.
 */

import type { PrivateKeyAccount } from "viem";

// ─── Chain Type ──────────────────────────────────────────────

export type ChainType = "evm";

// ─── Address Validation ──────────────────────────────────────

export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function isValidAddress(address: string): boolean {
  return isValidEvmAddress(address);
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

// ─── Chain Identity Interface ────────────────────────────────

/**
 * Identidad de cadena — envuelve una cuenta viem (EVM).
 */
export interface ChainIdentity {
  readonly chainType: ChainType;
  readonly address: string;
  signMessage(message: string): Promise<string>;
}

/**
 * EVM chain identity wrapping a viem PrivateKeyAccount.
 */
export class EvmChainIdentity implements ChainIdentity {
  readonly chainType: ChainType = "evm";
  readonly address: string;
  readonly account: PrivateKeyAccount;

  constructor(account: PrivateKeyAccount) {
    this.account = account;
    this.address = account.address;
  }

  async signMessage(message: string): Promise<string> {
    return this.account.signMessage({ message });
  }
}
