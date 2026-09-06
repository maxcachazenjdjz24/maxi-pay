const { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base } = require('viem/chains');

const RPC_URL = 'https://mainnet.base.org';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TREASURY_PK = '0x36d4d459878f891c378b285eaa68b6d08e7abbc377521564246095b6dad54e92';
const MERCHANT_WALLET = '0x355BAB72e5d6f5FF5ab46116C5beC522047f2004';
const AMOUNT_USDC = 20.00;

const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
]);

async function main() {
  const account = privateKeyToAccount(TREASURY_PK);
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });

  console.log('🏛️ Treasury Address:', account.address);
  console.log('👤 Merchant Address:', MERCHANT_WALLET);

  const ethBalance = await publicClient.getBalance({ address: account.address });
  const usdcBalance = await publicClient.readContract({
    address: USDC_CONTRACT,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [account.address]
  });

  console.log('⛽ Gas (ETH):', formatUnits(ethBalance, 18), 'ETH');
  console.log('💵 USDC Balance:', formatUnits(usdcBalance, 6), 'USDC');

  if (ethBalance === 0n) {
    console.log('⚠️ ALERTA: La tesorería necesita una fracción de ETH para pagar el gas en Base L2 (~.02 USD).');
    return { error: 'NO_GAS', ethBalance: 0 };
  }

  if (usdcBalance < parseUnits(AMOUNT_USDC.toString(), 6)) {
    console.log('⚠️ Saldo insuficiente de USDC en la tesorería.');
    return { error: 'INSUFFICIENT_USDC', usdcBalance: formatUnits(usdcBalance, 6) };
  }

  console.log('🚀 Despachando ' + AMOUNT_USDC + ' USDC a ' + MERCHANT_WALLET + '...');
  const hash = await walletClient.writeContract({
    address: USDC_CONTRACT,
    abi: usdcAbi,
    functionName: 'transfer',
    args: [MERCHANT_WALLET, parseUnits(AMOUNT_USDC.toString(), 6)]
  });

  console.log('⏳ Transacción enviada a Base L2. Tx Hash:', hash);
  console.log('🔍 BaseScan URL: https://basescan.org/tx/' + hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('✅ ¡Transacción confirmada en bloque!', receipt.blockNumber);

  return { success: true, hash, blockNumber: receipt.blockNumber };
}

if (require.main === module) {
  main().catch(err => console.error('Error:', err));
}

module.exports = { main };
