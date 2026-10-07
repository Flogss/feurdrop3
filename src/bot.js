const fs = require("fs");
const os = require("os");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const {
  addColis,
  createBatch,
  findColisByMessage,
  findAnyColisByMessage,
  getLatestBatchId,
  setColisType,
  setBatchType,
  setColisPrice,
  setColisCarrier,
  setColisMessage,
  setBatchCarrier,
  saveCarrierRule,
  getCarrierRules,
  listCarrierRules,
  clearCarrierRules,
  getUnclassifiedPending,
  getPrintableColis,
  getPrintableSummary,
  countAlreadyPrinted,
  getLitPrintable,
  countLitPrintable,
  markPrinted,
  getPrintJobs,
  getPrintJobColis,
  getColisById,
  evenements,
  dropColis,
  consumeStock,
  FREE_STATUS,
  getBatchColis,
  deleteColis,
  setBatchPrice,
  setColisNote,
  setBatchNote,
  getPendingSummary,
  getStatsMessageId,
  setStatsMessageId,
  getSetting,
  setSetting,
  journalise,
  undropColis,
  restoreStock,
  inscritArrivee,
  getArrivee,
  arriveeLiee,
  arriveeFaite,
  arriveeRatee,
  arriveesEnAttente,
} = require("./db");
const { renderStatsImage } = require("./statsImage");
const { detectCarrier, CARRIERS, parseCarrier, carrierLabel, deriveRules } = require("./carrier");
const { mergeLabels } = require("./printer");
const { buildRoll } = require("./rollPrinter");
const { createWriteQueue, delaiDemande, avecReessais } = require("./throttle");
const {
  apparieColis,
  apparieCode,
  paireDuColis,
  getPaire,
  setCodeMessage,
  oublieCode,
  roleSpecial,
  paireDuCode,
  paireParNumero,
  relie,
  retireCode,
  rendSeul,
  finiSeul,
} = require("./specials");
const { notifyNewColis } = require("./push");
const { classifyFile } = require("./classify");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8957997002:AAEzvJXgMZ9Qn7E4ERirZHTrTfseF8WDKm4";
const DEBOUNCE_MS = Number(process.env.BATCH_DEBOUNCE_MS || 3000);

// Groupe Telegram avec topics dedies : les PDF envoyes directement dans ces
// topics sont comptes automatiquement, sans avoir besoin de forward au bot.
const AUTO_GROUP_CHAT_ID = -1004388459228; // derive de l'id de canal 4388459228 (t.me/c/4388459228/...)
const AUTO_LIT_TOPIC_IDS = [4];
const AUTO_NORMAL_TOPIC_IDS = [2];
// Les colis BJ sont factures comme des colis normaux, ils sont juste
// comptabilises a part pour le suivi.
const AUTO_BJ_TOPIC_IDS = [6];
// Topic "special" : photos de contexte, captures, colis pris en photo. A
// renseigner dans SPECIAL_TOPIC_ID (le nombre a la fin du lien t.me/c/.../N).
// t.me/c/4388459228/5 . On y envoie aussi des PDF : dans "special" un PDF
// reste un colis ordinaire, seules les images y valent 0 EUR.
const AUTO_SPECIAL_TOPIC_IDS = (process.env.SPECIAL_TOPIC_ID || "5")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter(Number.isFinite);

// Ou reposter un fichier selon son type. Le topic 1 d'un forum est le General
// et n'a pas de message_thread_id cote Bot API : d'ou le filtre.
const TOPIC_BY_TYPE = {
  normal: AUTO_NORMAL_TOPIC_IDS[0],
  lit: AUTO_LIT_TOPIC_IDS[0],
  bj: AUTO_BJ_TOPIC_IDS[0],
  special: AUTO_SPECIAL_TOPIC_IDS[0],
};

const TYPE_LABELS = {
  normal: "Normaux",
  lit: "LIT",
  bj: "Boite jaune",
  special: "Special",
};
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
    if (AUTO_SPECIAL_TOPIC_IDS.includes(threadId)) return "special";
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

// Toutes les ecritures vers le groupe passent par une file cadencee : voir
// throttle.js pour le pourquoi.
// Les envois (copies de fichiers) sont doses sur le plafond de Telegram ; le
// reste -- editions, suppressions groupees, image de stats -- passe dans la
// meme file, a un rythme plus serre, puisqu'il ne compte pas dans ce plafond.
const ecritureGroupe = createWriteQueue({
  intervalMs: Number(process.env.GROUP_WRITE_INTERVAL_MS || 350),
  envoisParMinute: Number(process.env.GROUP_SENDS_PER_MIN || 20),
  fenetreMs: Number(process.env.GROUP_SENDS_WINDOW_MS || 60000),
  onWait: (secondes, err) =>
    console.warn(err ? `[bot] ${err.message} : nouvel essai dans ${secondes}s` : `[bot] 429 : pause de ${secondes}s avant de reessayer`),
});

// Les reactions partent une par une : un lot de 20 fichiers ferait sinon
// autant d'appels simultanes et Telegram limiterait.
let reactionQueue = Promise.resolve();
function queueReaction(bot, chatId, messageId, emoji, fallbackEmoji) {
  if (!chatId || !messageId) return;
  const react = (value) =>
    bot.setMessageReaction(chatId, messageId, { reaction: [{ type: "emoji", emoji: value }] });

  // dans le groupe, une reaction est une ecriture comme une autre : elle prend
  // sa place dans la file au lieu de doubler les copies en cours
  if (chatId === AUTO_GROUP_CHAT_ID) {
    ecritureGroupe(() => react(emoji))
      .catch(() => (fallbackEmoji ? ecritureGroupe(() => react(fallbackEmoji)) : null))
      .catch((err) => console.error("[bot] reaction", err.message));
    return;
  }

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

    // mode fusion (/fusion) : le fichier est mis de cote pour le PDF fusionne,
    // il ne compte pas et n'est pas republie
    if (ajouteAFusion(bot, msg, attachment)) return;

    const forcedType = resolveForcedType(msg);
    if (forcedType === null) return; // groupe suivi mais topic non concerne

    // Deux entrees, une seule file (voir routeToTopic) :
    //   - en tete-a-tete, le bot classe le fichier et le republie dans le bon
    //     topic : plus besoin de trier avant d'envoyer ;
    //   - poste a la main dans un topic, le fichier y reste, mais c'est le bot
    //     qui le republie, pour qu'il ait ses boutons comme les autres.
    // Un par un, dans l'ordre d'arrivee : c'est aussi l'ordre qui appaire un
    // code-barre de special avec son PDF.
    // Inscrit en base AVANT tout traitement (voir "Arrivees" dans db.js) : un
    // redemarrage ne perd plus rien, et un message que Telegram livre deux
    // fois n'est traite qu'une fois.
    const arriveeId = inscritArrivee(msg.chat.id, msg.message_id, msg);
    if (!arriveeId) return;
    enfileFichier(bot, msg, attachment, batches, arriveeId);
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
        "Envoie-moi tes fichiers ici : je les classe et je les republie moi-meme dans le bon topic (normaux, LIT, boite jaune), sans toucher au fichier ni a sa legende. Special, c'est a la main avec /special.\n\nTu peux aussi poster directement dans un topic : je republie le fichier a l'identique dans ce meme topic, avec ses boutons, et j'efface le tien.\n\nDans special, chaque colis va avec le code qui ouvre son locker. Le code est hors suivi comme apres /clear, mais numerote avec son colis (meme numero sous les deux, dans l'ordre d'envoi, par client). La legende tranche entre code et colis (\"t'ouvres le locker avec ca\" / \"tu mets lui dedans\"), sinon image = code et PDF = colis.\n/special image 3 en reponse : ce fichier (image ou PDF) ouvre le locker du #3\n/special pdf 3 en reponse : ce fichier est le colis du #3\n/special seul en reponse : ce fichier ouvre un locker mais ne va avec aucun PDF\n/del ou /clear en reponse a un code : le retire de sa paire\n\nSous chaque etiquette republiee : Imprime, Clean, Del. Une fois imprimee, un bouton Drop pour la solder a l'unite.\n\nJe compte les colis a dropper. Le prix depend de l'expediteur d'origine, configurable sur le dashboard.\n\n/lit ou /unlit en reponse a un colis : change son type ET deplace le fichier dans le bon topic\n/litall ou /unlitall pour appliquer au dernier groupe recu\n/normal en reponse a un colis pour le remettre dans normaux (/normalall : tout le dernier groupe)\n/special en reponse a un fichier : l'envoie dans special, comme code du locker ou comme colis selon sa legende\n/prix 7.5 en reponse a un colis pour forcer son montant (sans reponse : applique au dernier groupe)\n/note fragile en reponse a un colis : il passe en premier a l'impression et s'affiche en rouge sur le site (/note seul efface)\n/transporteur en reponse a un colis pour choisir sa compagnie dans une liste (ou /transporteur chrono directement)\n/del ou /clear en reponse a un fichier pour le retirer du suivi (avec ou sans effacer le fichier)\n/imprime pour fusionner les etiquettes d'un transporteur en un seul PDF\n/fusion : les fichiers que tu m'envoies ensuite ne comptent pas, je les garde de cote ; /stopfusion pour les recevoir fusionnes en un seul PDF",
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

  // /note fragile  (en reponse a un colis, sinon applique au dernier lot)
  // /note          efface la note
  bot.onText(
    /^\/note(@\w+)?(?:\s+([\s\S]+))?$/i,
    command((msg, match) => handleNote(bot, msg, match[2]))
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
  bot.onText(/^\/special(@\w+)?$/i, command((msg) => handleMoveType(bot, msg, "special")));
  // /special image 3 : ce fichier est le code qui ouvre le locker du #3
  // /special pdf 3   : ce fichier est le colis a mettre dans le locker du #3
  // "image" et "pdf" disent le role, pas la nature : un code peut etre un PDF
  bot.onText(
    /^\/special(@\w+)?\s+(image|img|code|pdf|colis)\s*#?\s*(\d+)\s*$/i,
    command((msg, m) => handleLienSpecial(bot, msg, /^(image|img|code)$/i.test(m[2]) ? "code" : "colis", Number(m[3])))
  );
  // /special seul : ce fichier ouvre un locker mais ne va avec aucun PDF
  bot.onText(/^\/special(@\w+)?\s+seule?\s*$/i, command((msg) => handleSeul(bot, msg)));
  bot.onText(
    /^\/special(@\w+)?\s+(image|img|code|pdf|colis)\s*$/i,
    command((msg) =>
      replyEphemeral(bot, msg, "Il manque le numero : /special image 3 (ce fichier ouvre le locker du #3) " +
        "ou /special pdf 3 (ce fichier est le colis du #3).", {}, 12000)
    )
  );
  // /normal ramene un colis dans normaux, d'ou qu'il vienne : special, LIT ou
  // boite jaune. /normalall fait de meme pour tout le dernier lot.
  bot.onText(/^\/normal(@\w+)?$/i, command((msg) => handleMoveType(bot, msg, "normal")));
  bot.onText(/^\/normalall(@\w+)?$/i, command((msg) => handleBatchType(bot, msg, "normal")));
  bot.onText(/^\/del(@\w+)?$/i, command((msg) => handleRemoveColis(bot, msg, true)));
  bot.onText(/^\/clear(@\w+)?$/i, command((msg) => handleRemoveColis(bot, msg, false)));

  bot.onText(/^\/fusion(@\w+)?$/i, command((msg) => handleFusion(bot, msg)));
  bot.onText(/^\/stopfusion(@\w+)?$/i, command((msg) => handleStopFusion(bot, msg)));

  bot.onText(/^\/regles(@\w+)?$/i, command((msg) => handleRulesCommand(bot, msg)));
  bot.onText(
    /^\/regles_reset(@\w+)?$/i,
    command((msg) => {
      const count = clearCarrierRules();
      replyEphemeral(bot, msg, `${count} regle(s) oubliee(s).`, {}, 8000);
    })
  );

  bot.on("callback_query", (query) => {
    if (/^c:/.test(query.data || "")) return handleFileButton(bot, query);
    if (/^sp:/.test(query.data || "")) return handleCodeButton(bot, query);
    if (/^pra?:|^prmenu:|^prjob:/.test(query.data || "")) return handlePrintCallback(bot, query);
    return handleCarrierCallback(bot, query);
  });

  registerCommands(bot);

  // ce qui restait a traiter au dernier arret (mise a jour en plein envoi) :
  // repris dans l'ordre d'arrivee
  const restantes = arriveesEnAttente();
  if (restantes.length) console.log(`[bot] ${restantes.length} fichier(s) recu(s) avant l'arret : repris`);
  for (const a of restantes) {
    let msg;
    try {
      msg = JSON.parse(a.message);
    } catch {
      arriveeRatee(a.id, "message illisible", { definitif: true });
      continue;
    }
    const attachment = colisAttachment(msg);
    if (!attachment) {
      arriveeFaite(a.id);
      continue;
    }
    enfileFichier(bot, msg, attachment, batches, a.id);
  }

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
    { command: "note", description: "Annoter le colis : il sort en premier (en reponse)" },
    { command: "transporteur", description: "Choisir le transporteur (en reponse au colis)" },
    { command: "imprime", description: "Fusionner les etiquettes a imprimer" },
    { command: "fusion", description: "Mode fusion : les fichiers envoyes ne comptent pas" },
    { command: "stopfusion", description: "Fin du mode fusion : recevoir le PDF fusionne" },
    { command: "del", description: "Retirer le colis et effacer son fichier (en reponse)" },
    { command: "special", description: "Dans Special (en reponse). /special image 3, /special pdf 3, /special seul" },
    { command: "normal", description: "Remettre le colis dans Normaux (en reponse)" },
    { command: "normalall", description: "Remettre tout le dernier lot dans Normaux" },
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

// Correction du transporteur depuis le site : meme geste que /transporteur en
// reponse a un colis, donc meme apprentissage -- la forme du numero et le
// mot-cle servent aux fichiers suivants. "Non reconnu" (null) efface le
// transporteur sans rien apprendre.
function corrigeTransporteur(id, code) {
  const colis = setColisCarrier(id, code || null, { journal: true });
  if (!colis) return null;
  if (!code) return { colis, appris: "" };
  const { learned, reclassified } = learnFrom([colis], code);
  return { colis, appris: describeLearned(learned, reclassified, code).trim() };
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
    const updated = setColisCarrier(target.id, code, { journal: true });
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
    // le code qui ouvre un locker n'est pas un colis, mais il se retire pareil
    const paire = paireDuCode(msg.chat.id, reply.message_id);
    if (paire) return retireCodeSpecial(bot, msg, paire, alsoDeleteFile);
    return replyEphemeral(bot, msg, "Ce message n'est ni un colis en attente ni un code de locker.", {}, 8000);
  }

  const removed = deleteColis(colis.id);
  if (!removed) return replyEphemeral(bot, msg, "Colis introuvable.", {}, 8000);

  if (alsoDeleteFile && removed.chat_id && removed.message_id) {
    // le fichier du topic, meme quand on repond a l'original dans le prive :
    // c'est lui qu'on veut voir disparaitre
    ecritureGroupe(() => bot.deleteMessage(removed.chat_id, removed.message_id)).catch((err) =>
      console.error("[bot] suppression du fichier impossible :", err.message)
    );
  }

  refreshGroupStats();
  replyEphemeral(
    bot,
    msg,
    `Colis #${removed.id} (${removed.sender_name}, ${removed.price.toFixed(2)} EUR) retire du suivi` +
      `${alsoDeleteFile ? " et efface du fil." : ". Le fichier reste dans la conversation."}`
  );
}

// /del sur un code : il sort de sa paire et le fichier est efface. /clear : il
// sort de sa paire, le fichier reste. Dans les deux cas son colis, s'il en a
// un, repasse "code en attente" -- et garde son numero.
function retireCodeSpecial(bot, msg, paire, alsoDeleteFile) {
  const numero = paire.numero;
  const { code_chat_id: chatId, code_message_id: messageId } = paire;
  const reste = retireCode(paire.id);

  if (alsoDeleteFile) {
    ecritureGroupe(() => bot.deleteMessage(chatId, messageId)).catch((err) =>
      console.error("[bot] suppression du code impossible :", err.message)
    );
  } else {
    poseBoutons(bot, chatId, messageId, { inline_keyboard: [] }).catch(() => {});
  }
  if (reste?.colis_id) refreshFileButtons(bot, getColisById(reste.colis_id));

  replyEphemeral(
    bot,
    msg,
    `Code #${numero} retire${alsoDeleteFile ? " et efface du fil" : ""}.` +
      (reste?.colis_id ? ` Le colis #${numero} attend un autre code.` : "")
  );
}


// --- Aiguillage des fichiers envoyes en prive --------------------------------
//
// Le fichier est republie tel quel dans le topic qui lui revient : copyMessage
// conserve le document et sa legende a l'octet pres, contrairement a un renvoi
// qui ajouterait un en-tete "transfere de". Le colis est ensuite rattache au
// message REPUBLIE, pour que /del et les boutons agissent la ou le fichier se
// trouve vraiment.

// Boutons sous un PDF republie. Ils font exactement ce que font les commandes
// /clear et /del, plus un "Imprime" qui sort l'etiquette de la file de
// /imprime sans rien effacer.
// Trois etats, dans l'ordre de la vie d'une etiquette :
//   a imprimer : Imprime / Clean / Del
//   imprimee   : Drop -- une liasse imprimee ne part pas forcement d'un bloc,
//                on doit pouvoir solder les colis un par un a mesure qu'on
//                les poste
//   dropee     : "Drope" -- un nouvel appui annule le drop (colis remis en
//                attente, de retour dans la file d'impression s'il n'avait pas
//                ete imprime)
function fileButtons(colisId, { printed = false, dropped = false, note = null, special = null } = {}) {
  const lignes = [];
  // un PDF de special porte le numero de sa paire : c'est ce qui le relie a
  // son code-barre devant le locker
  if (special) {
    lignes.push([
      {
        text: `⭐ #${special.numero} · ${special.code ? "🔑 code lie" : "🔑 code en attente"}`,
        callback_data: `c:s:${colisId}`,
      },
    ]);
  }
  // La note se lit sous le fichier sans y toucher : la legende reste celle de
  // l'expediteur. Le texte entier s'affiche en tapant dessus.
  if (note) {
    lignes.push([{ text: `📝 ${tronque(note, 40)}`, callback_data: `c:m:${colisId}` }]);
  }
  if (dropped) {
    lignes.push([{ text: "✅ Drope · annuler", callback_data: `c:k:${colisId}` }]);
  } else if (printed) {
    lignes.push([{ text: "📮 Drop", callback_data: `c:x:${colisId}` }]);
  } else {
    lignes.push([
      { text: "🖨 Imprime", callback_data: `c:p:${colisId}` },
      { text: "🧹 Clean", callback_data: `c:c:${colisId}` },
      { text: "🗑 Del", callback_data: `c:d:${colisId}` },
    ]);
  }
  return { inline_keyboard: lignes };
}

// Les boutons d'un colis se deduisent de son etat en base : un seul endroit
// pour les calculer, quel que soit le geste qui vient de le modifier.
function boutonsDe(colis) {
  const paire = colis.type === "special" ? paireDuColis(colis.id) : null;
  return fileButtons(colis.id, {
    printed: Boolean(colis.printed_at),
    dropped: colis.status === "dropped",
    note: colis.note,
    special: paire ? { numero: paire.numero, code: Boolean(paire.code_file_id) } : null,
  });
}

// Une image de "special" vaut 0 EUR et ne se drope pas : elle n'a rien a
// faire de boutons. Tout le reste, PDF ou image, est un vrai colis.
function aDesBoutons(colis) {
  return Boolean(colis) && colis.status !== FREE_STATUS;
}

function tronque(texte, max) {
  const propre = String(texte).replace(/\s+/g, " ").trim();
  return propre.length > max ? `${propre.slice(0, max - 1)}…` : propre;
}

// --- Pose des boutons ---------------------------------------------------------
// Le dernier clavier pose sur chaque message, pour ne jamais renvoyer a
// Telegram ce qu'il affiche deja. Un drop fait depuis le bouton Telegram, puis
// signale par la base, ne fait ainsi qu'une edition, pas deux -- et chaque
// edition evitee est une place de plus pour les envois.
const boutonsAffiches = new Map(); // "chat:message" -> clavier en JSON
const BOUTONS_MEMOIRE = 5000;

function retiensBoutons(chatId, messageId, clavier) {
  const cle = `${chatId}:${messageId}`;
  boutonsAffiches.delete(cle); // le plus recent passe en fin de liste
  boutonsAffiches.set(cle, JSON.stringify(clavier || { inline_keyboard: [] }));
  if (boutonsAffiches.size > BOUTONS_MEMOIRE) boutonsAffiches.delete(boutonsAffiches.keys().next().value);
}

function dejaAffiches(chatId, messageId, clavier) {
  return boutonsAffiches.get(`${chatId}:${messageId}`) === JSON.stringify(clavier);
}

// Pose un clavier par la file d'ecriture. `clavier` peut etre une fonction :
// il est alors calcule au moment de l'envoi, l'etat du colis ayant pu changer
// pendant l'attente.
function poseBoutons(bot, chatId, messageId, clavier, { priorite = "normale" } = {}) {
  const calcule = () => (typeof clavier === "function" ? clavier() : clavier);
  const avant = calcule();
  if (!avant || dejaAffiches(chatId, messageId, avant)) return Promise.resolve();

  return ecritureGroupe(() => edite(bot, chatId, messageId, calcule()), { priorite });
}

// Pour un bouton presse : l'edition part tout de suite, hors file -- c'est
// la reponse au doigt, elle ne doit pas attendre derriere des envois.
function poseBoutonsMaintenant(bot, chatId, messageId, clavier) {
  return edite(bot, chatId, messageId, clavier).catch(() => {});
}

// Le clavier est note comme affiche AU DEPART de l'edition, pas a son retour :
// deux editions identiques lancees ensemble (le bouton presse, et le signal de
// drop qui suit) n'en font qu'une. Si Telegram refuse, on l'oublie -- un 429
// reessaye par la file doit repartir pour de bon.
async function edite(bot, chatId, messageId, clavier) {
  if (!clavier || dejaAffiches(chatId, messageId, clavier)) return;
  const cle = `${chatId}:${messageId}`;
  const precedent = boutonsAffiches.get(cle);
  retiensBoutons(chatId, messageId, clavier);
  try {
    await bot.editMessageReplyMarkup(clavier, { chat_id: chatId, message_id: messageId });
  } catch (err) {
    // deja ce clavier-la : Telegram le dit, ce n'est pas un echec
    if (/not modified/i.test(err.message)) return;
    if (precedent === undefined) boutonsAffiches.delete(cle);
    else boutonsAffiches.set(cle, precedent);
    throw err;
  }
}

// Repose les boutons d'un colis en relisant son etat : appele apres /note, un
// drop, une correction depuis le site.
function refreshFileButtons(bot, colis, { priorite = "normale" } = {}) {
  if (!colis || !colis.chat_id || !colis.message_id) return;
  const id = colis.id;
  poseBoutons(
    bot,
    colis.chat_id,
    colis.message_id,
    () => {
      const frais = getColisById(id);
      return frais && aDesBoutons(frais) ? boutonsDe(frais) : null;
    },
    { priorite }
  )
    // le message n'a pas forcement de boutons (colis d'avant cette version)
    .catch(() => {});
}

// Un drop fait sur le site -- ou en fin de tournee, ou depuis le bouton --
// remet "Drope" sous les fichiers concernes. En voie basse : un "tout drope"
// sur cinquante colis ne doit pas retarder un fichier qui arrive au meme
// moment.
// dropes, ou remis en attente (drop annule depuis le site ou l'app) : les
// boutons sous les fichiers suivent l'etat en base
const majBoutonsDe = (ids) => {
  if (!botInstance) return;
  for (const id of ids) {
    const colis = getColisById(id);
    // seuls les fichiers republies par le bot ont des boutons a modifier
    if (!colis || colis.chat_id !== AUTO_GROUP_CHAT_ID || !colis.message_id) continue;
    refreshFileButtons(botInstance, colis, { priorite: "basse" });
  }
};
evenements.on("dropes", majBoutonsDe);
evenements.on("remis", majBoutonsDe);

// --- File des envois en tete-a-tete ------------------------------------------
// Dix PDF laches d'un coup arrivaient en dix aiguillages simultanes : Telegram
// en refusait une partie (429) et ces fichiers-la etaient perdus. Ils passent
// maintenant un par un, dans l'ordre d'arrivee, avec une barre qui dit ou on en
// est -- le total monte au fur et a mesure que les fichiers continuent d'entrer.
const filesPrivees = new Map(); // chatId -> { attente, total, faits, echecs, ... } : une file par chat

function enfileFichier(bot, msg, attachment, batches, arriveeId = null) {
  const chatId = msg.chat.id;
  let file = filesPrivees.get(chatId);
  if (!file) {
    file = {
      attente: [],
      total: 0,
      faits: 0,
      echecs: 0,
      message: null,
      derniereEdition: 0,
      // La barre ne s'affiche qu'en prive. Dans le groupe elle tomberait dans
      // le topic General, et les fichiers qui reapparaissent un par un avec
      // leurs boutons montrent deja ou on en est.
      barre: msg.chat.type === "private",
    };
    filesPrivees.set(chatId, file);
  }

  file.attente.push({ msg, attachment, arriveeId });
  file.total += 1;

  if (!file.actif) {
    file.actif = true;
    videFilePrivee(bot, chatId, file, batches).catch((err) =>
      console.error("[bot] file d'envoi :", err.message)
    );
  }
}

async function videFilePrivee(bot, chatId, file, batches) {
  while (file.attente.length > 0) {
    const issue = await traiteArrivee(bot, file.attente.shift(), batches);
    if (issue === "echec") file.echecs += 1;
    else file.faits += 1;
    await majProgression(bot, chatId, file);
  }

  file.actif = false;
  filesPrivees.delete(chatId);
  await effaceOriginaux(bot, chatId);
  // les PDF dont le code est arrive pendant la file passent a "code lie", une
  // edition chacun, apres les envois
  for (const id of boutonsEnFinDeFile) refreshFileButtons(bot, getColisById(id));
  boutonsEnFinDeFile.clear();
  await termineProgression(bot, chatId, file);
}

// Un fichier rate est reessaye plus tard, de plus en plus espace (10 s, 30 s,
// 1 min... jusqu'a ~1 h 40 en tout), puis signale clairement. Il n'est jamais
// abandonne en silence.
const REPRISES_MS = (process.env.FILE_REPRISES_MS || "10000,30000,60000,120000,300000,600000,1200000,1800000")
  .split(",")
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);

// Traite un fichier inscrit jusqu'au bout. "fait" : compte (et republie) ;
// "plus-tard" : compte, mais la republication dans le groupe sera reessayee
// (ou rien n'a pu etre enregistre encore : reessaye aussi) ; "echec" : abandonne
// apres toutes les reprises, l'utilisateur est prevenu.
async function traiteArrivee(bot, item, batches) {
  const { msg, attachment, arriveeId } = item;
  const arrivee = arriveeId ? getArrivee(arriveeId) : null;
  // deja traite (reprise en double) : rien a refaire
  if (arrivee && arrivee.statut !== "attente") return "fait";

  let resultat;
  try {
    resultat = (await routeToTopic(bot, msg, attachment, batches, arrivee)) || {};
  } catch (err) {
    console.error("[bot] aiguillage :", err.message);
    resultat = { erreur: err };
  }
  if (!resultat.erreur) {
    if (arriveeId) arriveeFaite(arriveeId);
    return "fait";
  }
  if (!arriveeId) return "echec";

  const apres = arriveeRatee(arriveeId, resultat.erreur.message);
  if (apres.essais > REPRISES_MS.length) {
    arriveeRatee(arriveeId, resultat.erreur.message, { definitif: true });
    previensEchec(bot, msg, attachment, apres, resultat.erreur);
    return "echec";
  }
  const delai = REPRISES_MS[apres.essais - 1];
  console.warn(`[bot] ${attachment.fileName || "fichier"} : ${resultat.erreur.message} -- nouvel essai dans ${delai / 1000}s`);
  setTimeout(() => enfileFichier(bot, msg, attachment, batches, arriveeId), delai);
  return "plus-tard";
}

// Le dernier essai a echoue : on le dit, en precisant si le colis est tout de
// meme compte (il l'est des qu'il a ete cree -- il apparait alors sur le site
// et s'imprime normalement, il ne lui manque que sa copie dans le groupe).
function previensEchec(bot, msg, attachment, arrivee, erreur) {
  const nom = attachment.fileName || "un fichier";
  const compte = Boolean(arrivee.colis_id && getColisById(arrivee.colis_id)) || Boolean(arrivee.paire_id);
  const texte = compte
    ? `⚠️ ${nom} : bien enregistre, mais je n'arrive pas a le republier dans le groupe (${erreur.message}). Il est sur le site et s'imprime normalement.`
    : `⚠️ ${nom} n'a pas pu etre enregistre (${erreur.message}). Renvoie-le moi.`;
  console.error(`[bot] abandon apres ${arrivee.essais} essais : ${nom} -- ${erreur.message}`);
  bot.sendMessage(msg.chat.id, texte, threadOpts(msg)).catch(() => {});
}

// Vrai tant qu'une file traite encore des fichiers : le recapitulatif du lot
// (image de stats, notification) attend qu'elle ait fini, au lieu de se
// refaire a chaque pause.
function filesEnCours() {
  for (const file of filesPrivees.values()) if (file.actif) return true;
  return false;
}

// Un fichier seul n'a pas besoin d'une barre : elle n'apparait qu'a partir du
// deuxieme, quand l'attente devient reelle.
async function majProgression(bot, chatId, file) {
  const restants = file.attente.length;
  const total = file.faits + file.echecs + restants;
  if (!file.barre || total < 2) return;

  const texte =
    `📤 Classement des fichiers\n${progressBar(file.faits + file.echecs, total)}\n` +
    `${file.faits + file.echecs}/${total} republies${restants > 0 ? ` · ${restants} en attente` : ""}`;

  if (!file.message) {
    file.message = await bot.sendMessage(chatId, texte).catch(() => null);
    file.derniereEdition = Date.now();
    return;
  }

  // Telegram limite aussi les editions : on n'en fait pas plus d'une par
  // seconde, la derniere etape etant de toute facon affichee a la fin.
  if (Date.now() - file.derniereEdition < PROGRESS_MIN_INTERVAL_MS) return;
  file.derniereEdition = Date.now();
  await bot
    .editMessageText(texte, { chat_id: chatId, message_id: file.message.message_id })
    .catch(() => {});
}

async function termineProgression(bot, chatId, file) {
  if (!file.message) return;
  const total = file.faits + file.echecs;
  const resume =
    file.echecs > 0
      ? `✅ ${file.faits}/${total} classes · ${file.echecs} en echec`
      : `✅ ${total} fichier${total > 1 ? "s" : ""} classe${total > 1 ? "s" : ""}`;

  await bot
    .editMessageText(`${resume}\n${progressBar(total, total)}`, {
      chat_id: chatId,
      message_id: file.message.message_id,
    })
    .catch(() => {});
  // le recapitulatif du lot arrive juste apres : la barre n'a plus de raison
  // de rester dans le fil
  setTimeout(() => bot.deleteMessage(chatId, file.message.message_id).catch(() => {}), 6000);
}

// Legendes d'album : Telegram n'attache la legende qu'a un seul fichier d'un
// envoi groupe. On la garde pour reconnaitre le transporteur des autres
// fichiers du meme album -- sans rien changer a leur legende a eux.
const legendesAlbum = new Map(); // media_group_id -> { legende, a }

function legendeDe(msg) {
  if (!msg.media_group_id) return msg.caption || null;
  const maintenant = Date.now();
  for (const [id, entree] of legendesAlbum) if (maintenant - entree.a > 10 * 60 * 1000) legendesAlbum.delete(id);
  if (msg.caption) legendesAlbum.set(msg.media_group_id, { legende: msg.caption, a: maintenant });
  return msg.caption || legendesAlbum.get(msg.media_group_id)?.legende || null;
}

// Deux entrees, un seul chemin :
//   - envoye au bot en prive : le fichier est classe (normaux, LIT, BJ) puis
//     republie dans le bon topic ;
//   - poste directement dans un topic du groupe : il reste dans CE topic, mais
//     il est republie par le bot -- pour porter les boutons -- et l'original
//     est efface.
// Dans les deux cas le fichier est copie a l'identique : ni le nom, ni la
// legende, ni le contenu ne changent.
// Renvoie { colis } quand c'est fait, { colis, erreur } quand le colis est
// compte mais que sa republication est a reessayer, { erreur } quand rien n'a
// pu etre enregistre. `arrivee` : l'inscription du fichier -- une reprise
// reutilise le colis cree au premier essai au lieu d'en creer un second.
async function routeToTopic(bot, msg, attachment, batches, arrivee = null) {
  const direct = msg.chat.type !== "private";
  const type = direct
    ? resolveForcedType(msg)
    : classifyFile({ fileName: attachment.fileName, caption: msg.caption });

  // le code qui ouvre le locker, pas un colis : voir republieCode. La legende
  // dit lequel des deux c'est ; sans indice, image = code, PDF = colis.
  if (direct && type === "special" && roleSpecial(attachment.kind, msg.caption) === "code") {
    return republieCode(bot, msg, attachment, arrivee);
  }

  const topic = TOPIC_BY_TYPE[type];
  const senderName = extractSenderName(msg);
  const legende = legendeDe(msg);

  // une reprise : le colis existe deja
  if (arrivee?.colis_id) {
    const deja = getColisById(arrivee.colis_id);
    // retire entre-temps (/del, site) ou deja republie : plus rien a faire
    if (!deja || (deja.chat_id === AUTO_GROUP_CHAT_ID && deja.message_id)) return { colis: deja };
    return republieColis(bot, msg, deja, topic, { direct, reprise: true });
  }

  const carrier = detectCarrier(attachment.fileName, legende, getCarrierRules());

  // Le colis est cree AVANT la republication pour que ses boutons partent avec
  // le fichier : une seule ecriture au lieu de deux, soit deux fois moins de
  // travail dans la file, ce qui compte quand dix PDF arrivent ensemble. Son
  // numero de message n'est connu qu'une fois la copie faite.
  const { batch, key } = lotCourant(batches, AUTO_GROUP_CHAT_ID, type);
  if (msg.media_group_id && msg.caption) batch.groupCaptions.set(msg.media_group_id, msg.caption);
  const colis = addColis(senderName, {
    chatId: AUTO_GROUP_CHAT_ID,
    messageId: null,
    batchId: batch.batchId,
    type,
    carrier,
    fileName: attachment.fileName,
    caption: msg.caption || null,
    fileId: attachment.fileId,
    fileKind: attachment.kind,
    // le fichier d'origine en prive : y repondre /lit ou /normal doit marcher
    sourceChatId: direct ? null : msg.chat.id,
    sourceMessageId: direct ? null : msg.message_id,
  });
  // aussitot lie a son inscription : une reprise ne le recreera pas
  if (arrivee) arriveeLiee(arrivee.id, { colisId: colis.id });

  // un PDF de special rejoint son code-barre (ou l'attend) avant d'etre
  // republie : son numero part avec lui, sous le fichier
  if (type === "special") apparieColis(colis.id, senderName);

  // Le colis est compte des maintenant, que la republication reussisse ou non :
  // le fichier est bien arrive. Avant, un echec de la copie (un 502 de
  // Telegram, une coupure) supprimait le colis -- c'etait la perte.
  ajouteAuLot(batches, key, batch, colis, senderName);
  const issue = await republieColis(bot, msg, colis, topic, { direct, reprise: false });

  // transporteur inconnu : point d'interrogation sur le fichier republie, apres
  // une derniere tentative a la fin du lot (la legende de l'album peut arriver
  // apres). Pas pour un special : il part au locker avec son code, son
  // transporteur ne change rien -- et chaque reaction est une ecriture de plus
  // dans le groupe, que Telegram compte.
  if (!issue.erreur && !carrier && type !== "bj" && type !== "special") {
    batch.unresolved.push({
      colisId: colis.id,
      fileName: attachment.fileName,
      caption: msg.caption,
      mediaGroupId: msg.media_group_id,
      chatId: AUTO_GROUP_CHAT_ID,
      messageId: getColisById(colis.id)?.message_id,
    });
  }
  return issue;
}

// Republie le fichier d'un colis dans son topic, avec ses boutons. Si la copie
// echoue : poste directement dans le groupe, le colis reste sur l'original
// (c'est deja le bon topic) ; envoye en prive, il reste compte sur le fichier
// d'origine et la copie sera reessayee (traiteArrivee).
async function republieColis(bot, msg, colis, topic, { direct, reprise }) {
  const clavier = aDesBoutons(colis) ? boutonsDe(getColisById(colis.id)) : null;
  let copie;
  try {
    copie = await ecritureGroupe(() =>
      bot.copyMessage(AUTO_GROUP_CHAT_ID, msg.chat.id, msg.message_id, {
        message_thread_id: topic,
        ...(clavier ? { reply_markup: clavier } : {}),
      }),
      { envoi: true }
    );
  } catch (err) {
    console.error("[bot] republication impossible :", err.message);
    setColisMessage(colis.id, msg.chat.id, msg.message_id);
    if (direct) return { colis };
    return { colis, erreur: err };
  }

  setColisMessage(colis.id, AUTO_GROUP_CHAT_ID, copie.message_id);
  if (clavier) retiensBoutons(AUTO_GROUP_CHAT_ID, copie.message_id, clavier);
  if (direct) planifieEffacement(msg, copie.message_id, { colisId: colis.id });
  if (!direct) queueReaction(bot, msg.chat.id, msg.message_id, REACTION_RECEIVED);
  if (reprise) console.log(`[bot] colis #${colis.id} republie au nouvel essai`);
  return { colis };
}

// Les fichiers postes a la main sont effaces une fois leur copie en place --
// par paquets de 10, en un seul appel (deleteMessages), plutot qu'un appel par
// fichier : trente fichiers faisaient trente suppressions, autant d'appels qui
// ralentissaient la file. Le reste du paquet part quand la file se vide.
const originauxAEffacer = new Map(); // chatId -> [{ msg, copieId, colisId, paireId }]
// PDF a remettre a jour ("code lie") quand la file aura fini ses envois
const boutonsEnFinDeFile = new Set();
const PAQUET_EFFACEMENT = 10;

function planifieEffacement(msg, copieId, lien) {
  const liste = originauxAEffacer.get(msg.chat.id) || [];
  liste.push({ msg, copieId, ...lien });
  originauxAEffacer.set(msg.chat.id, liste);
  if (liste.length >= PAQUET_EFFACEMENT) effaceOriginaux(botInstance, msg.chat.id);
}

// Sans le droit "Supprimer les messages", Telegram refuse : on retire alors
// nos copies pour ne pas doubler les fichiers, les colis restent sur les
// originaux, et on le dit une fois.
async function effaceOriginaux(bot, chatId) {
  const paquet = originauxAEffacer.get(chatId) || [];
  originauxAEffacer.delete(chatId);
  if (!bot || paquet.length === 0) return;

  try {
    await ecritureGroupe(() => bot.deleteMessages(chatId, paquet.map((o) => o.msg.message_id)));
  } catch (err) {
    console.error("[bot] originaux non effaces :", err.message);
    await ecritureGroupe(() => bot.deleteMessages(AUTO_GROUP_CHAT_ID, paquet.map((o) => o.copieId))).catch(() => {});
    for (const o of paquet) {
      if (o.colisId) setColisMessage(o.colisId, chatId, o.msg.message_id);
      if (o.paireId) setCodeMessage(o.paireId, chatId, o.msg.message_id);
    }
    if (!deleteRightWarned.has(chatId)) {
      deleteRightWarned.add(chatId);
      replyEphemeral(
        bot,
        paquet[0].msg,
        `Je n'arrive pas a effacer les fichiers postes ici pour les republier avec leurs boutons : ${err.message}\n` +
          `Ajoute-moi comme administrateur avec le droit "Supprimer les messages".`,
        {},
        20000
      );
    }
  }
}

// --- Codes-barres du topic special ---------------------------------------------
// Une image postee dans special est le code-barre qui ouvre le locker d'un
// colis. Ce n'est pas un colis -- comme apres un /clear : pas de prix, pas de
// drop, pas d'impression -- mais elle est numerotee avec son PDF (voir
// specials.js), et le numero s'affiche sous les deux.
async function republieCode(bot, msg, attachment, arrivee = null) {
  // une reprise : la paire existe deja (creee au premier essai)
  let paire = arrivee?.paire_id ? getPaire(arrivee.paire_id) : null;
  let completee = false;
  if (arrivee?.paire_id && !paire) return {}; // retiree entre-temps
  if (paire && paire.code_chat_id === AUTO_GROUP_CHAT_ID && paire.code_message_id) return { paire };
  if (!paire) {
    ({ paire, completee } = apparieCode(attachment.fileId, extractSenderName(msg), attachment.kind));
    if (arrivee) arriveeLiee(arrivee.id, { paireId: paire.id });
  }

  let copie;
  try {
    copie = await ecritureGroupe(() =>
      bot.copyMessage(AUTO_GROUP_CHAT_ID, msg.chat.id, msg.message_id, {
        message_thread_id: msg.message_thread_id,
        reply_markup: boutonsCode(paire),
      }),
      { envoi: true }
    );
  } catch (err) {
    // La paire est gardee : le code est bien arrive, et le mode locker
    // l'affiche par son fichier. Avant, un echec de la copie l'oubliait -- le
    // code du locker etait perdu. La copie sera reessayee.
    console.error("[bot] code non republie :", err.message);
    setCodeMessage(paire.id, msg.chat.id, msg.message_id);
    return { paire, erreur: err };
  }

  setCodeMessage(paire.id, AUTO_GROUP_CHAT_ID, copie.message_id);
  retiensBoutons(AUTO_GROUP_CHAT_ID, copie.message_id, boutonsCode(paire));
  planifieEffacement(msg, copie.message_id, { paireId: paire.id });
  if (completee && paire.colis_id) boutonsEnFinDeFile.add(paire.colis_id);
  return { paire };
}

// Le bouton d'un code ne porte que son numero. Y afficher "lie / en attente"
// obligeait a le reediter a chaque PDF arrive : quinze paires, quinze
// editions de plus dans la file. L'etat se lit sous le PDF, sur le site et
// dans le mode locker ; taper sur le code dit a quel colis il va.
function boutonsCode(paire) {
  const texte = paire.seul ? `🔑 Code #${paire.numero} · seul` : `🔑 Code #${paire.numero}`;
  return { inline_keyboard: [[{ text: texte, callback_data: `sp:${paire.id}` }]] };
}

function majBoutonsCode(bot, paire) {
  const actuelle = getPaire(paire.id);
  if (!actuelle || !actuelle.code_message_id) return;
  poseBoutons(bot, actuelle.code_chat_id, actuelle.code_message_id, () => {
    const p = getPaire(paire.id);
    return p ? boutonsCode(p) : null;
  }).catch(() => {});
}

// Taper sur le bouton d'un code : a quel colis il va.
function handleCodeButton(bot, query) {
  const paire = getPaire(Number((query.data || "").split(":")[1]));
  const colis = paire?.colis_id ? getColisById(paire.colis_id) : null;
  const texte = !paire
    ? "Code inconnu."
    : colis
      ? `Code #${paire.numero} : ${colis.file_name || `colis #${colis.id}`} (${colis.sender_name})`
      : paire.seul
        ? `Code #${paire.numero} : seul, il ne va avec aucun PDF.`
        : `Code #${paire.numero} : en attente de son PDF.`;
  return bot.answerCallbackQuery(query.id, { text: texte, show_alert: true }).catch(() => {});
}

function lotCourant(batches, chatId, type) {
  const key = batchKey(chatId, TOPIC_BY_TYPE[type]);
  let batch = batches.get(key);
  if (!batch) {
    batch = {
      chatId,
      threadId: TOPIC_BY_TYPE[type],
      batchId: createBatch(chatId),
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
  return { batch, key };
}

// Compte le colis dans le lot et relance le compte a rebours du recapitulatif.
// Appele seulement une fois le fichier reellement republie : un fichier refuse
// par Telegram ne doit pas apparaitre dans le total annonce.
function ajouteAuLot(batches, key, batch, colis, senderName) {
  // une image de "special" ne vaut rien : elle ne gonfle pas le total du lot
  if (colis.price > 0) {
    batch.count += 1;
    batch.total += colis.price;
    batch.bySender.set(senderName, (batch.bySender.get(senderName) || 0) + 1);
  }

  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => flushBatch(botInstance, key, batches), DEBOUNCE_MS);
}


// --- Boutons sous les etiquettes ---------------------------------------------
// Trois gestes, les memes que les commandes, mais a portee de pouce :
//   Imprime : sort l'etiquette de la file de /imprime, sans rien effacer
//   Clean   : retire le colis du suivi, garde le fichier    (= /clear)
//   Del     : retire le colis ET efface le message          (= /del)
async function handleFileButton(bot, query) {
  const [, action, rawId] = (query.data || "").split(":");
  const id = Number(rawId);
  const repondre = (texte, alerte = false) =>
    bot.answerCallbackQuery(query.id, { text: texte, show_alert: alerte }).catch(() => {});

  const colis = getColisById(id);
  if (!colis) return repondre("Ce colis n'est plus suivi.", true);

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const poseBoutons = (etat) => poseBoutonsMaintenant(bot, chatId, messageId, boutonsDe(etat));

  // le bouton de la note n'agit pas : il affiche le texte en entier, que le
  // bouton tronque a 40 caracteres
  if (action === "m") return repondre(colis.note || "Plus de note sur ce colis.", true);

  // "Deja imprime" des messages d'avant le bouton Drop : on les met a jour au
  // premier appui plutot que de laisser un bouton mort
  if (action === "n") {
    await poseBoutons(colis);
    return repondre(colis.status === "dropped" ? "Deja drope." : "Imprimee. Appuie sur Drop une fois postee.");
  }

  // re-appui sur "Drope" : le drop est annule, le colis repart en attente (et
  // sa pochette revient au stock). Un colis deja paye reste drope.
  if (action === "k") {
    const annule = undropColis(id);
    if (annule?.paye) return repondre("Ce colis est deja paye : il reste drope.", true);
    if (annule) {
      restoreStock(annule);
      refreshGroupStats();
    }
    const apres = getColisById(id);
    await poseBoutons(apres);
    if (!annule) return repondre("Ce colis n'est plus drope.");
    return repondre(
      apres.printed_at
        ? `Drop annule : colis #${id} remis en attente.`
        : `Drop annule : colis #${id} remis en attente, de retour dans la file d'impression.`
    );
  }

  if (action === "s") {
    const paire = paireDuColis(id);
    if (!paire) return repondre("Plus de numero : ce colis n'est plus en attente dans special.", true);
    return repondre(
      paire.code_file_id
        ? `Special #${paire.numero} : son code-barre est le code #${paire.numero}.`
        : `Special #${paire.numero} : son code-barre n'est pas encore arrive.`,
      true
    );
  }

  if (action === "p") {
    markPrinted([id], query.from?.username ? `@${query.from.username}` : query.from?.first_name);
    await poseBoutons(getColisById(id));
    return repondre("Marquee imprimee. Appuie sur Drop une fois postee.");
  }

  // Drop d'un seul colis : une liasse imprimee part rarement d'un bloc. Le
  // stock se decremente comme pour un drop depuis le site.
  if (action === "x") {
    const drope = dropColis(id);
    if (drope) {
      consumeStock(drope);
      refreshGroupStats();
    }
    await poseBoutons(getColisById(id));
    // deja drope ailleurs (site, "tout dropper") : le bouton se remet juste
    // a jour, sans rien compter deux fois
    return repondre(drope ? `Colis #${id} drope (${colis.price.toFixed(2)} EUR).` : "Ce colis etait deja drope.");
  }

  if (action === "c" || action === "d") {
    deleteColis(id);
    refreshGroupStats();
    if (action === "d") {
      await bot.deleteMessage(chatId, messageId).catch((err) =>
        console.error("[bot] suppression du fichier impossible :", err.message)
      );
      return repondre("Colis retire et fichier efface.");
    }
    await poseBoutonsMaintenant(bot, chatId, messageId, { inline_keyboard: [] });
    return repondre("Colis retire du suivi. Le fichier reste ici.");
  }

  return repondre("Action inconnue.");
}

// Une etiquette sortie par /imprime ne doit plus proposer le bouton : on
// remplace les boutons par la mention "deja imprime" sous le fichier concerne.
// Une liasse de 30 etiquettes, c'est 30 editions dans le groupe : elles passent
// par la file cadencee, sinon Telegram en refuse la moitie (429) et les
// boutons Drop n'apparaissent que sous une partie des fichiers.
function markButtonsPrinted(bot, ids) {
  for (const id of ids) refreshFileButtons(bot, getColisById(id));
}

// --- Deplacer un colis d'un topic a un autre ---------------------------------
// /lit, /unlit, /special : changer le type ne suffit pas, le fichier doit
// suivre. Sinon il reste la ou il etait et il faut encore trier a la main --
// exactement ce qu'on cherche a eviter.

// Deplace un seul colis. Renvoie vrai si le FICHIER a bouge ; le type, lui,
// est toujours applique, meme quand le deplacement echoue.
async function moveColis(bot, colis, type, { apparier = true } = {}) {
  // Dans special, un fichier est soit un colis, soit le code qui ouvre le
  // locker (voir specials.js). Un code n'est pas un colis : une fois deplace,
  // il sort des comptes, comme apres un /clear -- que la copie ait reussi ou non.
  const code = type === "special" && apparier && roleSpecial(colis.file_kind, colis.caption) === "code";
  const deplace = await deplaceFichier(bot, colis, type, { code, apparier });
  if (code) deleteColis(colis.id);
  return deplace;
}

async function deplaceFichier(bot, colis, type, { code = false, apparier = true } = {}) {
  const maj = setColisType(colis.id, type);
  const topic = TOPIC_BY_TYPE[type];
  if (!topic || !colis.chat_id || !colis.message_id) return false;
  // deja au bon endroit : rien a faire
  if (colis.chat_id === AUTO_GROUP_CHAT_ID && colis.type === type) return false;

  // L'etat APRES le changement de type decide des boutons : un code qui entre
  // dans "special" y devient un code numerote, un colis y rejoint (ou attend)
  // son code.
  const apres = getColisById(colis.id) || colis;
  let appairage = null;
  let boutons = aDesBoutons(apres) ? boutonsDe(apres) : null;
  if (code) {
    appairage = apparieCode(colis.file_id, colis.sender_name, colis.file_kind);
    boutons = boutonsCode(appairage.paire);
  } else if (type === "special" && apparier) {
    appairage = apparieColis(colis.id, colis.sender_name);
    boutons = boutonsDe(getColisById(colis.id));
  }

  let copie;
  try {
    // la copie, puis l'effacement de l'ancien : deux ecritures dans le groupe,
    // qui passent par la file comme tout le reste -- /litall sur dix fichiers
    // tombait sinon dans le meme 429 que l'envoi
    copie = await ecritureGroupe(() =>
      bot.copyMessage(AUTO_GROUP_CHAT_ID, colis.chat_id, colis.message_id, {
        message_thread_id: topic,
        ...(boutons ? { reply_markup: boutons } : {}),
      }),
      { envoi: true }
    );
  } catch (err) {
    console.error("[bot] deplacement impossible :", err.message);
    if (code && appairage) oublieCode(appairage.paire.id);
    return false;
  }

  setColisMessage(colis.id, AUTO_GROUP_CHAT_ID, copie.message_id);
  if (boutons) retiensBoutons(AUTO_GROUP_CHAT_ID, copie.message_id, boutons);
  if (code) {
    setCodeMessage(appairage.paire.id, AUTO_GROUP_CHAT_ID, copie.message_id);
    if (appairage.completee) refreshFileButtons(bot, getColisById(appairage.paire.colis_id));
  }

  await ecritureGroupe(() => bot.deleteMessage(colis.chat_id, colis.message_id)).catch((err) =>
    console.error("[bot] ancien message non efface :", err.message)
  );

  return Boolean(maj);
}

async function handleMoveType(bot, msg, type) {
  const reply = msg.reply_to_message;
  if (!reply) {
    return replyEphemeral(bot, msg, `Reponds au fichier a deplacer avec /${type}.`, {}, 8000);
  }

  const colis = findColisByMessage(msg.chat.id, reply.message_id);
  if (!colis) {
    // un code deja dans special : /special tout court veut dire "il est seul"
    if (type === "special" && paireDuCode(msg.chat.id, reply.message_id)) return handleSeul(bot, msg);
    return replyEphemeral(bot, msg, "Ce message n'est pas un colis suivi.", {}, 8000);
  }

  if (!TOPIC_BY_TYPE[type]) {
    return replyEphemeral(
      bot,
      msg,
      `Aucun topic "${TYPE_LABELS[type] || type}" configure${type === "special" ? " : renseigne SPECIAL_TOPIC_ID." : "."}`,
      {},
      12000
    );
  }

  const deplace = await moveColis(bot, colis, type);
  refreshGroupStats();

  const apres = getColisById(colis.id);
  if (!apres) {
    return replyEphemeral(
      bot,
      msg,
      `Passe en ${TYPE_LABELS[type]} comme code du locker${deplace ? ", fichier deplace" : ""} : ` +
        `numerote avec son colis, hors suivi comme apres un /clear.`
    );
  }
  replyEphemeral(
    bot,
    msg,
    `Colis #${colis.id} passe en ${TYPE_LABELS[type]} — ${apres.price.toFixed(2)} EUR` +
      (deplace ? ", fichier deplace." : ".")
  );
}

// Ce que designe une reponse dans special : un colis, un code, ou un fichier
// que le bot ne suivait pas (poste avant, retire par /clear...). Un colis d'un
// autre topic rejoint special d'abord -- sans appairage automatique : c'est la
// commande qui dit ou il va. Renvoie null si le message n'est pas un fichier.
async function elementVise(bot, msg, reply) {
  const colis = findColisByMessage(msg.chat.id, reply.message_id);
  const paireCode = colis ? null : paireDuCode(msg.chat.id, reply.message_id);

  if (colis) {
    if (colis.type !== "special") await moveColis(bot, colis, "special", { apparier: false });
    const frais = getColisById(colis.id);
    return {
      role: "colis",
      paireId: paireDuColis(colis.id)?.id || null,
      colisId: frais.id,
      fileId: frais.file_id,
      fileKind: frais.file_kind,
      fileName: frais.file_name,
      caption: frais.caption,
      chatId: frais.chat_id,
      messageId: frais.message_id,
      sender: frais.sender_name,
    };
  }
  if (paireCode) {
    return {
      role: "code",
      paireId: paireCode.id,
      fileId: paireCode.code_file_id,
      fileKind: paireCode.code_file_kind || "image",
      fileName: reply.document?.file_name || null,
      caption: reply.caption || null,
      chatId: paireCode.code_chat_id,
      messageId: paireCode.code_message_id,
      sender: paireCode.sender_name,
    };
  }
  const piece = colisAttachment(reply);
  if (!piece) return null;
  return {
    role: null,
    fileId: piece.fileId,
    fileKind: piece.kind,
    fileName: piece.fileName,
    caption: reply.caption || null,
    chatId: reply.chat?.id || msg.chat.id,
    messageId: reply.message_id,
    sender: extractSenderName(reply),
  };
}

// /special seul (ou /special tout court sur un code deja dans special) : ce
// fichier ouvre un locker mais ne va avec aucun PDF. Il prend un numero a lui,
// et les paires de son client, qu'il avait decalees, se remettent en ordre.
async function handleSeul(bot, msg) {
  const reply = msg.reply_to_message;
  if (!reply) return replyEphemeral(bot, msg, "Reponds au fichier avec /special seul.", {}, 8000);
  const element = await elementVise(bot, msg, reply);
  if (!element) return replyEphemeral(bot, msg, "Reponds a un fichier : une image ou un PDF.", {}, 8000);

  const r = rendSeul(element);
  if (r.deja) return replyEphemeral(bot, msg, `C'est deja un code seul (#${r.paire.numero}).`, {}, 8000);

  majBoutonsCode(bot, r.paire);
  for (const id of r.touchees) {
    const p = getPaire(id);
    if (!p) continue;
    if (p.code_message_id) majBoutonsCode(bot, p);
    if (p.colis_id) refreshFileButtons(bot, getColisById(p.colis_id));
  }
  // un colis devenu code sort des comptes
  if (element.role === "colis") refreshGroupStats();

  const remis = r.touchees.length;
  replyEphemeral(
    bot,
    msg,
    `Code #${r.paire.numero} : seul, sans PDF.` +
      (remis ? ` ${remis} paire${remis > 1 ? "s" : ""} remise${remis > 1 ? "s" : ""} dans l'ordre.` : ""),
    {},
    12000
  );
}

// --- Relier a la main dans special ------------------------------------------------
// L'appairage automatique suit l'ordre d'arrivee et la legende ; quand il se
// trompe -- un client qui envoie deux codes pour un colis, une legende muette --
// on dit soi-meme ou va un fichier. Le fichier peut etre un colis, un code, ou
// un fichier que le bot ne suivait pas.
async function handleLienSpecial(bot, msg, role, numero) {
  const reply = msg.reply_to_message;
  const commande = `/special ${role === "code" ? "image" : "pdf"} ${numero}`;
  if (!reply) return replyEphemeral(bot, msg, `Reponds au fichier avec ${commande}.`, {}, 8000);

  const element = await elementVise(bot, msg, reply);
  if (!element) return replyEphemeral(bot, msg, "Reponds a un fichier : une image ou un PDF.", {}, 8000);

  let resultat;
  try {
    resultat = relie(numero, role, element);
  } catch (err) {
    return replyEphemeral(bot, msg, err.message, {}, 10000);
  }
  const nom = (r) => (r === "code" ? "code" : "colis");
  if (resultat.deja) return replyEphemeral(bot, msg, `C'est deja le ${nom(role)} du #${numero}.`, {}, 8000);

  // tout ce qui a bouge reprend ses boutons : les deux elements de la paire
  // visee, l'ancienne paire du fichier, et celle de l'element deloge
  const touchees = new Set([resultat.cible.id]);
  if (element.paireId) touchees.add(element.paireId);
  if (resultat.deloge) {
    const p = paireParNumero(resultat.deloge.numero);
    if (p) touchees.add(p.id);
  }
  for (const id of touchees) {
    const p = getPaire(id);
    if (!p) continue; // paire videe, supprimee
    if (p.code_message_id) majBoutonsCode(bot, p);
    if (p.colis_id) refreshFileButtons(bot, getColisById(p.colis_id));
  }
  refreshGroupStats();

  let texte = `${role === "code" ? "Code" : "Colis"} relie au #${numero}.`;
  if (resultat.deloge) {
    texte +=
      resultat.deloge.numero === numero
        ? ` L'autre fichier du #${numero} devient son ${nom(resultat.deloge.role)}.`
        : ` L'ancien ${nom(resultat.deloge.role)} du #${numero} passe au #${resultat.deloge.numero}.`;
  }
  if (!resultat.cible.code_file_id) texte += " Code encore en attente.";
  if (!resultat.cible.colis_id) texte += " Colis encore en attente.";
  replyEphemeral(bot, msg, texte, {}, 12000);
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

  if (rawName && rawName.trim()) {
    // "lit" n'est pas un transporteur mais une file d'impression a part
    if (/^lits?$/i.test(rawName.trim())) return sendMergedLabels(bot, msg, "LIT");
    // les speciaux non plus : /imprime special sort leur liasse a part
    if (/^sp[eé]ciaux?$|^sp[eé]cial$/i.test(rawName.trim())) return sendMergedLabels(bot, msg, "SPECIAL");
    const carrier = parseCarrier(rawName);
    if (!carrier) {
      return replyEphemeral(bot, msg, `Transporteur inconnu : "${rawName.trim()}".\nAu choix : ${CARRIER_LIST_HINT}`);
    }
    return sendMergedLabels(bot, msg, carrier.code);
  }

  sendPrintMenu(bot, msg.chat.id);
}

// Pastilles reprenant les couleurs du dashboard, pour repérer une compagnie
// d'un coup d'oeil dans le menu.
// Les noms Telegram peuvent contenir < ou & : le mode HTML exige de les fuir.
function escapeHtml(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CARRIER_DOTS = {
  MR: "🩷",
  LP: "🟡",
  CHRONO: "🟢",
  UPS: "🟤",
  DPD: "🔴",
  GLS: "🔵",
  DHL: "🟠",
  FEDEX: "🟣",
  BJ: "🟨",
  LIT: "🧻",
  SPECIAL: "⭐",
  Inconnu: "⚠️",
};

function carrierDot(code) {
  return CARRIER_DOTS[code] || "⬜";
}

// Menu des etiquettes a imprimer. Par defaut il ne montre que celles qui ne
// sont jamais sorties de l'imprimante : imprimer 10 MR, en recevoir 2 puis
// faire "Tout" ne doit ressortir que les 2. Le bouton de reglage donne acces
// aux deja imprimees.
function sendPrintMenu(bot, chatId) {
  const summary = getPrintableSummary().filter((row) => row.count > 0);
  const alreadyPrinted = countAlreadyPrinted() + countLitPrintable({ scope: "printed" });

  if (summary.length === 0 && countLitPrintable() === 0) {
    const text =
      alreadyPrinted > 0
        ? `🖨 <b>Rien de nouveau a imprimer</b>\n\n${alreadyPrinted} etiquette(s) en attente sont deja sorties de l'imprimante.`
        : "🖨 <b>Aucune etiquette a imprimer</b>\n\nTout est a jour.";
    const opts = { parse_mode: "HTML" };
    if (alreadyPrinted > 0) {
      opts.reply_markup = {
        inline_keyboard: [[{ text: `↻ Reimprimer (${alreadyPrinted})`, callback_data: "prmenu:all" }]],
      };
    }
    return bot.sendMessage(chatId, text, opts).catch((err) => console.error("[bot] menu impression", err.message));
  }

  const lit = countLitPrintable();
  const total = summary.reduce((sum, row) => sum + row.count, 0) + lit;
  const lines = summary.map(
    (row) => `${carrierDot(row.carrier)} <b>${carrierLabel(row.carrier)}</b> — ${row.count}`
  );
  if (lit > 0) lines.push(`🧻 <b>LIT</b> — ${lit} <i>(rouleau)</i>`);
  const text = `<b>${total} etiquette${total > 1 ? "s" : ""}</b>\n\n${lines.join("\n")}`;

  const keyboard = [];
  for (let i = 0; i < summary.length; i += 2) {
    keyboard.push(
      summary.slice(i, i + 2).map((row) => ({
        text: `${carrierDot(row.carrier)} ${carrierLabel(row.carrier)} · ${row.count}`,
        callback_data: `pr:${row.carrier}`,
      }))
    );
  }
  if (lit > 0) keyboard.push([{ text: `🧻 LIT · ${lit} — rouleau 210 mm`, callback_data: "pr:LIT" }]);
  if (summary.length > 0) {
    const thermiques = total - lit;
    keyboard.push([{ text: `🖨 Tout imprimer · ${thermiques}`, callback_data: "pr:*" }]);
  }
  if (alreadyPrinted > 0) {
    keyboard.push([{ text: `↻ Deja imprimees · ${alreadyPrinted}`, callback_data: "prmenu:all" }]);
  }

  bot
    .sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } })
    .catch((err) => console.error("[bot] clavier impression", err.message));
}

// Menu de reimpression : on y voit qui a imprime quoi et quand, parce qu'on
// est plusieurs a travailler sur les memes colis.
function sendReprintMenu(bot, chatId) {
  const jobs = getPrintJobs();
  const summary = getPrintableSummary({ scope: "printed" }).filter((row) => row.count > 0);
  const litPrinted = countLitPrintable({ scope: "printed" });
  const alreadyPrinted = countAlreadyPrinted() + litPrinted;

  if (alreadyPrinted === 0) {
    return bot
      .sendMessage(chatId, "↻ <b>Rien a reimprimer</b>\n\nAucune etiquette en attente n'est deja sortie.", {
        parse_mode: "HTML",
      })
      .catch(() => {});
  }

  const lines = jobs.map((job) => {
    const carriers = String(job.carriers || "")
      .split(",")
      .map((code) => `${carrierDot(code)} ${carrierLabel(code)}`)
      .join(", ");
    return `${jobIcon(job)} <b>${escapeHtml(job.printed_by)}</b> · ${jobWhen(job.printed_at)}\n     ${job.count} etiquette${
      job.count > 1 ? "s" : ""
    } — ${carriers}`;
  });

  const text =
    `↻ <b>Deja imprimees</b>\n\n${
      lines.length > 0 ? lines.join("\n\n") : `${alreadyPrinted} etiquette(s), impressions d'avant le suivi.`
    }\n\n<i>Choisis une fournee a refaire, ou passe par les compagnies.</i>`;

  const keyboard = jobs.map((job) => [
    {
      text: `${jobIcon(job)} ${job.printed_by} · ${jobWhen(job.printed_at)} · ${job.count}`,
      callback_data: `prjob:${job.job}`,
    },
  ]);

  for (let i = 0; i < summary.length; i += 2) {
    keyboard.push(
      summary.slice(i, i + 2).map((row) => ({
        text: `${carrierDot(row.carrier)} ${carrierLabel(row.carrier)} · ${row.count}`,
        callback_data: `pra:${row.carrier}`,
      }))
    );
  }
  if (litPrinted > 0) {
    keyboard.push([{ text: `🧻 LIT · ${litPrinted} — rouleau`, callback_data: "pra:LIT" }]);
  }
  if (summary.length > 0) {
    keyboard.push([{ text: `↻ Tout reimprimer · ${alreadyPrinted - litPrinted}`, callback_data: "pra:*" }]);
  }
  keyboard.push([{ text: "← Retour", callback_data: "prmenu:new" }]);

  bot
    .sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } })
    .catch((err) => console.error("[bot] clavier reimpression", err.message));
}

// L'agent du Mac imprime sans utilisateur : on le distingue d'un humain.
function jobIcon(job) {
  return /auto/i.test(job.printed_by || "") ? "🤖" : "👤";
}

// "14:32", "hier 18:40", "lun 09:15" — les dates SQLite sont en UTC.
function jobWhen(sqlDate) {
  const date = new Date(`${String(sqlDate).replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "?";
  const heure = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const jours = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (jours === 0) return heure;
  if (jours === 1) return `hier ${heure}`;
  return `${date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })} ${heure}`;
}

function handlePrintCallback(bot, query) {
  const msg = { chat: query.message.chat, from: query.from };
  if (!canPrint(msg)) {
    return bot.answerCallbackQuery(query.id, { text: "Pas ici." }).catch(() => {});
  }

  const data = query.data || "";
  bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});

  if (data === "prmenu:all") {
    bot.answerCallbackQuery(query.id).catch(() => {});
    return sendReprintMenu(bot, query.message.chat.id);
  }
  if (data === "prmenu:new") {
    bot.answerCallbackQuery(query.id).catch(() => {});
    return sendPrintMenu(bot, query.message.chat.id);
  }

  bot.answerCallbackQuery(query.id, { text: "Preparation..." }).catch(() => {});

  if (data.startsWith("prjob:")) {
    return sendMergedLabels(bot, msg, null, { job: data.slice(6) });
  }

  const includePrinted = data.startsWith("pra:");
  const code = data.slice(data.indexOf(":") + 1);
  sendMergedLabels(bot, msg, code, { includePrinted });
}

// Telecharge les etiquettes une par une (Telegram limite les rafales), les
// assemble, puis renvoie le PDF pret a imprimer.
async function sendMergedLabels(bot, msg, code, { includePrinted = false, job = null } = {}) {
  const chatId = msg.chat.id;
  const scope = { scope: includePrinted ? "printed" : "new" };
  const rows = job
    ? getPrintJobColis(job)
    : code === "LIT"
      ? getLitPrintable(scope)
      : code === "*"
        ? getPrintableSummary(scope).flatMap((row) => getPrintableColis(row.carrier, scope))
        : getPrintableColis(code, scope);

  // les LIT sortent sur le rouleau 210 mm, pas sur la thermique 4x6
  const onRoll = code === "LIT" || (job && rows.length > 0 && rows.every((r) => r.type === "lit"));

  if (rows.length === 0) {
    return replyEphemeral(bot, msg, `Aucune etiquette ${code === "*" ? "" : carrierLabel(code)} a imprimer.`, {}, 8000);
  }

  const progress = await startProgress(bot, chatId, rows.length);

  const { labels, missing } = await downloadLabels(bot, rows, () => progress.step());

  await progress.finish(onRoll ? "Mise en page du rouleau..." : "Assemblage du PDF...");
  const assembled = onRoll ? await buildRoll(labels) : await mergeLabels(labels);
  const { pdf, failed } = assembled;
  progress.remove();

  if (!pdf) {
    // dire POURQUOI : "rien a imprimer" tout seul ne laisse aucune prise
    const causes = [...new Set(failed.map((f) => f.reason))].slice(0, 3);
    const detail = failed.length > 0
      ? `\n${failed.length} fichier(s) illisible(s) :\n• ${causes.join("\n• ")}`
      : missing.length > 0
        ? `\n${missing.length} fichier(s) introuvable(s) sur Telegram (message supprime ou trop vieux).`
        : "";
    return bot.sendMessage(chatId, `Aucune etiquette lisible : rien a imprimer.${detail}`).catch(() => {});
  }

  const name = onRoll
    ? "lit-rouleau"
    : job
      ? "reimpression"
      : code === "*"
        ? "toutes"
        : carrierLabel(code).toLowerCase().replace(/\s+/g, "-");
  const printedIds = labels.filter((l) => !failed.some((f) => f.colisId === l.colisId)).map((l) => l.colisId);
  const caption =
    captionFor(rows, printedIds) +
    (onRoll
      ? `\n📏 ${(assembled.lengthMm / 10).toFixed(0)} cm de rouleau · ${assembled.rows} rangee${assembled.rows > 1 ? "s" : ""}` +
        (assembled.trimmed > 0
          ? ` · ${assembled.trimmed} bloc${assembled.trimmed > 1 ? "s" : ""} d'instructions retire${assembled.trimmed > 1 ? "s" : ""}`
          : "") +
        `\n✂️ Decoupe le long des pointilles`
      : "") +
    (missing.length > 0 ? `\n⚠️ ${missing.length} fichier(s) introuvable(s) sur Telegram.` : "") +
    (failed.length > 0 ? `\n⚠️ ${failed.length} fichier(s) illisible(s).` : "");

  try {
    await bot.sendDocument(
      chatId,
      pdf,
      { caption },
      { filename: `etiquettes-${name}.pdf`, contentType: "application/pdf" }
    );
    // le PDF est parti : ces etiquettes ne reviendront plus dans le menu, ni
    // dans la file de l'impression automatique
    markPrinted(printedIds, printerName(msg));
    // sous chaque fichier concerne, le bouton "Imprime" laisse la place a la
    // mention "deja imprime"
    markButtonsPrinted(bot, printedIds);
  } catch (err) {
    bot.sendMessage(chatId, `Envoi impossible : ${err.message}`).catch(() => {});
  }
}

// --- Mode fusion ---------------------------------------------------------------
// /fusion : les fichiers envoyes ensuite dans ce chat (ou ce topic) ne sont pas
// des colis -- rien n'est compte, rien n'est republie -- ils sont mis de cote.
// /stopfusion : le bot les fusionne en un seul PDF, au format etiquette comme
// /imprime, et le renvoie. L'etat est garde en base : un redemarrage du bot en
// pleine fusion ne perd aucun fichier.

const minuteursFusion = new Map(); // cle -> minuteur de mise a jour du message

function cleFusion(msg) {
  return `fusion:${batchKey(msg.chat.id, msg.message_thread_id)}`;
}

function lisFusion(msg) {
  const brut = getSetting(cleFusion(msg), "");
  if (!brut) return null;
  try {
    return JSON.parse(brut);
  } catch {
    return null;
  }
}

function ecrisFusion(msg, etat) {
  setSetting(cleFusion(msg), etat ? JSON.stringify(etat) : "");
}

// les deux seules sources legitimes, comme pour les colis : le prive et le
// groupe configure
function fusionPermise(msg) {
  return msg.chat.type === "private" || msg.chat.id === AUTO_GROUP_CHAT_ID;
}

const fichiers = (n) => `${n} fichier${n > 1 ? "s" : ""}`;

function texteFusion(n) {
  return (
    `🔀 Mode fusion\n` +
    `${n === 0 ? "Envoie tes colis" : `${fichiers(n)} recu${n > 1 ? "s" : ""}`} : ils ne comptent pas.\n` +
    `/stopfusion pour recevoir le PDF fusionne.`
  );
}

async function handleFusion(bot, msg) {
  if (!fusionPermise(msg)) return;
  const deja = lisFusion(msg);
  if (deja) {
    replyEphemeral(bot, msg, `Deja en mode fusion (${fichiers(deja.fichiers.length)}). /stopfusion pour recevoir le PDF.`, {}, 8000);
    return;
  }
  // l'etat d'abord : un fichier envoye juste apres la commande est deja pris
  ecrisFusion(msg, { debut: Date.now(), fichiers: [], messageId: null });
  const envoye = await bot.sendMessage(msg.chat.id, texteFusion(0), threadOpts(msg)).catch(() => null);
  const etat = lisFusion(msg);
  if (etat && envoye) {
    etat.messageId = envoye.message_id;
    ecrisFusion(msg, etat);
    if (etat.fichiers.length > 0) majMessageFusion(bot, msg);
  } else if (envoye) {
    // /stopfusion est arrive entre-temps
    bot.deleteMessage(msg.chat.id, envoye.message_id).catch(() => {});
  }
}

// Vrai si le fichier a ete pris par une fusion en cours.
function ajouteAFusion(bot, msg, attachment) {
  if (!fusionPermise(msg)) return false;
  const etat = lisFusion(msg);
  if (!etat) return false;
  etat.fichiers.push({ fileId: attachment.fileId, kind: attachment.kind, nom: attachment.fileName, messageId: msg.message_id });
  ecrisFusion(msg, etat);
  // ✍ et non 👍 : on voit tout de suite qu'il n'est pas compte
  queueReaction(bot, msg.chat.id, msg.message_id, "✍", "👌");
  majMessageFusion(bot, msg);
  return true;
}

// Le compteur du message de fusion, mis a jour une fois la rafale passee (un
// album arrive en plusieurs messages : une seule edition pour tous).
function majMessageFusion(bot, msg) {
  const cle = cleFusion(msg);
  clearTimeout(minuteursFusion.get(cle));
  minuteursFusion.set(
    cle,
    setTimeout(() => {
      minuteursFusion.delete(cle);
      const etat = lisFusion(msg);
      if (!etat?.messageId) return;
      bot
        .editMessageText(texteFusion(etat.fichiers.length), { chat_id: msg.chat.id, message_id: etat.messageId })
        .catch(() => {});
    }, 800)
  );
}

async function handleStopFusion(bot, msg) {
  if (!fusionPermise(msg)) return;
  const etat = lisFusion(msg);
  if (!etat) {
    replyEphemeral(bot, msg, "Pas de fusion en cours. /fusion pour en commencer une.", {}, 8000);
    return;
  }
  // fin du mode : les fichiers suivants redeviennent des colis
  ecrisFusion(msg, null);
  clearTimeout(minuteursFusion.get(cleFusion(msg)));
  minuteursFusion.delete(cleFusion(msg));
  if (etat.messageId) bot.deleteMessage(msg.chat.id, etat.messageId).catch(() => {});

  // dans l'ordre d'envoi
  const recus = [...etat.fichiers].sort((a, b) => a.messageId - b.messageId);
  if (recus.length === 0) {
    replyEphemeral(bot, msg, "Mode fusion arrete : aucun fichier recu.", {}, 8000);
    return;
  }

  const progression = await startProgress(bot, msg.chat.id, recus.length, {
    titre: "🔀 Fusion des colis",
    unite: "recuperes",
    threadId: msg.message_thread_id || null,
  });
  const lignes = recus.map((f, i) => ({
    id: i + 1,
    file_id: f.fileId,
    file_kind: f.kind,
    file_name: f.nom || `fichier ${i + 1}`,
    type: "fusion",
  }));
  const { labels, missing } = await downloadLabels(bot, lignes, () => progression.step());
  const { pdf, pages, failed } = await mergeLabels(labels);
  progression.remove();

  if (!pdf) {
    bot
      .sendMessage(msg.chat.id, `Fusion impossible : aucun des ${fichiers(recus.length)} n'a pu etre lu.`, threadOpts(msg))
      .catch(() => {});
    return;
  }

  const fusionnes = labels.length - failed.length;
  journalise("fusion", `${fichiers(fusionnes)} fusionné${fusionnes > 1 ? "s" : ""} (/fusion)`, {
    detail: "hors suivi : ne comptent pas",
    nombre: fusionnes,
  });
  const caption =
    `🔀 ${fichiers(fusionnes)} fusionne${fusionnes > 1 ? "s" : ""} · ${pages} page${pages > 1 ? "s" : ""}\n` +
    `Ils ne comptent pas.` +
    (missing.length > 0 ? `\n⚠️ ${fichiers(missing.length)} introuvable${missing.length > 1 ? "s" : ""} sur Telegram.` : "") +
    (failed.length > 0 ? `\n⚠️ ${fichiers(failed.length)} illisible${failed.length > 1 ? "s" : ""}.` : "");
  // l'heure de Paris dans le nom (le serveur est en UTC) : fusion-2026-10-05-16h31.pdf
  const morceaux = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date())
      .map((m) => [m.type, m.value])
  );
  const jour = `${morceaux.year}-${morceaux.month}-${morceaux.day}-${morceaux.hour}h${morceaux.minute}`;
  await bot
    .sendDocument(msg.chat.id, pdf, { caption, ...threadOpts(msg) }, { filename: `fusion-${jour}.pdf`, contentType: "application/pdf" })
    .catch((err) => bot.sendMessage(msg.chat.id, `Envoi impossible : ${err.message}`, threadOpts(msg)).catch(() => {}));
}

// Recupere les fichiers aupres de Telegram. Un fichier introuvable (trop
// vieux, message supprime) n'interrompt pas le lot : il est juste signale.
async function downloadLabels(bot, rows, onStep) {
  const labels = [];
  const missing = [];

  for (const row of rows) {
    try {
      // un 429 ou un 502 de Telegram, une coupure : on reessaie au lieu de
      // sauter l'etiquette (elle manquait alors a la liasse sans bruit)
      const bytes = await avecReessais(async () => {
        const link = await bot.getFileLink(row.file_id);
        const res = await fetch(link);
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.response = { statusCode: res.status };
          throw err;
        }
        return new Uint8Array(await res.arrayBuffer());
      });
      labels.push({
        bytes,
        kind: row.file_kind === "image" ? "image" : "pdf",
        label: row.file_name || `colis #${row.id}`,
        colisId: row.id,
        // un special sort avec son numero de paire imprime en gros : c'est lui
        // qu'on lit sur le colis devant le locker
        numero: row.type === "special" ? paireDuColis(row.id)?.numero || null : null,
      });
    } catch (err) {
      missing.push({ id: row.id, label: row.file_name || `colis #${row.id}`, reason: err.message });
    }
    if (onStep) await onStep();
  }
  return { labels, missing };
}

// Utilise par le dashboard (impression automatique et onglet Imprime) : meme
// chaine que /imprime, sans Telegram autour. `roll` sort la mise en page du
// rouleau 210 mm des LIT au lieu du format thermique 4x6.
async function buildLabelsPdf(rows, { roll = false, onStep } = {}) {
  if (!botInstance) throw new Error("bot non demarre");
  const { labels, missing } = await downloadLabels(botInstance, rows, onStep);
  const assembled = roll ? await buildRoll(labels) : await mergeLabels(labels);
  const { pdf, failed } = assembled;
  const printedIds = labels
    .filter((l) => !failed.some((f) => f.colisId === l.colisId))
    .map((l) => l.colisId);
  return { ...assembled, pdf, printedIds, missing, failed };
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

async function startProgress(
  bot,
  chatId,
  total,
  { titre = "Preparation des etiquettes", unite = "recuperees", threadId = null } = {}
) {
  const text = (done, suffix) =>
    `${titre}\n${progressBar(done, total)}\n${suffix || `${done}/${total} ${unite}`}`;

  const opts = threadId ? { message_thread_id: threadId } : {};
  const message = await bot.sendMessage(chatId, text(0), opts).catch(() => null);
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

// Ce que contient le PDF, en une ligne : "🩷 6 MR · 🟤 3 UPS".
function captionFor(rows, printedIds) {
  const kept = new Set(printedIds);
  const counts = new Map();
  for (const row of rows) {
    if (!kept.has(row.id)) continue;
    const code = row.carrier_group || "Inconnu";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  if (counts.size === 0) return "Aucune etiquette lisible.";

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${carrierDot(code)} ${count} ${code === "Inconnu" ? "?" : code}`)
    .join("  ·  ");
}

// Nom affiche dans le menu de reimpression.
function printerName(msg) {
  const from = msg && msg.from;
  if (!from) return "Inconnu";
  return from.username ? `@${from.username}` : from.first_name || `#${from.id}`;
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

// Changer le type ne suffit plus : le fichier doit suivre, sinon il reste dans
// le topic ou il etait et il faut encore trier a la main.
function handleSingleType(bot, msg, type) {
  return handleMoveType(bot, msg, type);
}

async function handleBatchType(bot, msg, type) {
  const batchId = getLatestBatchId(msg.chat.id);
  if (!batchId) {
    replyEphemeral(bot, msg, "Aucun groupe de colis recent trouve.");
    return;
  }

  const colis = getBatchColis(batchId);
  if (colis.length === 0) {
    replyEphemeral(bot, msg, "Aucun colis en attente dans le dernier groupe.");
    return;
  }

  // Chaque deplacement, c'est une copie et un effacement dans le groupe, a la
  // cadence de la file : dix fichiers prennent une quinzaine de secondes. La
  // barre dit ou on en est au lieu de laisser croire que rien ne se passe.
  const progression =
    colis.length >= 2
      ? await startProgress(bot, msg.chat.id, colis.length, {
          titre: `Passage en ${TYPE_LABELS[type]}`,
          unite: "deplaces",
          threadId: msg.message_thread_id,
        })
      : null;

  let deplaces = 0;
  for (const item of colis) {
    // un fichier a la fois : c'est la file qui fixe la cadence
    // eslint-disable-next-line no-await-in-loop
    if (await moveColis(bot, item, type)) deplaces += 1;
    // eslint-disable-next-line no-await-in-loop
    if (progression) await progression.step();
  }
  if (progression) {
    await progression.finish(`✅ ${colis.length} en ${TYPE_LABELS[type]}`);
    setTimeout(() => progression.remove(), 6000);
  }

  refreshGroupStats();
  replyEphemeral(
    bot,
    msg,
    `${colis.length} colis passes en ${TYPE_LABELS[type]}` +
      (deplaces > 0 ? `, ${deplaces} fichier(s) deplaces dans le bon topic.` : ".")
  );
}

// /note fragile  (en reponse a un colis, sinon applique au dernier lot)
// /note          efface la note
//
// Un colis annote sort en premier a l'impression et s'affiche en rouge sur le
// site : la note n'est pas un pense-bete mort, elle change l'ordre du travail.
// Contrairement a /prix, elle s'applique aussi a un colis deja drope ou deja
// imprime -- "le client rappelle" reste vrai apres coup.
function handleNote(bot, msg, texte) {
  const note = (texte || "").trim();

  const reply = msg.reply_to_message;
  if (reply) {
    const colis = findAnyColisByMessage(msg.chat.id, reply.message_id);
    if (!colis) {
      replyEphemeral(bot, msg, "Colis introuvable : reponds au message du fichier.");
      return;
    }
    const updated = setColisNote(colis.id, note);
    refreshFileButtons(bot, updated);
    replyEphemeral(
      bot,
      msg,
      note
        ? `Note posee sur le colis #${updated.id} (${updated.sender_name}) : ${note}\nIl passera en premier a l'impression.`
        : `Note effacee sur le colis #${updated.id}.`
    );
    return;
  }

  const batchId = getLatestBatchId(msg.chat.id);
  if (!batchId) {
    replyEphemeral(bot, msg, "Aucun colis recent trouve.");
    return;
  }
  const count = setBatchNote(batchId, note);
  if (count === 0) {
    replyEphemeral(bot, msg, "Aucun colis dans le dernier groupe.");
    return;
  }
  for (const colis of getBatchColis(batchId)) refreshFileButtons(bot, colis);
  replyEphemeral(
    bot,
    msg,
    note ? `${count} colis annotes : ${note}` : `Note effacee sur ${count} colis.`
  );
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
    // trop vite : la file d'ecriture attend et reessaie
    if (delaiDemande(err) !== null) throw err;
    console.error("[bot] edition image stats impossible :", err.message);
    return false;
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }
}

// Ce que montre l'image actuellement postee. Une drop de prix, une note, un
// bouton presse depuis le site redemandent l'image : si ni le compte, ni la
// valeur, ni le dernier ajout n'ont bouge, on ne la refait pas -- c'etait un
// rendu et un envoi de PNG pour rien, a chaque geste.
let imageStatsAffichee = null;

async function updateGroupStatsPhoto(bot, addedCount) {
  try {
    const { count, value } = getPendingSummary();
    // rafraichissement depuis le site : on garde le "dernier ajout" du
    // dernier lot recu plutot que d'afficher +0
    const added = addedCount === null ? Number(getSetting("last_added_count", 0)) : addedCount;
    if (addedCount !== null) setSetting("last_added_count", addedCount);

    const prevId = getStatsMessageId("group");
    const cle = `${prevId}|${count}|${Number(value).toFixed(2)}|${added}`;
    if (prevId && cle === imageStatsAffichee) return;

    const image = await renderStatsImage({ pendingCount: count, pendingValue: value, addedCount: added });
    if (prevId && (await ecritureGroupe(() => editStatsPhoto(bot, prevId, image)))) {
      imageStatsAffichee = cle;
      return;
    }

    const sent = await ecritureGroupe(
      () => bot.sendPhoto(AUTO_GROUP_CHAT_ID, image, {}, { filename: "stats.png", contentType: "image/png" }),
      { envoi: true }
    );
    setStatsMessageId("group", sent.message_id);
    imageStatsAffichee = `${sent.message_id}|${count}|${Number(value).toFixed(2)}|${added}`;
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
  // une file qui travaille encore : le lot n'est pas fini, meme si une pause
  // (429) a laisse passer le delai. Sans ca, trente fichiers faisaient treize
  // recapitulatifs et treize images de stats.
  if (filesEnCours()) {
    batch.timer = setTimeout(() => flushBatch(bot, key, batches), DEBOUNCE_MS);
    return;
  }
  batches.delete(key);

  reactUnknownCarriers(bot, resolveBatchCarriers(batch));

  if (batch.chatId === AUTO_GROUP_CHAT_ID) {
    planifieRecap({ ajoutes: batch.count, notifier: true });
    return;
  }
  pushBatchNotification(batch);

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

// Recapitulatif regroupe : image de stats et notification.
// Un envoi qui touche normaux, LIT et BJ forme un lot par topic, et ces lots
// se ferment ensemble : ils ne doivent faire qu'une image et qu'une
// notification ("+4"), pas trois de chaque. Les gestes du site (drop, prix...)
// passent par ici aussi, et se fondent dans le meme recapitulatif.
let recapEnAttente = { ajoutes: 0, notifier: false };
let minuteurRecap = null;
let chaineStats = Promise.resolve();

function planifieRecap({ ajoutes = 0, notifier = false } = {}) {
  if (!botInstance) return;
  recapEnAttente.ajoutes += ajoutes;
  if (notifier) recapEnAttente.notifier = true;
  clearTimeout(minuteurRecap);
  minuteurRecap = setTimeout(() => {
    const { ajoutes: n, notifier: notif } = recapEnAttente;
    recapEnAttente = { ajoutes: 0, notifier: false };
    minuteurRecap = null;
    if (notif && n > 0) notifyNewColis({ count: n });
    // une mise a jour de l'image a la fois : deux en meme temps lisaient toutes
    // deux "pas encore d'image" et en postaient chacune une
    chaineStats = chaineStats
      .then(() => updateGroupStatsPhoto(botInstance, n > 0 ? n : null))
      .catch((err) => console.error("[bot] recapitulatif :", err.message));
  }, 800);
}

// Appele par le dashboard apres chaque modification de colis : l'image postee
// dans le groupe suit ce qu'on fait sur le site.
function refreshGroupStats() {
  planifieRecap();
}

module.exports = {
  startBot,
  refreshGroupStats,
  buildLabelsPdf,
  markButtonsPrinted,
  corrigeTransporteur,
  // le site modifie un colis (note, drop) : ses boutons suivent
  // le site a termine un code seul : la paire s'en va, son bouton aussi
  finiCodeSeul: (paireId) => {
    const paire = finiSeul(paireId);
    if (paire && botInstance && paire.code_message_id) {
      poseBoutons(botInstance, paire.code_chat_id, paire.code_message_id, { inline_keyboard: [] }).catch(() => {});
    }
    return paire;
  },
  refreshColisButtons: (id) => {
    if (botInstance) refreshFileButtons(botInstance, getColisById(id));
  },
  getBot: () => botInstance,
};
