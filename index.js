const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('WhatsApp Bot is running!');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web server listening on port ${PORT}`);
});

let pairingCodeRequested = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed due to statusCode ${statusCode}, reconnecting...`);
            
            // If session is logged out or unauthorized (401), clear auth and retry fresh
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log('Session expired or logged out. Clearing auth_info for a fresh code...');
                try {
                    fs.rmSync('auth_info', { recursive: true, force: true });
                } catch (e) {}
                pairingCodeRequested = false;
                setTimeout(startBot, 3000);
            } else {
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot connected successfully!');
            pairingCodeRequested = false;
        }
    });

    if (!sock.authState.creds.registered && !pairingCodeRequested) {
        pairingCodeRequested = true;
        const phoneNumber = process.env.OWNER_NUMBER;
        if (phoneNumber) {
            setTimeout(async () => {
                try {
                    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`Requesting pairing code for ${cleanNumber}...`);
                    let code = await sock.requestPairingCode(cleanNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log("\n========================================");
                    console.log(`  YOUR PAIRING CODE: ${code}`);
                    console.log("========================================\n");
                } catch (err) {
                    console.error("Pairing code error:", err.message);
                    pairingCodeRequested = false;
                }
            }, 6000);
        }
    }

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        const from = msg.key.remoteJid;

        if (text === '!ping') {
            await sock.sendMessage(from, { text: 'Pong! 🏓' });
        }
    });
}

startBot();


