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

    if (!sock.authState.creds.registered && !pairingInProgress) {
        pairingInProgress = true;
        setTimeout(async () => {
            try {
                console.log(`Requesting pairing code for ${OWNER_NUMBER}...`);
                let code = await sock.requestPairingCode(OWNER_NUMBER);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                lastPairingCode = code;

                console.log("\n========================================");
                console.log(`  YOUR PAIRING CODE: ${code}`);
                console.log("========================================\n");
            } catch (err) {
                console.error("Pairing request failed:", err.message);
            } finally {
                pairingInProgress = false;
            }
        }, 6000);
    }

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

            // 1. Ping Command
            if (command === "!ping" || command === "ping") {
                await sock.sendMessage(chatId, {
                    text: "🏓 Pong!"
                });
                continue;
            }

            // 2. Menu / Help Command
            if (command === "!menu" || command === "!help" || command === "menu") {
                const menuText = `🤖 *WhatsApp Bot Menu* 🤖\n\n` +
                    `*General Commands:*\n` +
                    `• \`!ping\` - Check responsiveness\n` +
                    `• \`!menu\` - View all commands\n` +
                    `• \`!owner\` - View bot owner contact\n` +
                    `• \`!time\` - Check current date & time\n\n` +
                    `*Fun & Utility Commands:*\n` +
                    `• \`!joke\` - Get a random joke\n` +
                    `• \`!quote\` - Get an inspirational quote\n` +
                    `• \`!fact\` - Get a random fun fact\n` +
                    `• \`!kick\` - Remove a user from a group (mention/reply)\n` +
                    `• \`!ai <prompt>\` - Chat with Gemini AI\n\n` +
                    `_Powered by Baileys & Gemini_`;

                await sock.sendMessage(chatId, { text: menuText });
                continue;
            }

            // 3. Owner Command
            if (command === "!owner" || command === "owner") {
                await sock.sendMessage(chatId, {
                    text: `👑 *Bot Owner Number:* +${OWNER_NUMBER}`
                });
                continue;
            }

            // 4. Time Command
            if (command === "!time" || command === "time") {
                const currentTime = new Date().toLocaleString();
                await sock.sendMessage(chatId, {
                    text: `⏰ *Current Time:* ${currentTime}`
                });
                continue;
            }

            // 5. Joke Command
            if (command === "!joke" || command === "joke") {
                const jokes = [
                    "Why don't scientists trust atoms? Because they make up everything!",
                    "Why did the scarecrow win an award? Because he was outstanding in his field!",
                    "Parallel lines have so much in common. It’s a shame they’ll never meet.",
                    "What do you call fake spaghetti? An impasta!",
                    "Why did the math book look sad? Because it had too many problems."
                ];
                const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
                await sock.sendMessage(chatId, { text: `😂 ${randomJoke}` });
                continue;
            }

            // 6. Quote Command
            if (command === "!quote" || command === "quote") {
                const quotes = [
                    "\"The best way to predict the future is to create it.\" – Peter Drucker",
                    "\"Do what you can, with what you have, where you are.\" – Theodore Roosevelt",
                    "\"Success is not final, failure is not fatal: it is the courage to continue that counts.\" – Winston Churchill",
                    "\"The only limit to our realization of tomorrow is our doubts of today.\" – Franklin D. Roosevelt"
                ];
                const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
                await sock.sendMessage(chatId, { text: `💬 ${randomQuote}` });
                continue;
            }

            // 7. Fact Command
            if (command === "!fact" || command === "fact") {
                const facts = [
                    "🧠 Honey never spoils. Archaeologists have found pots of honey in ancient Egyptian tombs over 3,000 years old that are still edible!",
                    "🐙 Octopuses have three hearts and blue blood.",
                    "🍌 Bananas are curved because they grow towards the sun against gravity—a process called negative geotropism.",
                    "⚡ Lightning strikes the Earth about 100 times every second."
                ];
                const randomFact = facts[Math.floor(Math.random() * facts.length)];
                await sock.sendMessage(chatId, { text: `🧠 *Did you know?*\n${randomFact}` });
                continue;
            }

            // 8. Group Kick Command: !kick (mention or reply)
            if (command.startsWith("!kick")) {
                if (!chatId.endsWith("@g.us")) {
                    await sock.sendMessage(chatId, { text: "⚠️ This command can only be used inside groups!" });
                    continue;
                }

                let targetJid = null;
                if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                    targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                } else if (msg.message.extendedTextMessage?.contextInfo?.participant) {
                    targetJid = msg.message.extendedTextMessage.contextInfo.participant;
                }

                if (!targetJid) {
                    await sock.sendMessage(chatId, { text: "⚠️ Please mention the user or reply to their message to kick them, e.g., !kick @user" });
                    continue;
                }

                try {
                    await sock.groupParticipantsUpdate(chatId, [targetJid], "remove");
                    await sock.sendMessage(chatId, { text: `✅ Successfully removed the user from the group.` });
                } catch (err) {
                    console.error("Kick Error:", err);
                    await sock.sendMessage(chatId, { text: "⚠️ Failed to kick user. Make sure the bot is an admin of this group." });
                }
                continue;
            }

            // 9. Gemini AI Auto-Reply Command: !ai <prompt>
            if (text.startsWith("!ai ")) {
                const prompt = text.slice(4).trim();
                if (!prompt) {
                    await sock.sendMessage(chatId, { text: "Please provide a prompt, e.g., !ai Hello" });
                    continue;
                }

                try {
                    const apiKey = process.env.GEMINI_API_KEY;
                    if (!apiKey) {
                        await sock.sendMessage(chatId, { text: "⚠️ GEMINI_API_KEY is not configured on Render." });
                        continue;
                    }

                    // Call Gemini API
                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }]
                        })
                    });

                    const data = await response.json();
                    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";

                    await sock.sendMessage(chatId, { text: replyText });
                } catch (err) {
                    console.error("AI Error:", err);
                    await sock.sendMessage(chatId, { text: "⚠️ Error communicating with the AI service." });
                }
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
                    
