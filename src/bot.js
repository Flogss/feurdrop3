const fs = require("fs");
const os = require("os");
const path = require("path");
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
  saveCarrierRule,
  getCarrierRules,
  listCarrierRules,
  clearCarrierRules,
  getUnclassifiedPending,
  getPrintableColis,
  getPrintableSummary,
  getColisById,
  getBatchColis,
  deleteColis,
  setBatchPrice,
  getPendingSummary,
  getStatsMessageId,
  setStatsMessageId,
  getSetting,
  setSetting,
} = require("./db");
const { renderStatsImage } = require("./statsImage");
const { detectCarrier, CARRIERS, parseCarrier, carrierLabel, deriveRules } = require("./carrier");
const { mergeLabels, LABEL_WIDTH, LABEL_HEIGHT } = require("./printer");
const { notifyNewColis } = require("./push");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8957997002:AAEzvJXgMZ9Qn7E4ERirZHTrTfseF8WDKm4";
const DEBOUNCE_MS = Number(process.env.BATCH_DEBOUNCE_MS || 3000);

// Groupe Telegram avec topics dedies : les PDF envoyes directement dans ces
// topics sont comptes automatiquement, sans avoir besoin de forward au bot.
const AUTO_GROUP_CHAT_ID = -1004388459228; // derive de l'id de canal 4388459228 (t.me/c/4388459228/...)
const AUTO_LIT_TOPIC_IDS = [4];
const AUTO_NORMAL_TOPIC_IDS = [2, 5];
// Les colis BJ sont factures comme des colis normaux, ils sont juste
// comptabilises a part pour le suivi.
const AUTO_BJ_TOPIC_IDS = [6];
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
  if (isPdf(msg.document)) {
    return { fileName: msg.document.file_name || null, fileId: msg.document.file_id, kind: "pdf" };
  }
  if (isImageDocument(msg.document)) {
    return { fileName: msg.document.file_name || null, fileId: msg.document.file_id, kind: "image" };
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    // on garde la plus grande taille : c'est celle qui imprime correctement
    const best = msg.photo[msg.photo.length - 1];
    return { fileName: null, fileId: best.file_id, kind: "image" };
  }
  return null;
}

// Chats inconnus deja signales, pour ne pas repeter le meme avertissement.
const ignoredChatsLogged = new Set();

// Determine le type impose par le topic Telegram, ou null si le fichier ne
// doit pas etre compte du tout.
// Deux sources sont legitimes et deux seulement :
//   - le groupe configure, dans un des topics suivis ;
//   - un transfert direct au bot en message prive.
// Tout le reste (autre groupe, autre canal, ancien groupe ou l'on est encore
// membre, topic non suivi) est ignore : sinon la moindre photo postee ailleurs
// se retrouvait comptee comme un colis.
function resolveForcedType(msg) {
  if (msg.chat.id === AUTO_GROUP_CHAT_ID) {
    const threadId = msg.message_thread_id;
    if (AUTO_LIT_TOPIC_IDS.includes(threadId)) return "lit";
    if (AUTO_NORMAL_TOPIC_IDS.includes(threadId)) return "normal";
    if (AUTO_BJ_TOPIC_IDS.includes(threadId)) return "bj";
    return null; // bon groupe, mais topic non suivi
  }

  if (msg.chat.type === "private") return undefined; // transfert direct au bot

  if (!ignoredChatsLogged.has(msg.chat.id)) {
    ignoredChatsLogged.add(msg.chat.id);
    console.log(
      `[bot] fichiers ignores dans "${msg.chat.title || msg.chat.id}" (id ${msg.chat.id}) :` +
        ` ce n'est pas le groupe configure (${AUTO_GROUP_CHAT_ID}).`
    );
  }
  return null;
}

// Reactions : le pouce accuse reception d'un colis, le point d'interrogation
// signale un transporteur non reconnu (il remplace le pouce sur le meme
// message). Telegram n'accepte qu'une liste fermee d'emojis en reaction, d'ou
// le repli sur 🤔 si ❓ est refuse.
const REACTION_RECEIVED = "👍";
const REACTION_UNKNOWN = "❓";
const REACTION_UNKNOWN_FALLBACK = "🤔";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Les reactions partent une par une : un lot de 20 fichiers ferait sinon
// autant d'appels simultanes et Telegram limiterait.
let reactionQueue = Promise.resolve();
function queueReaction(bot, chatId, messageId, emoji, fallbackEmoji) {
  if (!chatId || !messageId) return;
  const react = (value) =>
    bot.setMessageReaction(chatId, messageId, { reaction: [{ type: "emoji", emoji: value }] });

  reactionQueue = reactionQueue
    .then(() => sleep(120))
    .then(() => react(emoji))
    .catch(() => (fallbackEmoji ? react(fallbackEmoji) : null))
    .catch((err) => console.error("[bot] reaction", err.message));
}

// Efface la commande de l'utilisateur une fois traitee pour ne pas polluer le
// fil. Supprimer le message de QUELQU'UN D'AUTRE exige le droit "Supprimer les
// messages" (le bot peut toujours effacer ses propres messages, d'ou le cas ou
// seule la reponse disparait). Si Telegram refuse, on le dit une fois par chat
// avec le message d'erreur exact plutot que de laisser le doute.
const deleteRightWarned = new Set();

function deleteCommand(bot, msg) {
  bot.deleteMessage(msg.chat.id, msg.message_id).catch((err) => {
    console.error("[bot] suppression commande impossible :", err.message);
    if (deleteRightWarned.has(msg.chat.id)) return;
    deleteRightWarned.add(msg.chat.id);
    replyEphemeral(
      bot,
      msg,
      `Je n'arrive pas a effacer tes commandes : ${err.message}\n` +
        `Ajoute-moi comme administrateur avec le droit "Supprimer les messages".`,
      {},
      20000
    );
  });
}

function batchKey(chatId, threadId) {
  return `${chatId}:${threadId || 0}`;
}

// Instance partagee : le dashboard web (routes/api.js) s'en sert pour
// rafraichir l'image de stats du groupe quand on modifie des colis sur le site.
let botInstance = null;

function startBot() {
  if (!TOKEN) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN manquant, le bot ne demarre pas.");
    return null;
  }

  const bot = new TelegramBot(TOKEN, { polling: true });
  botInstance = bot;
  // l'id du message de stats vaut pour un chat donne : si on a change de
  // groupe, on repart de zero au lieu d'essayer d'editer un message d'ailleurs
  if (getSetting("stats_group_chat", null) !== String(AUTO_GROUP_CHAT_ID)) {
    setStatsMessageId("group", "");
    setSetting("stats_group_chat", AUTO_GROUP_CHAT_ID);
    console.log("[bot] nouveau groupe detecte, l'image de stats sera repostee");
  }
  const batches = new Map(); // "chatId:threadId" -> { chatId, threadId, batchId, count, total, bySender, timer }

  bot.on("polling_error", (err) => console.error("[bot] polling_error", err.message));

  const handleIncoming = (msg) => {
    const attachment = colisAttachment(msg);
    if (!attachment) return;

    const forcedType = resolveForcedType(msg);
    if (forcedType === null) return; // groupe suivi mais topic non concerne

    const senderName = extractSenderName(msg);
    const carrier = detectCarrier(attachment.fileName, msg.caption, getCarrierRules());
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
        groupFirstMessage: new Map(),
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

    // Telegram n'autorise la reaction que sur le premier message d'un album :
    // on retient lequel c'est, et on ne reagit qu'une fois par album.
    const isNewGroup = msg.media_group_id && !batch.groupFirstMessage.has(msg.media_group_id);
    if (isNewGroup) batch.groupFirstMessage.set(msg.media_group_id, msg.message_id);
    const reactionMessageId = msg.media_group_id
      ? batch.groupFirstMessage.get(msg.media_group_id)
      : msg.message_id;
    if (!msg.media_group_id || isNewGroup) {
      queueReaction(bot, msg.chat.id, reactionMessageId, REACTION_RECEIVED);
    }

    const colis = addColis(senderName, {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      batchId: batch.batchId,
      type: forcedType || "normal",
      carrier,
      fileName: attachment.fileName,
      caption: msg.caption || null,
      fileId: attachment.fileId,
      fileKind: attachment.kind,
    });

    // transporteur non reconnu : nouvelle tentative a la fin du lot (la
    // legende de l'album a pu arriver apres), puis signalement sur Telegram
    if (!carrier && forcedType !== "bj") {
      batch.unresolved.push({
        colisId: colis.id,
        fileName: attachment.fileName,
        caption: msg.caption,
        mediaGroupId: msg.media_group_id,
        chatId: msg.chat.id,
        messageId: reactionMessageId,
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

  // Chaque commande est effacee du fil une fois traitee : le chat ne garde
  // que les colis et les recapitulatifs.
  const command = (handler) => (msg, match) => {
    try {
      handler(msg, match);
    } finally {
      deleteCommand(bot, msg);
    }
  };

  bot.onText(
    /^\/start/,
    command((msg) => {
      replyEphemeral(
        bot,
        msg,
        "Envoie-moi des PDF (transferes ou non), je compte les colis a dropper. Le prix depend de l'expediteur d'origine, configurable sur le dashboard.\n\n/lit ou /unlit en reponse a un colis pour changer son type\n/litall ou /unlitall pour appliquer au dernier groupe recu\n/prix 7.5 en reponse a un colis pour forcer son montant (sans reponse : applique au dernier groupe)\n/transporteur en reponse a un colis pour choisir sa compagnie dans une liste (ou /transporteur chrono directement)\n/del ou /clear en reponse a un fichier pour le retirer du suivi (avec ou sans effacer le fichier)\n/imprime pour fusionner les etiquettes d'un transporteur en un seul PDF",
        {},
        30000
      );
    })
  );

  bot.onText(/^\/lit(@\w+)?$/, command((msg) => handleSingleType(bot, msg, "lit")));
  bot.onText(/^\/unlit(@\w+)?$/, command((msg) => handleSingleType(bot, msg, "normal")));

  bot.onText(/^\/litall(@\w+)?$/, command((msg) => handleBatchType(bot, msg, "lit")));
  bot.onText(/^\/unlitall(@\w+)?$/, command((msg) => handleBatchType(bot, msg, "normal")));

  bot.onText(
    /^\/prix(@\w+)?\s+(-?[\d]+(?:[.,][\d]+)?)/,
    command((msg, match) => handlePrice(bot, msg, Number(String(match[2]).replace(",", "."))))
  );

  // /transporteur MR  (en reponse a un colis, sinon applique au dernier lot)
  // /transporteur     -> propose les transporteurs en boutons
  bot.onText(
    /^\/transporteur(@\w+)?(?:\s+(.+))?$/i,
    command((msg, match) => handleCarrierCommand(bot, msg, match[2]))
  );
  // Variantes /transporteur_mr, /transporteur_chrono... : elles servent
  // surtout a faire apparaitre les noms dans les suggestions de Telegram.
  bot.onText(
    /^\/transporteur_([a-z]+)(@\w+)?$/i,
    command((msg, match) => handleCarrierCommand(bot, msg, match[1]))
  );

  bot.onText(
    /^\/imprime(@\w+)?(?:\s+(.+))?$/i,
    command((msg, match) => handlePrintCommand(bot, msg, match[2]))
  );
  bot.onText(/^\/del(@\w+)?$/i, command((msg) => handleRemoveColis(bot, msg, true)));
  bot.onText(/^\/clear(@\w+)?$/i, command((msg) => handleRemoveColis(bot, msg, false)));

  bot.onText(/^\/regles(@\w+)?$/i, command((msg) => handleRulesCommand(bot, msg)));
  bot.onText(
    /^\/regles_reset(@\w+)?$/i,
    command((msg) => {
      const count = clearCarrierRules();
      replyEphemeral(bot, msg, `${count} regle(s) oubliee(s).`, {}, 8000);
    })
  );

  bot.on("callback_query", (query) => {
    if ((query.data || "").startsWith("pr:")) return handlePrintCallback(bot, query);
    return handleCarrierCallback(bot, query);
  });

  registerCommands(bot);

  console.log("[bot] demarre (polling)");
  return bot;
}

// La liste envoyee a Telegram alimente le menu de suggestions : en tapant
// "/transporteur", les noms des transporteurs apparaissent directement.
// Telegram choisit la liste selon la portee du chat : sans enregistrement
// explicite pour les groupes, le menu peut rester vide la-bas. On enregistre
// donc la meme liste pour toutes les portees utiles.
const COMMAND_SCOPES = [
  null, // portee par defaut
  { type: "all_private_chats" },
  { type: "all_group_chats" },
  { type: "all_chat_administrators" },
  { type: "chat", chat_id: AUTO_GROUP_CHAT_ID },
];

async function registerCommands(bot) {
  const commands = [
    { command: "start", description: "Mode d'emploi" },
    { command: "lit", description: "Passer le colis en LIT (en reponse)" },
    { command: "unlit", description: "Repasser le colis en normal (en reponse)" },
    { command: "litall", description: "Passer tout le dernier lot en LIT" },
    { command: "unlitall", description: "Repasser tout le dernier lot en normal" },
    { command: "prix", description: "Forcer le montant, ex: /prix 7.5" },
    { command: "transporteur", description: "Choisir le transporteur (en reponse au colis)" },
    { command: "imprime", description: "Fusionner les etiquettes a imprimer" },
    { command: "del", description: "Retirer le colis et effacer son fichier (en reponse)" },
    { command: "clear", description: "Retirer le colis mais garder le fichier (en reponse)" },
    { command: "regles", description: "Voir ce que le bot a appris" },
    ...CARRIERS.map((carrier) => ({
      command: `transporteur_${carrier.code.toLowerCase()}`,
      description: carrier.code === "BJ" ? "BJ (type de colis)" : carrier.label,
    })),
  ];

  for (const scope of COMMAND_SCOPES) {
    try {
      await bot.setMyCommands(commands, scope ? { scope } : {});
    } catch (err) {
      // la portee "chat" echoue si le bot n'est pas (encore) dans le groupe
      console.error(`[bot] setMyCommands ${scope ? scope.type : "default"} :`, err.message);
    }
  }
  console.log(`[bot] ${commands.length} commandes enregistrees`);
}

// Dans un groupe a topics, il faut repondre dans le topic d'origine.
function threadOpts(msg) {
  return msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
}

// Les reponses du bot s'effacent toutes seules : combinees a la suppression
// de la commande, le fil ne garde que les colis et le recapitulatif.
const REPLY_TTL_MS = Number(process.env.REPLY_TTL_MS || 2000);

function replyEphemeral(bot, msg, text, extra = {}, ttl = REPLY_TTL_MS) {
  return bot
    .sendMessage(msg.chat.id, text, { ...threadOpts(msg), ...extra })
    .then((sent) => {
      scheduleDelete(bot, sent.chat.id, sent.message_id, ttl);
      return sent;
    })
    .catch((err) => console.error("[bot] envoi reponse", err.message));
}

function scheduleDelete(bot, chatId, messageId, ttl = REPLY_TTL_MS) {
  setTimeout(() => {
    bot.deleteMessage(chatId, messageId).catch((err) => {
      console.error("[bot] suppression reponse impossible :", err.message);
    });
  }, ttl);
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
    replyEphemeral(bot, msg, target.error);
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
    bot
      .sendMessage(msg.chat.id, `Transporteur pour ${scope} ?`, {
        ...threadOpts(msg),
        reply_markup: { inline_keyboard: keyboard },
      })
      .catch((err) => console.error("[bot] envoi clavier", err.message));
    return;
  }

  const carrier = parseCarrier(rawName);
  if (!carrier) {
    replyEphemeral(bot, msg, `Transporteur inconnu : "${rawName.trim()}".\nAu choix : ${CARRIER_LIST_HINT}`);
    return;
  }

  const result = applyCarrier(target, carrier.code);
  replyEphemeral(bot, msg, result);
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
    .then(() => scheduleDelete(bot, query.message.chat.id, query.message.message_id))
    .catch((err) => console.error("[bot] editMessageText", err.message));
}

// Corriger un colis apprend au bot a reconnaitre les suivants : la forme du
// numero de suivi ("857030747501" -> 12 chiffres) et le mot-cle de la
// description ("DHL SCAN" -> DHL) deviennent des regles. Les colis en attente
// encore non classes repassent ensuite a la moulinette.
function learnFrom(colisList, code) {
  const learned = [];
  for (const colis of colisList) {
    if (!colis) continue;
    for (const rule of deriveRules(colis.file_name, colis.caption)) {
      saveCarrierRule(rule.kind, rule.value, code);
      learned.push(rule);
    }
  }
  if (learned.length === 0) return { learned, reclassified: 0 };

  const rules = getCarrierRules();
  let reclassified = 0;
  for (const pending of getUnclassifiedPending()) {
    const carrier = detectCarrier(pending.file_name, pending.caption, rules);
    if (!carrier) continue;
    setColisCarrier(pending.id, carrier);
    reclassified += 1;
  }
  return { learned, reclassified };
}

function describeLearned(learned, reclassified, code) {
  if (learned.length === 0) return "";
  const parts = learned.map((rule) =>
    rule.kind === "keyword" ? `« ${rule.value} »` : `les numeros en ${describeShape(rule.value)}`
  );
  const unique = [...new Set(parts)];
  return (
    `\nAppris : ${unique.join(" et ")} = ${carrierLabel(code)}.` +
    (reclassified > 0 ? ` ${reclassified} colis reclasses.` : "")
  );
}

// "D12" -> "12 chiffres", "L2D9L2" -> "2 lettres + 9 chiffres + 2 lettres"
function describeShape(shape) {
  return (shape.match(/[DL]\d+/g) || [])
    .map((run) => `${run.slice(1)} ${run[0] === "D" ? "chiffres" : "lettres"}`)
    .join(" + ");
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
    const { learned, reclassified } = learnFrom([updated], code);
    return (
      `Colis #${updated.id} (${updated.sender_name}) : transporteur ${carrierLabel(code)}.` +
      describeLearned(learned, reclassified, code)
    );
  }

  const batchColis = getBatchColis(target.id);
  const count = code === "BJ" ? setBatchType(target.id, "bj") : setBatchCarrier(target.id, code);
  if (count === 0) return "Aucun colis en attente dans le dernier lot.";
  const label = code === "BJ" ? "BJ" : carrierLabel(code);
  const { learned, reclassified } = code === "BJ" ? { learned: [], reclassified: 0 } : learnFrom(batchColis, code);
  return `${count} colis passes en ${label}.` + describeLearned(learned, reclassified, code);
}

// --- Suppression d'un colis -------------------------------------------------
// /del  : retire le colis du suivi ET efface le fichier du fil Telegram.
// /clear: retire le colis du suivi (site, compagnies a poster, /imprime) mais
//         laisse le fichier dans la conversation.
function handleRemoveColis(bot, msg, alsoDeleteFile) {
  const reply = msg.reply_to_message;
  const commande = alsoDeleteFile ? "/del" : "/clear";
  if (!reply) {
    return replyEphemeral(bot, msg, `Reponds au fichier a retirer avec ${commande}.`, {}, 8000);
  }

  const colis = findColisByMessage(msg.chat.id, reply.message_id);
  if (!colis) {
    return replyEphemeral(bot, msg, "Ce message n'est pas un colis en attente.", {}, 8000);
  }

  const removed = deleteColis(colis.id);
  if (!removed) return replyEphemeral(bot, msg, "Colis introuvable.", {}, 8000);

  if (alsoDeleteFile) {
    bot
      .deleteMessage(msg.chat.id, reply.message_id)
      .catch((err) => console.error("[bot] suppression du fichier impossible :", err.message));
  }

  refreshGroupStats();
  replyEphemeral(
    bot,
    msg,
    `Colis #${removed.id} (${removed.sender_name}, ${removed.price.toFixed(2)} EUR) retire du suivi` +
      `${alsoDeleteFile ? " et efface du fil." : ". Le fichier reste dans la conversation."}`
  );
}

// --- Impression ------------------------------------------------------------
// Fusionne les etiquettes en attente d'un transporteur en un seul PDF au
// format exact de l'imprimante thermique 4x6. Reserve au proprietaire et au
// tete-a-tete avec le bot : c'est un fichier qui contient toutes les
// etiquettes, il n'a rien a faire dans un groupe.
// Ouvert a tout le monde, mais pas n'importe ou : en tete-a-tete avec le bot,
// ou dans le groupe de travail. Le PDF regroupe toutes les etiquettes en
// attente du transporteur choisi, quel que soit l'expediteur : il n'a rien a
// faire dans un groupe tiers.
function canPrint(msg) {
  return msg.chat.type === "private" || msg.chat.id === AUTO_GROUP_CHAT_ID;
}

function handlePrintCommand(bot, msg, rawName) {
  if (!canPrint(msg)) {
    return replyEphemeral(
      bot,
      msg,
      "La commande /imprime ne marche qu'en message prive avec le bot ou dans le groupe de travail.",
      {},
      8000
    );
  }

  const summary = getPrintableSummary().filter((row) => row.count > 0);
  if (summary.length === 0) {
    return replyEphemeral(bot, msg, "Aucune etiquette en attente a imprimer.", {}, 8000);
  }

  if (rawName && rawName.trim()) {
    const carrier = parseCarrier(rawName);
    if (!carrier) {
      return replyEphemeral(bot, msg, `Transporteur inconnu : "${rawName.trim()}".\nAu choix : ${CARRIER_LIST_HINT}`);
    }
    return sendMergedLabels(bot, msg, carrier.code);
  }

  const keyboard = [];
  for (let i = 0; i < summary.length; i += 2) {
    keyboard.push(
      summary.slice(i, i + 2).map((row) => ({
        text: `${carrierLabel(row.carrier)} (${row.count})`,
        callback_data: `pr:${row.carrier}`,
      }))
    );
  }
  const total = summary.reduce((sum, row) => sum + row.count, 0);
  keyboard.push([{ text: `Tout (${total})`, callback_data: "pr:*" }]);

  bot
    .sendMessage(msg.chat.id, "Quelles etiquettes imprimer ?", {
      reply_markup: { inline_keyboard: keyboard },
    })
    .catch((err) => console.error("[bot] clavier impression", err.message));
}

function handlePrintCallback(bot, query) {
  const msg = { chat: query.message.chat, from: query.from };
  if (!canPrint(msg)) {
    return bot.answerCallbackQuery(query.id, { text: "Pas ici." }).catch(() => {});
  }

  const code = (query.data || "").slice(3);
  bot.answerCallbackQuery(query.id, { text: "Preparation..." }).catch(() => {});
  bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
  sendMergedLabels(bot, msg, code);
}

// Telecharge les etiquettes une par une (Telegram limite les rafales), les
// assemble, puis renvoie le PDF pret a imprimer.
async function sendMergedLabels(bot, msg, code) {
  const chatId = msg.chat.id;
  const rows =
    code === "*"
      ? getPrintableSummary().flatMap((row) => getPrintableColis(row.carrier))
      : getPrintableColis(code);

  if (rows.length === 0) {
    return replyEphemeral(bot, msg, `Aucune etiquette ${code === "*" ? "" : carrierLabel(code)} a imprimer.`, {}, 8000);
  }

  const progress = await startProgress(bot, chatId, rows.length);

  const { labels, missing } = await downloadLabels(bot, rows, () => progress.step());

  await progress.finish("Assemblage du PDF...");
  const { pdf, pages, failed } = await mergeLabels(labels);
  progress.remove();

  if (!pdf) {
    return bot.sendMessage(chatId, "Aucune etiquette lisible : rien a imprimer.").catch(() => {});
  }

  const name = code === "*" ? "toutes" : carrierLabel(code).toLowerCase().replace(/\s+/g, "-");
  const caption =
    `${pages} etiquette${pages > 1 ? "s" : ""} — ${carrierPrintTitle(code)}\n` +
    `Format ${(LABEL_WIDTH / 72 * 25.4).toFixed(0)}x${(LABEL_HEIGHT / 72 * 25.4).toFixed(0)} mm (4x6"), imprime en "taille reelle".` +
    (missing.length > 0 ? `\n⚠️ ${missing.length} fichier(s) introuvable(s) sur Telegram.` : "") +
    (failed.length > 0 ? `\n⚠️ ${failed.length} fichier(s) illisible(s).` : "");

  await bot
    .sendDocument(chatId, pdf, { caption }, { filename: `etiquettes-${name}.pdf`, contentType: "application/pdf" })
    .catch((err) => bot.sendMessage(chatId, `Envoi impossible : ${err.message}`).catch(() => {}));
}

// Recupere les fichiers aupres de Telegram. Un fichier introuvable (trop
// vieux, message supprime) n'interrompt pas le lot : il est juste signale.
async function downloadLabels(bot, rows, onStep) {
  const labels = [];
  const missing = [];

  for (const row of rows) {
    try {
      const link = await bot.getFileLink(row.file_id);
      const res = await fetch(link);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      labels.push({
        bytes: new Uint8Array(await res.arrayBuffer()),
        kind: row.file_kind === "image" ? "image" : "pdf",
        label: row.file_name || `colis #${row.id}`,
        colisId: row.id,
      });
    } catch (err) {
      missing.push({ id: row.id, label: row.file_name || `colis #${row.id}`, reason: err.message });
    }
    if (onStep) await onStep();
  }
  return { labels, missing };
}

// Utilise par le dashboard (impression automatique) : meme chaine que
// /imprime, sans Telegram autour.
async function buildLabelsPdf(rows) {
  if (!botInstance) throw new Error("bot non demarre");
  const { labels, missing } = await downloadLabels(botInstance, rows);
  const { pdf, pages, failed } = await mergeLabels(labels);
  const printedIds = labels
    .filter((l) => !failed.some((f) => f.label === l.label))
    .map((l) => l.colisId);
  return { pdf, pages, printedIds, missing, failed };
}

// Barre de progression : un seul message, edite au fil des telechargements.
// Telegram limite les editions, d'ou le pas minimum d'une seconde entre deux
// mises a jour (la derniere etape est toujours affichee).
const PROGRESS_SLOTS = 12;
const PROGRESS_MIN_INTERVAL_MS = 1000;

function progressBar(done, total) {
  const ratio = total > 0 ? done / total : 1;
  const filled = Math.round(ratio * PROGRESS_SLOTS);
  return `${"█".repeat(filled)}${"░".repeat(PROGRESS_SLOTS - filled)} ${Math.round(ratio * 100)} %`;
}

async function startProgress(bot, chatId, total) {
  const text = (done, suffix) =>
    `Preparation des etiquettes\n${progressBar(done, total)}\n${suffix || `${done}/${total} recuperees`}`;

  const message = await bot.sendMessage(chatId, text(0)).catch(() => null);
  let done = 0;
  let lastEdit = 0;

  const edit = async (suffix) => {
    if (!message) return;
    await bot
      .editMessageText(text(done, suffix), { chat_id: chatId, message_id: message.message_id })
      .catch(() => {});
    lastEdit = Date.now();
  };

  return {
    async step() {
      done += 1;
      const last = done >= total;
      if (!last && Date.now() - lastEdit < PROGRESS_MIN_INTERVAL_MS) return;
      await edit();
    },
    async finish(suffix) {
      await edit(suffix);
    },
    remove() {
      if (message) bot.deleteMessage(chatId, message.message_id).catch(() => {});
    },
  };
}

function carrierPrintTitle(code) {
  return code === "*" ? "tous transporteurs" : carrierLabel(code);
}

// Liste ce que le bot a appris, et permet de tout oublier si une regle s'avere
// fausse.
function handleRulesCommand(bot, msg) {
  const rules = listCarrierRules();
  if (rules.length === 0) {
    return replyEphemeral(bot, msg, "Aucune regle apprise pour l'instant.", {}, 10000);
  }
  const lines = rules
    .slice(0, 30)
    .map((r) => `  • ${r.kind === "keyword" ? `« ${r.value} »` : describeShape(r.value)} → ${carrierLabel(r.carrier)}`);
  const extra = rules.length > 30 ? `\n  … et ${rules.length - 30} autre(s)` : "";
  replyEphemeral(
    bot,
    msg,
    `${rules.length} regle(s) apprise(s) :\n${lines.join("\n")}${extra}\n\n/regles_reset pour tout oublier.`,
    {},
    30000
  );
}

function handleSingleType(bot, msg, type) {
  const reply = msg.reply_to_message;
  if (!reply) {
    replyEphemeral(bot, msg, "Reponds a un message contenant un colis avec /lit ou /unlit.");
    return;
  }
  const colis = findColisByMessage(msg.chat.id, reply.message_id);
  if (!colis) {
    replyEphemeral(bot, msg, "Colis introuvable (deja drope ou pas un colis).");
    return;
  }
  const updated = setColisType(colis.id, type);
  const label = type === "lit" ? "LIT" : "normal";
  replyEphemeral(bot, msg, `Colis #${updated.id} (${updated.sender_name}) passe en ${label} (${updated.price.toFixed(2)} EUR).`);
}

function handleBatchType(bot, msg, type) {
  const batchId = getLatestBatchId(msg.chat.id);
  if (!batchId) {
    replyEphemeral(bot, msg, "Aucun groupe de colis recent trouve.");
    return;
  }
  const count = setBatchType(batchId, type);
  const label = type === "lit" ? "LIT" : "normal";
  if (count === 0) {
    replyEphemeral(bot, msg, "Aucun colis en attente dans le dernier groupe.");
    return;
  }
  replyEphemeral(bot, msg, `${count} colis passes en ${label}.`);
}

function handlePrice(bot, msg, price) {
  if (Number.isNaN(price) || price < 0) {
    replyEphemeral(bot, msg, "Montant invalide. Exemple : /prix 7.5");
    return;
  }

  const reply = msg.reply_to_message;
  if (reply) {
    const colis = findColisByMessage(msg.chat.id, reply.message_id);
    if (!colis) {
      replyEphemeral(bot, msg, "Colis introuvable (deja drope ou pas un colis).");
      return;
    }
    const updated = setColisPrice(colis.id, price);
    replyEphemeral(bot, msg, `Colis #${updated.id} (${updated.sender_name}) passe a ${price.toFixed(2)} EUR.`);
    return;
  }

  // sans reponse a un colis precis, on applique au dernier groupe recu
  const batchId = getLatestBatchId(msg.chat.id);
  if (!batchId) {
    replyEphemeral(bot, msg, "Aucun colis recent trouve.");
    return;
  }
  const count = setBatchPrice(batchId, price);
  if (count === 0) {
    replyEphemeral(bot, msg, "Aucun colis en attente dans le dernier groupe.");
    return;
  }
  replyEphemeral(bot, msg, `${count} colis passes a ${price.toFixed(2)} EUR.`);
}

// Met a jour l'image de stats deja postee plutot que d'en empiler une
// nouvelle. editMessageMedia de la librairie attend un chemin de fichier
// (attach://...), d'ou le passage par un fichier temporaire.
// Renvoie false si le message n'existe plus : l'appelant en poste alors un neuf.
async function editStatsPhoto(bot, messageId, image) {
  const tmpPath = path.join(os.tmpdir(), `drop-stats-${Date.now()}.png`);
  try {
    fs.writeFileSync(tmpPath, image);
    await bot.editMessageMedia(
      { type: "photo", media: `attach://${tmpPath}` },
      { chat_id: AUTO_GROUP_CHAT_ID, message_id: messageId }
    );
    return true;
  } catch (err) {
    // image identique : rien a faire, mais le message est toujours la
    if (/not modified/i.test(err.message)) return true;
    console.error("[bot] edition image stats impossible :", err.message);
    return false;
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }
}

async function updateGroupStatsPhoto(bot, addedCount) {
  try {
    const { count, value } = getPendingSummary();
    // rafraichissement depuis le site : on garde le "dernier ajout" du
    // dernier lot recu plutot que d'afficher +0
    const added = addedCount === null ? Number(getSetting("last_added_count", 0)) : addedCount;
    if (addedCount !== null) setSetting("last_added_count", addedCount);
    const image = await renderStatsImage({ pendingCount: count, pendingValue: value, addedCount: added });

    const prevId = getStatsMessageId("group");
    if (prevId && (await editStatsPhoto(bot, prevId, image))) return;

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

// Un fichier dont le transporteur n'a pas ete reconnu recoit un point
// d'interrogation en reaction : ca remplace le pouce sur le message concerne,
// sans polluer le fil avec un message d'alerte.
function reactUnknownCarriers(bot, unknown) {
  if (!unknown || unknown.length === 0) return;
  const done = new Set();
  for (const item of unknown) {
    const key = `${item.chatId}:${item.messageId}`;
    if (done.has(key)) continue; // album : une seule reaction possible
    done.add(key);
    queueReaction(bot, item.chatId, item.messageId, REACTION_UNKNOWN, REACTION_UNKNOWN_FALLBACK);
  }
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
    const carrier = groupCaption ? detectCarrier(item.fileName, groupCaption, getCarrierRules()) : null;
    if (carrier) setColisCarrier(item.colisId, carrier);
    else stillUnknown.push({ ...item, caption: item.caption || groupCaption });
  }
  return stillUnknown;
}

function flushBatch(bot, key, batches) {
  const batch = batches.get(key);
  if (!batch) return;
  batches.delete(key);

  reactUnknownCarriers(bot, resolveBatchCarriers(batch));
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
// Le contenu exact est calcule dans push.js a partir de la base : ici on ne
// passe que le nombre du lot, utilise tant que le site n'a jamais ete ouvert.
function pushBatchNotification(batch) {
  notifyNewColis({ count: batch.count });
}

// Appele par le dashboard apres chaque modification de colis : l'image postee
// dans le groupe suit ce qu'on fait sur le site. Regroupe les appels rapproches
// (drop de plusieurs expediteurs a la suite) en une seule edition.
let refreshTimer = null;
function refreshGroupStats() {
  if (!botInstance) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    updateGroupStatsPhoto(botInstance, null);
  }, 800);
}

module.exports = { startBot, refreshGroupStats, buildLabelsPdf };
