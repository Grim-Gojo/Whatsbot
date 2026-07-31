/**
 * WhatsApp bot (Baileys) — hardened for Render deployment.
 *
 * Fixes applied vs. the previous version:
 *  1. Always fetches the LATEST Baileys/WhatsApp protocol version at
 *     startup instead of relying on whatever the library defaults to.
 *  2. Pairing code requests are now GUARDED — only one code is
 *     requested at a time, with a cooldown, so a reconnect loop can't
 *     spam WhatsApp with new codes before you've had a chance to type
 *     one in.
 *  3. auth_info is only wiped on a REAL logout (loggedOut / 401),
 *     never on ordinary reconnects (408 timeouts, network hiccups),
 *     so you don't lose a session that was actually fine.
 *  4. Express server binds to 0.0.0.0 and process.env.PORT, required
 *     for Render's port detection.
 *  5. Removed the one-time cleanup block that was force-deleting
 *     auth_info on EVERY startup (this was the cause of the endless
 *     logout/re-pair loop and WhatsApp rate-limiting your pairing
 *     code requests).
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const P = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const AUTH_DIR = path.join(__dirname, 'auth_info');
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');

if (!OWNER_NUMBER) {
  console.error('[startup] OWNER_NUMBER is missing or empty. Set it in your environment variables — digits only, e.g. 2348012345678');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

let lastPairingCode = null;
let connectionStatus = 'starting';

app.get('/', (req, res) => {
  res.send(`WhatsApp bot status: ${connectionStatus}`);
});

app.get('/pairing-code', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send('Already connected — no pairing code needed.');
  }
  res.send(lastPairingCode ? `Current pairing code: ${lastPairingCode}` : 'No pairing code generated yet — check back in a few seconds.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Listening on 0.0.0.0:${PORT}`);
});

let pairingInProgress = false;
const PAIRING_COOLDOWN_MS = 45_000;

async function maybeRequestPairingCode(sock) {
  if (sock.authState.creds.registered) return;
  if (pairingInProgress) return;

  pairingInProgress = true;
  try {
    const code = await sock.requestPairingCode(OWNER_NUMBER);
    lastPairingCode = code;
    console.log('==================================================');
    console.log(' YOUR PAIRING CODE:', code);
    console.log(' Open WhatsApp on your phone > Linked Devices >');
    console.log(' Link a Device > Link with phone number instead,');
    console.log(' then type this code within the next 45 seconds.');
    console.log('==================================================');
  } catch (err) {
    console.error('[pairing] Failed to request pairing code:', err.message);
  } finally {
    setTimeout(() => {
      pairingInProgress = false;
    }, PAIRING_COOLDOWN_MS);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[baileys] Using WA protocol v${version.join('.')} (latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting' || connection === undefined) {
      await maybeRequestPairingCode(sock);
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      lastPairingCode = null;
      console.log('[baileys] Connected and linked successfully.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reasonText = DisconnectReason[statusCode] || `unknown (${statusCode})`;
      connectionStatus = 'disconnected';
      console.warn(`[baileys] Connection closed. Reason: ${reasonText} (${statusCode})`);

      const isRealLogout =
        statusCode === DisconnectReason.loggedOut || statusCode === 401;

      if (isRealLogout) {
        console.warn('[baileys] Real logout detected — clearing auth_info for a fresh pairing.');
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (err) {
          console.error('[baileys] Failed to clear auth_info:', err.message);
        }
        setTimeout(startBot, 5000);
        return;
      }

      console.log('[baileys] Reconnecting with existing session...');
      setTimeout(startBot, 3000);
      return;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // TEMPORARY FOR TESTING: normally this line also checks
      // `|| msg.key.fromMe` to skip messages you send yourself, so
      // the bot doesn't reply to its own messages in a loop. That
      // check is removed here ONLY so "Message yourself" testing
      // works. Put `|| msg.key.fromMe` back once testing is done —
      // see the note right below.
      if (!msg.message) continue;
      // ORIGINAL LINE (restore this after testing):
      // if (!msg.message || msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      console.log(`[message] from ${chatId}: ${text}`);

      if (text.trim().toLowerCase() === 'ping') {
        await sock.sendMessage(chatId, { text: 'pong 🏓' });
      }
    }
  });

  return sock;
}

startBot().catch((err) => {
  console.error('[startup] Fatal error starting bot:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled rejection:', reason);
});
      
