/**
 * Secure Settlement Dispatcher (Zero Hardcoded Secrets)
 * 
 * Carga la clave privada en memoria descifrándola de ~/.automaton/wallet.json
 * usando process.env.AUTOMATON_WALLET_PASSPHRASE.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base } = require('viem/chains');

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function loadTreasuryAccount() {
  const passphrase = process.env.AUTOMATON_WALLET_PASSPHRASE || process.env.MAXI_VAULT_PASSPHRASE;
  if (!passphrase) {
    throw new Error('AUTOMATON_WALLET_PASSPHRASE no configurada en las variables de entorno.');
  }
  const walletPath = path.join(os.homedir(), '.automaton', 'wallet.json');
  if (!fs.existsSync(walletPath)) {
    throw new Error('No se encontró el archivo de billetera en ~/.automaton/wallet.json');
  }

  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const payload = walletData.wallet;
  const salt = Buffer.from(payload.salt, 'hex');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = Buffer.from(payload.iv, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  
  const privateKey = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'hex')),
    decipher.final()
  ]).toString('utf-8');

  return privateKeyToAccount(privateKey);
}

const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
]);

async function dispatchUsdc(recipientWallet, amountUsdc) {
  const account = loadTreasuryAccount();
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });

  console.log('🏛️ Billetera Maestra (Tesorería):', account.address);
  console.log('👤 Billetera Destino:', recipientWallet);

  const ethBalance = await publicClient.getBalance({ address: account.address });
  const usdcBalance = await publicClient.readContract({
    address: USDC_CONTRACT,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [account.address]
  });

  console.log('⛽ Saldo Gas (ETH):', formatUnits(ethBalance, 18), 'ETH');
  console.log('💵 Saldo USDC:', formatUnits(usdcBalance, 6), 'USDC');

  if (ethBalance === 0n) {
    return { error: 'NO_GAS', message: 'La tesorería necesita micro-gas en Base L2.' };
  }

  if (usdcBalance < parseUnits(amountUsdc.toString(), 6)) {
    return { error: 'INSUFFICIENT_USDC', message: 'Saldo insuficiente de USDC.' };
  }

  console.log(`🚀 Despachando ${amountUsdc} USDC a ${recipientWallet}...`);
  const hash = await walletClient.writeContract({
    address: USDC_CONTRACT,
    abi: usdcAbi,
    functionName: 'transfer',
    args: [recipientWallet, parseUnits(amountUsdc.toString(), 6)]
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('✅ ¡Transacción confirmada en bloque!', receipt.blockNumber);

  return { success: true, hash, blockNumber: receipt.blockNumber };
}

module.exports = { loadTreasuryAccount, dispatchUsdc };
