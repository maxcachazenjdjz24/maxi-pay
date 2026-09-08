const assert = require('assert');
const cryptoVault = require('../crypto-vault');

async function runTests() {
  console.log('🧪 ==========================================');
  console.log('🧪 MAXI SUITE ZERO-TRUST & VAULT TEST SUITE');
  console.log('🧪 ==========================================');

  // Test 1: Password Hashing & Verification
  console.log('\n[TEST 1]: PBKDF2 Password Hashing & Timing-Safe Verification...');
  const pass = 'SuperSecretPass123!';
  const { hash, salt } = cryptoVault.hashPassword(pass);
  assert(hash && salt, 'Password hash and salt must exist');
  assert(cryptoVault.verifyPassword(pass, hash, salt), 'Valid password must verify');
  assert(!cryptoVault.verifyPassword('WrongPass', hash, salt), 'Invalid password must fail');
  console.log('✅ Test 1 Passed: Password hashing and verification robust.');

  // Test 2: Encrypted Wallet Generation & secp256k1 Address Derivation
  console.log('\n[TEST 2]: Encrypted Wallet Generation & secp256k1 Parity...');
  const wallet = cryptoVault.generateNewEncryptedWallet();
  assert(wallet.address && wallet.address.startsWith('0x') && wallet.address.length === 42, 'Address must be 42-char hex string');
  assert(wallet.encryptedVault && wallet.encryptedVault.encrypted, 'Vault must have encrypted: true');
  assert(wallet.encryptedVault.ciphertext && wallet.encryptedVault.iv && wallet.encryptedVault.salt && wallet.encryptedVault.authTag, 'Vault must have AES-GCM components');
  
  // Decrypt and check parity
  const decryptedPk = cryptoVault.decryptPrivateKey(wallet.encryptedVault);
  assert.strictEqual(decryptedPk.toLowerCase(), wallet.ephemeralPrivateKey.toLowerCase(), 'Decrypted private key must match original');
  assert(cryptoVault.verifyKeyParity(wallet.address, decryptedPk), 'Key parity must be true for derived address');
  console.log('✅ Test 2 Passed: Wallet generated, AES-256-GCM encrypted, decrypted and parity verified.');

  // Test 3: Key Parity with Fake Address
  console.log('\n[TEST 3]: Parity mismatch detection (Anti-Hallucination)...');
  const fakeAddress = '0x355BAB72e5d6f5FF5ab46116C5beC522047f2004';
  const isParity = cryptoVault.verifyKeyParity(fakeAddress, decryptedPk);
  assert.strictEqual(isParity, false, 'Fake address must not match real private key');
  console.log('✅ Test 3 Passed: Parity mismatch correctly rejected.');

  console.log('\n🎉 ALL CRYPTO-VAULT & SECURITY TESTS PASSED PERFECTLY!\n');
}

runTests().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
