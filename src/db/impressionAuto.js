// Impression automatique pilotee a distance (depuis le telephone) et executee
// par l'agent du Mac.
//
// - les filtres (categories, transporteurs, expediteurs) sont des reglages du
//   serveur : le telephone les ecrit, l'agent n'en sait rien, il recoit
//   simplement une file deja filtree ;
// - chaque envoi a l'agent est une TACHE a identifiant stable, gardee cote
//   serveur : « envoyée » tant que l'agent n'a pas confirme, « imprimée »
//   seulement apres sa confirmation. Une confirmation rejouee (reseau coupe
//   apres l'impression) ne remarque rien deux fois ;
// - les etiquettes d'une tache envoyee sont reservees (bail de 10 min) : un
//   second appel ne les ressort pas, et si l'agent disparait sans rien dire,
//   elles reviennent dans la file a l'expiration -- rien n'est perdu.
const crypto = require("crypto");
const { db } = require("./connexion");
const { getSetting, setSetting } = require("./reglages");
const { journalise } = require("./journal");
const { AUTOPRINT_SQL, CARRIER_GROUP_SQL } = require("./sql");
const { carrierLabel } = require("../carrier");

const BAIL_MS = Number(process.env.AUTOPRINT_BAIL_S || 600) * 1000;
const TACHES_GARDEES = 30;
// l'agent sonde toutes les 20 s : au-dela d'une minute sans nouvelles, il est
// considere hors ligne
const AGENT_PERDU_MS = 70 * 1000;

const CATEGORIES = [
  { code: "normal", nom: "Étiquettes classiques" },
  { code: "special", nom: "Spéciaux" },
  { code: "bj", nom: "BJ" },
];

// --- Filtres -------------------------------------------------------------------

const VIDE = { categories: [], transporteurs: [], expediteurs: [] };

function liste(v, permis) {
  if (!Array.isArray(v)) return [];
  const propre = [...new Set(v.map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 60);
  return permis ? propre.filter((x) => permis.includes(x)) : propre;
}

function normaliseFiltres(f) {
  return {
    categories: liste(f?.categories, CATEGORIES.map((c) => c.code)),
    transporteurs: liste(f?.transporteurs),
    expediteurs: liste(f?.expediteurs),
  };
}

function getFiltresAuto() {
  try {
    return normaliseFiltres(JSON.parse(getSetting("auto_print_filtres", "{}")));
  } catch {
    return { ...VIDE };
  }
}

function setFiltresAuto(f) {
  const avant = JSON.stringify(getFiltresAuto());
  const filtres = normaliseFiltres(f);
  setSetting("auto_print_filtres", JSON.stringify(filtres));
  if (JSON.stringify(filtres) !== avant) journalise("reglage", "Filtres de l'impression auto modifiés");
  return filtres;
}

// --- Taches --------------------------------------------------------------------

function lisTaches() {
  let taches;
  try {
    taches = JSON.parse(getSetting("auto_print_taches", "[]"));
  } catch {
    taches = [];
  }
  if (!Array.isArray(taches)) return [];
  // une tache envoyee sans nouvelles depuis le bail : ses etiquettes sont
  // rendues a la file
  const limite = Date.now() - BAIL_MS;
  for (const t of taches) {
    if (t.etat === "envoyee" && Date.parse(t.creee) < limite) t.etat = "expiree";
  }
  return taches;
}

function ecrisTaches(taches) {
  setSetting("auto_print_taches", JSON.stringify(taches.slice(0, TACHES_GARDEES)));
}

function idsReserves(taches = lisTaches()) {
  return taches.filter((t) => t.etat === "envoyee").flatMap((t) => t.ids);
}

// --- File filtree --------------------------------------------------------------

function clauseAuto() {
  const f = getFiltresAuto();
  const conds = [AUTOPRINT_SQL];
  const params = [];
  const dans = (expr, valeurs) => {
    conds.push(`${expr} IN (${valeurs.map(() => "?").join(",")})`);
    params.push(...valeurs);
  };
  if (f.categories.length) dans("type", f.categories);
  if (f.transporteurs.length) dans(CARRIER_GROUP_SQL, f.transporteurs);
  if (f.expediteurs.length) dans("sender_name", f.expediteurs);
  const reserves = idsReserves();
  if (reserves.length) {
    conds.push(`id NOT IN (${reserves.map(() => "?").join(",")})`);
    params.push(...reserves);
  }
  return { where: conds.join(" AND "), params };
}

function fileAuto(limit = 40) {
  const { where, params } = clauseAuto();
  return db
    .prepare(
      `SELECT id, sender_name, file_id, file_kind, file_name, carrier, type
       FROM colis WHERE ${where}
       ORDER BY ${CARRIER_GROUP_SQL}, id LIMIT ?`
    )
    .all(...params, limit);
}

function compteFileAuto() {
  const { where, params } = clauseAuto();
  return db.prepare(`SELECT COUNT(*) AS c FROM colis WHERE ${where}`).get(...params).c;
}

// Reserve des etiquettes AVANT de preparer le PDF (qui prend du temps) : deux
// appels simultanes ne recoivent jamais les memes.
function ouvreTache(ids) {
  const taches = lisTaches();
  const tache = {
    id: crypto.randomBytes(8).toString("hex"),
    ids: [...ids],
    pages: 0,
    etat: "envoyee",
    creee: new Date().toISOString(),
    finie: null,
    erreur: null,
  };
  ecrisTaches([tache, ...taches]);
  return tache;
}

function majTache(id, maj) {
  const taches = lisTaches();
  const t = taches.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, maj);
  ecrisTaches(taches);
  return t;
}

// L'agent ne confirme qu'apres avoir imprime. `markPrinted` est passe en
// parametre (il vit dans impression.js) pour garder ce module sans cycle.
// Rejouee, la confirmation ne remarque rien : `deja`.
function confirmeTache({ job, ids }, markPrinted) {
  const taches = lisTaches();
  const memes = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  // un ancien agent n'envoie pas l'identifiant : on retrouve la tache par
  // ses etiquettes
  const t = job ? taches.find((x) => x.id === job) : taches.find((x) => x.etat !== "imprimee" && memes(x.ids, ids));
  if (t?.etat === "imprimee") return { deja: true, tache: t, fournee: t.fournee || null };
  const aMarquer = t ? t.ids : ids;
  const fournee = markPrinted(aMarquer, "Impression auto");
  if (t) {
    Object.assign(t, { etat: "imprimee", finie: new Date().toISOString(), erreur: null, fournee });
    ecrisTaches(taches);
  }
  return { deja: false, tache: t || null, fournee, marques: aMarquer.length };
}

function echecTache(job, erreur) {
  const t = lisTaches().find((x) => x.id === job);
  if (!t || t.etat === "imprimee") return t || null;
  // les etiquettes repartent dans la file : l'agent reessaiera
  return majTache(job, { etat: "echec", finie: new Date().toISOString(), erreur: String(erreur || "Erreur").slice(0, 200) });
}

// --- Agent ---------------------------------------------------------------------

// En memoire : apres un redemarrage du serveur, le prochain sondage (20 s)
// le retablit.
const agent = { vu: null, imprimante: null };

function agentVu(imprimante) {
  agent.vu = new Date().toISOString();
  if (imprimante) agent.imprimante = String(imprimante).slice(0, 80);
}

function etatAgent() {
  const enLigne = Boolean(agent.vu) && Date.now() - Date.parse(agent.vu) < AGENT_PERDU_MS;
  return { enLigne, vu: agent.vu, imprimante: agent.imprimante };
}

// --- Ce que montre le telephone ------------------------------------------------

function optionsAuto() {
  const transporteurs = db
    .prepare(
      `SELECT DISTINCT ${CARRIER_GROUP_SQL} AS code FROM colis
       WHERE type != 'lit' AND created_at >= datetime('now', '-60 days') ORDER BY code`
    )
    .all()
    .map((r) => ({ code: r.code, nom: carrierLabel(r.code) }));
  const expediteurs = db
    .prepare(
      `SELECT sender_name AS nom, COUNT(*) AS c FROM colis
       WHERE sender_name IS NOT NULL AND sender_name != '' AND created_at >= datetime('now', '-60 days')
       GROUP BY sender_name ORDER BY c DESC LIMIT 60`
    )
    .all()
    .map((r) => r.nom);
  return { categories: CATEGORIES, transporteurs, expediteurs };
}

function etatImpressionAuto(enabled) {
  const taches = lisTaches();
  return {
    enabled,
    filtres: getFiltresAuto(),
    pending: enabled ? compteFileAuto() : 0,
    agent: etatAgent(),
    enCours: taches.filter((t) => t.etat === "envoyee").reduce((n, t) => n + t.ids.length, 0),
    taches: taches.slice(0, 10).map((t) => ({
      id: t.id,
      etat: t.etat,
      etiquettes: t.ids.length,
      pages: t.pages,
      creee: t.creee,
      finie: t.finie,
      erreur: t.erreur,
    })),
    options: optionsAuto(),
  };
}

module.exports = {
  getFiltresAuto,
  setFiltresAuto,
  fileAuto,
  compteFileAuto,
  ouvreTache,
  majTache,
  confirmeTache,
  echecTache,
  agentVu,
  etatAgent,
  etatImpressionAuto,
};
