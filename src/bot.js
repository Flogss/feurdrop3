const TelegramBot = require("node-telegram-bot-api");
const { addColis } = require("./db");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEBOUNCE_MS = Number(process.env.BATCH_DEBOUNCE_MS || 3000);

function extractSenderName(msg) {
  const origin = msg.forward_origin;
  if (origin) {
    if (origin.type === "user" && origin.sender_user) {
      return origin.sender_user.username
        ? `@${origin.sender_user.username}`
        : origin.sender_user.first_name;
    }
    if (origin.type === "hidden_user" && origin.sender_user_name) {
      return origin.sender_user_name;
    }
    if (origin.type === "chat" && origin.sender_chat) {
      return origin.sender_chat.title || origin.sender_chat.username || "Chat inconnu";
    }
    if (origin.type === "channel" && origin.chat) {
      return origin.chat.title || "Canal inconnu";
    }
  }

  if (msg.forward_from) {
    return msg.forward_from.username
      ? `@${msg.forward_from.username}`
      : msg.forward_from.first_name;
  }
  if (msg.forward_sender_name) return msg.forward_sender_name;
  if (msg.forward_from_chat) {
    return msg.forward_from_chat.title || msg.forward_from_chat.username || "Chat inconnu";
  }

  return "Non identifie";
}

function isPdf(document) {
  if (!document) return false;
  if (document.mime_type === "application/pdf") return true;
  return /\.pdf$/i.test(document.file_name || "");
}

function startBot() {
  if (!TOKEN) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN manquant, le bot ne demarre pas.");
    return null;
  }

  const bot = new TelegramBot(TOKEN, { polling: true });
  const batches = new Map(); // chatId -> { count, total, bySender: Map, timer }

  bot.on("polling_error", (err) => console.error("[bot] polling_error", err.message));

  bot.on("message", (msg) => {
    if (!isPdf(msg.document)) return;

    const senderName = extractSenderName(msg);
    const colis = addColis(senderName);

    let batch = batches.get(msg.chat.id);
    if (!batch) {
      batch = { count: 0, total: 0, bySender: new Map(), timer: null };
      batches.set(msg.chat.id, batch);
    }

    batch.count += 1;
    batch.total += colis.price;
    batch.bySender.set(senderName, (batch.bySender.get(senderName) || 0) + 1);

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => flushBatch(bot, msg.chat.id, batches), DEBOUNCE_MS);
  });

  bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "Envoie-moi des PDF (transferes ou non), je compte les colis a dropper. Le prix depend de l'expediteur d'origine, configurable sur le dashboard."
    );
  });

  console.log("[bot] demarre (polling)");
  return bot;
}

function flushBatch(bot, chatId, batches) {
  const batch = batches.get(chatId);
  if (!batch) return;
  batches.delete(chatId);

  const detail = [...batch.bySender.entries()]
    .map(([name, count]) => `  • ${name}: +${count}`)
    .join("\n");

  const text = `+${batch.count} colis recu${batch.count > 1 ? "s" : ""} (~${batch.total.toFixed(
    2
  )} EUR une fois drope${batch.count > 1 ? "s" : ""})\n${detail}`;

  bot.sendMessage(chatId, text).catch((err) => console.error("[bot] send error", err.message));
}

module.exports = { startBot };
