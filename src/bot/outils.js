// Petits outils partages par les parties du bot : file d'ecriture vers le
// groupe, reponses ephemeres, echappement HTML.
const { createWriteQueue } = require("../throttle");
const { CARRIERS } = require("../carrier");
const { AUTO_GROUP_CHAT_ID } = require("./config");

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

function batchKey(chatId, threadId) {
  return `${chatId}:${threadId || 0}`;
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

// Pastilles reprenant les couleurs du dashboard, pour repérer une compagnie
// d'un coup d'oeil dans le menu.
// Les noms Telegram peuvent contenir < ou & : le mode HTML exige de les fuir.
function escapeHtml(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Reactions : le pouce accuse reception d'un colis, le point d'interrogation
// signale un transporteur non reconnu (il remplace le pouce sur le meme
// message). Telegram n'accepte qu'une liste fermee d'emojis en reaction, d'ou
// le repli sur 🤔 si ❓ est refuse.
const REACTION_RECEIVED = "👍";
const REACTION_UNKNOWN = "❓";
const REACTION_UNKNOWN_FALLBACK = "🤔";

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

const CARRIER_LIST_HINT = CARRIERS.map((c) => `${c.code} (${c.label})`).join(", ");

module.exports = {
  REACTION_RECEIVED,
  REACTION_UNKNOWN,
  REACTION_UNKNOWN_FALLBACK,
  queueReaction,
  CARRIER_LIST_HINT,
  sleep,
  ecritureGroupe,
  batchKey,
  threadOpts,
  REPLY_TTL_MS,
  replyEphemeral,
  scheduleDelete,
  escapeHtml,
};
