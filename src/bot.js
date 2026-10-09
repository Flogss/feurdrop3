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
  markPrinted,
  getColisById,
  evenements,
  dropColis,
  consumeStock,
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
const { delaiDemande } = require("./throttle");
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
const { acteurs } = require("./bot/acces");
const {
  DEBOUNCE_MS,
  AUTO_GROUP_CHAT_ID,
  listeAcces,
  acces,
  TOPIC_BY_TYPE,
  TYPE_LABELS,
} = require("./bot/config");
const { extractSenderName, colisAttachment, resolveForcedType } = require("./bot/fichiers");
const {
  ecritureGroupe,
  batchKey,
  threadOpts,
  replyEphemeral,
  scheduleDelete,
  REACTION_RECEIVED,
  REACTION_UNKNOWN,
  REACTION_UNKNOWN_FALLBACK,
  queueReaction,
  CARRIER_LIST_HINT,
} = require("./bot/outils");
const {
  boutonsDe,
  retiensBoutons,
  aDesBoutons,
  poseBoutons,
  poseBoutonsMaintenant,
  refreshFileButtons,
  markButtonsPrinted,
} = require("./bot/boutons");
const {
  handlePrintCommand,
  handlePrintCallback,
  downloadLabels,
  startProgress,
  progressBar,
  PROGRESS_MIN_INTERVAL_MS,
} = require("./bot/impression");
const { handleFusion, ajouteAFusion, handleStopFusion } = require("./bot/fusion");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8957997002:AAEzvJXgMZ9Qn7E4ERirZHTrTfseF8WDKm4";

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

// --- Controle d'acces ----------------------------------------------------------
// Chaque entree (fichier, commande, bouton) passe par selonAcces. Quand la
// reponse est connue d'avance (liste blanche, groupe de travail), la suite
// s'execute tout de suite, exactement comme avant. Sinon (inconnu en prive),
// l'appartenance au groupe est verifiee aupres de Telegram ; les messages
// suivants du meme chat attendent leur tour, pour garder l'ordre d'arrivee
// (c'est lui qui appaire un code de special avec son PDF).
const accesEnCours = new Map(); // chatId -> promesse de la verification en cours
const refusSignales = new Map(); // userId -> instant du dernier message de refus
const REFUS_INTERVALLE_MS = 10 * 60 * 1000;

function refuseAcces(bot, entree, { niveau = "equipe" } = {}) {
  const { userId, chat } = acteurs(entree);
  if (entree?.data !== undefined && entree?.id) {
    bot
      .answerCallbackQuery(entree.id, { text: niveau === "admin" ? "🔒 Réservé aux administrateurs du bot" : "🔒 Non autorisé", show_alert: true })
      .catch(() => {});
    return;
  }
  const dernier = refusSignales.get(String(userId)) || 0;
  if (Date.now() - dernier < REFUS_INTERVALLE_MS) return;
  refusSignales.set(String(userId), Date.now());
  console.warn(`[bot] acces refuse : utilisateur ${userId ?? "?"} dans le chat ${chat?.id} (${chat?.type || "?"})`);
  // en prive seulement : un groupe tiers ou le bot aurait ete ajoute ne
  // recoit rien
  if (chat?.type !== "private" && niveau !== "admin") return;
  const texte =
    niveau === "admin"
      ? "🔒 Cette commande est réservée aux administrateurs du bot (TELEGRAM_ALLOWED_USERS)."
      : `🔒 Ce bot est réservé à l'équipe.\nTon identifiant Telegram : ${userId ?? "inconnu"} -- envoie-le à l'administrateur pour être ajouté.`;
  bot.sendMessage(chat.id, texte, entree?.message_thread_id ? { message_thread_id: entree.message_thread_id } : {}).catch(() => {});
}

function selonAcces(bot, entree, suite, options = {}) {
  const { chat } = acteurs(entree);
  const cle = chat?.id;
  const executeSuite = () => {
    try {
      return Promise.resolve(suite()).catch((err) => console.error("[bot] traitement :", err?.stack || err));
    } catch (err) {
      console.error("[bot] traitement :", err?.stack || err);
      return undefined;
    }
  };
  const enCours = accesEnCours.get(cle);
  const verdict = enCours ? null : acces.verdictImmediat(entree, options);
  if (verdict === true) return executeSuite();
  if (verdict === false) return refuseAcces(bot, entree, options);

  const verification = (enCours || Promise.resolve())
    .then(() => acces.autorise(bot, entree, options))
    .then((ok) => (ok ? executeSuite() : refuseAcces(bot, entree, options)))
    .catch((err) => console.error("[bot] controle d'acces :", err?.message || err))
    .finally(() => {
      if (accesEnCours.get(cle) === verification) accesEnCours.delete(cle);
    });
  accesEnCours.set(cle, verification);
  return verification;
}

// Instance partagee : le dashboard web (routes/api.js) s'en sert pour
// rafraichir l'image de stats du groupe quand on modifie des colis sur le site.
let botInstance = null;

function startBot() {
  if (!TOKEN) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN manquant, le bot ne demarre pas.");
    return null;
  }

  // TELEGRAM_API_URL : une autre adresse que api.telegram.org -- un faux
  // serveur Telegram pour les tests (voir test/bot.test.js), jamais en prod
  const bot = new TelegramBot(TOKEN, {
    polling: true,
    ...(process.env.TELEGRAM_API_URL ? { baseApiUrl: process.env.TELEGRAM_API_URL } : {}),
  });
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
    // un inconnu en prive n'entre pas : rien n'est compte, republie ni imprime
    selonAcces(bot, msg, () => recoitFichier(msg, attachment));
  };

  const recoitFichier = (msg, attachment) => {
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
  // que les colis et les recapitulatifs. Elle ne s'execute que pour l'equipe
  // (niveau "admin" : la liste blanche seule). Une erreur dans une commande
  // async est consignee au lieu de remonter en rejet non gere.
  const command = (handler, options = {}) => (msg, match) => {
    try {
      selonAcces(bot, msg, () => handler(msg, match), options);
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
  // efface tout ce que le bot a appris : reserve a la liste blanche
  bot.onText(
    /^\/regles_reset(@\w+)?$/i,
    command(
      (msg) => {
        const count = clearCarrierRules();
        replyEphemeral(bot, msg, `${count} regle(s) oubliee(s).`, {}, 8000);
      },
      { niveau: "admin" }
    )
  );

  // Les boutons agissent sur un colis designe par son numero : un appui venu
  // d'ailleurs que le groupe ou l'equipe est refuse comme une commande.
  bot.on("callback_query", (query) =>
    selonAcces(bot, query, () => {
      if (/^c:/.test(query.data || "")) return handleFileButton(bot, query);
      if (/^sp:/.test(query.data || "")) return handleCodeButton(bot, query);
      if (/^pra?:|^prmenu:|^prjob:/.test(query.data || "")) return handlePrintCallback(bot, query);
      return handleCarrierCallback(bot, query);
    })
  );

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

  console.log(
    `[bot] acces : groupe de travail, ${acces.taille()} utilisateur(s) en liste blanche` +
      (listeAcces.source ? ` (${listeAcces.source})` : " (TELEGRAM_ALLOWED_USERS vide : /regles_reset ferme)") +
      (process.env.TELEGRAM_GROUP_MEMBERS !== "0" ? ", membres du groupe en prive" : "")
  );
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
    if (await moveColis(bot, item, type)) deplaces += 1;
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
