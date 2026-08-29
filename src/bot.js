const TelegramBot = require("node-telegram-bot-api");
const {
  addColis,
  createBatch,
  findColisByMessage,
  getLatestBatchId,
  setColisType,
  setBatchType,
} = require("./db");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8957997002:AAEzvJXgMZ9Qn7E4ERirZHTrTfseF8WDKm4";
const DEBOUNCE_MS = Number(process.env.BATCH_DEBOUNCE_MS || 3000);

// Groupe Telegram avec topics dedies : les PDF envoyes directement dans ces
// topics sont comptes automatiquement, sans avoir besoin de forward au bot.
const AUTO_GROUP_CHAT_ID = -1004349429422; // derive de l'id de canal 4349429422 (t.me/c/4349429422/...)
const AUTO_LIT_TOPIC_IDS = [3];
const AUTO_NORMAL_TOPIC_IDS = [2, 4];

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
  if (msg.from) {
    return msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  }

  return "Non identifie";
}

function isPdf(document) {
  if (!document) return false;
  if (document.mime_type === "application/pdf") return true;
  return /\.pdf$/i.test(document.file_name || "");
}

// Determine le type impose par le topic Telegram (groupe auto-import), ou
// null si le message n'est pas dans un topic reconnu / n'est pas concerne.
function resolveForcedType(msg) {
  if (msg.chat.id !== AUTO_GROUP_CHAT_ID) return undefined;
  const threadId = msg.message_thread_id;
  if (AUTO_LIT_TOPIC_IDS.includes(threadId)) return "lit";
  if (AUTO_NORMAL_TOPIC_IDS.includes(threadId)) return "normal";
  return null; // dans ce groupe mais hors des topics suivis : on ignore
}

function batchKey(chatId, threadId) {
  return `${chatId}:${threadId || 0}`;
}

function startBot() {
  if (!TOKEN) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN manquant, le bot ne demarre pas.");
    return null;
  }

  const bot = new TelegramBot(TOKEN, { polling: true });
  const batches = new Map(); // "chatId:threadId" -> { chatId, threadId, batchId, count, total, bySender, timer }

  bot.on("polling_error", (err) => console.error("[bot] polling_error", err.message));

  bot.on("message", (msg) => {
    if (!isPdf(msg.document)) return;

    const forcedType = resolveForcedType(msg);
    if (forcedType === null) return; // groupe suivi mais topic non concerne

    const senderName = extractSenderName(msg);
    const threadId = msg.message_thread_id;
    const key = batchKey(msg.chat.id, threadId);

    let batch = batches.get(key);
    if (!batch) {
      batch = {
        chatId: msg.chat.id,
        threadId,
        batchId: createBatch(msg.chat.id),
        count: 0,
        total: 0,
        bySender: new Map(),
        timer: null,
      };
      batches.set(key, batch);
    }

    const colis = addColis(senderName, {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      batchId: batch.batchId,
      type: forcedType || "normal",
    });

    batch.count += 1;
    batch.total += colis.price;
    batch.bySender.set(senderName, (batch.bySender.get(senderName) || 0) + 1);

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => flushBatch(bot, key, batches), DEBOUNCE_MS);
  });

  bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "Envoie-moi des PDF (transferes ou non), je compte les colis a dropper. Le prix depend de l'expediteur d'origine, configurable sur le dashboard.\n\nRepond a un colis avec /lit ou /unlit pour changer son type. Utilise /litall ou /unlitall pour appliquer au dernier groupe de colis envoye."
    );
  });

  bot.onText(/^\/lit(@\w+)?$/, (msg) => handleSingleType(bot, msg, "lit"));
  bot.onText(/^\/unlit(@\w+)?$/, (msg) => handleSingleType(bot, msg, "normal"));

  bot.onText(/^\/litall(@\w+)?$/, (msg) => handleBatchType(bot, msg, "lit"));
  bot.onText(/^\/unlitall(@\w+)?$/, (msg) => handleBatchType(bot, msg, "normal"));

  console.log("[bot] demarre (polling)");
  return bot;
}

function handleSingleType(bot, msg, type) {
  const reply = msg.reply_to_message;
  if (!reply) {
    bot.sendMessage(msg.chat.id, "Reponds a un message contenant un colis avec /lit ou /unlit.");
    return;
  }
  const colis = findColisByMessage(msg.chat.id, reply.message_id);
  if (!colis) {
    bot.sendMessage(msg.chat.id, "Colis introuvable (deja drope ou pas un colis).");
    return;
  }
  const updated = setColisType(colis.id, type);
  const label = type === "lit" ? "LIT" : "normal";
  bot.sendMessage(msg.chat.id, `Colis #${updated.id} (${updated.sender_name}) passe en ${label} (${updated.price.toFixed(2)} EUR).`);
}

function handleBatchType(bot, msg, type) {
  const batchId = getLatestBatchId(msg.chat.id);
  if (!batchId) {
    bot.sendMessage(msg.chat.id, "Aucun groupe de colis recent trouve.");
    return;
  }
  const count = setBatchType(batchId, type);
  const label = type === "lit" ? "LIT" : "normal";
  if (count === 0) {
    bot.sendMessage(msg.chat.id, "Aucun colis en attente dans le dernier groupe.");
    return;
  }
  bot.sendMessage(msg.chat.id, `${count} colis passes en ${label}.`);
}

function flushBatch(bot, key, batches) {
  const batch = batches.get(key);
  if (!batch) return;
  batches.delete(key);

  const detail = [...batch.bySender.entries()]
    .map(([name, count]) => `  • ${name}: +${count}`)
    .join("\n");

  const text = `+${batch.count} colis recu${batch.count > 1 ? "s" : ""} (~${batch.total.toFixed(
    2
  )} EUR une fois drope${batch.count > 1 ? "s" : ""})\n${detail}`;

  const opts = batch.threadId ? { message_thread_id: batch.threadId } : {};
  bot
    .sendMessage(batch.chatId, text, opts)
    .catch((err) => console.error("[bot] send error", err.message));
}

module.exports = { startBot };
