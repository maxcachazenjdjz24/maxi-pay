/**
 * On-chain Payments (EVM / Base)
 *
 * Módulo nuevo (no existía en el original — Conway manejaba esto vía su
 * propio backend de créditos). Transferencias reales en Base usando viem:
 * ETH nativo y USDC (ERC-20). Pensado para montos pequeños ($1-$10),
 * siempre bajo los límites de agent/spend-tracker.ts.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base } from "viem/chains";

// Dirección oficial del contrato USDC en Base mainnet.
const USDC_ADDRESS_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function getRpcUrl(): string {
  return process.env.AUTOMATON_RPC_URL || "https://mainnet.base.org";
}

function getPublicClient() {
  return createPublicClient({ chain: base, transport: http(getRpcUrl()) });
}

function getWalletClient(account: PrivateKeyAccount) {
  return createWalletClient({ account, chain: base, transport: http(getRpcUrl()) });
}

/**
 * Balance de USDC de una dirección, en dólares (no centavos).
 */
export async function getUsdcBalance(address: Address): Promise<number> {
  const client = getPublicClient();
  const raw = await client.readContract({
    address: USDC_ADDRESS_BASE,
    abi: ERC20_TRANSFER_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return Number(formatUnits(raw as bigint, USDC_DECIMALS));
}

/**
 * Balance de ETH nativo (para gas), en ETH.
 */
export async function getEthBalance(address: Address): Promise<number> {
  const client = getPublicClient();
  const raw = await client.getBalance({ address });
  return Number(formatUnits(raw, 18));
}

/**
 * Transferir USDC a una dirección. amountUsd es en dólares (ej. 0.50 = 50 centavos).
 * Requiere que la wallet tenga algo de ETH para pagar el gas de la transacción.
 */
export async function transferUsdc(
  account: PrivateKeyAccount,
  toAddress: Address,
  amountUsd: number,
): Promise<{ txHash: string }> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(`Invalid amount: ${amountUsd}`);
  }

  const walletClient = getWalletClient(account);
  const amountRaw = parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  const txHash = await walletClient.writeContract({
    address: USDC_ADDRESS_BASE,
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [toAddress, amountRaw],
  });

  return { txHash };
}

export function isValidBaseAddress(address: string): address is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
