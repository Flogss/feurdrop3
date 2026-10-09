// Configuration du bot : le groupe de travail, ses topics, et qui a le
// droit de se servir du bot (voir acces.js). Le jeton, lui, reste dans bot.js.
const { creeControleAcces, listeDepuisEnvironnement } = require("./acces");

const DEBOUNCE_MS = Number(process.env.BATCH_DEBOUNCE_MS || 3000);

// Groupe Telegram avec topics dedies : les PDF envoyes directement dans ces
// topics sont comptes automatiquement, sans avoir besoin de forward au bot.
const AUTO_GROUP_CHAT_ID = -1004388459228; // derive de l'id de canal 4388459228 (t.me/c/4388459228/...)

// Qui peut se servir du bot : liste blanche, groupe de travail, et en prive
// les membres de ce groupe. Voir bot/acces.js.
const listeAcces = listeDepuisEnvironnement();
const acces = creeControleAcces({
  groupeId: AUTO_GROUP_CHAT_ID,
  utilisateurs: listeAcces.utilisateurs,
  // TELEGRAM_GROUP_MEMBERS=0 : en prive, seule la liste blanche compte
  membresDuGroupe: process.env.TELEGRAM_GROUP_MEMBERS !== "0",
});
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

module.exports = {
  DEBOUNCE_MS,
  AUTO_GROUP_CHAT_ID,
  listeAcces,
  acces,
  AUTO_LIT_TOPIC_IDS,
  AUTO_NORMAL_TOPIC_IDS,
  AUTO_BJ_TOPIC_IDS,
  AUTO_SPECIAL_TOPIC_IDS,
  TOPIC_BY_TYPE,
  TYPE_LABELS,
};
