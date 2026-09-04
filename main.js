// MAXI SUITE 9.0 - PRODUCTION CLOUD ENTRYPOINT
const { fork } = require('child_process');
const path = require('path');

console.log('🚀 [MAXI SUITE CLOUD RUNNER]: Starting Production Services...');

// 1. Start Web Server
const web = fork(path.join(__dirname, 'web-server.js'));
web.on('exit', (code) => {
  console.log('Web server exited with code ' + code + ', restarting in 3s...');
  setTimeout(() => fork(path.join(__dirname, 'web-server.js')), 3000);
});

// 2. Start Telegram Bot
const bot = fork(path.join(__dirname, 'telegram-bot.js'));
bot.on('exit', (code) => {
  console.log('Telegram bot exited with code ' + code + ', restarting in 3s...');
  setTimeout(() => fork(path.join(__dirname, 'telegram-bot.js')), 3000);
});

console.log('✅ [MAXI SUITE CLOUD RUNNER]: Web Server and Telegram Bot running concurrently 24/7.');
