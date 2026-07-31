const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // Request pairing code if device is not registered yet
        if (!sock.authState.creds.registered) {
            const phoneNumber = process.env.OWNER_NUMBER;
            if (phoneNumber) {
                setTimeout(async () => {
                    try {
                        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                        let code = await sock.requestPairingCode(cleanNumber);
                        code = code?.match(/.{1,4}/g)?.join("-") || code;
                        console.log("\n========================================");
                        console.log(`  YOUR PAIRING CODE: ${code}`);
                        console.log("========================================\n");
                    } catch (err) {
                        console.error("Failed to generate pairing code:", err);
                    }
                }, 3000);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot connected successfully!');
        }
    });

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
