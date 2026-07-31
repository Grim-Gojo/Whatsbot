require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const P = require("pino");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers
} = require("@whiskeysockets/baileys");

const app = express();

const PORT = process.env.PORT || 3000;

const OWNER_NUMBER = (process.env.OWNER_NUMBER || "").replace(/\D/g, "");

const AUTH_DIR = path.join(__dirname, "auth_info");

if (!OWNER_NUMBER) {
    console.error("❌ OWNER_NUMBER is missing.");
    process.exit(1);
}

let lastPairingCode = null;
let pairingInProgress = false;
let connectionStatus = "Starting";

const PAIRING_COOLDOWN = 45000;

app.get("/", (req, res) => {
    res.send({
        status: connectionStatus,
        paired: connectionStatus === "Connected",
        pairingCode: lastPairingCode
    });
});

app.get("/pairing-code", (req, res) => {
    if (connectionStatus === "Connected") {
        return res.send("Bot already connected.");
    }

    if (!lastPairingCode) {
        return res.send("Pairing code not available yet.");
    }

    res.send(lastPairingCode);
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Server running on port ${PORT}`);
});

async function requestPairing(sock) {
    if (pairingInProgress) return;

    pairingInProgress = true;

    try {
        if (sock.authState?.creds?.registered) {
            pairingInProgress = false;
            return;
        }

        const code = await sock.requestPairingCode(OWNER_NUMBER);

        lastPairingCode = code;

        console.log("");
        console.log("====================================");
        console.log("PAIRING CODE");
        console.log(code);
        console.log("====================================");
        console.log("");

    } catch (err) {
        console.log("Pairing request failed.");
        console.log(err.message);
    }

    setTimeout(() => {
        pairingInProgress = false;
    }, PAIRING_COOLDOWN);
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(
        `Using WhatsApp protocol ${version.join(".")} (Latest: ${isLatest})`
    );

    const sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.macOS("Chrome"),
        logger: P({ level: "silent" }),
        printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
            connectionStatus = "Connecting";
            await requestPairing(sock);
        }

        if (connection === "open") {
            connectionStatus = "Connected";
            lastPairingCode = null;

            console.log("");
            console.log("=================================");
            console.log("WhatsApp Connected Successfully");
            console.log("=================================");
            console.log("");
        }

        if (connection === "close") {
            connectionStatus = "Disconnected";

            const statusCode = lastDisconnect?.error?.output?.statusCode;

            console.log("Disconnected:", statusCode);

            const loggedOut =
                statusCode === DisconnectReason.loggedOut ||
                statusCode === 401;

            if (loggedOut) {
                console.log("Logged out. Clearing old session...");

                try {
                    fs.rmSync(AUTH_DIR, {
                        recursive: true,
                        force: true
                    });
                } catch (e) {}

                setTimeout(() => {
                    startBot();
                }, 5000);

                return;
            }

            console.log("Reconnecting...");

            setTimeout(() => {
                startBot();
            }, 3000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key.fromMe) continue;

            const chatId = msg.key.remoteJid;

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

            console.log(`[MESSAGE] ${chatId}: ${text}`);

            const command = text.trim().toLowerCase();

            if (command === "ping") {
                await sock.sendMessage(chatId, {
                    text: "🏓 Pong!"
                });
            }
        }
    });

    return sock;
}

startBot()
    .then(() => {
        console.log("Bot started.");
    })
    .catch((err) => {
        console.error("Fatal startup error:", err);
        process.exit(1);
    });

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
});
           
