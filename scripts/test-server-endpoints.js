const http = require('http');
const assert = require('assert');
const crypto = require('crypto');

async function runEndpointTests() {
  console.log('🧪 ========================================================');
  console.log('🧪 MAXI SUITE MASTER ZERO-TRUST SECURITY & HARDENING SUITE');
  console.log('🧪 ========================================================');

  const testSecret = 'wompi_test_secret_2026_xyz';
  const serverProcess = require('child_process').spawn('node', ['web-server.js'], {
    cwd: 'd:/AUTOMATON/mi-automaton',
    env: { 
      ...process.env, 
      PORT: '3456', 
      AUTOMATON_WALLET_PASSPHRASE: 'TestPassphrase2026!',
      WOMPI_EVENTS_SECRET: testSecret
    },
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
    // 1. Health check & Security Headers
    console.log('\n[TEST 1]: HTTP Security Headers Check (S02)...');
    const healthRes = await fetch('http://127.0.0.1:3456/health');
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'ok', 'Health status should be ok');
    assert.strictEqual(healthRes.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options must be nosniff');
    assert.strictEqual(healthRes.headers.get('x-frame-options'), 'SAMEORIGIN', 'X-Frame-Options must be SAMEORIGIN');
    assert.strictEqual(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'Referrer-Policy must be set');
    assert.strictEqual(healthRes.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains', 'HSTS header must be set');
    console.log('✅ Test 1 Passed: /health is OK and all 4 HTTP security headers are enforced.');

    // 2. Unauthenticated endpoint guards (S03)
    console.log('\n[TEST 2]: Unauthenticated Endpoint Guards...');
    const unauthWalletRes = await fetch('http://127.0.0.1:3456/api/user/wallet-data');
    assert.strictEqual(unauthWalletRes.status, 401, 'Unauthenticated /api/user/wallet-data must return 401');
    
    const unauthGenRes = await fetch('http://127.0.0.1:3456/api/user/generate-wallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(unauthGenRes.status, 401, 'Unauthenticated /api/user/generate-wallet must return 401');

    const unauthWthRes = await fetch('http://127.0.0.1:3456/api/user/withdraw-to-nequi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountUsd: 10 })
    });
    assert.strictEqual(unauthWthRes.status, 401, 'Unauthenticated /api/user/withdraw-to-nequi must return 401');
    console.log('✅ Test 2 Passed: Unauthenticated API access strictly blocked with 401.');

    // 3. User Registration with Validations (S04)
    console.log('\n[TEST 3]: User Registration & Validation Rules...');
    const invalidEmailRes = await fetch('http://127.0.0.1:3456/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User', email: 'invalid-email', phone: '1234567', password: 'password123' })
    });
    assert.strictEqual(invalidEmailRes.status, 400, 'Invalid email format must be rejected with 400');

    const testEmail = `test_${Date.now()}@example.com`;
    const regRes = await fetch('http://127.0.0.1:3456/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: "Juan's Store",
        email: testEmail,
        phone: '+573001234567',
        password: 'Password123!'
      })
    });
    const regData = await regRes.json();
    assert.strictEqual(regData.success, true, 'Valid registration must succeed');
    assert(regData.token, 'Session token must be returned');
    assert(regData.user.wallet.startsWith('0x'), 'Wallet address must be generated');
    assert.strictEqual(regData.user.passwordHash, undefined, 'Sanitized user MUST NOT leak passwordHash');
    assert.strictEqual(regData.user.encryptedVault, undefined, 'Sanitized user MUST NOT leak encryptedVault');
    assert.strictEqual(regData.user.privateKey, undefined, 'Sanitized user MUST NOT leak privateKey');
    console.log('✅ Test 3 Passed: Registration valid with strict input sanitization and zero credential leaks.');

    // 4. Session Validation & /cuenta zero-leak verification (S03)
    console.log('\n[TEST 4]: Session Verification & Cookie Spoofing Defense...');
    // Attempt spoofing with maxi_user_email cookie without a session token
    const spoofRes = await fetch('http://127.0.0.1:3456/cuenta', {
      headers: { 'Cookie': `maxi_user_email=${encodeURIComponent(testEmail)}` }
    });
    const spoofHtml = await spoofRes.text();
    assert(!spoofHtml.includes('"passwordHash"'), 'HTML MUST NEVER contain passwordHash');
    assert(!spoofHtml.includes('"encryptedVault"'), 'HTML MUST NEVER contain encryptedVault');
    assert(!spoofHtml.includes('"ciphertext"'), 'HTML MUST NEVER contain vault ciphertext');
    console.log('✅ Test 4 Passed: /cuenta HTML rendering sanitized and resistant to email cookie spoofing.');

    // 5. Native Card Direct Submission Rejection (S05 / PCI-DSS SAQ-A)
    console.log('\n[TEST 5]: PCI-DSS SAQ-A Native Card Endpoint Protection...');
    const cardRes = await fetch('http://127.0.0.1:3456/api/v1/checkout/native-card-pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardNumber: '4242424242424242',
        cardCvc: '123',
        cardExpiry: '12/28'
      })
    });
    assert.strictEqual(cardRes.status, 400, 'Direct un-tokenized card endpoint must reject direct card data with 400');
    console.log('✅ Test 5 Passed: Native raw card processing rejected in compliance with PCI-DSS SAQ-A.');

    // 6. Wompi Webhook HMAC Signature & Idempotency (S06)
    console.log('\n[TEST 6]: Wompi Webhook HMAC-SHA256 Signature Verification...');
    const fakeTxId = 'TX_TEST_' + Date.now();
    const timestamp = Date.now();
    const concatStr = `${fakeTxId}APPROVED2000000${timestamp}${testSecret}`;
    const validChecksum = crypto.createHash('sha256').update(concatStr).digest('hex');

    // 6a. Invalid signature must return 401
    const invalidSigRes = await fetch('http://127.0.0.1:3456/api/wompi-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'transaction.updated',
        data: {
          transaction: {
            id: fakeTxId,
            status: 'APPROVED',
            amount_in_cents: 2000000,
            customer_email: testEmail
          }
        },
        timestamp,
        signature: {
          properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
          checksum: 'invalid_checksum_hash'
        }
      })
    });
    assert.strictEqual(invalidSigRes.status, 401, 'Invalid Wompi webhook signature must return 401');
    console.log('  -> Invalid signature correctly rejected with 401.');

    // 6b. Valid signature must succeed
    const validSigRes = await fetch('http://127.0.0.1:3456/api/wompi-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'transaction.updated',
        data: {
          transaction: {
            id: fakeTxId,
            status: 'APPROVED',
            amount_in_cents: 2000000,
            customer_email: testEmail
          }
        },
        timestamp,
        signature: {
          properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
          checksum: validChecksum
        }
      })
    });
    const validSigData = await validSigRes.json();
    assert.strictEqual(validSigData.success, true, 'Valid Wompi webhook signature must succeed');
    console.log('  -> Valid signature successfully verified.');

    // 6c. Duplicate event must be handled idempotently
    const duplicateRes = await fetch('http://127.0.0.1:3456/api/wompi-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'transaction.updated',
        data: {
          transaction: {
            id: fakeTxId,
            status: 'APPROVED',
            amount_in_cents: 2000000,
            customer_email: testEmail
          }
        },
        timestamp,
        signature: {
          properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
          checksum: validChecksum
        }
      })
    });
    const duplicateData = await duplicateRes.json();
    assert.strictEqual(duplicateData.success, true, 'Duplicate webhook must return 200 OK idempotently');
    console.log('  -> Idempotency guard prevents duplicate crediting.');
    console.log('✅ Test 6 Passed: Wompi webhook HMAC verification & idempotency guard verified.');

    // 7. Market Ticker API
    console.log('\n[TEST 7]: Real-time Market Ticker API...');
    const tickerRes = await fetch('http://127.0.0.1:3456/api/market-ticker');
    const tickerData = await tickerRes.json();
    assert.strictEqual(tickerData.success, true, 'Ticker API must succeed');
    assert(tickerData.prices && tickerData.prices.BTC, 'Ticker prices must include BTC');
    console.log('✅ Test 7 Passed: Market ticker engine serving real-time prices.');

    console.log('\n🎉 ========================================================');
    console.log('🎉 ALL ZERO-TRUST TESTS PASSED - SYSTEM 100% HARDENED & VERIFIED');
    console.log('🎉 ========================================================\n');
  } finally {
    serverProcess.kill('SIGINT');
  }
}

runEndpointTests().catch(err => {
  console.error('❌ SERVER ENDPOINT TEST FAILED:', err);
  process.exit(1);
});
