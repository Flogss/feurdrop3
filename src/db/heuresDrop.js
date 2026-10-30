// Les heures de drop : quand on compte aller poster, et quels transporteurs.
// « La Poste 16:00 », puis « Mondial Relay 19:30 » : autant d'heures qu'on
// veut, chacune avec ses transporteurs. Le dashboard les pose, les modifie,
// les retire ; l'expediteur les voit sur son espace (portail.js) pour ceux
// de ses colis qui attendent.
//
// Une heure se solde toute seule quand ses colis sont postes : un drop
// groupe (« Dropper » sur un transporteur, « Tout », la fin de tournee) qui
// emporte un transporteur le retire de ses heures ; un colis droppe a l'unite
// aussi, s'il ne reste plus rien de pret pour ce transporteur. Une heure
// dont plus aucun transporteur n'attend disparait. Une heure oubliee s'efface
// 12 h apres son passage.
//
// Rangees dans les reglages (une ligne JSON) : rien a migrer, et une liste
// de quelques heures n'a pas besoin de table.
const crypto = require("crypto");
const { db } = require("./connexion");
const { getSetting, setSetting } = require("./reglages");
const { journalise } = require("./journal");
const { CARRIER_GROUP_SQL, PRET_SQL } = require("./sql");
const { evenements } = require("./drops");
const { CARRIERS, carrierLabel } = require("../carrier");
const { FUSEAU, aujourdhuiParis, ajouteJours, heureParis, jourParis } = require("../dates");

const CLE = "heures_drop";
const MAX_HEURES = 20;
const OUBLI_MS = 12 * 3600 * 1000;
// une heure deja passee de plus d'une heure, c'est pour demain (22 h : « 9:00 »)
const RETARD_TOLERE_MS = 3600 * 1000;

// les transporteurs qu'on peut prevoir : ceux du bot, et la boite jaune
const TRANSPORTEURS = CARRIERS.map((c) => ({ code: c.code, label: c.code === "BJ" ? "Boîte jaune" : c.label }));
const CODES = new Set(TRANSPORTEURS.map((t) => t.code));
const labelDe = (code) => TRANSPORTEURS.find((t) => t.code === code)?.label || carrierLabel(code);

const formatParties = new Intl.DateTimeFormat("en-GB", {
  timeZone: FUSEAU,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

// L'instant (ms) ou il est `heure` a Paris le `jour` : on part de la meme
// heure en UTC et on corrige du decalage de Paris a cet instant (une fois de
// plus autour d'un changement d'heure).
function instantParis(jour, heure) {
  const pivot = Date.parse(`${jour}T${heure}:00Z`);
  let t = pivot;
  for (let i = 0; i < 2; i += 1) {
    const p = Object.fromEntries(formatParties.formatToParts(t).map((x) => [x.type, x.value]));
    const vu = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    t -= vu - pivot;
  }
  return t;
}

/** « 16:00 », « 9h30 », « 19h » -> « 16:00 » ; null si illisible. */
function lisHeure(texte) {
  const m = String(texte ?? "").trim().match(/^(\d{1,2})\s*(?:[:hH.]\s*(\d{2})?)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function lisTransporteurs(liste) {
  if (!Array.isArray(liste)) return [];
  return [...new Set(liste.map((c) => String(c).trim().toUpperCase()))].filter((c) => CODES.has(c));
}

// La prochaine fois qu'il sera `heure` a Paris (aujourd'hui, ou demain si
// l'heure est passee depuis plus d'une heure).
function prochainInstant(heure, maintenant = Date.now()) {
  const aujourdhui = aujourdhuiParis();
  const t = instantParis(aujourdhui, heure);
  return t < maintenant - RETARD_TOLERE_MS ? instantParis(ajouteJours(aujourdhui, 1), heure) : t;
}

function lis() {
  try {
    const liste = JSON.parse(getSetting(CLE, "[]"));
    return Array.isArray(liste) ? liste.filter((h) => h && h.id && Number.isFinite(h.a) && Array.isArray(h.transporteurs)) : [];
  } catch {
    return [];
  }
}

function ecris(liste) {
  setSetting(CLE, JSON.stringify(liste));
}

const trie = (liste) => [...liste].sort((x, y) => x.a - y.a);

// les heures encore valables (une heure oubliee s'efface)
function heuresActives(maintenant = Date.now()) {
  const liste = lis();
  const actives = liste.filter((h) => h.a + OUBLI_MS > maintenant && h.transporteurs.length > 0);
  if (actives.length !== liste.length) ecris(actives);
  return trie(actives);
}

// Ce que voient le dashboard et l'app.
function vueHeure(h) {
  const jour = jourParis(h.a);
  return {
    id: h.id,
    a: new Date(h.a).toISOString(),
    heure: heureParis(h.a),
    jour,
    demain: jour === ajouteJours(aujourdhuiParis(), 1),
    passee: h.a < Date.now(),
    transporteurs: h.transporteurs.map((code) => ({ code, label: labelDe(code) })),
  };
}

function getHeuresDrop() {
  return { heures: heuresActives().map(vueHeure), transporteurs: TRANSPORTEURS };
}

const texteHeure = (h) => `${h.transporteurs.map(labelDe).join(", ")} à ${heureParis(h.a)}`;

function valide({ heure, transporteurs }) {
  const hh = lisHeure(heure);
  if (!hh) return { erreur: "Heure illisible : écris-la comme 16:00." };
  const codes = lisTransporteurs(transporteurs);
  if (!codes.length) return { erreur: "Choisis au moins un transporteur." };
  return { hh, codes };
}

function ajouteHeureDrop(corps = {}) {
  const v = valide(corps);
  if (v.erreur) return v;
  const liste = heuresActives();
  if (liste.length >= MAX_HEURES) return { erreur: `${MAX_HEURES} heures au plus : retires-en une d'abord.` };
  const h = { id: crypto.randomBytes(6).toString("base64url"), a: prochainInstant(v.hh), transporteurs: v.codes };
  ecris([...liste, h]);
  journalise("tournee", "Heure de drop prévue", { detail: texteHeure(h) });
  return getHeuresDrop();
}

function modifieHeureDrop(id, corps = {}) {
  const liste = heuresActives();
  const h = liste.find((x) => x.id === id);
  if (!h) return { erreur: "Cette heure n'existe plus.", status: 404 };
  const v = valide({ heure: corps.heure ?? heureParis(h.a), transporteurs: corps.transporteurs ?? h.transporteurs });
  if (v.erreur) return v;
  // l'heure n'a pas change (seulement les transporteurs) : le jour non plus
  if (v.hh !== heureParis(h.a)) h.a = prochainInstant(v.hh);
  h.transporteurs = v.codes;
  ecris(liste);
  journalise("tournee", "Heure de drop modifiée", { detail: texteHeure(h) });
  return getHeuresDrop();
}

function retireHeureDrop(id) {
  const liste = heuresActives();
  const h = liste.find((x) => x.id === id);
  if (h) {
    ecris(liste.filter((x) => x !== h));
    journalise("tournee", "Heure de drop retirée", { detail: texteHeure(h) });
  }
  return getHeuresDrop();
}

// Apres un drop : les transporteurs postes quittent leurs heures.
function soldeApresDrop(ids) {
  const liste = lis();
  if (!liste.length || !ids?.length) return;
  const groupes = db
    .prepare(`SELECT DISTINCT ${CARRIER_GROUP_SQL} AS g FROM colis WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids))
    .map((r) => r.g);
  const restePret = db.prepare(`SELECT COUNT(*) AS c FROM colis WHERE status = 'pending' AND ${PRET_SQL} AND ${CARRIER_GROUP_SQL} = ?`);
  // un drop groupe emporte le transporteur ; un colis seul, seulement s'il
  // etait le dernier pret
  const postes = new Set(groupes.filter((g) => ids.length > 1 || restePret.get(g).c === 0));
  if (!postes.size) return;
  let change = false;
  const reste = [];
  for (const h of liste) {
    const garde = h.transporteurs.filter((c) => !postes.has(c));
    if (garde.length !== h.transporteurs.length) change = true;
    if (garde.length) reste.push({ ...h, transporteurs: garde });
  }
  if (change) ecris(reste);
}

evenements.on("dropes", (ids) => {
  try {
    soldeApresDrop(ids);
  } catch (err) {
    // une heure mal soldee ne doit jamais empecher un drop
    console.error("[heures de drop]", err.message);
  }
});

// Pour l'espace d'un expediteur : les heures qui concernent ses colis en
// attente. `groupes` : le transporteur de chacun de ses colis pas encore
// postes (« BJ » pour la boite jaune), avec leur nombre.
function heuresPourGroupes(groupes) {
  const vues = [];
  for (const h of heuresActives()) {
    const transporteurs = h.transporteurs.filter((c) => groupes.has(c)).map((code) => ({ code, nom: labelDe(code), colis: groupes.get(code) }));
    if (!transporteurs.length) continue;
    const v = vueHeure(h);
    vues.push({ a: v.a, heure: v.heure, jour: v.jour, demain: v.demain, passee: v.passee, transporteurs });
  }
  return vues;
}

module.exports = {
  getHeuresDrop,
  ajouteHeureDrop,
  modifieHeureDrop,
  retireHeureDrop,
  heuresPourGroupes,
  lisHeure,
  instantParis,
};
