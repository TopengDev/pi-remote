
const { Bot } = require("grammy");
const http = require("http");
const fs = require("fs");

// Config
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPERUSER = parseInt(process.env.SUPERUSER_TG_ID || "0", 10);
const PI_ADDRESS = process.env.PI_ADDRESS || "0x25e18599b3804382c4a03c488196778bbffb77bc";
const ATTN_PORT = 9742;

if (!TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// attn HTTP helpers
function attnPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1", port: ATTN_PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 15000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data); req.end();
  });
}

// attn WebSocket (receive replies from pi)
function connectAttnWs(bot) {
  const WebSocket = require("ws");
  let ws, daemonAddress = "unknown";
  const sentIds = new Set(); // track IDs we sent to prevent echo
  const recentSent = new Map(); // content → timestamp for content-based dedup
  const DEDUP_WINDOW_MS = 10000; // 10s window for content dedup

  function connect() {
    ws = new WebSocket("ws://127.0.0.1:" + ATTN_PORT + "/?session=main");
    ws.on("open", () => console.log("[attn-ws] Connected as 'main'"));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "status" && msg.address) daemonAddress = msg.address;
        if (msg.type === "message") {
          const text = (msg.message || "").trim();
          // ID-based dedup
          if (msg.id && sentIds.has(msg.id)) {
            console.log("[attn-ws] Skipping echo (ID match): " + msg.id);
            return;
          }
          // Content-based dedup for race condition (echo arrives before /send response)
          const lastSent = recentSent.get(text);
          if (lastSent && (Date.now() - lastSent) < DEDUP_WINDOW_MS) {
            console.log("[attn-ws] Skipping echo (content match): " + text.substring(0, 50));
            return;
          }
          const tgMsg = "<b>📥 pi</b>\n<code>" + escapeHtml(text) + "</code>";
          bot.api.sendMessage(SUPERUSER, tgMsg, { parse_mode: "HTML" }).catch(() => {});
        }
      } catch {}
    });
    ws.on("close", () => { console.log("[attn-ws] Disconnected, reconnecting..."); setTimeout(connect, 5000); });
    ws.on("error", () => {});
  }
  connect();
  return { getAddress: () => daemonAddress, sentIds, recentSent };
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Telegram Bot
async function main() {
  const bot = new Bot(TOKEN);
  const attn = connectAttnWs(bot);
  const sentIds = attn.sentIds;
  const recentSent = attn.recentSent;

  bot.command("start", async (ctx) => {
    if (ctx.from.id !== SUPERUSER) return ctx.reply("Access denied.");
    await ctx.reply(
      "👋 <b>ChillPi Remote Control</b>\n\n" +
      "Talk naturally — no prefix needed. Just send a message and your pi will respond.\n\n" +
      "Daemon: <code>" + attn.getAddress() + "</code>",
      { parse_mode: "HTML" }
    );
  });

  bot.command("status", async (ctx) => {
    if (ctx.from.id !== SUPERUSER) return ctx.reply("Access denied.");
    try {
      const { body } = await attnPost("/status", {});
      await ctx.reply(
        "<b>📡 Bridge Status</b>\n" +
        "Daemon: <code>" + (body.address || "unknown") + "</code>\n" +
        "Relay: " + (body.relayConnected ? "✅ Connected" : "❌ Disconnected") + "\n" +
        "Peers: " + (body.peers || "?"),
        { parse_mode: "HTML" }
      );
    } catch (e) { await ctx.reply("❌ attn daemon unreachable: " + e.message); }
  });

  // Photo handler — save to /tmp, send via /op/send_file
  bot.on('message:photo', async (ctx) => {
    if (ctx.from.id !== SUPERUSER) return ctx.reply('Access denied.');
    const ack = await ctx.reply('📎 Downloading photo...');
    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const arrayBuf = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const filename = `photo_${Date.now()}.jpg`;
      const filePath = `/tmp/${filename}`;
      fs.writeFileSync(filePath, buf);
      const { body } = await attnPost('/op/send_file', { to: PI_ADDRESS, path: filePath });
      try { fs.unlinkSync(filePath); } catch {}
      if (body.ok) {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          '📤 Photo sent to pi' + (ctx.message.caption ? ' \n📝 ' + ctx.message.caption : '') + '\nID: <code>' + (body.data && body.data.id || '') + '</code>',
          { parse_mode: 'HTML' });
      } else {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          '❌ ' + (body.error || 'Upload failed'), { parse_mode: 'HTML' });
      }
    } catch (e) {
      await ctx.api.editMessageText(ack.chat.id, ack.message_id,
        '❌ ' + e.message, { parse_mode: 'HTML' });
    }
  });

  // Voice note handler — save to /tmp, send via /op/send_file
  bot.on('message:voice', async (ctx) => {
    if (ctx.from.id !== SUPERUSER) return ctx.reply('Access denied.');
    const ack = await ctx.reply('🎤 Downloading voice note...');
    try {
      const voice = ctx.message.voice;
      const file = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const arrayBuf = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const filename = `voice_${Date.now()}.ogg`;
      const filePath = `/tmp/${filename}`;
      fs.writeFileSync(filePath, buf);
      const { body } = await attnPost('/op/send_file', { to: PI_ADDRESS, path: filePath });
      try { fs.unlinkSync(filePath); } catch {}
      if (body.ok) {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          '🎤 Voice note sent to pi\nID: <code>' + (body.data && body.data.id || '') + '</code>',
          { parse_mode: 'HTML' });
      } else {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          '❌ ' + (body.error || 'Upload failed'), { parse_mode: 'HTML' });
      }
    } catch (e) {
      await ctx.api.editMessageText(ack.chat.id, ack.message_id,
        '❌ ' + e.message, { parse_mode: 'HTML' });
    }
  });

  // Document handler — save to /tmp, send via /op/send_file
  bot.on('message:document', async (ctx) => {
    if (ctx.from.id !== SUPERUSER) return ctx.reply('Access denied.');
    const doc = ctx.message.document;
    const filename = doc.file_name || `document_${Date.now()}`;
    const ack = await ctx.reply('📎 Downloading ' + filename + '...');
    try {
      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const arrayBuf = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const filePath = `/tmp/${filename}`;
      fs.writeFileSync(filePath, buf);
      const { body } = await attnPost('/op/send_file', { to: PI_ADDRESS, path: filePath });
      try { fs.unlinkSync(filePath); } catch {}
      if (body.ok) {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          '📤 ' + escapeHtml(filename) + ' sent to pi' + (ctx.message.caption ? ' \n📝 ' + ctx.message.caption : '') + '\nID: <code>' + (body.data && body.data.id || '') + '</code>',
          { parse_mode: 'HTML' });
      } else {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          '❌ ' + (body.error || 'Upload failed'), { parse_mode: 'HTML' });
      }
    } catch (e) {
      await ctx.api.editMessageText(ack.chat.id, ack.message_id,
        '❌ ' + e.message, { parse_mode: 'HTML' });
    }
  });

  // ALL text messages from superuser forwarded to pi (no prefix filter)
  bot.on("message:text", async (ctx) => {
    if (ctx.from.id !== SUPERUSER) return ctx.reply("Access denied.");

    const text = ctx.message.text.trim();
    
    // Build message with reply context
    let fullText = text;
    if (ctx.message.reply_to_message) {
      const reply = ctx.message.reply_to_message;
      let quoted = '';
      if (reply.text) {
        quoted = reply.text.substring(0, 200);
      } else if (reply.caption) {
        quoted = '[photo] ' + reply.caption.substring(0, 200);
      } else if (reply.photo) {
        quoted = '[photo]';
      } else if (reply.document) {
        quoted = '[file: ' + (reply.document.file_name || 'unknown') + ']';
      } else {
        quoted = '[message]';
      }
      fullText = '↪️ Replying to: "' + quoted + '"\n' + text;
    }

    const ack = await ctx.reply("📤 <code>" + escapeHtml(text) + "</code>...", { parse_mode: "HTML" });

    // Preemptively track content to beat the WS echo race
    recentSent.set(fullText, Date.now());

    try {
      const { status, body } = await attnPost("/send", {
        to: PI_ADDRESS,
        message: fullText,
      });
      if (status === 200 && (body.status === "sent" || body.status === "received" || body.status === "delivered" || body.status === "unconfirmed")) {
        sentIds.add(body.id);
        console.log("[tg] Tracked sent ID: " + body.id);
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          "✅ <code>" + escapeHtml(text) + "</code>\nID: <code>" + body.id + "</code>",
          { parse_mode: "HTML" });
      } else if (status === 200 && body.status === "queued") {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          "⚠️ Queued for delivery.\n<code>" + escapeHtml(text) + "</code>",
          { parse_mode: "HTML" });
      } else if (status === 503) {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          "⚠️ Relay not connected. Queued.\n<code>" + escapeHtml(text) + "</code>",
          { parse_mode: "HTML" });
      } else {
        await ctx.api.editMessageText(ack.chat.id, ack.message_id,
          "❌ " + (body.error || "HTTP " + status), { parse_mode: "HTML" });
      }
    } catch (e) {
      await ctx.api.editMessageText(ack.chat.id, ack.message_id,
        "❌ " + e.message, { parse_mode: "HTML" });
    }
  });

  console.log("[tg] Starting Telegram bot polling...");
  bot.start({ onStart: (info) => console.log("[tg] Bot started as @" + info.username) });
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
