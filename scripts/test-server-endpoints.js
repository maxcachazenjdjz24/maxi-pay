const http = require('http');
const assert = require('assert');

// Spawn web-server in subprocess or import logic
async function runEndpointTests() {
  console.log('🧪 Testing Web Server Zero-Trust Authentication Security...');

  const serverProcess = require('child_process').spawn('node', ['web-server.js'], {
    cwd: 'd:/AUTOMATON/mi-automaton',
    env: { ...process.env, PORT: '3456', AUTOMATON_WALLET_PASSPHRASE: 'TestPassphrase2026!' },
    stdio: 'pipe'
  });

  serverProcess.stdout.on('data', d => {
    // console.log('[SERVER LOG]:', d.toString());
  });

  serverProcess.stderr.on('data', d => {
    // console.error('[SERVER ERR]:', d.toString());
  });

  // Wait for server to start
  await new Promise(r => setTimeout(r, 2000));

  try {
    // 1. Health check
    const healthRes = await fetch('http://127.0.0.1:3456/health');
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'ok', 'Health status should be ok');
    console.log('✅ /health is OK');

    // 2. Unauthenticated /api/user/wallet-data must return 401
    const unauthWalletRes = await fetch('http://127.0.0.1:3456/api/user/wallet-data');
    assert.strictEqual(unauthWalletRes.status, 401, 'Unauthenticated /api/user/wallet-data must return 401');
    console.log('✅ Unauthenticated /api/user/wallet-data returns 401 Unauthorized');

    // 3. Unauthenticated /api/user/generate-wallet must return 401
    const unauthGenRes = await fetch('http://127.0.0.1:3456/api/user/generate-wallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(unauthGenRes.status, 401, 'Unauthenticated /api/user/generate-wallet must return 401');
    console.log('✅ Unauthenticated /api/user/generate-wallet returns 401 Unauthorized');

    // 4. Unauthenticated /api/user/withdraw-to-nequi must return 401
    const unauthWthRes = await fetch('http://127.0.0.1:3456/api/user/withdraw-to-nequi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountUsd: 10 })
    });
    assert.strictEqual(unauthWthRes.status, 401, 'Unauthenticated /api/user/withdraw-to-nequi must return 401');
    console.log('✅ Unauthenticated /api/user/withdraw-to-nequi returns 401 Unauthorized');

    // 5. Register a new test user and verify encrypted vault & wallet
    const testEmail = `test_${Date.now()}@example.com`;
    const regRes = await fetch('http://127.0.0.1:3456/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Tester Zero Trust',
        email: testEmail,
        phone: '+573000000000',
        password: 'Password123!'
      })
    });
    const regData = await regRes.json();
    assert.strictEqual(regData.success, true, 'Registration should succeed');
    assert(regData.token, 'Token should be returned');
    assert(regData.user.wallet.startsWith('0x'), 'Wallet should be generated');
    assert.strictEqual(regData.user.hasVault, true, 'User should have vault');
    assert.strictEqual(regData.user.privateKey, undefined, 'Sanitized user DTO MUST NOT leak privateKey');
    assert.strictEqual(regData.user.encryptedVault, undefined, 'Sanitized user DTO MUST NOT leak encryptedVault');
    console.log('✅ User Registration with Zero-Leak Encrypted Vault succeeded');

    // 6. Authenticated /api/user/wallet-data with Bearer Token
    const authWalletRes = await fetch('http://127.0.0.1:3456/api/user/wallet-data', {
      headers: { 'Authorization': `Bearer ${regData.token}` }
    });
    const authWalletData = await authWalletRes.json();
    assert.strictEqual(authWalletData.success, true, 'Authenticated wallet data should succeed');
    assert.strictEqual(authWalletData.wallet.toLowerCase(), regData.user.wallet.toLowerCase(), 'Wallet address should match');
    console.log('✅ Authenticated /api/user/wallet-data with Bearer token succeeded');

    console.log('\n🎉 ALL ZERO-TRUST HTTP ENDPOINT TESTS PASSED WITH FLYING COLORS!\n');
  } finally {
    serverProcess.kill('SIGINT');
  }
}

runEndpointTests().catch(err => {
  console.error('❌ SERVER ENDPOINT TEST FAILED:', err);
  process.exit(1);
});
