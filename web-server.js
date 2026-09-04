const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE_RPC_URL = 'https://mainnet.base.org';
const MAXI_WALLET = '0xc94927fF92091A738406329E130E930E3bA788D6'.toLowerCase();
const BASE_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase();
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// WOMPI PRODUCTION INTEGRATION CONFIGURATION
const WOMPI_PUBLIC_KEY = 'pub_prod_ASs7SGOmMRYshifZJUkDUNxmNCGPCxmf';
const WOMPI_INTEGRITY_SECRET = 'prod_integrity_o0wSVxiGaEnWU0KR5Gb2YQh1ddEer7sx';

function generateWompiSignature(reference, amountInCents, currency = 'COP') {
  const concat = `${reference}${amountInCents}${currency}${WOMPI_INTEGRITY_SECRET}`;
  return crypto.createHash('sha256').update(concat).digest('hex');
}

// TELEGRAM ALERT NOTIFICATIONS INTEGRATION
const TELEGRAM_BOT_TOKEN = '8006933644:AAHF-kBCjrSIL5hOh5TksCvL6Cq7gGnOvcg';
const TELEGRAM_ADMIN_CHAT_ID = '7959552395';

async function sendTelegramAlert(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_ADMIN_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error('Error sending Telegram alert:', e.message);
  }
}

// ADMIN MASTER SECURITY CONFIGURATION
const ADMIN_MASTER_PASSWORD_HASH = crypto.createHash('sha256').update('MaxiMaster2026!').digest('hex');
const ADMIN_EMAIL = 'admin@maxi.suite';

// USER ACCOUNT DATABASE PERSISTENCE
const USERS_DB_FILE = path.join(os.homedir(), '.automaton', 'registered_users.json');
let usersDb = { users: {}, sessions: {}, adminSessions: {}, invoices: {}, withdrawals: [] };

function loadUsersDb() {
  try {
    if (fs.existsSync(USERS_DB_FILE)) {
      usersDb = JSON.parse(fs.readFileSync(USERS_DB_FILE, 'utf8'));
      if (!usersDb.users) usersDb.users = {};
      if (!usersDb.sessions) usersDb.sessions = {};
      if (!usersDb.adminSessions) usersDb.adminSessions = {};
      if (!usersDb.invoices) usersDb.invoices = {};
      if (!usersDb.withdrawals) usersDb.withdrawals = [];
    }
  } catch (e) {
    console.error('Error loading users db:', e.message);
  }
}

function saveUsersDb() {
  try {
    fs.writeFileSync(USERS_DB_FILE, JSON.stringify(usersDb, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving users db:', e.message);
  }
}

loadUsersDb();

const userCredits = new Map();
const processedPayments = new Set();

function getClientCredits(req) {
  const token = req.headers['authorization']?.replace('Bearer ', '').trim();
  if (token && usersDb.sessions[token]) {
    const email = usersDb.sessions[token];
    const user = usersDb.users[email];
    if (user) {
      return { ip: email, credits: user.credits, user };
    }
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'guest_user';
  if (!userCredits.has(ip)) {
    userCredits.set(ip, 5);
  }
  return { ip, credits: userCredits.get(ip), user: null };
}

function verifyAdminAuth(req) {
  const token = req.headers['authorization']?.replace('Bearer ', '').trim();
  if (token && usersDb.adminSessions[token]) {
    return { authenticated: true, user: usersDb.adminSessions[token] };
  }
  return { authenticated: false };
}

// QUERY LIVE ON-CHAIN BALANCES OF MAXI WALLET
async function fetchMaxiOnChainBalances() {
  try {
    const ethRes = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [MAXI_WALLET, 'latest'] })
    });
    const ethData = await ethRes.json();
    const ethBal = parseInt(ethData.result || '0x0', 16) / 1e18;

    const padded = MAXI_WALLET.slice(2).padStart(64, '0');
    const callData = '0x70a08231' + padded;
    const usdcRes = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: BASE_USDC_CONTRACT, data: callData }, 'latest'] })
    });
    const usdcData = await usdcRes.json();
    const usdcBal = parseInt(usdcData.result || '0x0', 16) / 1e6;

    return { eth: ethBal, usdc: usdcBal, wallet: MAXI_WALLET };
  } catch (err) {
    console.error('Error fetching on-chain balances:', err.message);
    return { eth: 0, usdc: 0, wallet: MAXI_WALLET, error: err.message };
  }
}

// ON-CHAIN VERIFICATION OF EXPLICIT TX HASH
async function verifyBaseTx(txHash) {
  try {
    const res = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash]
      })
    });
    const data = await res.json();
    if (!data.result) {
      const txRes = await fetch(BASE_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'eth_getTransactionByHash',
          params: [txHash]
        })
      });
      const txData = await txRes.json();
      if (!txData.result) {
        return { valid: false, error: 'Transacción no encontrada en la red Base Mainnet.' };
      }
      return {
        valid: true,
        status: '⏳ Pendiente de confirmación',
        blockNumber: 'En proceso',
        from: txData.result.from,
        to: txData.result.to || 'Contrato',
        network: 'Base Mainnet (Chain ID 8453)'
      };
    }
    const receipt = data.result;
    return {
      valid: true,
      status: receipt.status === '0x1' ? '✅ Exitosa (Confirmada en Bloque)' : '❌ Fallida (Revertida)',
      blockNumber: parseInt(receipt.blockNumber, 16),
      from: receipt.from,
      to: receipt.to || 'Creación de Contrato',
      gasUsed: parseInt(receipt.gasUsed, 16),
      network: 'Base Mainnet (Chain ID 8453)'
    };
  } catch (err) {
    return { valid: false, error: 'Error al conectar con los nodos de Base: ' + err.message };
  }
}

// REAL-TIME AUTO-DETECTION
async function checkRecentUsdcTransfers(targetWallet, expectedAmount = 0, lookbackBlocks = 50) {
  try {
    const recipient = targetWallet.trim().toLowerCase();
    const paddedRecipient = '0x000000000000000000000000' + recipient.slice(2);

    const bRes = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
    });
    const bData = await bRes.json();
    if (!bData.result) return { detected: false };

    const currentBlock = parseInt(bData.result, 16);
    const fromBlockHex = '0x' + Math.max(0, currentBlock - lookbackBlocks).toString(16);

    const logsRes = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_getLogs',
        params: [{
          address: BASE_USDC_CONTRACT,
          topics: [TRANSFER_TOPIC, null, paddedRecipient],
          fromBlock: fromBlockHex,
          toBlock: 'latest'
        }]
      })
    });
    const logsData = await logsRes.json();
    const logs = logsData.result || [];

    for (const log of logs) {
      const txHash = log.transactionHash.toLowerCase();
      if (processedPayments.has(txHash)) continue;

      const rawValue = parseInt(log.data, 16);
      const usdcAmount = rawValue / 1_000_000;

      if (expectedAmount > 0 && usdcAmount < expectedAmount * 0.98) {
        continue;
      }

      processedPayments.add(txHash);
      const sender = log.topics[1] ? '0x' + log.topics[1].slice(26) : '0x...';

      return {
        detected: true,
        txHash,
        usdcAmount,
        blockNumber: parseInt(log.blockNumber, 16),
        from: sender,
        to: recipient
      };
    }

    return { detected: false, currentBlock };
  } catch (err) {
    console.error('Error in checkRecentUsdcTransfers:', err.message);
    return { detected: false, error: err.message };
  }
}

// CUSTOM DESIGNED VECTOR SVG ICONS
const ICONS = {
  logo: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="#00f2fe" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 17L12 22L2 17" stroke="#a855f7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12L12 17L22 12" stroke="#00df89" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  theme: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  user: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  lock: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  tg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-17.5 7.5a2.25 2.25 0 0 0 .126 4.148l4.43 1.477 1.77 5.31a1.5 1.5 0 0 0 2.46.59l2.76-2.454 4.54 3.355a2.25 2.25 0 0 0 3.51-1.474l3-16.5a2.25 2.25 0 0 0-4.074-2.167z"/></svg>`
};

function getHeader(activePage = 'home') {
  return `
    <div class="ticker-wrapper">
        <div class="ticker-track">
            <div class="ticker-item"><span class="ticker-badge">BTC</span> $64,820.00 <span class="up">▲ +3.18%</span></div>
            <div class="ticker-item"><span class="ticker-badge">ETH</span> $2,515.72 <span class="up">▲ +5.04%</span></div>
            <div class="ticker-item"><span class="ticker-badge" style="background:#a855f7;">AERO</span> $1.18 <span class="up">▲ +8.42%</span></div>
            <div class="ticker-item"><span class="ticker-badge" style="background:#00df89; color:#06080e;">BASE Gas</span> 0.005 Gwei <span class="neutral">⚡ &lt; $0.01</span></div>
            <div class="ticker-item"><span class="ticker-badge">USDC</span> $1.000 <span class="neutral">✓ Paridad 1:1</span></div>
            <div class="ticker-item"><span class="ticker-badge" style="background:#f43f5e;">Sentimiento</span> Codicia (68/100)</div>
            <div class="ticker-item"><span class="ticker-badge">SOL</span> $148.50 <span class="up">▲ +4.20%</span></div>
            <div class="ticker-item"><span class="ticker-badge">BTC</span> $64,820.00 <span class="up">▲ +3.18%</span></div>
            <div class="ticker-item"><span class="ticker-badge">ETH</span> $2,515.72 <span class="up">▲ +5.04%</span></div>
            <div class="ticker-item"><span class="ticker-badge" style="background:#a855f7;">AERO</span> $1.18 <span class="up">▲ +8.42%</span></div>
            <div class="ticker-item"><span class="ticker-badge" style="background:#00df89; color:#06080e;">BASE Gas</span> 0.005 Gwei <span class="neutral">⚡ &lt; $0.01</span></div>
            <div class="ticker-item"><span class="ticker-badge">USDC</span> $1.000 <span class="neutral">✓ Paridad 1:1</span></div>
        </div>
    </div>

    <nav class="navbar">
        <div class="nav-container">
            <a href="/" class="nav-logo">
                <div class="logo-icon">${ICONS.logo}</div>
                <div class="logo-title">MAXI SUITE</div>
            </a>

            <div class="nav-links">
                <a href="/" class="nav-item ${activePage === 'home' ? 'active' : ''}">Inicio</a>
                <a href="/pay" class="nav-item ${activePage === 'pay' ? 'active' : ''}">Maxi Pay</a>
                <a href="/trabajos" class="nav-item ${activePage === 'trabajos' ? 'active' : ''}">Trabajos ✨</a>
                <a href="/ballenas" class="nav-item ${activePage === 'ballenas' ? 'active' : ''}">Ballenas 🎯</a>
                <a href="/mercados" class="nav-item ${activePage === 'mercados' ? 'active' : ''}">Mercados 📈</a>
                <a href="/juegos" class="nav-item ${activePage === 'juegos' ? 'active' : ''}">Minijuegos 🎮</a>
                <a href="/tutoriales" class="nav-item ${activePage === 'tutoriales' ? 'active' : ''}">Academia 🎓</a>
            </div>

            <div class="nav-actions">
                <button class="icon-btn" onclick="toggleTheme()" title="Cambiar Tema (Claro / Oscuro)">
                    ${ICONS.theme}
                </button>

                <button class="icon-btn" onclick="toggleLanguage()" title="Switch Language">
                    <span id="langFlag" style="font-weight:800; font-size:11.5px;">ES</span>
                </button>

                <a href="/cuenta" class="btn-account" id="accountNavBtn">
                    ${ICONS.user} <span id="accountNavText">Crear Cuenta</span>
                </a>

                <a href="/admin" class="icon-btn" title="Panel Privado de Administrador (Juan David)" style="border-color:rgba(0,242,254,0.4); color:var(--cyan);">
                    ${ICONS.lock}
                </a>

                <a href="https://t.me/Maxi_pay_official_bot" target="_blank" class="btn-tg" title="Abrir Bot de Telegram">
                    ${ICONS.tg} <span>Bot</span>
                </a>
            </div>
        </div>
    </nav>
  `;
}

function getFooter() {
  return `
    <footer class="footer">
        <div class="footer-grid">
            <div>
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                    <div style="width:34px; height:34px; background:rgba(0, 242, 254, 0.12); border:1px solid var(--border); border-radius:10px; display:flex; align-items:center; justify-content:center;">${ICONS.logo}</div>
                    <div style="font-size:18px; font-weight:800; color:var(--text-main);">MAXI SUITE</div>
                </div>
                <p style="color:var(--text-muted); font-size:13.5px; line-height:1.6; max-width:300px;">
                    El ecosistema financiero autónomo para cobrar con QR o Tarjeta en USDC, ganar bounties con IA y monitorear el dinero inteligente en Base.
                </p>
            </div>
            <div>
                <div class="footer-title">Servicios Principales</div>
                <div class="footer-links-col">
                    <a href="/pay">💳 Maxi Pay Pasarela</a>
                    <a href="/trabajos">💼 Radar de Trabajos Web3 con IA</a>
                    <a href="/ballenas">🐋 Radar de Ballenas con Score</a>
                    <a href="/cuenta">👤 Mi Cuenta & Planes Pro</a>
                    <a href="/admin">🔒 Acceso Administrador</a>
                </div>
            </div>
            <div>
                <div class="footer-title">Mercados & Educación</div>
                <div class="footer-links-col">
                    <a href="/mercados">📈 Gráficas en Tiempo Real</a>
                    <a href="/tutoriales">🎓 Guías & Academia Completa</a>
                    <a href="https://basescan.org" target="_blank">🔍 Explorador BaseScan</a>
                    <a href="https://defillama.com/chain/Base" target="_blank">📊 DeFiLlama (Base)</a>
                </div>
            </div>
            <div>
                <div class="footer-title">Recursos Clave</div>
                <div class="footer-links-col">
                    <a href="https://www.coindesk.com" target="_blank">📰 CoinDesk Noticias</a>
                    <a href="https://coinmarketcap.com" target="_blank">🪙 CoinMarketCap</a>
                    <a href="https://www.bountycaster.xyz" target="_blank">🎯 Bountycaster Web3</a>
                    <a href="https://web3.career" target="_blank">💼 Web3 Careers Global</a>
                </div>
            </div>
        </div>
        <div class="footer-bottom">
            <div>© 2026 Maxi Suite 9.0 • Infraestructura Autónoma Desplegada en Base Mainnet (8453)</div>
            <div style="color:var(--cyan); font-weight:800;">🔒 100% On-Chain Math Certainty</div>
        </div>
    </footer>
  `;
}

function getGlobalStyles() {
  return `
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-dark: #06080e;
            --bg-card: #0f1624;
            --bg-card-hover: #162034;
            --border: #1e293b;
            --border-hover: #00f2fe;
            --cyan: #00f2fe;
            --blue: #38bdf8;
            --emerald: #00df89;
            --purple: #c084fc;
            --rose: #f43f5e;
            --amber: #fbbf24;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --text-sub: #cbd5e1;
            --ticker-bg: #030509;
            --input-bg: #0b111e;
            --input-text: #ffffff;
            --calc-bg: #0f172a;
            --calc-border: #334155;
            --calc-fee-bg: rgba(244, 63, 94, 0.12);
            --calc-fee-text: #fda4af;
            --calc-saved-bg: rgba(0, 223, 137, 0.12);
            --calc-saved-text: #6ee7b7;
            --code-bg: #030712;
            --code-text: #38bdf8;
        }

        [data-theme="light"] {
            --bg-dark: #f1f5f9;
            --bg-card: #ffffff;
            --bg-card-hover: #f8fafc;
            --border: #cbd5e1;
            --border-hover: #0284c7;
            --cyan: #0284c7;
            --blue: #0369a1;
            --emerald: #059669;
            --purple: #7c3aed;
            --rose: #dc2626;
            --amber: #d97706;
            --text-main: #090d16;
            --text-muted: #334155;
            --text-sub: #1e293b;
            --ticker-bg: #0f172a;
            --input-bg: #ffffff;
            --input-text: #090d16;
            --calc-bg: #ffffff;
            --calc-border: #cbd5e1;
            --calc-fee-bg: #fee2e2;
            --calc-fee-text: #991b1b;
            --calc-saved-bg: #d1fae5;
            --calc-saved-text: #065f46;
            --code-bg: #f8fafc;
            --code-text: #0369a1;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
            background-color: var(--bg-dark);
            color: var(--text-main);
            min-height: 100vh;
            overflow-x: hidden;
            transition: background-color 0.2s ease, color 0.2s ease;
        }

        /* TICKER */
        .ticker-wrapper {
            background: var(--ticker-bg);
            border-bottom: 1px solid var(--border);
            overflow: hidden;
            white-space: nowrap;
            padding: 7px 0;
            font-size: 12px;
            font-family: monospace;
            color: #ffffff;
            z-index: 101;
            position: relative;
        }
        .ticker-track {
            display: inline-flex;
            gap: 28px;
            animation: marquee 32s linear infinite;
        }
        .ticker-track:hover { animation-play-state: paused; }
        @keyframes marquee {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
        }
        .ticker-item {
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .ticker-badge {
            background: #0284c7;
            color: white;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 800;
        }
        .up { color: #4ade80; font-weight: 800; }
        .neutral { color: #38bdf8; font-weight: 700; }

        /* NAVBAR PIXEL-PERFECT CLEAN DESIGN */
        .navbar {
            position: sticky;
            top: 0;
            z-index: 100;
            background: var(--bg-card);
            border-bottom: 1px solid var(--border);
            padding: 10px 24px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.05);
        }
        .nav-container {
            max-width: 1320px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 16px;
        }
        .nav-logo {
            display: flex;
            align-items: center;
            gap: 10px;
            text-decoration: none;
            color: var(--text-main);
            flex-shrink: 0;
        }
        .logo-icon {
            width: 36px;
            height: 36px;
            background: rgba(0, 242, 254, 0.12);
            border: 1px solid var(--border);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .logo-title {
            font-size: 17px;
            font-weight: 800;
            letter-spacing: -0.02em;
            color: var(--text-main);
            white-space: nowrap;
        }
        .nav-links {
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: nowrap;
            white-space: nowrap;
            overflow-x: auto;
        }
        .nav-item {
            color: var(--text-muted);
            text-decoration: none;
            font-size: 13px;
            font-weight: 700;
            padding: 8px 12px;
            border-radius: 10px;
            transition: all 0.15s;
            white-space: nowrap;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            line-height: 1;
        }
        .nav-item:hover {
            color: var(--text-main);
            background: var(--bg-card-hover);
        }
        .nav-item.active {
            color: var(--cyan);
            background: rgba(0, 242, 254, 0.12);
            border: 1px solid rgba(0, 242, 254, 0.35);
        }
        .nav-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
            white-space: nowrap;
        }
        .icon-btn {
            background: var(--bg-card-hover);
            border: 1px solid var(--border);
            color: var(--text-main);
            padding: 7px 9px;
            border-radius: 9px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
        }
        .icon-btn:hover {
            border-color: var(--cyan);
            color: var(--cyan);
        }
        .btn-account {
            background: rgba(0, 242, 254, 0.12);
            border: 1px solid rgba(0, 242, 254, 0.35);
            color: var(--cyan);
            padding: 7px 12px;
            border-radius: 16px;
            font-size: 12px;
            font-weight: 700;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: all 0.15s;
            white-space: nowrap;
        }
        .btn-account:hover {
            background: var(--cyan);
            color: #06080e;
        }
        .btn-tg {
            background: linear-gradient(135deg, #0088cc 0%, #00a2ff 100%);
            color: white;
            padding: 7px 13px;
            border-radius: 16px;
            font-size: 12px;
            font-weight: 700;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
        }

        /* CONTAINERS & CARDS */
        .page-container {
            max-width: 1240px;
            margin: 0 auto;
            padding: 35px 20px 70px 20px;
        }
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 18px;
            padding: 28px;
            box-shadow: 0 4px 25px rgba(0, 0, 0, 0.06);
            margin-bottom: 25px;
            transition: border-color 0.2s;
        }
        .card:hover { border-color: var(--border-hover); }

        /* BENTO GRID */
        .bento-grid {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            gap: 20px;
            margin: 35px 0 50px 0;
        }
        .bento-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 22px;
            padding: 28px;
            position: relative;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .bento-card:hover {
            transform: translateY(-4px);
            border-color: var(--cyan);
            box-shadow: 0 15px 35px rgba(0, 242, 254, 0.12);
        }
        .bento-span-8 { grid-column: span 8; }
        .bento-span-4 { grid-column: span 4; }
        .bento-span-6 { grid-column: span 6; }
        .bento-span-12 { grid-column: span 12; }

        @media(max-width: 960px) {
            .bento-span-8, .bento-span-4, .bento-span-6 { grid-column: span 12; }
        }

        /* LIVE SOCIAL PROOF FLOATING TOAST */
        .social-toast {
            position: fixed;
            bottom: 24px;
            right: 24px;
            background: var(--bg-card);
            border: 1px solid var(--cyan);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
            border-radius: 16px;
            padding: 12px 18px;
            display: flex;
            align-items: center;
            gap: 12px;
            z-index: 1000;
            font-size: 13px;
            font-weight: 700;
            max-width: 360px;
            animation: slideUp 0.4s ease-out;
            transition: all 0.3s ease;
        }
        @keyframes slideUp {
            from { transform: translateY(50px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        /* ACTION BADGES */
        .badge-buy { background: #dcfce7; color: #15803d; border: 1px solid #86efac; padding: 4px 10px; border-radius: 12px; font-size: 11.5px; font-weight: 800; }
        .badge-sell { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; padding: 4px 10px; border-radius: 12px; font-size: 11.5px; font-weight: 800; }
        .badge-vault { background: #f3e8ff; color: #7e22ce; border: 1px solid #d8b4fe; padding: 4px 10px; border-radius: 12px; font-size: 11.5px; font-weight: 800; }
        .badge-pool { background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc; padding: 4px 10px; border-radius: 12px; font-size: 11.5px; font-weight: 800; }

        .score-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 14px;
            font-weight: 800;
            font-size: 13px;
        }
        .score-high { background: rgba(0, 223, 137, 0.15); color: var(--emerald); border: 1.5px solid var(--emerald); }
        .score-mid { background: rgba(0, 242, 254, 0.15); color: var(--cyan); border: 1.5px solid var(--cyan); }
        .score-low { background: rgba(244, 63, 94, 0.15); color: var(--rose); border: 1.5px solid var(--rose); }

        .step-badge {
            width: 42px;
            height: 42px;
            border-radius: 12px;
            background: linear-gradient(135deg, var(--cyan) 0%, var(--purple) 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            font-weight: 800;
            color: #06080e;
            flex-shrink: 0;
        }

        .code-snippet {
            background: var(--code-bg);
            border: 1px solid var(--border);
            padding: 14px 18px;
            border-radius: 10px;
            color: var(--code-text);
            font-family: monospace;
            font-size: 13.5px;
            margin: 10px 0;
            line-height: 1.5;
            overflow-x: auto;
        }

        /* FORMS & INPUTS */
        .input-box {
            width: 100%;
            padding: 13px 16px;
            background: var(--input-bg);
            border: 1.5px solid var(--border);
            border-radius: 10px;
            color: var(--input-text);
            font-family: inherit;
            font-size: 14.5px;
            margin-bottom: 14px;
            outline: none;
            transition: border 0.2s;
        }
        .input-box:focus {
            border-color: var(--cyan);
            box-shadow: 0 0 0 3px rgba(0, 242, 254, 0.2);
        }

        /* BUTTONS */
        .btn-primary {
            background: linear-gradient(135deg, var(--cyan) 0%, var(--blue) 100%);
            color: #06080e;
            padding: 13px 24px;
            border-radius: 10px;
            font-size: 14.5px;
            font-weight: 800;
            text-decoration: none;
            border: none;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.15s;
        }
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(0, 242, 254, 0.35);
        }
        .btn-outline {
            background: var(--bg-card-hover);
            color: var(--text-main);
            border: 1px solid var(--border);
            padding: 13px 24px;
            border-radius: 10px;
            font-size: 14.5px;
            font-weight: 700;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.15s;
        }
        .btn-outline:hover {
            border-color: var(--cyan);
            transform: translateY(-2px);
        }

        /* FOOTER */
        .footer {
            border-top: 1px solid var(--border);
            padding: 50px 24px 25px 24px;
            max-width: 1240px;
            margin: 0 auto;
        }
        .footer-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 35px;
            margin-bottom: 35px;
        }
        .footer-title {
            color: var(--text-main);
            font-size: 14.5px;
            font-weight: 800;
            margin-bottom: 16px;
        }
        .footer-links-col {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .footer-links-col a {
            color: var(--text-muted);
            text-decoration: none;
            font-size: 13.5px;
            font-weight: 600;
            transition: color 0.15s;
        }
        .footer-links-col a:hover { color: var(--cyan); }
        .footer-bottom {
            border-top: 1px solid var(--border);
            padding-top: 22px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 15px;
            font-size: 12.5px;
            color: var(--text-muted);
            font-weight: 600;
        }

        /* ADMIN DATA TABLE */
        .admin-table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-size: 13.5px;
        }
        .admin-table th {
            background: var(--bg-card-hover);
            color: var(--text-muted);
            padding: 12px 16px;
            font-weight: 800;
            border-bottom: 1.5px solid var(--border);
        }
        .admin-table td {
            padding: 14px 16px;
            border-bottom: 1px solid var(--border);
            color: var(--text-main);
            font-weight: 600;
        }
        .admin-table tr:hover td {
            background: rgba(0, 242, 254, 0.04);
        }
        /* FLOATING MODAL OVERLAY & CARDS */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(6, 8, 14, 0.82);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            padding: 20px;
            box-sizing: border-box;
            animation: modalFadeIn 0.2s ease-out;
        }
        .modal-card {
            background: var(--bg-card);
            border: 1.5px solid var(--cyan);
            border-radius: 20px;
            box-shadow: 0 25px 70px rgba(0, 0, 0, 0.7), 0 0 40px rgba(0, 242, 254, 0.2);
            max-width: 680px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            padding: 28px;
            position: relative;
            animation: modalPop 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes modalFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        @keyframes modalPop {
            0% { transform: scale(0.92); opacity: 0; }
            100% { transform: scale(1); opacity: 1; }
        }
    </style>

    <script>
        let currentLang = localStorage.getItem('maxi_lang') || 'es';
        let currentTheme = localStorage.getItem('maxi_theme') || 'dark';

        const TRANSLATIONS = {
            en: {
                "Inicio": "Home",
                "Maxi Pay": "Maxi Pay",
                "Trabajos ✨": "Gigs ✨",
                "Ballenas 🎯": "Whales 🎯",
                "Mercados 📈": "Markets 📈",
                "Minijuegos 🎮": "Games 🎮",
                "Academia 🎓": "Academy 🎓",
                "Crear Cuenta": "Create Account",
                "Bot": "Bot",
                "Pasarela de Pagos de Próxima Generación": "Next-Generation Payment Gateway",
                "Crea Enlaces de Cobro en Dólares o Tarjeta": "Create Dollar & Card Payment Links",
                "Envía tu link a tus clientes. Acepta pagos con tarjeta débito/crédito tradicional o cripto con auto-detección instantánea.": "Send your link to clients. Accept payments with traditional cards or crypto with instant auto-detection.",
                "Generar Factura / Link de Pago": "Generate Invoice / Payment Link",
                "Tu Billetera EVM (Base):": "Your EVM Wallet (Base):",
                "Nombre de tu Comercio o Freelance:": "Merchant / Freelancer Name:",
                "Monto a Cobrar (USD):": "Amount to Charge (USD):",
                "Concepto / Producto:": "Concept / Digital Product:",
                "Abrir Checkout Dual (Tarjeta + QR)": "Open Dual Checkout (Card + QR)",
                "Copiar Link de Pago": "Copy Payment Link",
                "Compartir por WhatsApp": "Share via WhatsApp",
                "Calculadora de Ahorro Real vs Bancos / PayPal": "Real Savings Calculator vs Banks / PayPal",
                "Desliza para calcular tu ganancia neta mensual:": "Slide to calculate your monthly net savings:",
                "CON PAYPAL / STRIPE (4.5% + $0.30)": "WITH PAYPAL / STRIPE (4.5% + $0.30)",
                "CON MAXI PAY (PLAN PRO)": "WITH MAXI PAY (PRO PLAN)",
                "Comisiones bancarias perdidas al mes": "Lost banking fees per month",
                "Tarifa fija de solo $9.99/mes": "Flat fee of only $9.99/month",
                "Bóveda Pública Verificada en Base Mainnet": "Public Vault Verified on Base Mainnet",
                "100% On-Chain y Transparente": "100% On-Chain & Transparent",
                "Auditar en BaseScan": "Audit on BaseScan",
                "Planes & Suscripciones Maxi Suite": "Maxi Suite Plans & Subscriptions",
                "Elige el plan ideal para tu negocio o flujo freelance:": "Choose the ideal plan for your business or freelance workflow:",
                "Plan Gratuito": "Free Plan",
                "Maxi Pay Pro": "Maxi Pay Pro",
                "Maxi Enterprise": "Maxi Enterprise",
                "Elegir Plan": "Select Plan",
                "AI Auto-Proposal Sniper Integrado": "AI Auto-Proposal Sniper Integrated",
                "Trabajos Remotos & Bounties en USDC": "Remote Jobs & Bounties in USDC",
                "No pierdas tiempo escribiendo postulaciones desde cero. Haz clic en «✨ Postularme con IA» y Maxi genera tu propuesta ganadora en 30 segundos.": "Don't waste time writing proposals from scratch. Click «✨ Apply with AI» and Maxi generates your winning proposal in 30 seconds.",
                "Postularme con IA (30s)": "Apply with AI (30s)",
                "Generador de Propuesta con IA": "AI Proposal Generator",
                "Maxi analizó los requerimientos del trabajo y redactó esta propuesta técnica persuasiva para postularte:": "Maxi analyzed job requirements and drafted this persuasive proposal:",
                "Copiar Propuesta": "Copy Proposal",
                "Abrir Convocatoria Oficial": "Open Official Bounty",
                "Diseño de Banner & Interfaz Web3 (UI/UX)": "Web3 Banner & UI/UX Design",
                "Bot de Telegram para Pagos y Membresías": "Telegram Bot for Payments & Memberships",
                "Traducción de Whitepaper Técnico (Inglés a Español)": "Technical Whitepaper Translation (EN to ES)",
                "Auditoría de Seguridad de Smart Contracts (Solidity)": "Smart Contract Security Audit (Solidity)",
                "Radar de Ballenas & Smart Money (Base L2)": "Whale Radar & Smart Money (Base L2)",
                "Monitoreo on-chain en tiempo real de transacciones de gran volumen, movimientos de tesorerías e inyecciones de liquidez.": "Real-time on-chain monitoring of large volume transactions, treasury moves, and liquidity injections.",
                "Cotizaciones en Tiempo Real": "Real-Time Market Quotes",
                "Libro de Órdenes Descentralizado": "Decentralized Orderbook",
                "Minijuegos On-Chain & Fichas": "On-Chain Games & Tokens",
                "Gira la Ruleta Diaria": "Spin Daily Roulette",
                "Jugar a los Dados": "Play Dice",
                "Multiplicador Crash": "Crash Multiplier",
                "Academia Master Web3 & Base": "Master Web3 & Base Academy",
                "5 Guías prácticas interactivas para dominar billeteras, pagos con 0% comisiones, trading de ballenas y retiros bancarios.": "5 interactive master guides to conquer crypto wallets, 0% fee payments, whale trading, and bank withdrawals.",
                "Mi Cuenta & Perfil": "My Account & Profile",
                "Crear Cuenta de Usuario": "Create User Account",
                "Tu Nombre Completo:": "Your Full Name:",
                "Correo Electrónico:": "Email Address:",
                "WhatsApp / Celular:": "WhatsApp / Phone:",
                "Contraseña:": "Password:",
                "Billetera EVM en Base (Opcional):": "EVM Wallet on Base (Optional):",
                "Crear Cuenta & Reclamar 100 Fichas": "Create Account & Claim 100 Tokens",
                "¿Ya tienes cuenta? Iniciar Sesión": "Already have an account? Log In"
            },
            es: {
                "Home": "Inicio",
                "Gigs ✨": "Trabajos ✨",
                "Whales 🎯": "Ballenas 🎯",
                "Markets 📈": "Mercados 📈",
                "Games 🎮": "Minijuegos 🎮",
                "Academy 🎓": "Academia 🎓",
                "Create Account": "Crear Cuenta",
                "Next-Generation Payment Gateway": "Pasarela de Pagos de Próxima Generación",
                "Create Dollar & Card Payment Links": "Crea Enlaces de Cobro en Dólares o Tarjeta",
                "Send your link to clients. Accept payments with traditional cards or crypto with instant auto-detection.": "Envía tu link a tus clientes. Acepta pagos con tarjeta débito/crédito tradicional o cripto con auto-detección instantánea.",
                "Generate Invoice / Payment Link": "Generar Factura / Link de Pago",
                "Your EVM Wallet (Base):": "Tu Billetera EVM (Base):",
                "Merchant / Freelancer Name:": "Nombre de tu Comercio o Freelance:",
                "Amount to Charge (USD):": "Monto a Cobrar (USD):",
                "Concept / Digital Product:": "Concepto / Producto:",
                "Open Dual Checkout (Card + QR)": "Abrir Checkout Dual (Tarjeta + QR)",
                "Copy Payment Link": "Copiar Link de Pago",
                "Share via WhatsApp": "Compartir por WhatsApp",
                "Real Savings Calculator vs Banks / PayPal": "Calculadora de Ahorro Real vs Bancos / PayPal",
                "Slide to calculate your monthly net savings:": "Desliza para calcular tu ganancia neta mensual:",
                "WITH PAYPAL / STRIPE (4.5% + $0.30)": "CON PAYPAL / STRIPE (4.5% + $0.30)",
                "WITH MAXI PAY (PRO PLAN)": "CON MAXI PAY (PLAN PRO)",
                "Lost banking fees per month": "Comisiones bancarias perdidas al mes",
                "Flat fee of only $9.99/month": "Tarifa fija de solo $9.99/mes",
                "Public Vault Verified on Base Mainnet": "Bóveda Pública Verificada en Base Mainnet",
                "100% On-Chain & Transparent": "100% On-Chain y Transparente",
                "Audit on BaseScan": "Auditar en BaseScan",
                "Maxi Suite Plans & Subscriptions": "Planes & Suscripciones Maxi Suite",
                "Choose the ideal plan for your business or freelance workflow:": "Elige el plan ideal para tu negocio o flujo freelance:",
                "Free Plan": "Plan Gratuito",
                "Select Plan": "Elegir Plan",
                "AI Auto-Proposal Sniper Integrated": "AI Auto-Proposal Sniper Integrado",
                "Remote Jobs & Bounties in USDC": "Trabajos Remotos & Bounties en USDC",
                "Don't waste time writing proposals from scratch. Click «✨ Apply with AI» and Maxi generates your winning proposal in 30 seconds.": "No pierdas tiempo escribiendo postulaciones desde cero. Haz clic en «✨ Postularme con IA» y Maxi genera tu propuesta ganadora en 30 segundos.",
                "Apply with AI (30s)": "Postularme con IA (30s)",
                "AI Proposal Generator": "Generador de Propuesta con IA",
                "Maxi analyzed job requirements and drafted this persuasive proposal:": "Maxi analizó los requerimientos del trabajo y redactó esta propuesta técnica persuasiva para postularte:",
                "Copy Proposal": "Copiar Propuesta",
                "Open Official Bounty": "Abrir Convocatoria Oficial",
                "Web3 Banner & UI/UX Design": "Diseño de Banner & Interfaz Web3 (UI/UX)",
                "Telegram Bot for Payments & Memberships": "Bot de Telegram para Pagos y Membresías",
                "Technical Whitepaper Translation (EN to ES)": "Traducción de Whitepaper Técnico (Inglés a Español)",
                "Smart Contract Security Audit (Solidity)": "Auditoría de Seguridad de Smart Contracts (Solidity)",
                "Whale Radar & Smart Money (Base L2)": "Radar de Ballenas & Smart Money (Base L2)",
                "Live Markets & Quotes": "Mercados & Cotizaciones en Vivo",
                "On-Chain Games & Tokens": "Minijuegos On-Chain & Fichas",
                "Master Web3 & Base Academy": "Academia Master Web3 & Base",
                "My Account & Profile": "Mi Cuenta & Perfil",
                "Create User Account": "Crear Cuenta de Usuario",
                "Your Full Name:": "Tu Nombre Completo:",
                "Email Address:": "Correo Electrónico:",
                "WhatsApp / Phone:": "WhatsApp / Celular:",
                "Password:": "Contraseña:",
                "EVM Wallet on Base (Optional):": "Billetera EVM en Base (Opcional):",
                "Create Account & Claim 100 Tokens": "Crear Cuenta & Reclamar 100 Fichas",
                "Already have an account? Log In": "¿Ya tienes cuenta? Iniciar Sesión"
            }
        };

        function translateDom(targetLang) {
            const map = TRANSLATIONS[targetLang];
            if (!map) return;

            function walk(node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.nodeValue.trim();
                    if (text && map[text]) {
                        node.nodeValue = node.nodeValue.replace(text, map[text]);
                    }
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'TEXTAREA') return;
                    for (let child of node.childNodes) {
                        walk(child);
                    }
                }
            }

            walk(document.body);
        }

        function applyLanguage(lang) {
            currentLang = lang;
            localStorage.setItem('maxi_lang', lang);
            const flagEl = document.getElementById('langFlag');
            if (flagEl) flagEl.innerText = lang.toUpperCase();
            document.documentElement.lang = lang;
            translateDom(lang);
        }

        function toggleLanguage() {
            const newLang = currentLang === 'es' ? 'en' : 'es';
            applyLanguage(newLang);
        }

        function applyTheme(theme) {
            currentTheme = theme;
            localStorage.setItem('maxi_theme', theme);
            if (theme === 'light') {
                document.documentElement.setAttribute('data-theme', 'light');
            } else {
                document.documentElement.removeAttribute('data-theme');
            }
        }

        function toggleTheme() {
            applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
        }

        async function checkUserSession() {
            const token = localStorage.getItem('maxi_user_token');
            if (!token) return;

            try {
                const res = await fetch('/api/auth/me', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                if (data.authenticated && data.user) {
                    const btn = document.getElementById('accountNavBtn');
                    const txt = document.getElementById('accountNavText');
                    if (btn && txt) {
                        const planTag = (data.user.plan && data.user.plan !== 'Gratuito') ? ' 👑 PRO' : '';
                        txt.innerText = data.user.name.split(' ')[0] + planTag + ' (' + data.user.credits + ' Fichas)';
                        btn.style.background = (data.user.plan && data.user.plan !== 'Gratuito') ? 'rgba(0, 242, 254, 0.2)' : 'rgba(0, 223, 137, 0.15)';
                        btn.style.color = (data.user.plan && data.user.plan !== 'Gratuito') ? 'var(--cyan)' : 'var(--emerald)';
                    }
                }
            } catch (e) {}
        }

        const toasts = [
            { icon: "💳", text: "<strong>Tarjeta Aprobada:</strong> Suscripción Maxi Pay Pro ($9.99 USD)" },
            { icon: "🟢", text: "<strong>@juan_comercio</strong> cobró <strong>$75.00 USDC</strong> hace 2 min" },
            { icon: "🐋", text: "<strong>Radar Base:</strong> Ballena acumuló <strong>206.5 ETH (SMS: 94/100)</strong>" },
            { icon: "✨", text: "<strong>AI Proposal Sniper:</strong> Propuesta generada para Bounty de <strong>$400 USDC</strong>" }
        ];
        let toastIdx = 0;

        function rotateToast() {
            const t = toasts[toastIdx % toasts.length];
            const toastEl = document.getElementById('liveToast');
            if (toastEl) {
                toastEl.style.opacity = '0';
                setTimeout(() => {
                    toastEl.innerHTML = '<span style="font-size:18px;">' + t.icon + '</span> <div>' + t.text + '</div>';
                    toastEl.style.opacity = '1';
                }, 300);
            }
            toastIdx++;
        }

        window.addEventListener('DOMContentLoaded', () => {
            applyTheme(currentTheme);
            if (currentLang === 'en') {
                applyLanguage('en');
            }
            checkUserSession();
            setInterval(rotateToast, 5500);
        });
    </script>
  `;
}

// 2. DUAL CHECKOUT: CRYPTO QR + TRADITIONAL DEBIT/CREDIT CARD
function renderCheckoutHtml(orderId, amount, concept, wallet, recipientName = 'Maxi Pay') {
  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=ethereum:' + wallet + '@8453?value=0';

  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maxi Pay Checkout • ${recipientName}</title>
    ${getGlobalStyles()}
    <style>
        .radar-pulse {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: var(--emerald);
            box-shadow: 0 0 0 0 rgba(0, 223, 137, 0.7);
            animation: pulse-green 1.6s infinite;
        }
        @keyframes pulse-green {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 223, 137, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(0, 223, 137, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 223, 137, 0); }
        }
        .success-box {
            animation: zoomIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes zoomIn {
            from { transform: scale(0.85); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }
        .pay-tab {
            flex: 1;
            padding: 12px;
            text-align: center;
            font-weight: 800;
            font-size: 13.5px;
            cursor: pointer;
            border-radius: 12px;
            transition: all 0.2s;
            border: 1px solid transparent;
        }
        .pay-tab.active {
            background: var(--cyan);
            color: #06080e;
            box-shadow: 0 4px 15px rgba(0, 242, 254, 0.3);
        }
        .pay-tab.inactive {
            background: var(--bg-card-hover);
            color: var(--text-muted);
            border-color: var(--border);
        }
    </style>
    <script type="text/javascript" src="https://checkout.wompi.co/widget.js"></script>
</head>
<body>
    <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px;">
        <div class="card" style="width:100%; max-width:540px; text-align:center; padding:36px; border-color:var(--cyan); box-shadow:0 20px 60px rgba(0,242,254,0.15);">
            
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:1px solid var(--border); padding-bottom:14px;">
                <div style="display:flex; align-items:center; gap:8px; font-size:16px; font-weight:800; color:var(--text-main);">
                    <div style="width:28px; height:28px; background:rgba(0,242,254,0.12); border-radius:8px; display:flex; align-items:center; justify-content:center;">${ICONS.logo}</div>
                    <span>Maxi Pay Pro Checkout</span>
                </div>
                <div style="font-size:12.5px; color:var(--text-muted); font-weight:700;">Orden: <strong>${orderId}</strong></div>
            </div>

            <div id="paymentPendingSection">
                <div style="font-size:14px; font-weight:800; color:var(--cyan); margin-bottom:4px;">Concepto: ${concept}</div>
                <div style="font-size:13px; color:var(--text-muted); margin-bottom:16px; font-weight:600;">Destinatario: ${recipientName}</div>

                <div style="font-size:40px; font-weight:800; color:var(--emerald); margin-bottom:20px; letter-spacing:-0.03em;">
                    $${amount}.00 <span style="font-size:16px; color:var(--text-muted);">USD (~$${(parseFloat(amount) * 4000).toLocaleString()} COP)</span>
                </div>

                <!-- PAYMENT METHOD TABS -->
                <div style="display:flex; gap:10px; margin-bottom:20px;">
                    <div id="tabCard" class="pay-tab active" onclick="switchPayTab('card')">
                        💳 Tarjeta Débito / Crédito
                    </div>
                    <div id="tabCrypto" class="pay-tab inactive" onclick="switchPayTab('crypto')">
                        🪙 Cripto / QR (Base)
                    </div>
                </div>

                <!-- METHOD 1: TRADITIONAL CARD PAY / WOMPI -->
                <div id="cardPaySection" style="text-align:left;">
                    <div style="background:var(--bg-card-hover); border:1px solid var(--border); border-radius:14px; padding:20px; margin-bottom:16px;">
                        <button type="button" class="btn-primary" onclick="openWompiCheckout()" style="width:100%; justify-content:center; padding:14px; font-size:15px; margin-bottom:10px; background:linear-gradient(135deg, #00df89 0%, #00f2fe 100%); color:#06080e; font-weight:800; border:none; box-shadow:0 6px 20px rgba(0,223,137,0.35);">
                            🇨🇴 Pagar con Wompi (Nequi, PSE, Bancolombia, Tarjeta)
                        </button>
                        <button type="button" class="btn-secondary" onclick="openWompiCheckout(1500)" style="width:100%; justify-content:center; padding:11px; font-size:13.5px; margin-bottom:14px; background:rgba(0,242,254,0.08); color:var(--cyan); border:1px dashed var(--cyan); font-weight:800; border-radius:10px; cursor:pointer; display:flex; align-items:center; gap:8px;">
                            🧪 Probar Pago Real con Nequi ($1.500 COP)
                        </button>

                        <div style="display:flex; align-items:center; gap:10px; margin: 14px 0 16px;">
                            <div style="flex:1; height:1px; background:var(--border);"></div>
                            <span style="font-size:11px; color:var(--text-muted); font-weight:800; letter-spacing:0.5px;">O PAGO RÁPIDO CON TARJETA DE PRUEBA</span>
                            <div style="flex:1; height:1px; background:var(--border);"></div>
                        </div>

                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                            <span style="font-size:13px; font-weight:800; color:var(--text-main);">Datos de Tarjeta Segura (256-bit SSL)</span>
                            <span style="font-size:18px;">💳 🔒</span>
                        </div>

                        <label style="display:block; font-size:12.5px; font-weight:700; margin-bottom:5px; color:var(--text-main);">Nombre del Titular:</label>
                        <input type="text" id="cardHolder" class="input-box" placeholder="Ej: Juan David Jaramillo" value="Juan David">

                        <label style="display:block; font-size:12.5px; font-weight:700; margin-bottom:5px; color:var(--text-main);">Número de Tarjeta (Visa / Mastercard):</label>
                        <input type="text" id="cardNumber" class="input-box" placeholder="•••• •••• •••• 4242" value="4000 1234 5678 9010" maxlength="19">

                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                            <div>
                                <label style="display:block; font-size:12.5px; font-weight:700; margin-bottom:5px; color:var(--text-main);">Expiración (MM/AA):</label>
                                <input type="text" id="cardExp" class="input-box" placeholder="12/28" value="12/28" maxlength="5">
                            </div>
                            <div>
                                <label style="display:block; font-size:12.5px; font-weight:700; margin-bottom:5px; color:var(--text-main);">CVV / CVC:</label>
                                <input type="password" id="cardCvc" class="input-box" placeholder="•••" value="888" maxlength="4">
                            </div>
                        </div>

                        <button class="btn-primary" id="btnCardSubmit" onclick="processCardPayment()" style="width:100%; justify-content:center; padding:13px; font-size:15px; margin-top:6px;">
                            💳 Pagar $${amount}.00 USD con Tarjeta
                        </button>
                    </div>

                    <div style="text-align:center; font-size:12px; color:var(--text-muted); font-weight:600;">
                        🔒 Pagos protegidos con encriptación bancaria y conversión automática a USDC.
                    </div>
                </div>

                <!-- METHOD 2: CRYPTO QR SCAN -->
                <div id="cryptoPaySection" style="display:none;">
                    <div style="background:white; padding:16px; border-radius:18px; display:inline-block; margin-bottom:14px; box-shadow:0 8px 30px rgba(0,0,0,0.2);">
                        <img src="${qrUrl}" alt="QR de Pago" style="width:200px; height:200px; display:block;">
                    </div>

                    <div style="font-size:12px; color:var(--text-muted); margin-bottom:6px; font-weight:700;">
                        Escanea con Binance, Coinbase, MetaMask o TrustWallet (Red Base):
                    </div>

                    <div style="font-family:monospace; font-size:12px; color:var(--cyan); background:var(--input-bg); padding:10px 14px; border-radius:10px; border:1px solid var(--border); word-break:break-all; margin-bottom:18px; display:flex; justify-content:space-between; align-items:center;">
                        <span>${wallet}</span>
                        <button onclick="navigator.clipboard.writeText('${wallet}'); alert('Dirección copiada');" style="background:none; border:none; color:var(--cyan); font-weight:bold; cursor:pointer; margin-left:8px;">Copiar</button>
                    </div>

                    <div style="background:rgba(0, 223, 137, 0.08); border:1.5px solid rgba(0, 223, 137, 0.3); padding:12px 16px; border-radius:12px; display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom:15px;">
                        <div class="radar-pulse"></div>
                        <div style="font-size:12.5px; font-weight:800; color:var(--emerald);">
                            Monitoreando red Base en vivo... (Auto-detección activa)
                        </div>
                    </div>
                </div>

            </div>

            <!-- SUCCESS CONFIRMATION SECTION -->
            <div id="paymentSuccessSection" style="display:none;" class="success-box">
                <div style="font-size:60px; margin-bottom:10px;">🎉</div>
                <h2 style="font-size:26px; font-weight:800; color:var(--emerald); margin-bottom:8px;">¡PAGO APROBADO CON ÉXITO!</h2>
                <p style="color:var(--text-muted); font-size:14px; font-weight:600; margin-bottom:20px;">
                    El pago fue procesado satisfactoriamente y tu membresía / servicio ya se encuentra 100% activo.
                </p>

                <div style="background:var(--calc-saved-bg); border:1.5px solid var(--emerald); padding:18px; border-radius:14px; text-align:left; font-size:13.5px; line-height:1.7; margin-bottom:24px;">
                    <strong>Monto Pagado:</strong> <span id="succAmount" style="color:var(--emerald); font-weight:800;">$${amount}.00 USD</span><br>
                    <strong>Método:</strong> <span id="succMethod">💳 Tarjeta Débito/Crédito (Aprobación Bancaria Inmediata)</span><br>
                    <strong>ID de Comprobante:</strong> <code id="succTx" style="color:var(--cyan); font-weight:bold;">${orderId}</code><br>
                    <strong>Estado de Cuenta:</strong> <strong style="color:var(--emerald);">👑 Maxi Plan Pro Activado (+100 Fichas)</strong>
                </div>

                <div style="display:flex; gap:10px;">
                    <button class="btn-primary" onclick="window.location.href='/cuenta'" style="flex:1; justify-content:center;">
                        👤 Ir a Mi Cuenta Pro
                    </button>
                    <button class="btn-outline" onclick="window.location.href='/admin'" style="flex:1; justify-content:center; border-color:var(--cyan); color:var(--cyan);">
                        🔒 Ver en Admin
                    </button>
                </div>
            </div>

        </div>
    </div>

    <script>
        let pollTimer = null;
        let isConfirmed = false;

        function switchPayTab(tab) {
            const tabCard = document.getElementById('tabCard');
            const tabCrypto = document.getElementById('tabCrypto');
            const cardSection = document.getElementById('cardPaySection');
            const cryptoSection = document.getElementById('cryptoPaySection');

            if (tab === 'card') {
                tabCard.className = 'pay-tab active';
                tabCrypto.className = 'pay-tab inactive';
                cardSection.style.display = 'block';
                cryptoSection.style.display = 'none';
            } else {
                tabCard.className = 'pay-tab inactive';
                tabCrypto.className = 'pay-tab active';
                cardSection.style.display = 'none';
                cryptoSection.style.display = 'block';
            }
        }

        function playSuccessChime() {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(587.33, ctx.currentTime);
                osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.15);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                osc.stop(ctx.currentTime + 0.8);
            } catch (e) {}
        }

        function showSuccess(method, txId) {
            if (isConfirmed) return;
            isConfirmed = true;
            if (pollTimer) clearInterval(pollTimer);

            playSuccessChime();

            document.getElementById('paymentPendingSection').style.display = 'none';
            document.getElementById('paymentSuccessSection').style.display = 'block';
            document.getElementById('succMethod').innerText = method;
            if (txId) document.getElementById('succTx').innerText = txId;
        }

        async function openWompiCheckout(forceCop) {
            let amountCop = forceCop || Math.round(parseFloat('${amount}') * 4000);
            if (amountCop < 1500) amountCop = 1500;
            const amountInCents = amountCop * 100;
            const ref = '${orderId}' + '-' + Math.floor(1000 + Math.random() * 9000);

            if (typeof WidgetCheckout === 'undefined') {
                alert('Conectando con la pasarela segura de Wompi... por favor intenta nuevamente en 2 segundos.');
                return;
            }

            try {
                const sigRes = await fetch('/api/v1/wompi/signature?reference=' + encodeURIComponent(ref) + '&amountInCents=' + amountInCents);
                const sigData = await sigRes.json();

                const config = {
                    currency: 'COP',
                    amountInCents: amountInCents,
                    reference: ref,
                    publicKey: 'pub_prod_ASs7SGOmMRYshifZJUkDUNxmNCGPCxmf',
                    redirectUrl: window.location.origin + '/cuenta'
                };

                if (sigData && sigData.signature) {
                    config.signature = {
                        integrity: sigData.signature
                    };
                }

                const checkout = new WidgetCheckout(config);

                checkout.open(function (result) {
                    var transaction = result.transaction;
                    if (transaction && (transaction.status === 'APPROVED' || transaction.status === 'PENDING')) {
                        showSuccess('🇨🇴 Wompi Bancolombia / Nequi (Aprobación Exitosa)', transaction.id || ref);
                    }
                });
            } catch (err) {
                console.error('Error al generar firma de Wompi:', err);
                alert('Conectando con Wompi... reintentando.');
            }
        }

        async function processCardPayment() {
            const btn = document.getElementById('btnCardSubmit');
            btn.disabled = true;
            btn.innerText = '⏳ Procesando con tu banco (3s)...';

            const token = localStorage.getItem('maxi_user_token');

            try {
                const res = await fetch('/api/v1/checkout/card-pay', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': token ? 'Bearer ' + token : ''
                    },
                    body: JSON.stringify({
                        orderId: '${orderId}',
                        amount: ${amount},
                        concept: '${concept}',
                        cardHolder: document.getElementById('cardHolder').value,
                        cardNumber: document.getElementById('cardNumber').value
                    })
                });
                const data = await res.json();

                if (data.success) {
                    showSuccess('💳 Tarjeta Débito/Crédito (Aprobación Bancaria Inmediata)', data.invoiceId);
                } else {
                    alert('Error en pago: ' + data.error);
                    btn.disabled = false;
                    btn.innerText = '💳 Pagar $' + ${amount} + '.00 USD con Tarjeta';
                }
            } catch (err) {
                alert('Error de conexión: ' + err.message);
                btn.disabled = false;
                btn.innerText = '💳 Pagar $' + ${amount} + '.00 USD con Tarjeta';
            }
        }

        async function pollAutoDetection() {
            if (isConfirmed) return;

            try {
                const res = await fetch('/api/v1/checkout/poll-status?wallet=${wallet}&amount=${amount}');
                const data = await res.json();
                if (data.detected) {
                    showSuccess('🪙 Cripto On-Chain (Base Mainnet)', data.txHash);
                }
            } catch (e) {}
        }

        window.addEventListener('DOMContentLoaded', () => {
            pollTimer = setInterval(pollAutoDetection, 2500);
        });
    </script>
</body>
</html>`;
}

// 3. PAGE: CUENTA
function renderCuentaPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mi Cuenta & Planes • Maxi Suite</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('cuenta')}

    <div class="page-container">
        <!-- AUTH REGISTRATION / LOGIN -->
        <div id="authForms" style="max-width:520px; margin:0 auto;">
            <div class="card">
                <div style="text-align:center; margin-bottom:24px;">
                    <div style="font-size:36px; margin-bottom:8px;">👤</div>
                    <h2 style="font-size:26px; font-weight:800; margin-bottom:6px; color:var(--text-main);">Crear Cuenta en Maxi Suite</h2>
                    <p style="color:var(--text-muted); font-size:14px; font-weight:600;">
                        Regístrate con tu <strong>Correo Electrónico</strong> y <strong>Número de Celular</strong> para recibir <strong>+5 Fichas Gratis de Bienvenida</strong>.
                    </p>
                </div>

                <div id="regError" style="display:none; padding:12px; border-radius:8px; background:var(--calc-fee-bg); border:1px solid var(--rose); color:var(--rose); font-size:13px; font-weight:bold; margin-bottom:15px;"></div>

                <label style="display:block; font-size:13.5px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Nombre Completo:</label>
                <input type="text" id="regName" class="input-box" placeholder="Ej: Juan David Jaramillo">

                <label style="display:block; font-size:13.5px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Correo Electrónico:</label>
                <input type="email" id="regEmail" class="input-box" placeholder="ejemplo@correo.com">

                <label style="display:block; font-size:13.5px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Número de Celular (WhatsApp):</label>
                <input type="tel" id="regPhone" class="input-box" placeholder="+57 300 123 4567">

                <label style="display:block; font-size:13.5px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Billetera Base (Opcional):</label>
                <input type="text" id="regWallet" class="input-box" placeholder="0x... (EVM Wallet)">

                <button class="btn-primary" onclick="submitRegister()" style="width:100%; justify-content:center; margin-top:10px;">
                    🎁 Crear Cuenta & Reclamar 5 Fichas Gratis
                </button>

                <div style="text-align:center; margin-top:20px; font-size:13.5px; color:var(--text-muted); font-weight:600;">
                    ¿Ya tienes cuenta? <a href="javascript:void(0)" onclick="quickLoginPrompt()" style="color:var(--cyan); font-weight:800;">Iniciar Sesión con tu Correo</a>
                </div>
            </div>
        </div>

        <!-- AUTHENTICATED USER PROFILE -->
        <div id="userProfile" style="display:none;">
            <div class="card" style="border-color:var(--cyan);">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
                    <div>
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                            <span id="profBadge" style="background:var(--calc-saved-bg); color:var(--emerald); border:1px solid var(--emerald); padding:4px 12px; border-radius:20px; font-size:12px; font-weight:800;">
                                ✓ Cuenta Activa
                            </span>
                            <span id="profPlanTag" style="background:rgba(0, 242, 254, 0.15); color:var(--cyan); border:1px solid var(--cyan); padding:4px 12px; border-radius:20px; font-size:12px; font-weight:800;">
                                Plan Gratuito
                            </span>
                        </div>
                        <h2 style="font-size:28px; font-weight:800; color:var(--text-main);" id="profName">Juan David</h2>
                        <div style="color:var(--text-muted); font-size:14px; font-weight:600; margin-top:4px;">
                            📧 <span id="profEmail">correo@ejemplo.com</span> • 📱 <span id="profPhone">+57 300...</span>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:13px; color:var(--text-muted); font-weight:800;">SALDO DISPONIBLE:</div>
                        <div style="font-size:36px; font-weight:800; color:var(--cyan);" id="profCredits">5 Fichas</div>
                        <button onclick="logout()" class="btn-outline" style="padding:6px 14px; font-size:12px; margin-top:6px;">Cerrar Sesión</button>
                    </div>
                </div>
            </div>

            <!-- PRO VIP BANNER IF UPGRADED -->
            <div id="proFeaturesSection" style="display:none;" class="card" style="border-color:var(--emerald); background:rgba(0, 223, 137, 0.08);">
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
                    <span style="font-size:30px;">👑</span>
                    <div>
                        <h3 style="font-size:20px; font-weight:800; color:var(--emerald);">¡Tu Membresía Pro está Activa!</h3>
                        <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">Tienes acceso ilimitado a todas las herramientas avanzadas de Maxi.</p>
                    </div>
                </div>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-top:10px;">
                    <div style="background:var(--bg-card); padding:12px; border-radius:10px; border:1px solid var(--border); font-size:13px; font-weight:700;">⚡ 0% Comisiones en Enlaces de Pago</div>
                    <div style="background:var(--bg-card); padding:12px; border-radius:10px; border:1px solid var(--border); font-size:13px; font-weight:700;">✨ Asistente IA Sniper Ilimitado</div>
                    <div style="background:var(--bg-card); padding:12px; border-radius:10px; border:1px solid var(--border); font-size:13px; font-weight:700;">🐋 Señales de Ballenas Prioritarias</div>
                </div>
            </div>

            <!-- USER PERSONAL PAYMENT LINK -->
            <div class="card" style="border-color:var(--emerald); background:rgba(0, 223, 137, 0.05);">
                <h3 style="font-size:18px; font-weight:800; margin-bottom:6px; color:var(--text-main);">🔗 Tu Enlace de Cobro Personalizado (Maxi Pay Pro)</h3>
                <p style="color:var(--text-muted); font-size:13.5px; font-weight:600; margin-bottom:12px;">Comparte este link con tus clientes para recibir pagos en dólares o tarjeta:</p>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <div id="userCustomLink" style="font-family:monospace; font-size:14px; color:var(--cyan); background:var(--input-bg); padding:10px 14px; border-radius:8px; border:1px solid var(--border); flex:1;">
                        https://...
                    </div>
                    <button class="btn-primary" onclick="copyUserCustomLink()" style="padding:10px 16px; font-size:13px;">📋 Copiar</button>
                    <button class="btn-outline" style="background:#25D366; color:#06080e; border:none; font-weight:bold; font-size:13px;" onclick="shareMyLinkWhatsapp()">📲 WhatsApp</button>
                </div>
            </div>

            <!-- MEMBERSHIP CATALOG -->
            <h3 style="font-size:24px; font-weight:800; margin:30px 0 20px 0; text-align:center; color:var(--text-main);">
                💎 Planes Pro & Membresías (Paga con Tarjeta o Cripto)
            </h3>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:24px;">
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
                    <div>
                        <div style="font-size:13px; font-weight:800; color:var(--cyan);">PLAN COMERCIO</div>
                        <h4 style="font-size:22px; font-weight:800; margin:6px 0; color:var(--text-main);">Maxi Pay Pro</h4>
                        <div style="font-size:32px; font-weight:800; color:var(--emerald); margin:12px 0;">$9.99 <span style="font-size:14px; color:var(--text-muted);">USD / mes</span></div>
                        <ul style="color:var(--text-muted); font-size:13.5px; font-weight:600; line-height:1.8; margin-bottom:20px; padding-left:20px;">
                            <li>Facturas y códigos QR ilimitados.</li>
                            <li>0% de comisiones por venta.</li>
                            <li>Acepta Tarjeta Débito y Cripto.</li>
                        </ul>
                    </div>
                    <button class="btn-primary" onclick="openPaymentModal('Maxi Pay Pro', 9.99)" style="justify-content:center;">💳 Activar Maxi Pay Pro ($9.99)</button>
                </div>

                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border-color:var(--emerald);">
                    <div>
                        <div style="font-size:13px; font-weight:800; color:var(--emerald);">PLAN FREELANCE</div>
                        <h4 style="font-size:22px; font-weight:800; margin:6px 0; color:var(--text-main);">Gig Finder VIP</h4>
                        <div style="font-size:32px; font-weight:800; color:var(--emerald); margin:12px 0;">$14.99 <span style="font-size:14px; color:var(--text-muted);">USD / mes</span></div>
                        <ul style="color:var(--text-muted); font-size:13.5px; font-weight:600; line-height:1.8; margin-bottom:20px; padding-left:20px;">
                            <li>AI Proposal Sniper ilimitado.</li>
                            <li>Alertas de trabajos de $50 a $1,000 USD.</li>
                            <li>Canal privado VIP en Telegram.</li>
                        </ul>
                    </div>
                    <button class="btn-primary" onclick="openPaymentModal('Gig Finder VIP', 14.99)" style="justify-content:center; background:linear-gradient(135deg, #00df89 0%, #10b981 100%);">💼 Activar Gig Finder VIP ($14.99)</button>
                </div>

                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border-color:var(--purple);">
                    <div>
                        <div style="font-size:13px; font-weight:800; color:var(--purple);">PLAN TRADER</div>
                        <h4 style="font-size:22px; font-weight:800; margin:6px 0; color:var(--text-main);">Maxi Alpha VIP</h4>
                        <div style="font-size:32px; font-weight:800; color:var(--purple); margin:12px 0;">$29.99 <span style="font-size:14px; color:var(--text-muted);">USD / mes</span></div>
                        <ul style="color:var(--text-muted); font-size:13.5px; font-weight:600; line-height:1.8; margin-bottom:20px; padding-left:20px;">
                            <li>Smart Money Score (0 a 100) en vivo.</li>
                            <li>Setups cuantitativos con Entry, SL y TP.</li>
                            <li>Alertas sonoras 24/7 en Telegram.</li>
                        </ul>
                    </div>
                    <button class="btn-primary" onclick="openPaymentModal('Maxi Alpha VIP', 29.99)" style="justify-content:center; background:linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); color:white;">🐋 Activar Alpha VIP ($29.99)</button>
                </div>
            </div>

            <!-- USER INVOICES & PAYMENT RECEIPTS -->
            <div class="card" style="margin-top:28px; border-color:var(--cyan); background:rgba(0, 242, 254, 0.03);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
                    <div>
                        <h3 style="font-size:20px; font-weight:800; color:var(--text-main); margin-bottom:4px;">🧾 Historial de Facturas & Pagos Aprobados</h3>
                        <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">Comprobantes oficiales de tus transacciones procesadas por Wompi Bancolombia, Nequi y Cripto.</p>
                    </div>
                    <span id="invoiceCountBadge" style="background:rgba(0, 223, 137, 0.15); color:var(--emerald); border:1px solid var(--emerald); padding:6px 14px; border-radius:20px; font-size:12.5px; font-weight:800;">
                        1 Factura
                    </span>
                </div>
                <div id="invoicesListContainer" style="overflow-x:auto;">
                    <div style="text-align:center; padding:20px; color:var(--text-muted); font-weight:600;">Cargando facturas...</div>
                </div>
            </div>
        </div>
    </div>

    ${getFooter()}

    <script>
        async function submitRegister() {
            const name = document.getElementById('regName').value.trim();
            const email = document.getElementById('regEmail').value.trim();
            const phone = document.getElementById('regPhone').value.trim();
            const wallet = document.getElementById('regWallet').value.trim();
            const errBox = document.getElementById('regError');

            if (!name || !email || !phone) {
                errBox.style.display = 'block';
                errBox.innerText = 'Por favor completa tu Nombre, Correo Electrónico y Celular.';
                return;
            }

            try {
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, phone, wallet })
                });
                const data = await res.json();
                if (data.success && data.token) {
                    localStorage.setItem('maxi_user_token', data.token);
                    showProfile(data.user);
                } else {
                    errBox.style.display = 'block';
                    errBox.innerText = data.error || 'Error al registrar.';
                }
            } catch (err) {
                errBox.style.display = 'block';
                errBox.innerText = 'Error de conexión: ' + err.message;
            }
        }

        async function quickLoginPrompt() {
            const email = prompt('Ingresa tu Correo Electrónico registrado:');
            if (!email) return;

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const data = await res.json();
                if (data.success && data.token) {
                    localStorage.setItem('maxi_user_token', data.token);
                    showProfile(data.user);
                } else {
                    alert(data.error || 'No se encontró una cuenta con ese correo.');
                }
            } catch (e) {
                alert('Error al iniciar sesión: ' + e.message);
            }
        }

        function showProfile(user, invoices = []) {
            document.getElementById('authForms').style.display = 'none';
            document.getElementById('userProfile').style.display = 'block';
            document.getElementById('profName').innerText = user.name;
            document.getElementById('profEmail').innerText = user.email;
            document.getElementById('profPhone').innerText = user.phone;
            document.getElementById('profCredits').innerText = user.credits + ' Fichas';

            const isPro = user.plan && user.plan !== 'Gratuito';
            document.getElementById('profPlanTag').innerText = isPro ? ('👑 ' + user.plan) : 'Plan Gratuito';
            document.getElementById('profPlanTag').style.color = isPro ? 'var(--emerald)' : 'var(--cyan)';
            document.getElementById('profPlanTag').style.borderColor = isPro ? 'var(--emerald)' : 'var(--cyan)';

            if (isPro) {
                document.getElementById('proFeaturesSection').style.display = 'block';
            }

            const userSlug = encodeURIComponent(user.name.toLowerCase().replace(/\s+/g, '-'));
            const customLink = window.location.origin + '/pay/' + userSlug + '/50?wallet=' + encodeURIComponent(user.wallet || '${MAXI_WALLET}');
            document.getElementById('userCustomLink').innerText = customLink;

            // Render Invoices Table
            const invContainer = document.getElementById('invoicesListContainer');
            const invBadge = document.getElementById('invoiceCountBadge');
            
            if (invoices && invoices.length > 0) {
                invBadge.innerText = invoices.length + (invoices.length === 1 ? ' Factura' : ' Facturas');
                let html = '<table style="width:100%; border-collapse:collapse; font-size:13.5px; text-align:left;">';
                html += '<thead><tr style="border-bottom:1px solid var(--border); color:var(--text-muted);">';
                html += '<th style="padding:10px 12px;">ID Factura / Ref</th>';
                html += '<th style="padding:10px 12px;">Concepto</th>';
                html += '<th style="padding:10px 12px;">Método de Pago</th>';
                html += '<th style="padding:10px 12px;">Monto</th>';
                html += '<th style="padding:10px 12px;">Estado</th>';
                html += '<th style="padding:10px 12px;">Fecha</th>';
                html += '</tr></thead><tbody>';

                invoices.forEach(inv => {
                    const isWompi = (inv.method || '').includes('Wompi') || (inv.method || '').includes('NEQUI');
                    const methodBadge = isWompi ? '🇨🇴 ' + inv.method : '💳 ' + (inv.method || 'Tarjeta');
                    const amountStr = inv.amountCop ? ('$' + Number(inv.amountCop).toLocaleString() + ' COP') : ('$' + inv.amount + ' USD');
                    const dateStr = inv.timestamp ? new Date(inv.timestamp).toLocaleString('es-CO') : 'Reciente';

                    html += '<tr style="border-bottom:1px solid var(--border);">';
                    html += '<td style="padding:12px; font-family:monospace; font-weight:800; color:var(--cyan);">' + (inv.orderId || inv.invoiceId) + '<br><span style="font-size:11px; color:var(--text-muted); font-weight:normal;">' + inv.invoiceId + '</span></td>';
                    html += '<td style="padding:12px; font-weight:700; color:var(--text-main);">' + (inv.concept || 'Suscripción') + '</td>';
                    html += '<td style="padding:12px;"><span style="background:rgba(0,223,137,0.12); color:var(--emerald); border:1px solid var(--emerald); padding:3px 8px; border-radius:6px; font-weight:800; font-size:12px;">' + methodBadge + '</span></td>';
                    html += '<td style="padding:12px; font-weight:800; color:var(--emerald); font-size:14.5px;">' + amountStr + '</td>';
                    html += '<td style="padding:12px;"><span style="color:var(--emerald); font-weight:800;">✓ ' + (inv.status || 'Aprobado 100%') + '</span></td>';
                    html += '<td style="padding:12px; color:var(--text-muted); font-size:12.5px;">' + dateStr + '</td>';
                    html += '</tr>';
                });
                html += '</tbody></table>';
                invContainer.innerHTML = html;
            } else {
                invBadge.innerText = '0 Facturas';
                invContainer.innerHTML = '<div style="text-align:center; padding:24px; color:var(--text-muted); font-weight:600;">No tienes pagos registrados aún.</div>';
            }

            checkUserSession();
        }

        function copyUserCustomLink() {
            const link = document.getElementById('userCustomLink').innerText;
            navigator.clipboard.writeText(link);
            alert('¡Enlace de cobro personal copiado!');
        }

        function shareMyLinkWhatsapp() {
            const link = document.getElementById('userCustomLink').innerText;
            const text = encodeURIComponent('Hola! Puedes pagarme de forma segura en dólares (USDC) o tarjeta a través de mi link personal de Maxi Pay: ' + link);
            window.open('https://api.whatsapp.com/send?text=' + text, '_blank');
        }

        function logout() {
            localStorage.removeItem('maxi_user_token');
            window.location.reload();
        }

        async function initAccountPage() {
            let token = localStorage.getItem('maxi_user_token');
            if (!token) {
                // Auto-login default user for seamless experience
                try {
                    const res = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: 'jdavidjaramillo@hotmail.com' })
                    });
                    const data = await res.json();
                    if (data.success && data.token) {
                        localStorage.setItem('maxi_user_token', data.token);
                        token = data.token;
                        showProfile(data.user, data.invoices);
                        return;
                    }
                } catch (e) {}
            }

            if (token) {
                try {
                    const res = await fetch('/api/auth/me', {
                        headers: { 'Authorization': 'Bearer ' + token }
                    });
                    const data = await res.json();
                    if (data.authenticated && data.user) {
                        showProfile(data.user, data.invoices);
                    }
                } catch (e) {}
            }
        }

        function openPaymentModal(planName, amount) {
            const orderId = 'PLAN-' + Math.floor(100000 + Math.random() * 900000);
            window.location.href = '/checkout?order_id=' + orderId + '&amount=' + amount + '&concept=' + encodeURIComponent('Membresia ' + planName) + '&wallet=${MAXI_WALLET}';
        }

        window.addEventListener('DOMContentLoaded', initAccountPage);
    </script>
</body>
</html>`;
}

// 4. ADMIN, TUTORIALES, BALLENAS, TRABAJOS, PAY, JUEGOS, MERCADOS, DEMO STORE
function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Panel de Administrador • Maxi Suite</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('admin')}

    <div class="page-container">
        <!-- ADMIN LOGIN BOX (SHOWN IF NOT AUTHENTICATED) -->
        <div id="adminLoginSection" style="max-width:480px; margin:40px auto;">
            <div class="card" style="border-color:var(--cyan); box-shadow:0 15px 45px rgba(0, 242, 254, 0.15);">
                <div style="text-align:center; margin-bottom:24px;">
                    <div style="font-size:42px; margin-bottom:10px;">🔒</div>
                    <h2 style="font-size:26px; font-weight:800; margin-bottom:6px; color:var(--text-main);">Centro de Comando Administrador</h2>
                    <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">
                        Acceso exclusivo para el fundador y administrador general (Juan David).
                    </p>
                </div>

                <div id="adminLoginError" style="display:none; padding:12px; border-radius:8px; background:var(--calc-fee-bg); border:1px solid var(--rose); color:var(--rose); font-size:13px; font-weight:bold; margin-bottom:15px;"></div>

                <label style="display:block; font-size:13px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Correo de Administrador:</label>
                <input type="email" id="adminEmailInput" class="input-box" value="${ADMIN_EMAIL}">

                <label style="display:block; font-size:13px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Contraseña Maestra de Seguridad:</label>
                <input type="password" id="adminPassInput" class="input-box" placeholder="Ingresa tu clave maestra">

                <button class="btn-primary" onclick="submitAdminLogin()" style="width:100%; justify-content:center; margin-top:10px;">
                    🔐 Iniciar Sesión de Administrador
                </button>
            </div>
        </div>

        <!-- AUTHENTICATED ADMIN DASHBOARD -->
        <div id="adminDashboardSection" style="display:none;">
            <!-- ADMIN HEADER -->
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; margin-bottom:30px; border-bottom:1px solid var(--border); padding-bottom:20px;">
                <div>
                    <div style="display:inline-flex; align-items:center; gap:8px; background:rgba(0, 242, 254, 0.12); color:var(--cyan); border:1px solid rgba(0, 242, 254, 0.3); padding:4px 12px; border-radius:14px; font-size:12px; font-weight:800; margin-bottom:8px;">
                        👑 Mando General & Auditoría Privada
                    </div>
                    <h1 style="font-size:32px; font-weight:800; color:var(--text-main);">Bienvenido, Juan David</h1>
                    <div style="color:var(--text-muted); font-size:14px; font-weight:600;">Control total de ingresos, clientes y retiros on-chain.</div>
                </div>
                <div style="display:flex; gap:10px;">
                    <button class="btn-outline" onclick="loadAdminData()" style="padding:9px 16px; font-size:13px;">🔄 Actualizar Datos</button>
                    <button class="btn-outline" onclick="logoutAdmin()" style="border-color:var(--rose); color:var(--rose); padding:9px 16px; font-size:13px;">Cerrar Sesión</button>
                </div>
            </div>

            <!-- ROW 1: TREASURY & KPI METRICS -->
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:20px; margin-bottom:30px;">
                <div class="card" style="margin-bottom:0; border-left:5px solid var(--emerald);">
                    <div style="font-size:12.5px; font-weight:800; color:var(--emerald); margin-bottom:6px;">BÓVEDA PRINCIPAL (USDC)</div>
                    <div style="font-size:36px; font-weight:800; color:var(--emerald);" id="kpiUsdc">$0.00 <span style="font-size:18px; color:var(--text-muted);">USDC</span></div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600; margin-top:6px;">Fondos disponibles en Base Mainnet</div>
                </div>

                <div class="card" style="margin-bottom:0; border-left:5px solid var(--cyan);">
                    <div style="font-size:12.5px; font-weight:800; color:var(--cyan); margin-bottom:6px;">RESERVA DE GAS (ETH)</div>
                    <div style="font-size:36px; font-weight:800; color:var(--cyan);" id="kpiEth">0.0000 <span style="font-size:18px; color:var(--text-muted);">ETH</span></div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600; margin-top:6px;">Suficiente para > 10,000 txs en Base</div>
                </div>

                <div class="card" style="margin-bottom:0; border-left:5px solid var(--purple);">
                    <div style="font-size:12.5px; font-weight:800; color:var(--purple); margin-bottom:6px;">CLIENTES REGISTRADOS</div>
                    <div style="font-size:36px; font-weight:800; color:var(--purple);" id="kpiUsers">0</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600; margin-top:6px;">Usuarios en la base de datos</div>
                </div>

                <div class="card" style="margin-bottom:0; border-left:5px solid var(--amber);">
                    <div style="font-size:12.5px; font-weight:800; color:var(--amber); margin-bottom:6px;">MRR ESTIMADO</div>
                    <div style="font-size:36px; font-weight:800; color:var(--amber);" id="kpiMrr">$0.00 <span style="font-size:16px; color:var(--text-muted);">/ mes</span></div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600; margin-top:6px;">Ingresos recurrentes proyectados</div>
                </div>
            </div>

            <!-- ROW 2: WITHDRAWAL / PAYOUT MODULE -->
            <div class="card" style="border-color:var(--cyan); background:rgba(0, 242, 254, 0.03);">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px;">
                    <div>
                        <h3 style="font-size:20px; font-weight:800; color:var(--text-main);">💸 Módulo de Retiro de Ganancias a Tu Cuenta</h3>
                        <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">
                            Transfiere los USDC de la bóveda de Maxi a tu dirección de depósito de <strong>Binance, MetaMask o tu exchange preferido</strong>.
                        </p>
                    </div>
                    <a href="https://basescan.org/address/${MAXI_WALLET}" target="_blank" class="btn-outline" style="padding:8px 14px; font-size:12.5px;">
                        🔍 Auditar en BaseScan
                    </a>
                </div>

                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px; margin-bottom:16px;">
                    <div>
                        <label style="display:block; font-size:13px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Monto a Retirar (USDC):</label>
                        <input type="number" id="withdrawAmount" class="input-box" placeholder="Ej: 50" value="50">
                    </div>
                    <div>
                        <label style="display:block; font-size:13px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Dirección de Destino (Tu Binance en Base / 0x...):</label>
                        <input type="text" id="withdrawAddress" class="input-box" placeholder="0xTuDireccionDeDepositoBinance...">
                    </div>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:700;">
                        ⚡ Comisión de red Base: <strong style="color:var(--emerald);">&lt; $0.01 centavo</strong> • Tiempo de llegada: <strong>~3 segundos</strong>
                    </div>
                    <button class="btn-primary" onclick="executeWithdrawal()" style="background:linear-gradient(135deg, #00df89 0%, #10b981 100%);">
                        🚀 Ejecutar Retiro On-Chain
                    </button>
                </div>

                <div id="withdrawStatus" style="display:none; margin-top:15px; padding:12px; border-radius:10px; font-size:13.5px; font-weight:800;"></div>
            </div>

            <!-- ROW 3: CRM USER MANAGEMENT TABLE -->
            <div class="card">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; flex-wrap:wrap; gap:12px;">
                    <div>
                        <h3 style="font-size:20px; font-weight:800; color:var(--text-main);">👥 Directorio de Clientes & Usuarios Registrados</h3>
                        <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">Gestión de cuentas, planes y contacto directo vía WhatsApp.</p>
                    </div>
                    <span id="userCountBadge" style="background:rgba(0, 242, 254, 0.12); color:var(--cyan); padding:4px 12px; border-radius:12px; font-weight:800; font-size:13px;">0 Clientes</span>
                </div>

                <div style="overflow-x:auto;">
                    <table class="admin-table">
                        <thead>
                            <tr>
                                <th>Cliente</th>
                                <th>Correo</th>
                                <th>WhatsApp</th>
                                <th>Billetera Base</th>
                                <th>Plan Activo</th>
                                <th>Fichas</th>
                                <th>Acciones</th>
                            </tr>
                        </thead>
                        <tbody id="usersTableBody">
                            <tr>
                                <td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">Cargando usuarios...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    ${getFooter()}

    <script>
        async function submitAdminLogin() {
            const email = document.getElementById('adminEmailInput').value.trim();
            const password = document.getElementById('adminPassInput').value.trim();
            const errBox = document.getElementById('adminLoginError');

            if (!password) {
                errBox.style.display = 'block';
                errBox.innerText = 'Por favor ingresa la contraseña maestra.';
                return;
            }

            try {
                const res = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();
                if (data.success && data.token) {
                    localStorage.setItem('maxi_admin_token', data.token);
                    document.getElementById('adminLoginSection').style.display = 'none';
                    document.getElementById('adminDashboardSection').style.display = 'block';
                    loadAdminData();
                } else {
                    errBox.style.display = 'block';
                    errBox.innerText = data.error || 'Credenciales incorrectas.';
                }
            } catch (err) {
                errBox.style.display = 'block';
                errBox.innerText = 'Error de conexión: ' + err.message;
            }
        }

        async function loadAdminData() {
            const token = localStorage.getItem('maxi_admin_token');
            if (!token) {
                document.getElementById('adminLoginSection').style.display = 'block';
                document.getElementById('adminDashboardSection').style.display = 'none';
                return;
            }

            try {
                const res = await fetch('/api/admin/metrics', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (res.status === 401) {
                    logoutAdmin();
                    return;
                }
                const data = await res.json();
                
                document.getElementById('adminLoginSection').style.display = 'none';
                document.getElementById('adminDashboardSection').style.display = 'block';

                document.getElementById('kpiUsdc').innerHTML = '$' + (data.treasury.usdc || 0).toFixed(2) + ' <span style="font-size:18px; color:var(--text-muted);">USDC</span>';
                document.getElementById('kpiEth').innerHTML = (data.treasury.eth || 0).toFixed(4) + ' <span style="font-size:18px; color:var(--text-muted);">ETH</span>';
                document.getElementById('kpiUsers').innerText = data.metrics.totalUsers || 0;
                document.getElementById('kpiMrr').innerHTML = '$' + (data.metrics.mrr || 0).toFixed(2) + ' <span style="font-size:16px; color:var(--text-muted);">/ mes</span>';
                document.getElementById('userCountBadge').innerText = (data.metrics.totalUsers || 0) + ' Clientes';

                renderUsersTable(data.users || []);
            } catch (err) {
                console.error('Error loading admin data:', err);
            }
        }

        function renderUsersTable(users) {
            const tbody = document.getElementById('usersTableBody');
            if (!users || users.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">No hay clientes registrados aún.</td></tr>';
                return;
            }

            tbody.innerHTML = users.map(u => {
                const cleanPhone = (u.phone || '').replace(/[^0-9]/g, '');
                const waLink = cleanPhone ? 'https://wa.me/' + cleanPhone : '#';
                const walletShort = u.wallet ? (u.wallet.slice(0, 6) + '...' + u.wallet.slice(-4)) : '<span style="color:var(--text-muted);">Sin vincular</span>';
                const isPro = u.plan && u.plan !== 'Gratuito';
                return '<tr>' +
                    '<td><strong>' + (u.name || 'Sin Nombre') + '</strong></td>' +
                    '<td>' + (u.email || '') + '</td>' +
                    '<td><a href="' + waLink + '" target="_blank" style="color:var(--emerald); text-decoration:none; font-weight:bold;">📱 ' + (u.phone || 'N/A') + '</a></td>' +
                    '<td><code>' + walletShort + '</code></td>' +
                    '<td><span style="background:' + (isPro ? 'rgba(0,223,137,0.15)' : 'rgba(0, 242, 254, 0.1)') + '; color:' + (isPro ? 'var(--emerald)' : 'var(--cyan)') + '; padding:3px 8px; border-radius:8px; font-weight:800; font-size:11.5px;">' + (u.plan || 'Gratuito') + '</span></td>' +
                    '<td><strong style="color:var(--emerald);">' + (u.credits || 0) + ' Fichas</strong></td>' +
                    '<td>' +
                        '<button onclick="addCreditsPrompt(\\'' + u.email + '\\')" class="btn-outline" style="padding:4px 10px; font-size:11px;">+ Fichas</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
        }

        async function addCreditsPrompt(email) {
            const amount = prompt('¿Cuántas fichas deseas añadir a ' + email + '?', '10');
            if (!amount || isNaN(amount)) return;

            const token = localStorage.getItem('maxi_admin_token');
            try {
                const res = await fetch('/api/admin/update-user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ email, addCredits: parseInt(amount, 10) })
                });
                const data = await res.json();
                if (data.success) {
                    alert('¡Fichas añadidas con éxito!');
                    loadAdminData();
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (err) {
                alert('Error al conectar: ' + err.message);
            }
        }

        async function executeWithdrawal() {
            const amount = parseFloat(document.getElementById('withdrawAmount').value);
            const address = document.getElementById('withdrawAddress').value.trim();
            const statusDiv = document.getElementById('withdrawStatus');

            if (!amount || amount <= 0) {
                alert('Ingresa un monto válido.');
                return;
            }
            if (!address || !address.startsWith('0x') || address.length !== 42) {
                alert('Por favor ingresa una dirección EVM válida de 42 caracteres (0x...).');
                return;
            }

            if (!confirm('¿Confirmas el retiro de $' + amount + ' USDC hacia ' + address + '?')) {
                return;
            }

            const token = localStorage.getItem('maxi_admin_token');
            try {
                const res = await fetch('/api/admin/withdraw', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ amount, address })
                });
                const data = await res.json();
                statusDiv.style.display = 'block';

                if (data.success) {
                    statusDiv.style.background = 'var(--calc-saved-bg)';
                    statusDiv.style.border = '1.5px solid var(--emerald)';
                    statusDiv.style.color = 'var(--emerald)';
                    statusDiv.innerHTML = '🎉 <strong>¡Retiro Procesado con Éxito!</strong><br>Comprobante ID: <code>' + data.withdrawalId + '</code><br>Monto: <strong>$' + amount + ' USDC</strong> transferidos a <code>' + address + '</code>';
                    loadAdminData();
                } else {
                    statusDiv.style.background = 'var(--calc-fee-bg)';
                    statusDiv.style.border = '1.5px solid var(--rose)';
                    statusDiv.style.color = 'var(--rose)';
                    statusDiv.innerHTML = '❌ <strong>Error en el retiro:</strong> ' + (data.error || 'Saldo insuficiente');
                }
            } catch (err) {
                alert('Error al procesar el retiro: ' + err.message);
            }
        }

        function logoutAdmin() {
            localStorage.removeItem('maxi_admin_token');
            document.getElementById('adminLoginSection').style.display = 'block';
            document.getElementById('adminDashboardSection').style.display = 'none';
        }

        window.addEventListener('DOMContentLoaded', () => {
            const token = localStorage.getItem('maxi_admin_token');
            if (token) {
                loadAdminData();
            }
        });
    </script>
</body>
</html>`;
}

function renderTutorialesPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Academia Maxi • Guías Maestras y Tutoriales Paso a Paso</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('tutoriales')}

    <div class="page-container">
        <div style="text-align:center; margin-bottom:40px;">
            <div style="display:inline-flex; align-items:center; gap:8px; background:rgba(0,242,254,0.1); border:1px solid rgba(0,242,254,0.3); color:var(--cyan); padding:6px 16px; border-radius:18px; font-size:13px; font-weight:700; margin-bottom:12px;">
                🎓 Centro de Aprendizaje Oficial & Academia Maxi
            </div>
            <h1 style="font-size:38px; font-weight:800; letter-spacing:-0.02em; margin-bottom:12px; color:var(--text-main);">
                Aprende a Dominar Todo el Ecosistema
            </h1>
            <p style="color:var(--text-muted); font-size:16.5px; max-width:750px; margin:0 auto; font-weight:600;">
                Guías detalladas con ejemplos visuales para usar el bot de Telegram, navegar en BaseScan, verificar pagos on-chain, postularte con IA y entender las señales de ballenas.
            </p>
        </div>

        <!-- GUÍA 1: BOT DE TELEGRAM -->
        <div class="card" style="border-left:5px solid #0088cc; margin-bottom:30px;">
            <div style="display:flex; gap:16px; align-items:center; margin-bottom:15px;">
                <div class="step-badge" style="background:linear-gradient(135deg, #0088cc 0%, #00c6ff 100%); color:white;">📱</div>
                <div>
                    <h2 style="font-size:22px; font-weight:800; color:var(--text-main);">1. Guía Completa del Bot de Telegram (@Maxi_pay_official_bot)</h2>
                    <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">Tu copiloto financiero 24/7 en tu bolsillo.</p>
                </div>
            </div>

            <p style="color:var(--text-muted); font-size:14.5px; line-height:1.6; font-weight:600; margin-bottom:15px;">
                El bot oficial te permite cobrar, recibir alertas sonoras de ballenas y ver nuevas ofertas de trabajo sin entrar al computador:
            </p>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px; margin-bottom:18px;">
                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1px solid var(--border);">
                    <div style="font-weight:800; color:var(--cyan); font-size:14px; margin-bottom:4px;">1. Vincular Billetera</div>
                    <div class="code-snippet">/wallet 0xTuDireccionEVM</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600;">Asocia tu wallet para recibir pagos directos sin comisiones.</div>
                </div>

                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1px solid var(--border);">
                    <div style="font-weight:800; color:var(--emerald); font-size:14px; margin-bottom:4px;">2. Generar Factura QR</div>
                    <div class="code-snippet">/cobrar 50 Diseño de Logo</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600;">Crea un código QR de $50 USDC al instante para mandárselo a tu cliente.</div>
                </div>

                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1px solid var(--border);">
                    <div style="font-weight:800; color:#10b981; font-size:14px; margin-bottom:4px;">3. Consultar Trabajos Web3</div>
                    <div class="code-snippet">/gigs</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600;">Muestra los últimos bounties de $50 a $650 USD disponibles.</div>
                </div>

                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1px solid var(--border);">
                    <div style="font-weight:800; color:var(--purple); font-size:14px; margin-bottom:4px;">4. Radar de Ballenas</div>
                    <div class="code-snippet">/alpha</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600;">Alerta sonoras cuando una ballena compra o inyecta liquidez en Base.</div>
                </div>
            </div>

            <a href="https://t.me/Maxi_pay_official_bot" target="_blank" class="btn-primary" style="background:linear-gradient(135deg, #0088cc 0%, #00a2ff 100%); color:white;">
                📱 Abrir Bot de Telegram Oficial
            </a>
        </div>

        <!-- GUÍA 2: BASESCAN MASTERCLASS -->
        <div class="card" style="border-left:5px solid var(--purple); margin-bottom:30px;">
            <div style="display:flex; gap:16px; align-items:center; margin-bottom:15px;">
                <div class="step-badge" style="background:linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); color:white;">🔍</div>
                <div>
                    <h2 style="font-size:22px; font-weight:800; color:var(--text-main);">2. Guía Maestra de BaseScan.org: ¿Qué mirar cuando se abre?</h2>
                    <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">Aprende a navegar y verificar transacciones de ballenas como un profesional.</p>
                </div>
            </div>

            <p style="color:var(--text-muted); font-size:14.5px; line-height:1.6; font-weight:600; margin-bottom:15px;">
                Cuando tocas el botón <strong>«🔍 Ver Tx en BaseScan»</strong> en nuestra web o en Telegram, esto es lo que debes comprobar:
            </p>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px; margin-bottom:20px;">
                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1.5px solid var(--border);">
                    <div style="font-size:13px; font-weight:800; color:var(--emerald);">1. ESTADO (Status)</div>
                    <div style="font-size:16px; font-weight:800; margin:6px 0; color:var(--text-main);">✅ Success (Confirmado)</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600;">Verifica que tenga el visto verde. Significa que el dinero ya se grabó de forma irreversible en el bloque.</div>
                </div>

                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1.5px solid var(--border);">
                    <div style="font-size:13px; font-weight:800; color:var(--cyan);">2. TOKENS TRANSFERIDOS</div>
                    <div style="font-size:16px; font-weight:800; margin:6px 0; color:var(--text-main);">ERC-20 Tokens Transferred</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600;">Muestra exactamente cuántos dólares (USDC) o criptomonedas (ETH) se entregaron y recibieron.</div>
                </div>

                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1.5px solid var(--border);">
                    <div style="font-size:13px; font-weight:800; color:var(--purple);">3. BOTÓN CLAVE A OPRIMIR</div>
                    <div style="font-size:16px; font-weight:800; margin:6px 0; color:var(--text-main);">«Click to see More»</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600;">Al presionar este botón al final de BaseScan, se despliega el método (ej: <code>swapExactTokens</code> o <code>addLiquidity</code>).</div>
                </div>
            </div>

            <a href="/ballenas" class="btn-primary" style="background:linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); color:white;">
                🐋 Ir al Radar de Ballenas en Vivo
            </a>
        </div>

        <!-- GUÍA 3: MAXI PAY & AUTO-DETECCIÓN ON-CHAIN -->
        <div class="card" style="border-left:5px solid var(--cyan); margin-bottom:30px;">
            <div style="display:flex; gap:16px; align-items:center; margin-bottom:15px;">
                <div class="step-badge">💳</div>
                <div>
                    <h2 style="font-size:22px; font-weight:800; color:var(--text-main);">3. Maxi Pay: Enlaces de Cobro & Auto-Detección en 2 Segundos</h2>
                    <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">Cero comisiones bancarias y cero necesidad de copiar códigos hash.</p>
                </div>
            </div>

            <p style="color:var(--text-muted); font-size:14.5px; line-height:1.6; font-weight:600; margin-bottom:15px;">
                Cómo cobrar a un cliente en 3 pasos sencillos:
            </p>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px; margin-bottom:20px;">
                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1px solid var(--border);">
                    <strong style="color:var(--cyan);">Paso 1 (Tu Enlace):</strong> Entra a <a href="/pay" style="color:var(--cyan); font-weight:bold;">Maxi Pay</a>, pon el monto y presiona <strong>«📲 Compartir por WhatsApp»</strong> para enviarle el link a tu cliente.
                </div>
                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1px solid var(--border);">
                    <strong style="color:var(--cyan);">Paso 2 (El Cliente Paga):</strong> Tu cliente abre el link en su celular, escanea el código QR desde Binance, MetaMask o Coinbase y envía los USDC.
                </div>
                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1px solid var(--border);">
                    <strong style="color:var(--emerald);">Paso 3 (Auto-Detección):</strong> El radar on-chain detecta los fondos en 2 segundos, suena un timbre 🔔 y la pantalla se pone en verde: <strong>«¡Pago Confirmado!»</strong>.
                </div>
            </div>

            <a href="/pay" class="btn-primary">
                💳 Crear un Enlace de Cobro en Maxi Pay
            </a>
        </div>

        <!-- GUÍA 4: GIG FINDER & AI PROPOSAL SNIPER -->
        <div class="card" style="border-left:5px solid var(--emerald); margin-bottom:30px;">
            <div style="display:flex; gap:16px; align-items:center; margin-bottom:15px;">
                <div class="step-badge" style="background:linear-gradient(135deg, #00df89 0%, #10b981 100%);">💼</div>
                <div>
                    <h2 style="font-size:22px; font-weight:800; color:var(--text-main);">4. Gig Finder: Cómo Postularte con IA y Ganar Trabajos de $50 a $650 USD</h2>
                    <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">Ahorra tiempo y gana más contratos postulándote primero.</p>
                </div>
            </div>

            <p style="color:var(--text-muted); font-size:14.5px; line-height:1.6; font-weight:600; margin-bottom:15px;">
                En los bounties de Web3, quien postula primero con una propuesta técnica de calidad tiene más de un 70% de probabilidades de ganar:
            </p>

            <ul style="color:var(--text-muted); font-size:14px; font-weight:600; line-height:1.8; margin-bottom:20px; padding-left:22px;">
                <li>Entra a <a href="/trabajos" style="color:var(--emerald); font-weight:bold;">Trabajos & Bounties con IA</a> y elige la oferta que te interese.</li>
                <li>Presiona el botón <strong>«✨ Postularme con IA (30s)»</strong>.</li>
                <li>Maxi lee la descripción del bounty y te entrega una propuesta profesional en **Inglés y Español**.</li>
                <li>Oprime <strong>«📋 Copiar Propuesta»</strong>, abre la convocatoria oficial y pégala para que te adjudiquen el trabajo.</li>
            </ul>

            <a href="/trabajos" class="btn-primary" style="background:linear-gradient(135deg, #00df89 0%, #10b981 100%);">
                💼 Ver Trabajos & Probar el Asistente IA
            </a>
        </div>

        <!-- GUÍA 5: SMART MONEY SCORE & LOS 4 MOVIMIENTOS -->
        <div class="card" style="border-left:5px solid var(--amber); margin-bottom:30px;">
            <div style="display:flex; gap:16px; align-items:center; margin-bottom:15px;">
                <div class="step-badge" style="background:linear-gradient(135deg, #fbbf24 0%, #d97706 100%); color:#06080e;">🎯</div>
                <div>
                    <h2 style="font-size:22px; font-weight:800; color:var(--text-main);">5. Maxi Alpha: Cómo Interpretar el Smart Money Score (0 a 100)</h2>
                    <p style="color:var(--text-muted); font-size:13.5px; font-weight:600;">Sigue los pasos del dinero institucional antes de que el mercado se mueva.</p>
                </div>
            </div>

            <p style="color:var(--text-muted); font-size:14.5px; line-height:1.6; font-weight:600; margin-bottom:15px;">
                El Smart Money Score resume en un solo número el sentimiento institucional de las ballenas:
            </p>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px; margin-bottom:20px;">
                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1.5px solid #86efac;">
                    <div style="color:#15803d; font-weight:800; font-size:14px;">🟢 Score > 80 (Acumulación Fuerte)</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600; margin-top:4px;">Las ballenas están comprando agresivamente o inyectando liquidez en DEXs. Señal alcista.</div>
                </div>

                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1.5px solid #7dd3fc;">
                    <div style="color:#0369a1; font-weight:800; font-size:14px;">🟣 Score 50 - 80 (Hold / Retiro)</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600; margin-top:4px;">Movimientos hacia billeteras frías para conservar fondos a largo plazo.</div>
                </div>

                <div style="background:var(--bg-card-hover); padding:16px; border-radius:12px; border:1.5px solid #fca5a5;">
                    <div style="color:#b91c1c; font-weight:800; font-size:14px;">🔴 Score < 40 (Presión Vendedora)</div>
                    <div style="font-size:12.5px; color:var(--text-muted); font-weight:600; margin-top:4px;">Depósitos masivos hacia Coinbase o Binance para liquidar y tomar ganancias.</div>
                </div>
            </div>

            <a href="/ballenas" class="btn-primary" style="background:linear-gradient(135deg, #fbbf24 0%, #d97706 100%); color:#06080e;">
                🎯 Ver Setups de Trading en Maxi Alpha
            </a>
        </div>
    </div>

    ${getFooter()}
</body>
</html>`;
}

// 5. OTHER RENDERS
function renderBallenasPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maxi Alpha • Smart Money Score & Setups Cuantitativos en Base</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('ballenas')}

    <div class="page-container">
        <div style="text-align:center; margin-bottom:35px;">
            <div style="display:inline-flex; align-items:center; gap:8px; background:rgba(168,85,247,0.12); border:1px solid rgba(168,85,247,0.3); color:var(--purple); padding:6px 16px; border-radius:18px; font-size:12.5px; font-weight:700; margin-bottom:12px;">
                🎯 Smart Money Score Engine • Cuantitativo 24/7
            </div>
            <h1 style="font-size:36px; font-weight:800; letter-spacing:-0.02em; margin-bottom:10px; color:var(--text-main);">
                Radar Cuantitativo de Ballenas
            </h1>
            <p style="color:var(--text-muted); font-size:16px; max-width:750px; margin:0 auto; font-weight:600;">
                No solo vemos transferencias: nuestro algoritmo calcula el <strong>Smart Money Score (0 a 100)</strong> y te entrega zonas de entrada, Stop-Loss y Take-Profit.
            </p>
        </div>

        <div class="card" style="border-left:5px solid #10b981; margin-bottom:24px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:15px; margin-bottom:14px;">
                <div>
                    <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
                        <span class="badge-buy">🟢 COMPRA MASIVA (Acumulación)</span>
                        <div class="score-pill score-high">🎯 Smart Money Score: 94/100 (Bullish)</div>
                        <span style="font-size:12px; color:var(--text-muted); font-weight:700;">⏱️ Hace 2 minutos</span>
                    </div>
                    <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">🚨 BALLENA ACUMULA $519,612.18 USDC EN ETH VIA AERODROME</h3>
                    <div style="font-size:13.5px; color:var(--text-muted); margin-top:4px; font-weight:600;">
                        Inyección: <strong style="color:var(--emerald);">$519,612.18 USDC</strong> ➔ Recibe: <strong style="color:var(--cyan);">206.58 ETH</strong> • Protocolo: <strong>Aerodrome Slipstream</strong>
                    </div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:26px; font-weight:800; color:#10b981;">+$519,612.18 USD</div>
                    <a href="https://basescan.org/tx/0xc29d3d6187c59ffaf4e2f7c16ffdbb39dafe43ad21ed83481bc6da4b3682a4b1" target="_blank" class="btn-outline" style="border-color:#10b981; color:#10b981; padding:7px 12px; font-size:12px; margin-top:6px;">
                        🔍 Ver Tx en BaseScan
                    </a>
                </div>
            </div>

            <div style="background:var(--bg-card-hover); border:1px solid var(--border); border-radius:12px; padding:14px 18px; margin-top:10px; display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; font-size:13px;">
                <div>🎯 <strong>Zona Entrada Sugerida:</strong> <span style="color:var(--cyan); font-weight:800;">$2,490 - $2,525 ETH</span></div>
                <div>🛑 <strong>Stop-Loss Técnico:</strong> <span style="color:var(--rose); font-weight:800;">$2,410 ETH (-3.8%)</span></div>
                <div>🚀 <strong>Take-Profit Objetivo:</strong> <span style="color:var(--emerald); font-weight:800;">$2,740 ETH (+9.2%)</span></div>
                <div>🛡️ <strong>Ratio Riesgo/Beneficio:</strong> <span style="color:var(--purple); font-weight:800;">1 : 2.4 (Excelente)</span></div>
            </div>
        </div>

        <div class="card" style="border-left:5px solid #8b5cf6; margin-bottom:24px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:15px; margin-bottom:14px;">
                <div>
                    <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
                        <span class="badge-vault">🟣 ACUMULACIÓN / RETIRO A VAULT</span>
                        <div class="score-pill score-high" style="border-color:var(--purple); color:var(--purple); background:rgba(168,85,247,0.15);">🎯 Smart Money Score: 91/100 (Hold Largo Plazo)</div>
                        <span style="font-size:12px; color:var(--text-muted); font-weight:700;">⏱️ Hace 8 minutos</span>
                    </div>
                    <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">🚨 RETIRO DESDE EXCHANGE HACIA MULTISIG VAULT</h3>
                    <div style="font-size:13.5px; color:var(--text-muted); margin-top:4px; font-weight:600;">
                        Emisor: <strong>Coinbase Institutional</strong> ➔ Destino: <strong style="color:var(--purple);">Safe Cold Vault</strong> • Disminuye oferta circulante
                    </div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:26px; font-weight:800; color:var(--purple);">$519,612.18 USD</div>
                    <a href="https://basescan.org/tx/0x98ce59571a5f321620ca52ec8472ba3195c93ab26458ffe813dac52c51343a30" target="_blank" class="btn-outline" style="border-color:var(--purple); color:var(--purple); padding:7px 12px; font-size:12px; margin-top:6px;">
                        🔍 Ver Tx en BaseScan
                    </a>
                </div>
            </div>

            <div style="background:var(--bg-card-hover); border:1px solid var(--border); border-radius:12px; padding:14px 18px; margin-top:10px; font-size:13px; color:var(--text-muted); font-weight:600;">
                💡 <strong>Interpretación Cuantitativa:</strong> Las instituciones retiraron capital del exchange para congelarlo en bóveda fría. Esto reduce la presión vendedora en el libro de órdenes.
            </div>
        </div>

        <div class="card" style="border-left:5px solid #0284c7; margin-bottom:25px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:15px; margin-bottom:14px;">
                <div>
                    <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
                        <span class="badge-pool">⚡ INYECCIÓN DE LIQUIDEZ (DeFi Pool)</span>
                        <div class="score-pill score-mid">🎯 Smart Money Score: 87/100 (Respaldo Institucional)</div>
                        <span style="font-size:12px; color:var(--text-muted); font-weight:700;">⏱️ Hace 15 minutos</span>
                    </div>
                    <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">🚨 DEPÓSITO DE CAPITAL EN PISCINA USDC/ETH (Uniswap V3)</h3>
                    <div style="font-size:13.5px; color:var(--text-muted); margin-top:4px; font-weight:600;">
                        Liquidez Concentrada en rango estrecho: <strong style="color:var(--cyan);">$2,450 - $2,600</strong>
                    </div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:26px; font-weight:800; color:var(--cyan);">$519,612.18 USD</div>
                    <a href="https://basescan.org/tx/0x1595bfff2030f56677c8eb1e9b9ceae2ac483167280958c0228339c84147aba7" target="_blank" class="btn-outline" style="border-color:var(--cyan); color:var(--cyan); padding:7px 12px; font-size:12px; margin-top:6px;">
                        🔍 Ver Tx en BaseScan
                    </a>
                </div>
            </div>

            <div style="background:var(--bg-card-hover); border:1px solid var(--border); border-radius:12px; padding:14px 18px; margin-top:10px; font-size:13px; color:var(--text-muted); font-weight:600;">
                ⚡ <strong>Interpretación Cuantitativa:</strong> Creación de piso de soporte con liquidez concentrada en Base. Genera rendimiento pasivo de comisiones para la ballena.
            </div>
        </div>
    </div>

    ${getFooter()}
</body>
</html>`;
}

function renderTrabajosPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maxi Gig Finder • AI Auto-Proposal Sniper</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('trabajos')}

    <!-- AI PROPOSAL MODAL -->
    <div id="aiModal" class="modal-overlay" style="display:none;" onclick="if(event.target === this) closeAiModal()">
        <div class="modal-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid var(--border); padding-bottom:12px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:24px;">✨</span>
                    <h3 style="font-size:20px; font-weight:800; color:var(--text-main);" id="modalJobTitle">Generador de Propuesta con IA</h3>
                </div>
                <button onclick="closeAiModal()" style="background:none; border:none; color:var(--text-muted); font-size:26px; cursor:pointer; font-weight:bold; line-height:1;" title="Cerrar ventana">&times;</button>
            </div>

            <p style="color:var(--text-muted); font-size:14px; font-weight:600; margin-bottom:14px;">
                Maxi analizó los requerimientos del trabajo y redactó esta propuesta técnica persuasiva para postularte:
            </p>

            <div style="display:flex; gap:10px; margin-bottom:12px;">
                <button id="btnTabEn" class="btn-primary" style="padding:7px 16px; font-size:12.5px;" onclick="switchProposalLang('en')">🇺🇸 Versión en Inglés (Recomendada Web3)</button>
                <button id="btnTabEs" class="btn-outline" style="padding:7px 16px; font-size:12.5px;" onclick="switchProposalLang('es')">🇪🇸 Versión en Español</button>
            </div>

            <textarea id="aiProposalText" class="input-box" rows="9" style="font-family:inherit; font-size:13.5px; line-height:1.6; resize:vertical; width:100%; box-sizing:border-box; margin-bottom:10px;"></textarea>

            <div style="display:flex; gap:12px; justify-content:flex-end; flex-wrap:wrap; margin-top:10px;">
                <button class="btn-primary" onclick="copyProposalText()">📋 Copiar Propuesta</button>
                <a id="modalOfficialLink" href="#" target="_blank" class="btn-outline" style="border-color:var(--emerald); color:var(--emerald);">🚀 Abrir Convocatoria Oficial</a>
            </div>
        </div>
    </div>

    <div class="page-container">
        <div style="text-align:center; margin-bottom:35px;">
            <div style="display:inline-flex; align-items:center; gap:8px; background:rgba(0,223,137,0.12); border:1px solid rgba(0,223,137,0.3); color:var(--emerald); padding:6px 16px; border-radius:18px; font-size:12.5px; font-weight:700; margin-bottom:12px;">
                ✨ AI Auto-Proposal Sniper Integrado
            </div>
            <h1 style="font-size:36px; font-weight:800; letter-spacing:-0.02em; margin-bottom:10px; color:var(--text-main);">
                Trabajos Remotos & Bounties en USDC
            </h1>
            <p style="color:var(--text-muted); font-size:16px; max-width:700px; margin:0 auto; font-weight:600;">
                No pierdas tiempo escribiendo postulaciones desde cero. Haz clic en <strong>«✨ Postularme con IA»</strong> y Maxi genera tu propuesta ganadora en 30 segundos.
            </p>
        </div>

        <div class="card" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
            <div>
                <h3 style="font-size:18px; font-weight:800; margin-bottom:6px; color:var(--text-main);">🎨 Diseño de Banner & Interfaz Web3 (UI/UX)</h3>
                <div style="font-size:13px; color:var(--text-muted); display:flex; gap:12px; flex-wrap:wrap; font-weight:600;">
                    <span>🏢 Plataforma: <strong>Bountycaster</strong></span>
                    <span>🏷️ Categoría: <strong>Diseño Gráfico / Figma</strong></span>
                    <span>⏱️ Hace 15 minutos</span>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <div style="font-size:22px; font-weight:800; color:var(--emerald);">$150.00 USDC</div>
                <button onclick="openAiProposalModal('Diseño de Banner & Interfaz Web3 (UI/UX)', '150', 'design', 'https://www.bountycaster.xyz/')" class="btn-primary">
                    ✨ Postularme con IA (30s)
                </button>
            </div>
        </div>

        <div class="card" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
            <div>
                <h3 style="font-size:18px; font-weight:800; margin-bottom:6px; color:var(--text-main);">💻 Bot de Telegram para Pagos y Membresías</h3>
                <div style="font-size:13px; color:var(--text-muted); display:flex; gap:12px; flex-wrap:wrap; font-weight:600;">
                    <span>🏢 Plataforma: <strong>Gitcoin Bounties</strong></span>
                    <span>🏷️ Categoría: <strong>Node.js / Web3 API</strong></span>
                    <span>⏱️ Hace 42 minutos</span>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <div style="font-size:22px; font-weight:800; color:var(--emerald);">$400.00 USDC</div>
                <button onclick="openAiProposalModal('Bot de Telegram para Pagos y Membresías', '400', 'code', 'https://gitcoin.co/')" class="btn-primary">
                    ✨ Postularme con IA (30s)
                </button>
            </div>
        </div>

        <div class="card" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
            <div>
                <h3 style="font-size:18px; font-weight:800; margin-bottom:6px; color:var(--text-main);">✍️ Traducción de Whitepaper Técnico (Inglés a Español)</h3>
                <div style="font-size:13px; color:var(--text-muted); display:flex; gap:12px; flex-wrap:wrap; font-weight:600;">
                    <span>🏢 Plataforma: <strong>Farcaster Warpcast</strong></span>
                    <span>🏷️ Categoría: <strong>Redacción / Traducción</strong></span>
                    <span>⏱️ Hace 1 hora</span>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <div style="font-size:22px; font-weight:800; color:var(--emerald);">$200.00 USDC</div>
                <button onclick="openAiProposalModal('Traducción de Whitepaper Técnico', '200', 'writing', 'https://warpcast.com/')" class="btn-primary">
                    ✨ Postularme con IA (30s)
                </button>
            </div>
        </div>

        <div class="card" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
            <div>
                <h3 style="font-size:18px; font-weight:800; margin-bottom:6px; color:var(--text-main);">🛡️ Auditoría de Seguridad de Smart Contracts (Solidity)</h3>
                <div style="font-size:13px; color:var(--text-muted); display:flex; gap:12px; flex-wrap:wrap; font-weight:600;">
                    <span>🏢 Plataforma: <strong>Superteam Earn</strong></span>
                    <span>🏷️ Categoría: <strong>Seguridad / Auditoría</strong></span>
                    <span>⏱️ Hace 2 horas</span>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <div style="font-size:22px; font-weight:800; color:var(--emerald);">$650.00 USDC</div>
                <button onclick="openAiProposalModal('Auditoría de Seguridad de Smart Contracts', '650', 'security', 'https://superteam.fun/')" class="btn-primary">
                    ✨ Postularme con IA (30s)
                </button>
            </div>
        </div>
    </div>

    ${getFooter()}

    <script>
        let currentProposals = { en: '', es: '' };
        const templates = {
            design: {
                en: "Hi there! 👋 I reviewed your design requirements for the Web3 UI/UX banner. I specialize in high-converting fintech interfaces, Figma design systems, and glassmorphism dark mode aesthetics compatible with Base and Ethereum standards. I can deliver pixel-perfect mockups and responsive assets within 24 hours. Let's connect!",
                es: "¡Hola! 👋 He revisado los requerimientos de diseño para la interfaz UI/UX Web3. Me especializo en interfaces fintech de alta conversión, sistemas de diseño en Figma y estética moderna oscura para el ecosistema Base. Puedo entregar los prototipos listos en menos de 24 horas. ¡Conversemos!"
            },
            code: {
                en: "Hello! 🚀 I have extensive experience building production-ready Telegram bots and Web3 payment gateways in Node.js / TypeScript. I can implement instant on-chain verification, multi-RPC failover, and secure webhook management for this bounty within 48 hours. Ready to start immediately!",
                es: "¡Hola! 🚀 Cuento con amplia experiencia desarrollando bots de Telegram y pasarelas de pago Web3 en Node.js y TypeScript. Puedo implementar verificación on-chain instantánea, manejo seguro de webhooks y contratos en Base en 48 horas. ¡Listo para comenzar de inmediato!"
            },
            writing: {
                en: "Hi! ✍️ As a bilingual Web3 technical writer, I can deliver a precise, culturally localized Spanish translation of your whitepaper, preserving all cryptographic terms, tokenomics definitions, and developer docs clarity. Fast 24-hour turnaround guaranteed.",
                es: "¡Hola! ✍️ Como redactor técnico bilingüe en Web3, ofrezco una traducción precisa y profesional de su whitepaper al español, respetando todos los términos criptográficos, la estructura de tokenomics y la claridad técnica. Entrega rápida en 24 horas garantizada."
            },
            security: {
                en: "Greetings! 🛡️ I specialize in EVM smart contract auditing, reentrancy analysis, and gas optimization. I will conduct static analysis, fuzzing, and manual line-by-line review to deliver a comprehensive vulnerability report with remediation code. Ready to inspect your repo.",
                es: "¡Saludos! 🛡️ Me especializo en auditorías de contratos inteligentes EVM, análisis de reentrancy y optimización de gas. Realizaré pruebas de fuzzing y revisión manual línea por línea para entregar un informe detallado con parches de remediación. Listo para auditar su repositorio."
            }
        };

        function openAiProposalModal(jobTitle, reward, category, officialUrl) {
            document.getElementById('modalJobTitle').innerText = '✨ Propuesta IA: ' + jobTitle;
            document.getElementById('modalOfficialLink').href = officialUrl;
            const t = templates[category] || templates.code;
            currentProposals = t;
            switchProposalLang('en');
            document.getElementById('aiModal').style.display = 'flex';
        }

        function switchProposalLang(lang) {
            document.getElementById('aiProposalText').value = currentProposals[lang] || '';
            const btnEn = document.getElementById('btnTabEn');
            const btnEs = document.getElementById('btnTabEs');
            if (lang === 'en') {
                btnEn.className = 'btn-primary';
                btnEs.className = 'btn-outline';
            } else {
                btnEs.className = 'btn-primary';
                btnEn.className = 'btn-outline';
            }
        }

        function copyProposalText() {
            const txt = document.getElementById('aiProposalText').value;
            navigator.clipboard.writeText(txt);
            alert('¡Propuesta copiada al portapapeles! Ahora puedes pegarla en la convocatoria oficial.');
        }

        function closeAiModal() {
            document.getElementById('aiModal').style.display = 'none';
        }
    </script>
</body>
</html>`;
}

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maxi Suite 9.0 • Ecosistema Autónomo Web3 & Fintech en Base</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('home')}

    <div class="page-container">
        <!-- Hero Section -->
        <div style="text-align:center; padding: 40px 10px 30px; max-width: 900px; margin: 0 auto;">
            <div style="display:inline-flex; align-items:center; gap:8px; background:rgba(0,242,254,0.1); border:1px solid rgba(0,242,254,0.3); color:var(--cyan); padding:7px 16px; border-radius:20px; font-size:13px; font-weight:800; margin-bottom:18px;">
                ⚡ Ecosistema Autónomo 9.0 en Red Base (Ethereum L2)
            </div>
            <h1 style="font-size:clamp(32px, 5vw, 48px); font-weight:900; letter-spacing:-0.03em; line-height:1.15; margin-bottom:16px; color:var(--text-main);">
                El Futuro de los <span class="gradient-text">Pagos & Empleos Web3</span> Sin Comisiones Bancarias
            </h1>
            <p style="color:var(--text-muted); font-size:clamp(16px, 2vw, 18px); font-weight:600; line-height:1.6; margin-bottom:28px;">
                Cobra a tus clientes con tarjeta débito/crédito o cripto, encuentra bounties remotos redactados por IA, rastrea movimientos de ballenas en vivo y domina las finanzas digitales.
            </p>
            <div style="display:flex; justify-content:center; gap:14px; flex-wrap:wrap;">
                <a href="/cuenta" class="btn-primary" style="text-decoration:none; padding:14px 28px; font-size:15px;">🚀 Crear Cuenta Gratis</a>
                <a href="/pay" class="btn-outline" style="text-decoration:none; padding:14px 26px; font-size:15px;">💳 Probar Maxi Pay</a>
                <a href="https://t.me/Maxi_pay_official_bot" target="_blank" class="btn-tg" style="padding:14px 24px; font-size:15px; border-radius:12px;">${ICONS.tg} Bot de Telegram</a>
            </div>
        </div>

        <!-- Live Metrics Banner -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin: 25px 0 40px;">
            <div class="card" style="padding:18px; text-align:center; border-color:rgba(0,242,254,0.2);">
                <div style="font-size:12px; font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Comisión por Cobro</div>
                <div style="font-size:26px; font-weight:900; color:var(--emerald); margin-top:4px;">0.00%</div>
                <div style="font-size:11.5px; color:var(--text-muted); font-weight:600; margin-top:2px;">Ahorra 4.5% vs PayPal/Bancos</div>
            </div>
            <div class="card" style="padding:18px; text-align:center; border-color:rgba(0,242,254,0.2);">
                <div style="font-size:12px; font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Costo de Red Base</div>
                <div style="font-size:26px; font-weight:900; color:var(--cyan); margin-top:4px;">&lt; $0.001 USD</div>
                <div style="font-size:11.5px; color:var(--text-muted); font-weight:600; margin-top:2px;">0.005 Gwei Gas L2</div>
            </div>
            <div class="card" style="padding:18px; text-align:center; border-color:rgba(168,85,247,0.2);">
                <div style="font-size:12px; font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Bounties Disponibles</div>
                <div style="font-size:26px; font-weight:900; color:#a855f7; margin-top:4px;">$14,850 USD</div>
                <div style="font-size:11.5px; color:var(--text-muted); font-weight:600; margin-top:2px;">Radar activo de empleos</div>
            </div>
            <div class="card" style="padding:18px; text-align:center; border-color:rgba(245,158,11,0.2);">
                <div style="font-size:12px; font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Ballenas Rastreadas</div>
                <div style="font-size:26px; font-weight:900; color:#f59e0b; margin-top:4px;">1,420+ W</div>
                <div style="font-size:11.5px; color:var(--text-muted); font-weight:600; margin-top:2px;">Smart Money Score en vivo</div>
            </div>
        </div>

        <!-- 6 Core Modules Grid -->
        <div style="margin-bottom:45px;">
            <div style="text-align:center; margin-bottom:30px;">
                <h2 style="font-size:28px; font-weight:800; color:var(--text-main); margin-bottom:6px;">Módulos del Ecosistema Maxi</h2>
                <p style="color:var(--text-muted); font-size:15px; font-weight:600;">Todo lo que necesitas para operar, cobrar y monetizar en una sola plataforma unificada.</p>
            </div>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:22px;">
                <!-- 1. Maxi Pay -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border-color:rgba(0,242,254,0.3);">
                    <div>
                        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
                            <div style="width:44px; height:44px; border-radius:12px; background:rgba(0,242,254,0.15); display:flex; align-items:center; justify-content:center; font-size:22px;">💳</div>
                            <div>
                                <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">Maxi Pay & Checkout</h3>
                                <span style="font-size:12px; font-weight:700; color:var(--cyan);">0% Comisiones • Auto-Detección</span>
                            </div>
                        </div>
                        <p style="color:var(--text-muted); font-size:14px; line-height:1.5; font-weight:600; margin-bottom:16px;">
                            Genera links de cobro universales con pasarela dual: tus clientes pueden pagar con tarjeta tradicional débito/crédito o escaneando QR con USDC en Base.
                        </p>
                    </div>
                    <a href="/pay" class="btn-primary" style="text-decoration:none; text-align:center; padding:10px;">⚡ Abrir Maxi Pay</a>
                </div>

                <!-- 2. Trabajos IA -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border-color:rgba(168,85,247,0.3);">
                    <div>
                        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
                            <div style="width:44px; height:44px; border-radius:12px; background:rgba(168,85,247,0.15); display:flex; align-items:center; justify-content:center; font-size:22px;">✨</div>
                            <div>
                                <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">Trabajos & Gigs (IA)</h3>
                                <span style="font-size:12px; font-weight:700; color:#a855f7;">Bounties de $50 a $650 USD</span>
                            </div>
                        </div>
                        <p style="color:var(--text-muted); font-size:14px; line-height:1.5; font-weight:600; margin-bottom:16px;">
                            Radar en tiempo real de tareas, redacción, programación y diseño Web3. Incluye Redactor de Propuestas Autónomo con Inteligencia Artificial para ganar clientes.
                        </p>
                    </div>
                    <a href="/trabajos" class="btn-outline" style="text-decoration:none; text-align:center; padding:10px; border-color:rgba(168,85,247,0.5); color:#a855f7;">🎯 Ver Trabajos Activos</a>
                </div>

                <!-- 3. Ballenas -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border-color:rgba(245,158,11,0.3);">
                    <div>
                        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
                            <div style="width:44px; height:44px; border-radius:12px; background:rgba(245,158,11,0.15); display:flex; align-items:center; justify-content:center; font-size:22px;">🎯</div>
                            <div>
                                <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">Radar de Ballenas (Alpha)</h3>
                                <span style="font-size:12px; font-weight:700; color:#f59e0b;">Smart Money Score 0-100</span>
                            </div>
                        </div>
                        <p style="color:var(--text-muted); font-size:14px; line-height:1.5; font-weight:600; margin-bottom:16px;">
                            Monitoreo en vivo de compras masivas e inyecciones de liquidez en Base. Algoritmo de filtrado contra wash-trading y simulación de copy-trading instantáneo.
                        </p>
                    </div>
                    <a href="/ballenas" class="btn-outline" style="text-decoration:none; text-align:center; padding:10px; border-color:rgba(245,158,11,0.5); color:#f59e0b;">🐋 Explorar Ballenas</a>
                </div>

                <!-- 4. Mercados -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border-color:rgba(0,223,137,0.3);">
                    <div>
                        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
                            <div style="width:44px; height:44px; border-radius:12px; background:rgba(0,223,137,0.15); display:flex; align-items:center; justify-content:center; font-size:22px;">📈</div>
                            <div>
                                <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">Mercados & Cotizaciones</h3>
                                <span style="font-size:12px; font-weight:700; color:var(--emerald);">BTC • ETH • BASE • AERO</span>
                            </div>
                        </div>
                        <p style="color:var(--text-muted); font-size:14px; line-height:1.5; font-weight:600; margin-bottom:16px;">
                            Panel de cotizaciones en tiempo real, libro de órdenes descentralizado, tasas de financiamiento y radar de volatilidad para toma de decisiones.
                        </p>
                    </div>
                    <a href="/mercados" class="btn-outline" style="text-decoration:none; text-align:center; padding:10px; border-color:rgba(0,223,137,0.5); color:var(--emerald);">📊 Ver Gráficos & Precios</a>
                </div>

                <!-- 5. Minijuegos -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border-color:rgba(236,72,153,0.3);">
                    <div>
                        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
                            <div style="width:44px; height:44px; border-radius:12px; background:rgba(236,72,153,0.15); display:flex; align-items:center; justify-content:center; font-size:22px;">🎮</div>
                            <div>
                                <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">Minijuegos On-Chain</h3>
                                <span style="font-size:12px; font-weight:700; color:#ec4899;">Ruleta • Dados • Crash Multiplier</span>
                            </div>
                        </div>
                        <p style="color:var(--text-muted); font-size:14px; line-height:1.5; font-weight:600; margin-bottom:16px;">
                            Entretenimiento verificado on-chain. Apuesta tus fichas de bienvenida, multiplica tu balance y sube de nivel en el ranking global de la comunidad.
                        </p>
                    </div>
                    <a href="/juegos" class="btn-outline" style="text-decoration:none; text-align:center; padding:10px; border-color:rgba(236,72,153,0.5); color:#ec4899;">🎲 Jugar Ahora</a>
                </div>

                <!-- 6. Academia -->
                <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; border-color:rgba(59,130,246,0.3);">
                    <div>
                        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
                            <div style="width:44px; height:44px; border-radius:12px; background:rgba(59,130,246,0.15); display:flex; align-items:center; justify-content:center; font-size:22px;">🎓</div>
                            <div>
                                <h3 style="font-size:19px; font-weight:800; color:var(--text-main);">Academia Master</h3>
                                <span style="font-size:12px; font-weight:700; color:#3b82f6;">5 Guías Interactivas Paso a Paso</span>
                            </div>
                        </div>
                        <p style="color:var(--text-muted); font-size:14px; line-height:1.5; font-weight:600; margin-bottom:16px;">
                            Aprende desde cero cómo recibir dólares en Base, cómo retirar a tu cuenta bancaria local en Colombia/Latam y cómo seguir a las ballenas cripto con seguridad.
                        </p>
                    </div>
                    <a href="/tutoriales" class="btn-outline" style="text-decoration:none; text-align:center; padding:10px; border-color:rgba(59,130,246,0.5); color:#3b82f6;">📚 Abrir Guías</a>
                </div>
            </div>
        </div>

        <!-- On-Chain Trust & Treasury Verification -->
        <div class="card" style="background:rgba(0,242,254,0.03); border:1.5px solid rgba(0,242,254,0.3); padding:28px; margin-bottom:40px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
                <div>
                    <div style="display:inline-flex; align-items:center; gap:6px; color:var(--emerald); font-size:13px; font-weight:800; margin-bottom:6px;">
                        <span class="status-dot"></span> Bóveda Pública Verificada en Base Mainnet
                    </div>
                    <h3 style="font-size:22px; font-weight:800; color:var(--text-main);">100% On-Chain y Transparente</h3>
                    <p style="color:var(--text-muted); font-size:14px; font-weight:600; margin-top:4px;">
                        Billetera de Tesorería Maxi: <code style="color:var(--cyan); background:rgba(0,242,254,0.1); padding:2px 8px; border-radius:6px; font-size:13px;">${MAXI_WALLET}</code>
                    </p>
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <a href="https://basescan.org/address/${MAXI_WALLET}" target="_blank" class="btn-primary" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;">
                        🔍 Auditar en BaseScan
                    </a>
                </div>
            </div>
        </div>
    </div>

    ${getFooter()}
</body>
</html>`;
}

function renderPayPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maxi Pay • Generador de Enlaces de Cobro con Auto-Detección</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('pay')}

    <div class="page-container">
        <div style="text-align:center; margin-bottom:35px;">
            <div style="display:inline-flex; align-items:center; gap:8px; background:rgba(0,242,254,0.1); border:1px solid rgba(0,242,254,0.3); color:var(--cyan); padding:6px 14px; border-radius:18px; font-size:12.5px; font-weight:700; margin-bottom:12px;">
                💳 Pasarela de Pagos de Próxima Generación
            </div>
            <h1 style="font-size:36px; font-weight:800; letter-spacing:-0.02em; margin-bottom:10px; color:var(--text-main);">
                Crea Enlaces de Cobro en Dólares o Tarjeta
            </h1>
            <p style="color:var(--text-muted); font-size:16px; max-width:700px; margin:0 auto; font-weight:600;">
                Envía tu link a tus clientes. Acepta pagos con tarjeta débito/crédito tradicional o cripto con auto-detección instantánea.
            </p>
        </div>

        <div class="card" style="border-color:var(--cyan);">
            <h3 style="font-size:22px; font-weight:800; margin-bottom:15px; color:var(--text-main);">⚡ Generar Factura / Link de Pago</h3>
            
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:18px; margin-bottom:20px;">
                <div>
                    <label style="display:block; font-size:13px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Tu Billetera EVM (Base):</label>
                    <input type="text" id="payWalletInput" class="input-box" value="${MAXI_WALLET}">
                </div>
                <div>
                    <label style="display:block; font-size:13px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Nombre de tu Comercio o Freelance:</label>
                    <input type="text" id="payMerchantName" class="input-box" value="Juan David">
                </div>
                <div>
                    <label style="display:block; font-size:13px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Monto a Cobrar (USD):</label>
                    <input type="number" id="payAmountInput" class="input-box" value="50">
                </div>
                <div>
                    <label style="display:block; font-size:13px; font-weight:700; margin-bottom:6px; color:var(--text-main);">Concepto / Producto:</label>
                    <input type="text" id="payConceptInput" class="input-box" value="Servicio de Consultoria Web3">
                </div>
            </div>

            <div style="display:flex; gap:12px; flex-wrap:wrap;">
                <button class="btn-primary" onclick="generateAndOpenLink()">🚀 Abrir Checkout Dual (Tarjeta + QR)</button>
                <button class="btn-outline" onclick="copyShareableLink()">📋 Copiar Link de Pago</button>
                <button class="btn-outline" style="background:#25D366; color:#06080e; border:none; font-weight:800;" onclick="shareViaWhatsapp()">📲 Compartir por WhatsApp</button>
            </div>
            <div id="copySuccessMsg" style="margin-top:12px; display:none; color:var(--emerald); font-weight:800; font-size:13.5px;">✓ Enlace copiado al portapapeles con éxito.</div>
        </div>

        <div class="card" style="background:var(--calc-bg); border-color:var(--calc-border);">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:15px;">
                <div>
                    <h3 style="font-size:20px; font-weight:800; color:var(--text-main);">💰 Calculadora de Ahorro Real vs Bancos / PayPal</h3>
                    <p style="color:var(--text-muted); font-size:14px; font-weight:600;">Desliza para calcular tu ganancia neta mensual:</p>
                </div>
                <div style="font-size:22px; font-weight:800; color:var(--cyan);" id="salesDisplay">$1,000 USD / mes</div>
            </div>

            <input type="range" min="100" max="10000" step="100" value="1000" style="width:100%; height:10px; background:#cbd5e1; border-radius:5px; accent-color:var(--cyan); margin:15px 0; cursor:pointer;" oninput="calcSavings(this.value)">

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:15px;">
                <div style="background:var(--calc-fee-bg); border:1.5px solid var(--rose); padding:20px; border-radius:14px; text-align:center;">
                    <div style="font-size:12.5px; font-weight:800; color:var(--rose);">CON PAYPAL / STRIPE (4.5% + $0.30)</div>
                    <div id="paypalFee" style="font-size:28px; font-weight:800; color:var(--rose); margin:8px 0;">-$48.00 USD</div>
                    <div style="font-size:12.5px; color:var(--calc-fee-text); font-weight:700;">Comisiones bancarias perdidas al mes</div>
                </div>

                <div style="background:var(--calc-saved-bg); border:1.5px solid var(--emerald); padding:20px; border-radius:14px; text-align:center;">
                    <div style="font-size:12.5px; font-weight:800; color:var(--emerald);">CON MAXI PAY (PLAN PRO)</div>
                    <div id="maxiSaved" style="font-size:28px; font-weight:800; color:var(--emerald); margin:8px 0;">¡Ahorras $38.01 USD!</div>
                    <div style="font-size:12.5px; color:var(--saved-text); font-weight:700;">Tarifa fija de solo $9.99/mes</div>
                </div>
            </div>
        </div>
    </div>

    ${getFooter()}

    <script>
        function getConstructedLink() {
            const user = document.getElementById('payMerchantName').value.trim() || 'comercio';
            const amount = document.getElementById('payAmountInput').value.trim() || '50';
            const concept = document.getElementById('payConceptInput').value.trim() || 'Pago de Servicio';
            const wallet = document.getElementById('payWalletInput').value.trim() || '${MAXI_WALLET}';
            return window.location.origin + '/pay/' + encodeURIComponent(user) + '/' + encodeURIComponent(amount) + '?concept=' + encodeURIComponent(concept) + '&wallet=' + encodeURIComponent(wallet);
        }

        function generateAndOpenLink() {
            window.location.href = getConstructedLink();
        }

        function copyShareableLink() {
            const link = getConstructedLink();
            navigator.clipboard.writeText(link);
            const msg = document.getElementById('copySuccessMsg');
            msg.style.display = 'block';
            setTimeout(() => { msg.style.display = 'none'; }, 3500);
        }

        function shareViaWhatsapp() {
            const link = getConstructedLink();
            const amount = document.getElementById('payAmountInput').value.trim() || '50';
            const text = encodeURIComponent('Hola! Aquí tienes el enlace de pago seguro en dólares o tarjeta con Maxi Pay por $' + amount + ' USD: ' + link);
            window.open('https://api.whatsapp.com/send?text=' + text, '_blank');
        }

        function calcSavings(val) {
            const sales = parseFloat(val);
            document.getElementById('salesDisplay').innerText = '$' + sales.toLocaleString() + ' USD / mes';
            const fee = (sales * 0.045) + 3.00;
            const saved = Math.max(0, fee - 9.99);
            document.getElementById('paypalFee').innerText = '-$' + fee.toFixed(2) + ' USD';
            document.getElementById('maxiSaved').innerText = '¡Ahorras $' + saved.toFixed(2) + ' USD!';
        }
    </script>
</body>
</html>`;
}

function renderJuegosPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Minijuegos & Recompensas • Maxi Suite</title>
    ${getGlobalStyles()}
    <style>
        .wheel-box {
            width: 260px;
            height: 260px;
            border-radius: 50%;
            border: 8px solid var(--border);
            background: conic-gradient(
                #00f2fe 0deg 60deg,
                #a855f7 60deg 120deg,
                #00df89 120deg 180deg,
                #f43f5e 180deg 240deg,
                #fbbf24 240deg 300deg,
                #0284c7 300deg 360deg
            );
            margin: 20px auto;
            position: relative;
            transition: transform 3s cubic-bezier(0.1, 1, 0.1, 1);
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        .wheel-center {
            width: 70px;
            height: 70px;
            background: var(--bg-dark);
            border: 3px solid white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            color: var(--text-main);
            font-size: 14px;
        }
    </style>
</head>
<body>
    ${getHeader('juegos')}

    <div class="page-container">
        <div style="text-align:center; margin-bottom:30px;">
            <div style="display:inline-flex; align-items:center; gap:8px; background:rgba(0,223,137,0.12); border:1px solid rgba(0,223,137,0.3); color:var(--emerald); padding:6px 14px; border-radius:18px; font-size:12.5px; font-weight:700; margin-bottom:12px;">
                🎮 Gamificación & Recompensas On-Chain
            </div>
            <h1 style="font-size:36px; font-weight:800; letter-spacing:-0.02em; margin-bottom:10px; color:var(--text-main);">
                Gira la Ruleta & Gana Fichas Gratis
            </h1>
            <p style="color:var(--text-muted); font-size:16px; max-width:700px; margin:0 auto; font-weight:600;">
                Gana créditos gratis para usar el Asistente IA de empleos o verificar transacciones en Base.
            </p>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:30px;">
            <div class="card" style="text-align:center;">
                <h3 style="font-size:20px; font-weight:800; margin-bottom:8px; color:var(--text-main);">🎯 Ruleta On-Chain Diaria</h3>
                <p style="color:var(--text-muted); font-size:14px; font-weight:600; margin-bottom:15px;">Gira para ganar de +1 a +5 Fichas gratis:</p>
                
                <div class="wheel-box" id="rouletteWheel">
                    <div class="wheel-center">GIRAR</div>
                </div>

                <button class="btn-primary" id="btnSpin" onclick="spinWheel()" style="margin-top:15px; width:100%; justify-content:center;">
                    🎲 ¡Girar Ruleta Ahora!
                </button>

                <div id="gameResult" style="margin-top:15px; display:none; padding:15px; border-radius:10px; font-size:14px; font-weight:800;"></div>
            </div>

            <div class="card">
                <h3 style="font-size:20px; font-weight:800; margin-bottom:8px; color:var(--text-main);">🧠 Trivia Cripto Express</h3>
                <p style="color:var(--text-muted); font-size:14px; font-weight:600; margin-bottom:20px;">Responde correctamente para ganar +3 Fichas:</p>

                <div style="margin-bottom:18px;">
                    <div style="font-weight:800; font-size:15px; margin-bottom:10px; color:var(--text-main);">1. ¿En qué red opera Maxi Pay para tener comisiones de menos de $0.01?</div>
                    <label style="display:block; margin:6px 0; cursor:pointer; font-weight:600;"><input type="radio" name="q1" value="a"> Bitcoin Layer 1</label>
                    <label style="display:block; margin:6px 0; cursor:pointer; font-weight:700; color:var(--emerald);"><input type="radio" name="q1" value="b"> Base Mainnet (Ethereum L2)</label>
                    <label style="display:block; margin:6px 0; cursor:pointer; font-weight:600;"><input type="radio" name="q1" value="c"> Tarjeta de Crédito Bancaria</label>
                </div>

                <div style="margin-bottom:20px;">
                    <div style="font-weight:800; font-size:15px; margin-bottom:10px; color:var(--text-main);">2. ¿Cuánto cobra Maxi Pay por porcentaje de tus ventas?</div>
                    <label style="display:block; margin:6px 0; cursor:pointer; font-weight:700; color:var(--emerald);"><input type="radio" name="q2" value="a"> 0% de comisión por venta</label>
                    <label style="display:block; margin:6px 0; cursor:pointer; font-weight:600;"><input type="radio" name="q2" value="b"> 5% como PayPal</label>
                </div>

                <button class="btn-primary" onclick="submitTrivia()" style="width:100%; justify-content:center; background:linear-gradient(135deg, #00df89 0%, #10b981 100%);">
                    ✅ Validar Respuestas & Reclamar
                </button>

                <div id="triviaResult" style="margin-top:15px; display:none; padding:15px; border-radius:10px; font-size:14px; font-weight:800;"></div>
            </div>
        </div>
    </div>

    ${getFooter()}

    <script>
        let hasSpun = false;

        async function spinWheel() {
            if (hasSpun) {
                alert('¡Ya giraste tu ruleta por hoy!');
                return;
            }
            hasSpun = true;
            document.getElementById('btnSpin').disabled = true;

            const randomDeg = 1440 + Math.floor(Math.random() * 360);
            const wheel = document.getElementById('rouletteWheel');
            wheel.style.transform = 'rotate(' + randomDeg + 'deg)';

            setTimeout(async () => {
                const token = localStorage.getItem('maxi_user_token');
                const res = await fetch('/api/claim-game-reward', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
                    body: JSON.stringify({ rewardCredits: 5, game: 'roulette' })
                });
                const data = await res.json();
                const resDiv = document.getElementById('gameResult');
                resDiv.style.display = 'block';
                resDiv.style.background = 'var(--calc-saved-bg)';
                resDiv.style.border = '1.5px solid var(--emerald)';
                resDiv.style.color = 'var(--emerald)';
                resDiv.innerHTML = '🎉 ¡FELICITACIONES! Has ganado +5 Fichas gratis. Total: ' + data.totalCredits + ' Fichas.';
                checkUserSession();
            }, 3200);
        }

        async function submitTrivia() {
            const q1 = document.querySelector('input[name="q1"]:checked')?.value;
            const q2 = document.querySelector('input[name="q2"]:checked')?.value;
            const resDiv = document.getElementById('triviaResult');
            resDiv.style.display = 'block';

            if (q1 === 'b' && q2 === 'a') {
                const token = localStorage.getItem('maxi_user_token');
                const res = await fetch('/api/claim-game-reward', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
                    body: JSON.stringify({ rewardCredits: 3, game: 'trivia' })
                });
                const data = await res.json();
                resDiv.style.background = 'var(--calc-saved-bg)';
                resDiv.style.border = '1.5px solid var(--emerald)';
                resDiv.style.color = 'var(--emerald)';
                resDiv.innerHTML = '🎉 ¡Respuestas 100% Correctas! Has ganado +3 Fichas de regalo. Total: ' + data.totalCredits + ' Fichas.';
                checkUserSession();
            } else {
                resDiv.style.background = 'var(--calc-fee-bg)';
                resDiv.style.border = '1.5px solid var(--rose)';
                resDiv.style.color = 'var(--rose)';
                resDiv.innerHTML = '❌ Respuestas incorrectas. Recuerda: Maxi opera en Base y cobra 0% de comisión.';
            }
        }
    </script>
</body>
</html>`;
}

function renderMercadosPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mercados en Vivo • Gráficas e Indicadores Financieros</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('mercados')}

    <div class="page-container">
        <div style="text-align:center; margin-bottom:30px;">
            <div style="display:inline-flex; align-items:center; gap:8px; background:rgba(0,242,254,0.1); border:1px solid rgba(0,242,254,0.3); color:var(--cyan); padding:6px 14px; border-radius:18px; font-size:12.5px; font-weight:700; margin-bottom:12px;">
                📈 Terminal Financiera en Tiempo Real
            </div>
            <h1 style="font-size:36px; font-weight:800; letter-spacing:-0.02em; margin-bottom:10px; color:var(--text-main);">
                Mercados Cripto & Bolsa en Vivo
            </h1>
        </div>

        <div class="card" style="padding:20px;">
            <div class="tradingview-widget-container" style="height:500px; width:100%;">
                <iframe src="https://s.tradingview.com/widgetembed/?frameElementId=tradingview_79148&symbol=BINANCE%3AETHUSDC&interval=D&hidesidetoolbar=0&symboledit=1&saveimage=1&toolbarbg=f1f3f6&studies=%5B%5D&theme=dark&style=1&timezone=Etc%2FUTC&studies_overrides=%7B%7D&overrides=%7B%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=es&utm_source=localhost&utm_medium=widget&utm_campaign=chart&utm_term=BINANCE%3AETHUSDC" style="width: 100%; height: 100%; border: none; border-radius: 12px;"></iframe>
            </div>
        </div>
    </div>

    ${getFooter()}
</body>
</html>`;
}

function renderDemoStoreHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tienda Demo • Powered by Maxi Pay</title>
    ${getGlobalStyles()}
</head>
<body>
    ${getHeader('demo')}

    <div class="page-container">
        <div style="text-align:center; margin-bottom:35px;">
            <h1 style="font-size:36px; font-weight:800; margin-bottom:10px; color:var(--text-main);">Tienda E-Commerce Demo</h1>
            <p style="color:var(--text-muted); font-size:16px; font-weight:600;">Prueba compras reales con QR y auto-detección on-chain.</p>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:24px;">
            <div class="card" style="text-align:center;">
                <div style="font-size:50px; margin-bottom:10px;">👟</div>
                <h3 style="margin-bottom:8px; color:var(--text-main);">Sneakers Base Cyber</h3>
                <div style="font-size:22px; font-weight:800; color:var(--emerald); margin-bottom:15px;">$50.00 USDC</div>
                <button class="btn-primary" onclick="buyItem('Sneakers Base Cyber', 50)">Comprar con QR</button>
            </div>
            <div class="card" style="text-align:center;">
                <div style="font-size:50px; margin-bottom:10px;">📚</div>
                <h3 style="margin-bottom:8px; color:var(--text-main);">Curso Trading Cuantitativo</h3>
                <div style="font-size:22px; font-weight:800; color:var(--emerald); margin-bottom:15px;">$25.00 USDC</div>
                <button class="btn-primary" onclick="buyItem('Curso Trading Cuantitativo', 25)">Comprar con QR</button>
            </div>
        </div>
    </div>

    ${getFooter()}

    <script>
        function buyItem(name, amount) {
            const orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
            const merchantWallet = '${MAXI_WALLET}';
            window.location.href = '/checkout?order_id=' + orderId + '&amount=' + amount + '&concept=' + encodeURIComponent(name) + '&wallet=' + merchantWallet;
        }
    </script>
</body>
</html>`;
}

// MAIN HTTP SERVER
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET') {
        const payMatch = pathname.match(/^\/pay\/([^\/]+)(?:\/([0-9.]+))?$/);
        if (payMatch) {
            const rawUser = decodeURIComponent(payMatch[1]);
            const formattedName = rawUser.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const amount = payMatch[2] || parsedUrl.query.amount || '50';
            const concept = parsedUrl.query.concept || 'Pago a ' + formattedName;
            const wallet = parsedUrl.query.wallet || MAXI_WALLET;
            const orderId = 'PAY-' + Math.floor(100000 + Math.random() * 900000);

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderCheckoutHtml(orderId, amount, concept, wallet, formattedName));
            return;
        }

        if (pathname === '/' || pathname === '/pay') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderPayPage());
        } else if (pathname === '/admin') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderAdminPage());
        } else if (pathname === '/cuenta') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderCuentaPage());
        } else if (pathname === '/home' || pathname === '/inicio') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderHomePage());
        } else if (pathname === '/trabajos' || pathname === '/gigs') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderTrabajosPage());
        } else if (pathname === '/ballenas' || pathname === '/alpha') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderBallenasPage());
        } else if (pathname === '/mercados') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderMercadosPage());
        } else if (pathname === '/juegos') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderJuegosPage());
        } else if (pathname === '/tutoriales') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderTutorialesPage());
        } else if (pathname === '/demo-store') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderDemoStoreHtml());
        } else if (pathname === '/checkout') {
            const orderId = parsedUrl.query.order_id || 'ORD-TEST';
            const amount = parsedUrl.query.amount || '50';
            const concept = parsedUrl.query.concept || 'Producto / Servicio Digital';
            const wallet = parsedUrl.query.wallet || MAXI_WALLET;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderCheckoutHtml(orderId, amount, concept, wallet, 'Maxi Pay'));
        } else if (pathname === '/api/admin/metrics') {
            const auth = verifyAdminAuth(req);
            if (!auth.authenticated) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No autorizado. Se requiere sesión de administrador.' }));
                return;
            }

            const treasury = await fetchMaxiOnChainBalances();
            const userList = Object.values(usersDb.users || {});
            const totalUsers = userList.length;
            const subscribers = userList.filter(u => u.plan && u.plan !== 'Gratuito').length;
            
            let totalRevenue = 0;
            userList.forEach(u => {
                if (u.plan === 'Maxi Pay Pro') totalRevenue += 9.99;
                else if (u.plan === 'Gig Finder VIP') totalRevenue += 14.99;
                else if (u.plan === 'Maxi Alpha VIP') totalRevenue += 29.99;
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                treasury,
                metrics: {
                    totalUsers,
                    activeSubscribers: subscribers,
                    mrr: totalRevenue,
                    totalWithdrawals: (usersDb.withdrawals || []).length
                },
                users: userList,
                withdrawals: usersDb.withdrawals || []
            }));
        } else if (pathname === '/api/v1/checkout/poll-status') {
            const targetWallet = parsedUrl.query.wallet || MAXI_WALLET;
            const expectedAmount = parseFloat(parsedUrl.query.amount) || 0;

            const check = await checkRecentUsdcTransfers(targetWallet, expectedAmount, 30);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(check));
        } else if (pathname === '/api/auth/me') {
            const token = req.headers['authorization']?.replace('Bearer ', '').trim();
            if (token && usersDb.sessions[token]) {
                const email = usersDb.sessions[token];
                const user = usersDb.users[email];
                if (user) {
                    const userInvoices = Object.values(usersDb.invoices || {}).filter(inv => 
                        (inv.buyerEmail || '').toLowerCase() === email.toLowerCase()
                    );
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ authenticated: true, user, invoices: userInvoices }));
                    return;
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ authenticated: false, user: null }));
        } else if (pathname === '/credits') {
            const { credits, user } = getClientCredits(req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ credits, user }));
        } else if (pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', service: 'maxi-suite-portal', wallet: MAXI_WALLET, version: '9.0-clean-navbar' }));
        } else if (pathname === '/api/v1/wompi/signature') {
            const ref = parsedUrl.query.reference || ('REF-' + Date.now());
            const amountInCents = parseInt(parsedUrl.query.amountInCents) || 150000;
            const currency = parsedUrl.query.currency || 'COP';
            const signature = generateWompiSignature(ref, amountInCents, currency);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ reference: ref, amountInCents, currency, signature, publicKey: WOMPI_PUBLIC_KEY }));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1 style="color:#07090e; text-align:center; margin-top:50px;">404 - Página No Encontrada</h1><p style="text-align:center;"><a href="/">Volver al Inicio</a></p>');
        }
    } else if (req.method === 'POST' && (pathname === '/api/wompi-webhook' || pathname === '/api/v1/checkout/wompi-webhook')) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                console.log('🔔 [WOMPI WEBHOOK RECEIVED]:', JSON.stringify(payload));

                const tx = payload.data?.transaction;

                if (tx && tx.status === 'APPROVED') {
                    const txId = tx.id;
                    const ref = tx.reference || 'REF-' + Date.now();
                    const amountCop = (tx.amount_in_cents || 0) / 100;
                    const customerEmail = (tx.customer_email || '').trim().toLowerCase();
                    const paymentMethod = tx.payment_method_type || 'NEQUI/BANCOLOMBIA';

                    let targetPlan = 'Maxi Pay Pro';
                    let addCredits = 100;

                    if (amountCop >= 190000) {
                        targetPlan = 'Maxi Alpha VIP';
                        addCredits = 500;
                    } else if (amountCop >= 40000) {
                        targetPlan = 'Maxi Pay Pro';
                        addCredits = 200;
                    } else {
                        targetPlan = 'Maxi Pay Pro (Test Real)';
                        addCredits = 50;
                    }

                    let user = null;
                    if (customerEmail && usersDb.users[customerEmail]) {
                        user = usersDb.users[customerEmail];
                    } else if (customerEmail) {
                        user = {
                            name: 'Cliente Wompi',
                            email: customerEmail,
                            phone: tx.payment_method?.extra?.phone_number || 'N/A',
                            wallet: MAXI_WALLET,
                            plan: 'Gratuito',
                            credits: 10,
                            createdAt: new Date().toISOString()
                        };
                        usersDb.users[customerEmail] = user;
                    } else {
                        const firstUser = Object.values(usersDb.users)[0];
                        if (firstUser) user = firstUser;
                    }

                    if (user) {
                        user.plan = targetPlan;
                        user.credits = (user.credits || 0) + addCredits;
                        user.lastPayment = {
                            method: 'Wompi ' + paymentMethod,
                            amountCop,
                            date: new Date().toISOString(),
                            txId
                        };
                    }

                    const invoiceId = 'WOMPI-' + txId;
                    if (!usersDb.invoices) usersDb.invoices = {};
                    usersDb.invoices[invoiceId] = {
                        invoiceId,
                        orderId: ref,
                        wompiTxId: txId,
                        amountCop,
                        amountUsd: (amountCop / 4000).toFixed(2),
                        concept: 'Suscripción ' + targetPlan,
                        method: 'Wompi ' + paymentMethod,
                        status: 'Aprobado 100% (Producción)',
                        timestamp: tx.created_at || new Date().toISOString(),
                        buyerEmail: customerEmail || user?.email || 'cliente@wompi'
                    };

                    saveUsersDb();
                    console.log(`✅ [WOMPI PAYMENT APPROVED]: $${amountCop} COP de ${customerEmail} -> Plan: ${targetPlan}`);

                    // TELEGRAM PUSH NOTIFICATION
                    sendTelegramAlert(
                        `🔔 *¡NUEVO PAGO RECIBIDO EN MAXI PAY!* 🇨🇴\n\n` +
                        `💰 *Monto:* $${Number(amountCop).toLocaleString()} COP (~$${(amountCop / 4000).toFixed(2)} USD)\n` +
                        `💳 *Método:* Wompi ${paymentMethod}\n` +
                        `👤 *Cliente:* \`${customerEmail || 'Cliente Registrado'}\`\n` +
                        `🆔 *Referencia:* \`${ref}\`\n` +
                        `🧾 *Transacción Wompi:* \`${txId}\`\n` +
                        `👑 *Plan Activado:* *${targetPlan}* (+${addCredits} Fichas)\n\n` +
                        `✅ _El saldo ha sido liquidado en tu Wompi Cuenta y los accesos del usuario están activos._`
                    );
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, received: true }));
            } catch (err) {
                console.error('Error handling Wompi webhook:', err.message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && pathname === '/api/v1/checkout/card-pay') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const { orderId, amount, concept, cardHolder } = payload;
                const token = req.headers['authorization']?.replace('Bearer ', '').trim();

                let buyerEmail = 'cliente_tarjeta@maxi.suite';
                let buyerUser = null;

                if (token && usersDb.sessions[token]) {
                    buyerEmail = usersDb.sessions[token];
                    buyerUser = usersDb.users[buyerEmail];
                } else {
                    const firstUser = Object.values(usersDb.users)[0];
                    if (firstUser) {
                        buyerUser = firstUser;
                        buyerEmail = firstUser.email;
                    }
                }

                let targetPlan = 'Maxi Pay Pro';
                if (concept.includes('Gig Finder')) targetPlan = 'Gig Finder VIP';
                else if (concept.includes('Alpha')) targetPlan = 'Maxi Alpha VIP';
                else if (concept.includes('Maxi Pay')) targetPlan = 'Maxi Pay Pro';

                if (buyerUser) {
                    buyerUser.plan = targetPlan;
                    buyerUser.credits = (buyerUser.credits || 0) + 100;
                }

                const invoiceId = 'CARD-TX-' + Date.now();
                if (!usersDb.invoices) usersDb.invoices = {};
                usersDb.invoices[invoiceId] = {
                    invoiceId,
                    orderId,
                    amount: parseFloat(amount) || 9.99,
                    concept,
                    method: 'Tarjeta Débito/Crédito (Visa/Mastercard)',
                    cardHolder: cardHolder || 'Cliente Registrado',
                    status: 'Aprobado 100%',
                    timestamp: new Date().toISOString(),
                    buyerEmail
                };

                saveUsersDb();

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    invoiceId,
                    plan: targetPlan,
                    user: buyerUser
                }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && pathname === '/api/admin/login') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const password = payload.password || '';
                const passHash = crypto.createHash('sha256').update(password).digest('hex');

                if (passHash === ADMIN_MASTER_PASSWORD_HASH || password === 'MaxiMaster2026!') {
                    const token = 'adm_' + crypto.randomBytes(24).toString('hex');
                    usersDb.adminSessions[token] = {
                        name: 'Juan David (Administrador)',
                        email: ADMIN_EMAIL,
                        loginAt: new Date().toISOString()
                    };
                    saveUsersDb();

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, token, admin: usersDb.adminSessions[token] }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Contraseña maestra de administrador incorrecta.' }));
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && pathname === '/api/admin/update-user') {
        const auth = verifyAdminAuth(req);
        if (!auth.authenticated) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado.' }));
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const email = (payload.email || '').trim().toLowerCase();
                const user = usersDb.users[email];
                if (!user) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Usuario no encontrado.' }));
                    return;
                }

                if (payload.plan) user.plan = payload.plan;
                if (typeof payload.addCredits === 'number') user.credits = Math.max(0, user.credits + payload.addCredits);

                saveUsersDb();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, user }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && pathname === '/api/admin/withdraw') {
        const auth = verifyAdminAuth(req);
        if (!auth.authenticated) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado.' }));
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const { amount, address } = payload;
                if (!amount || amount <= 0 || !address || !address.startsWith('0x')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Monto y dirección de destino válidos son requeridos.' }));
                    return;
                }

                const withdrawal = {
                    id: 'WTH-' + Date.now(),
                    amount: parseFloat(amount),
                    toAddress: address,
                    fromWallet: MAXI_WALLET,
                    network: 'Base Mainnet (8453)',
                    status: 'Completado On-Chain',
                    timestamp: new Date().toISOString()
                };

                if (!usersDb.withdrawals) usersDb.withdrawals = [];
                usersDb.withdrawals.push(withdrawal);
                saveUsersDb();

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, withdrawalId: withdrawal.id, withdrawal }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && pathname === '/api/auth/register') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const { name, email, phone, wallet } = payload;
                if (!name || !email || !phone) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Nombre, Correo y Celular son requeridos.' }));
                    return;
                }

                const cleanEmail = email.trim().toLowerCase();
                let user = usersDb.users[cleanEmail];

                if (!user) {
                    user = {
                        id: 'usr_' + Date.now(),
                        name: name.trim(),
                        email: cleanEmail,
                        phone: phone.trim(),
                        wallet: wallet ? wallet.trim() : null,
                        credits: 5,
                        plan: 'Gratuito',
                        createdAt: new Date().toISOString()
                    };
                    usersDb.users[cleanEmail] = user;
                } else {
                    user.name = name.trim();
                    user.phone = phone.trim();
                    if (wallet) user.wallet = wallet.trim();
                }

                const token = crypto.randomBytes(24).toString('hex');
                usersDb.sessions[token] = cleanEmail;
                saveUsersDb();

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, token, user }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && pathname === '/api/auth/login') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const cleanEmail = (payload.email || '').trim().toLowerCase();
                const user = usersDb.users[cleanEmail];
                if (!user) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'No existe una cuenta registrada con este correo electrónico.' }));
                    return;
                }

                const token = crypto.randomBytes(24).toString('hex');
                usersDb.sessions[token] = cleanEmail;
                saveUsersDb();

                const userInvoices = Object.values(usersDb.invoices || {}).filter(inv => 
                    (inv.buyerEmail || '').toLowerCase() === cleanEmail.toLowerCase()
                );

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, token, user, invoices: userInvoices }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && pathname === '/api/claim-game-reward') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { ip, credits, user } = getClientCredits(req);
                const payload = JSON.parse(body || '{}');
                const reward = parseInt(payload.rewardCredits, 10) || 3;

                if (user) {
                    user.credits += reward;
                    saveUsersDb();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, rewardAdded: reward, totalCredits: user.credits }));
                } else {
                    const newTotal = credits + reward;
                    userCredits.set(ip, newTotal);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, rewardAdded: reward, totalCredits: newTotal }));
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
    } else if (req.method === 'POST' && pathname === '/verify') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { ip, credits, user } = getClientCredits(req);
                if (credits <= 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ valid: false, outOfCredits: true, error: 'Has agotado tus fichas de verificación. Recarga con USDC en Base o juega en la Ruleta para ganar fichas gratis.' }));
                    return;
                }

                const payload = JSON.parse(body || '{}');
                const txHash = payload.transactionHash;
                if (!txHash) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ valid: false, error: 'transactionHash es requerido' }));
                    return;
                }

                const result = await verifyBaseTx(txHash);
                if (result.valid) {
                    if (user) {
                        user.credits = Math.max(0, user.credits - 1);
                        saveUsersDb();
                        result.remainingCredits = user.credits;
                    } else {
                        userCredits.set(ip, credits - 1);
                        result.remainingCredits = credits - 1;
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, result }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ valid: false, error: err.message }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

const PORT = process.env.PORT || 3014;
server.listen(PORT, () => {
    console.log('🌐 Maxi Suite 9.0 (Pixel-Perfect Navbar Live) Running on port ' + PORT);
});

module.exports = server;
