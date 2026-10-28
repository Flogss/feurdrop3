// La liste du jour et le PDF qui la suit.
//
// Le fournisseur envoie deux messages, transferes tels quels au bot :
//
//   📋 Mes drops du jour — PARIS94 (7 colis)
//     📅 28/10/2026 — 2 colis
//       🆕 XX118806506JB (2560g)   <- nouveau : son bordereau arrive dans le PDF
//       🆕 8R50362619068
//     📅 27/10/2026 — 5 colis
//       📄 8R50357987028           <- deja envoye (souvent deja recu)
//       ...
//
// puis l'annonce « 📄 Nouveau PDF ! » (« Total : 2 bordereaux · Nouveaux : 2 »,
// les poids) et un PDF d'une page par etiquette, dans l'ordre de la liste. Les
// pages sont des images : aucun numero ne s'y lit, c'est l'ordre de la liste
// qui dit quelle page porte quel numero. Les pages sont celles des numeros
// PAS ENCORE RECUS : un numero deja recu n'est jamais recompte (voir
// pagesDuPdf).
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
    entrees.push({ numero, pret: m[1] === "📄", nouveau: m[1] === "🆕", grammes: m[3] ? grammesDe(m[3], m[4]) : null });
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
  // les poids deja annonces restent si la liste est renvoyee (ceux de la
  // liste, au gramme pres, l'emportent)
  const avant = listeEnAttente(chatId);
  const poids = { ...(avant?.poids || {}) };
  for (const e of liste.entrees) if (e.grammes) poids[e.numero] = e.grammes;
  const l = { ...liste, poids, recue: Date.now() };
  setSetting(cle(chatId), JSON.stringify(l));
  return l;
}

// (le poids de la liste, au gramme pres -- « 2560g » --, l'emporte sur
// l'arrondi de l'annonce -- « 2.6kg » -- quand ils disent la meme chose)
function fusionnePoids(avant, nouveaux) {
  const poids = { ...(avant || {}) };
  for (const [numero, g] of Object.entries(nouveaux || {})) {
    const deja = poids[numero];
    if (deja && Math.abs(deja - g) <= Math.max(60, deja * 0.03)) continue;
    poids[numero] = g;
  }
  return poids;
}

function ajoutePoids(chatId, poids) {
  const l = listeEnAttente(chatId);
  if (!l) return null;
  l.poids = fusionnePoids(l.poids, poids);
  setSetting(cle(chatId), JSON.stringify(l));
  return l;
}

function oublieListe(chatId) {
  setSetting(cle(chatId), "null");
}

/**
 * Les numeros dont les pages sont dans ce PDF, dans l'ordre de la liste : le
 * premier groupe dont le nombre egale celui des pages, parmi
 *   1. les numeros pas encore recus (les anciens deja recus sont sautes) ;
 *   2. les nouveaux « 🆕 » pas encore recus ;
 *   3. les « 📄 » pas encore recus (forme d'avant : tout le PDF en « 📄 ») ;
 *   4. toute la liste (le meme PDF renvoye : les recus ne sont pas recomptes).
 * null quand aucun ne colle : decouper au hasard donnerait de faux numeros.
 */
function pagesDuPdf(liste, pages, dejaRecu = () => false) {
  const pasRecus = liste.entrees.filter((e) => !dejaRecu(e.numero));
  const groupes = [pasRecus, pasRecus.filter((e) => e.nouveau), pasRecus.filter((e) => e.pret), liste.entrees];
  return groupes.find((g) => g.length > 0 && g.length === pages) || null;
}

// Ce PDF est-il celui de la liste ? Son nom (« PARIS94_2026-10-20.pdf ») ou
// son nombre de pages, qui colle a la liste.
function pdfDeLaListe(liste, { fileName, pages }, dejaRecu = () => false) {
  const nomOk = Boolean(liste.nom) && String(fileName || "").toUpperCase().startsWith(`${liste.nom.toUpperCase()}_`);
  const entrees = pagesDuPdf(liste, pages, dejaRecu);
  return { concerne: nomOk || (pages > 1 && Boolean(entrees)), complet: Boolean(entrees), entrees: entrees || [], attendues: liste.entrees.filter((e) => !dejaRecu(e.numero)) };
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
  pagesDuPdf,
  fusionnePoids,
};
