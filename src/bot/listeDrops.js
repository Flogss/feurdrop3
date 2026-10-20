// La liste du jour et le PDF qui la suit.
//
// Le fournisseur envoie deux messages, transferes tels quels au bot :
//
//   📋 Mes drops du jour — PARIS94 (4 colis)
//     📄 8R50345899012 (1000g)
//     📄 8R49597374149
//     🆕 8R49597373395        <- bordereau pas encore pret : pas dans le PDF
//     📄 8571271394
//
// puis un PDF d'une page par etiquette « 📄 », dans l'ordre de la liste
// (l'annonce « 📄 Nouveau PDF ! » qui l'accompagne redonne les poids). Les
// pages sont des images : aucun numero ne s'y lit, c'est l'ordre de la liste
// qui dit quelle page porte quel numero.
//
// Un numero = une etiquette : jamais deux fois le meme numero.
const { getSetting, setSetting } = require("../db");

// la liste vaut le temps de deposer : le fournisseur donne 48 h
const VALIDITE_MS = 48 * 3600 * 1000;

// un numero de suivi : majuscules et chiffres, au moins un chiffre
const NUMERO = /^(?=[A-Z0-9]*\d)[A-Z0-9]{8,30}$/;

function grammesDe(valeur, unite) {
  const n = Number(String(valeur).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(/^kg$/i.test(unite) ? n * 1000 : n);
}

// « 1kg », « 1,5kg », « 750g » : la note posee sur l'etiquette
function notePoids(grammes) {
  if (!grammes) return null;
  if (grammes < 1000) return `${grammes}g`;
  return `${String(Math.round(grammes / 10) / 100).replace(".", ",")}kg`;
}

/** « 📋 Mes drops du jour » : { nom, entrees: [{ numero, pret, grammes }] } ou null */
function lisListeDrops(texte) {
  if (!texte || !/Mes drops du jour/i.test(texte)) return null;
  const nom = texte.match(/Mes drops du jour\s*[—–-]\s*([^\s(]+)/i)?.[1] || null;
  const entrees = [];
  const vus = new Set();
  for (const ligne of String(texte).split(/\r?\n/)) {
    const m = ligne.match(/(📄|🆕)\s*([A-Z0-9]+)\s*(?:\(\s*(\d+(?:[.,]\d+)?)\s*(kg|g)\s*\))?/iu);
    if (!m) continue;
    const numero = m[2].toUpperCase();
    if (!NUMERO.test(numero) || vus.has(numero)) continue;
    vus.add(numero);
    entrees.push({ numero, pret: m[1] === "📄", grammes: m[3] ? grammesDe(m[3], m[4]) : null });
  }
  return entrees.length ? { nom, entrees } : null;
}

/** « 📄 Nouveau PDF ! » : { nom, poids: { numero: grammes } } ou null */
function lisAnnoncePdf(texte) {
  if (!texte || !/Nouveau PDF/i.test(texte)) return null;
  const nom = texte.match(/📍\s*([^\s-]+)/u)?.[1] || null;
  const poids = {};
  for (const m of String(texte).matchAll(/([A-Z0-9]{8,30})\s*(?:→|->|:)\s*(\d+(?:[.,]\d+)?)\s*(kg|g)\b/giu)) {
    const numero = m[1].toUpperCase();
    const g = grammesDe(m[2], m[3]);
    if (NUMERO.test(numero) && g) poids[numero] = g;
  }
  return { nom, poids };
}

// --- La liste en attente de son PDF, par conversation -------------------------
// Gardee en base : un redemarrage entre la liste et le PDF ne la perd pas.

const cle = (chatId) => `liste_drops:${chatId}`;

function listeEnAttente(chatId) {
  try {
    const l = JSON.parse(getSetting(cle(chatId), "null"));
    if (!l || Date.now() - l.recue > VALIDITE_MS) return null;
    return l;
  } catch {
    return null;
  }
}

function retiensListe(chatId, liste) {
  // les poids deja annonces restent si la liste est renvoyee
  const avant = listeEnAttente(chatId);
  const poids = { ...(avant?.poids || {}) };
  for (const e of liste.entrees) if (e.grammes) poids[e.numero] = e.grammes;
  const l = { ...liste, poids, recue: Date.now() };
  setSetting(cle(chatId), JSON.stringify(l));
  return l;
}

function ajoutePoids(chatId, poids) {
  const l = listeEnAttente(chatId);
  if (!l) return null;
  l.poids = { ...(l.poids || {}), ...poids };
  setSetting(cle(chatId), JSON.stringify(l));
  return l;
}

function oublieListe(chatId) {
  setSetting(cle(chatId), "null");
}

// Ce PDF est-il celui de la liste ? Son nom (« PARIS94_2026-10-20.pdf ») ou
// son nombre de pages, egal au nombre d'etiquettes « 📄 ».
function pdfDeLaListe(liste, { fileName, pages }) {
  const prets = liste.entrees.filter((e) => e.pret);
  const nomOk = Boolean(liste.nom) && String(fileName || "").toUpperCase().startsWith(`${liste.nom.toUpperCase()}_`);
  return { concerne: nomOk || (pages > 1 && pages === prets.length), complet: pages === prets.length, prets };
}

module.exports = {
  lisListeDrops,
  lisAnnoncePdf,
  notePoids,
  listeEnAttente,
  retiensListe,
  ajoutePoids,
  oublieListe,
  pdfDeLaListe,
};
