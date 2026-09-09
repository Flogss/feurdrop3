const TelegramBot = require("node-telegram-bot-api");
const {
  addColis,
  createBatch,
  findColisByMessage,
  getLatestBatchId,
  setColisType,
  setBatchType,
  setColisPrice,
  setColisCarrier,
  setBatchCarrier,
  getColisById,
  setBatchPrice,
  getPendingSummary,
  getStatsMessageId,
  setStatsMessageId,
} = require("./db");
const { renderStatsImage } = require("./statsImage");
const { detectCarrier, CARRIERS, parseCarrier, carrierLabel } = require("./carrier");
const { notifyNewColis } = require("./push");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8957997002:AAEzvJXgMZ9Qn7E4ERirZHTrTfseF8WDKm4";
const DEBOUNCE_MS = Number(process.env.BATCH_DEBOUNCE_MS || 3000);

// Groupe Telegram avec topics dedies : les PDF envoyes directement dans ces
// topics sont comptes automatiquement, sans avoir besoin de forward au bot.
const AUTO_GROUP_CHAT_ID = -1004349429422; // derive de l'id de canal 4349429422 (t.me/c/4349429422/...)
const AUTO_LIT_TOPIC_IDS = [3];
const AUTO_NORMAL_TOPIC_IDS = [2, 4];
// Les colis BJ sont factures comme des colis normaux, ils sont juste
// comptabilises a part pour le suivi.
const AUTO_BJ_TOPIC_IDS = [5];
// Le topic "1" (t.me/c/.../1) correspond au topic General par defaut d'un
// forum Telegram, qui n'a pas de vrai message_thread_id cote Bot API : il ne
// faut pas en passer un pour y poster.

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

  // pas de trace de transfert : le PDF a ete poste directement, il vient donc
  // de nous et non d'un expediteur tiers
  return "Moi";
}

function isPdf(document) {
  if (!document) return false;
  if (document.mime_type === "application/pdf") return true;
  return /\.pdf$/i.test(document.file_name || "");
}

function isImageDocument(document) {
  if (!document) return false;
  if ((document.mime_type || "").startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(document.file_name || "");
}

// Un colis peut arriver en PDF, en fichier image, ou en photo Telegram
// (compressee : dans ce cas il n'y a pas de nom de fichier, seule la
// legende peut porter le numero de suivi).
function colisAttachment(msg) {
  if (isPdf(msg.document) || isImageDocument(msg.document)) {
    return { fileName: msg.document.file_name || null };
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    return { fileName: null };
  }
  return null;
}

// Determine le type impose par le topic Telegram (groupe auto-import), ou
// null si le message n'est pas dans un topic reconnu / n'est pas concerne.
function resolveForcedType(msg) {
  if (msg.chat.id !== AUTO_GROUP_CHAT_ID) return undefined;
  const threadId = msg.message_thread_id;
  if (AUTO_LIT_TOPIC_IDS.includes(threadId)) return "lit";
  if (AUTO_NORMAL_TOPIC_IDS.includes(threadId)) return "normal";
  if (AUTO_BJ_TOPIC_IDS.includes(threadId)) return "bj";
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

  const handleIncoming = (msg) => {
    const attachment = colisAttachment(msg);
    if (!attachment) return;

    const forcedType = resolveForcedType(msg);
    if (forcedType === null) return; // groupe suivi mais topic non concerne

    const senderName = extractSenderName(msg);
    const carrier = detectCarrier(attachment.fileName, msg.caption);
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
        groupCaptions: new Map(),
        unresolved: [],
        timer: null,
      };
      batches.set(key, batch);
    }

    // dans un album, Telegram n'attache la legende qu'a un seul des messages :
    // on la memorise pour la rattacher aux autres photos du meme envoi
    if (msg.media_group_id && msg.caption) {
      batch.groupCaptions.set(msg.media_group_id, msg.caption);
    }

    const colis = addColis(senderName, {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      batchId: batch.batchId,
      type: forcedType || "normal",
      carrier,
    });

    // transporteur non reconnu : nouvelle tentative a la fin du lot (la
    // legende de l'album a pu arriver apres), puis signalement sur Telegram
    if (!carrier && forcedType !== "bj") {
      batch.unresolved.push({
        colisId: colis.id,
        fileName: attachment.fileName,
        caption: msg.caption,
        mediaGroupId: msg.media_group_id,
      });
    }

    batch.count += 1;
    batch.total += colis.price;
    batch.bySender.set(senderName, (batch.bySender.get(senderName) || 0) + 1);

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => flushBatch(bot, key, batches), DEBOUNCE_MS);
  };

  bot.on("message", handleIncoming);
  // Si "4349429422" est un Channel Telegram (pas un supergroupe), les posts
  // arrivent comme channel_post et non comme message classique.
  bot.on("channel_post", handleIncoming);

  bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "Envoie-moi des PDF (transferes ou non), je compte les colis a dropper. Le prix depend de l'expediteur d'origine, configurable sur le dashboard.\n\n/lit ou /unlit en reponse a un colis pour changer son type\n/litall ou /unlitall pour appliquer au dernier groupe recu\n/prix 7.5 en reponse a un colis pour forcer son montant (sans reponse : applique au dernier groupe)\n/transporteur en reponse a un colis pour choisir sa compagnie dans une liste (ou /transporteur chrono directement)"
    );
  });

  bot.onText(/^\/lit(@\w+)?$/, (msg) => handleSingleType(bot, msg, "lit"));
  bot.onText(/^\/unlit(@\w+)?$/, (msg) => handleSingleType(bot, msg, "normal"));

  bot.onText(/^\/litall(@\w+)?$/, (msg) => handleBatchType(bot, msg, "lit"));
  bot.onText(/^\/unlitall(@\w+)?$/, (msg) => handleBatchType(bot, msg, "normal"));

  bot.onText(/^\/prix(@\w+)?\s+(-?[\d]+(?:[.,][\d]+)?)/, (msg, match) =>
    handlePrice(bot, msg, Number(String(match[2]).replace(",", ".")))
  );

  // /transporteur MR  (en reponse a un colis, sinon applique au dernier lot)
  // /transporteur     -> propose les transporteurs en boutons
  bot.onText(/^\/transporteur(@\w+)?(?:\s+(.+))?$/i, (msg, match) =>
    handleCarrierCommand(bot, msg, match[2])
  );
  // Variantes /transporteur_mr, /transporteur_chrono... : elles servent
  // surtout a faire apparaitre les noms dans les suggestions de Telegram.
  bot.onText(/^\/transporteur_([a-z]+)(@\w+)?$/i, (msg, match) =>
    handleCarrierCommand(bot, msg, match[1])
  );

  bot.on("callback_query", (query) => handleCarrierCallback(bot, query));

  registerCommands(bot);

  console.log("[bot] demarre (polling)");
  return bot;
}

// La liste envoyee a Telegram alimente le menu de suggestions : en tapant
// "/transporteur", les noms des transporteurs apparaissent directement.
function registerCommands(bot) {
  const commands = [
    { command: "start", description: "Mode d'emploi" },
    { command: "lit", description: "Passer le colis en LIT (en reponse)" },
    { command: "unlit", description: "Repasser le colis en normal (en reponse)" },
    { command: "litall", description: "Passer tout le dernier lot en LIT" },
    { command: "unlitall", description: "Repasser tout le dernier lot en normal" },
    { command: "prix", description: "Forcer le montant, ex: /prix 7.5" },
    { command: "transporteur", description: "Choisir le transporteur (en reponse au colis)" },
    ...CARRIERS.map((carrier) => ({
      command: `transporteur_${carrier.code.toLowerCase()}`,
      description: carrier.code === "BJ" ? "BJ (type de colis)" : carrier.label,
    })),
  ];
  bot.setMyCommands(commands).catch((err) => console.error("[bot] setMyCommands", err.message));
}

// Dans un groupe a topics, il faut repondre dans le topic d'origine.
function threadOpts(msg) {
  return msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
}

const CARRIER_LIST_HINT = CARRIERS.map((c) => `${c.code} (${c.label})`).join(", ");

// Cible de la commande : le colis auquel on repond, sinon le dernier lot recu.
function carrierTarget(msg) {
  const reply = msg.reply_to_message;
  if (reply) {
    const colis = findColisByMessage(msg.chat.id, reply.message_id);
    if (!colis) return { error: "Colis introuvable (deja drope ou pas un colis)." };
    return { kind: "colis", id: colis.id };
  }
  const batchId = getLatestBatchId(msg.chat.id);
  if (!batchId) return { error: "Aucun colis recent trouve. Reponds au colis avec /transporteur." };
  return { kind: "batch", id: batchId };
}

function handleCarrierCommand(bot, msg, rawName) {
  const target = carrierTarget(msg);
  if (target.error) {
    bot.sendMessage(msg.chat.id, target.error, threadOpts(msg));
    return;
  }

  // sans nom : on propose les transporteurs en boutons
  if (!rawName || !rawName.trim()) {
    const keyboard = [];
    for (let i = 0; i < CARRIERS.length; i += 2) {
      keyboard.push(
        CARRIERS.slice(i, i + 2).map((carrier) => ({
          text: carrier.label,
          callback_data: `tr:${carrier.code}:${target.kind[0]}:${target.id}`,
        }))
      );
    }
    const scope = target.kind === "colis" ? "ce colis" : "le dernier lot";
    bot.sendMessage(msg.chat.id, `Transporteur pour ${scope} ?`, {
      ...threadOpts(msg),
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  const carrier = parseCarrier(rawName);
  if (!carrier) {
    bot.sendMessage(
      msg.chat.id,
      `Transporteur inconnu : "${rawName.trim()}".\nAu choix : ${CARRIER_LIST_HINT}`,
      threadOpts(msg)
    );
    return;
  }

  const result = applyCarrier(target, carrier.code);
  bot.sendMessage(msg.chat.id, result, threadOpts(msg));
}

function handleCarrierCallback(bot, query) {
  const data = query.data || "";
  if (!data.startsWith("tr:")) return;

  const [, code, kindLetter, rawId] = data.split(":");
  const carrier = CARRIERS.find((c) => c.code === code);
  if (!carrier) return bot.answerCallbackQuery(query.id, { text: "Transporteur inconnu" });

  const target = { kind: kindLetter === "c" ? "colis" : "batch", id: Number(rawId) };
  const result = applyCarrier(target, carrier.code);

  bot.answerCallbackQuery(query.id, { text: carrier.label });
  bot
    .editMessageText(result, { chat_id: query.message.chat.id, message_id: query.message.message_id })
    .catch((err) => console.error("[bot] editMessageText", err.message));
}

// "BJ" n'est pas un transporteur mais un type de colis : il se corrige avec la
// meme commande parce que c'est une ligne de "compagnies a poster" comme
// les autres.
function applyCarrier(target, code) {
  if (target.kind === "colis") {
    if (code === "BJ") {
      const updated = setColisType(target.id, "bj");
      if (!updated) return "Colis introuvable ou deja drope.";
      return `Colis #${updated.id} (${updated.sender_name}) passe en BJ (${updated.price.toFixed(2)} EUR).`;
    }
    const updated = setColisCarrier(target.id, code);
    if (!updated) return "Colis introuvable.";
    return `Colis #${updated.id} (${updated.sender_name}) : transporteur ${carrierLabel(code)}.`;
  }

  const count = code === "BJ" ? setBatchType(target.id, "bj") : setBatchCarrier(target.id, code);
  if (count === 0) return "Aucun colis en attente dans le dernier lot.";
  const label = code === "BJ" ? "BJ" : carrierLabel(code);
  return `${count} colis passes en ${label}.`;
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

function handlePrice(bot, msg, price) {
  if (Number.isNaN(price) || price < 0) {
    bot.sendMessage(msg.chat.id, "Montant invalide. Exemple : /prix 7.5");
    return;
  }

  const reply = msg.reply_to_message;
  if (reply) {
    const colis = findColisByMessage(msg.chat.id, reply.message_id);
    if (!colis) {
      bot.sendMessage(msg.chat.id, "Colis introuvable (deja drope ou pas un colis).");
      return;
    }
    const updated = setColisPrice(colis.id, price);
    bot.sendMessage(
      msg.chat.id,
      `Colis #${updated.id} (${updated.sender_name}) passe a ${price.toFixed(2)} EUR.`
    );
    return;
  }

  // sans reponse a un colis precis, on applique au dernier groupe recu
  const batchId = getLatestBatchId(msg.chat.id);
  if (!batchId) {
    bot.sendMessage(msg.chat.id, "Aucun colis recent trouve.");
    return;
  }
  const count = setBatchPrice(batchId, price);
  if (count === 0) {
    bot.sendMessage(msg.chat.id, "Aucun colis en attente dans le dernier groupe.");
    return;
  }
  bot.sendMessage(msg.chat.id, `${count} colis passes a ${price.toFixed(2)} EUR.`);
}

async function updateGroupStatsPhoto(bot, addedCount) {
  try {
    const { count, value } = getPendingSummary();
    const image = await renderStatsImage({ pendingCount: count, pendingValue: value, addedCount });

    const prevId = getStatsMessageId("group");
    if (prevId) {
      try {
        await bot.deleteMessage(AUTO_GROUP_CHAT_ID, prevId);
      } catch (err) {
        // message deja supprime ou trop vieux, on continue
      }
    }

    const sent = await bot.sendPhoto(
      AUTO_GROUP_CHAT_ID,
      image,
      {},
      { filename: "stats.png", contentType: "image/png" }
    );
    setStatsMessageId("group", sent.message_id);
  } catch (err) {
    console.error("[bot] updateGroupStatsPhoto error", err.message);
  }
}

// Previent dans le topic General du groupe quand des fichiers n'ont pas pu
// etre rattaches a un transporteur, avec nom de fichier et description pour
// pouvoir completer les regles de detection.
function notifyUnknownCarriers(bot, unknown) {
  if (!unknown || unknown.length === 0) return;

  const detail = unknown
    .slice(0, 15)
    .map((u) => `  • ${u.fileName || "sans nom"} — ${u.caption ? `"${u.caption}"` : "sans description"}`)
    .join("\n");
  const extra = unknown.length > 15 ? `\n  … et ${unknown.length - 15} autre(s)` : "";
  const text =
    `⚠️ ${unknown.length} colis sans transporteur reconnu :\n${detail}${extra}\n\n` +
    `Reponds au fichier avec /transporteur (ou /transporteur mr, /transporteur chrono...) pour le classer.`;

  bot
    .sendMessage(AUTO_GROUP_CHAT_ID, text)
    .catch((err) => console.error("[bot] notify unknown error", err.message));
}

// Deuxieme passe sur les colis restes sans transporteur : dans un album de
// photos, la legende peut etre arrivee sur un autre message du meme envoi.
// Renvoie ceux qui restent non identifies.
function resolveBatchCarriers(batch) {
  const stillUnknown = [];
  for (const item of batch.unresolved) {
    // un colis passe en BJ entre-temps est deja classe : les BJ forment leur
    // propre ligne dans "compagnies a poster", pas besoin de transporteur
    const colis = getColisById(item.colisId);
    if (colis && colis.type === "bj") continue;

    const groupCaption = item.mediaGroupId ? batch.groupCaptions.get(item.mediaGroupId) : null;
    const carrier = groupCaption ? detectCarrier(item.fileName, groupCaption) : null;
    if (carrier) setColisCarrier(item.colisId, carrier);
    else stillUnknown.push({ ...item, caption: item.caption || groupCaption });
  }
  return stillUnknown;
}

function flushBatch(bot, key, batches) {
  const batch = batches.get(key);
  if (!batch) return;
  batches.delete(key);

  notifyUnknownCarriers(bot, resolveBatchCarriers(batch));
  pushBatchNotification(batch);

  if (batch.chatId === AUTO_GROUP_CHAT_ID) {
    updateGroupStatsPhoto(bot, batch.count);
    return;
  }

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

// Notification push vers les appareils abonnes (PWA sur l'ecran d'accueil).
// C'est l'equivalent du "ding" de vente : un lot recu = une notification.
function pushBatchNotification(batch) {
  const pending = getPendingSummary();
  const bySender = [...batch.bySender.entries()].map(([name, count]) => `${name} +${count}`);
  notifyNewColis({
    count: batch.count,
    total: batch.total,
    pendingCount: pending.count,
    pendingValue: pending.value,
    bySender,
  });
}

module.exports = { startBot };
