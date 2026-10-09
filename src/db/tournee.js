// Tournee : le depart, le sac (tourScope), le choix des transporteurs, la
// cloture et l'historique des sorties.
const { db } = require("./connexion");
const { getSetting, setSetting } = require("./reglages");
const { journalise } = require("./journal");
const { CODE_TOURNEE_SQL, PRET_SQL } = require("./sql");
const { carrierLabel } = require("../carrier");

// --- Tournee ----------------------------------------------------------------
// Quand on part poster, on fige l'instant du depart : tout ce qui arrive
// pendant qu'on est dehors n'est pas dans le sac, donc ne doit pas pouvoir
// etre drope. Toutes les vues et actions "a dropper" se limitent alors aux
// colis anterieurs au depart.
function getTourStart() {
  return getSetting("tour_started_at", null) || null;
}

// On ne part pas forcement avec tout : au depart, on choisit les
// transporteurs qu'on va poster (et, a part, ceux des speciaux et des LIT).
// La selection est une liste de cles "type:transporteur" -- "normal:MR",
// "lit:DHL", "special:LP", "bj:BJ". Sans selection, la tournee prend tout.
const TYPES_TOURNEE = new Set(["normal", "lit", "special", "bj"]);
const CLE_TOURNEE = /^(normal|lit|special|bj):[A-Za-z]{1,20}$/;

function getTourSelection() {
  const brut = getSetting("tour_selection", null);
  if (!brut) return null;
  try {
    const liste = JSON.parse(brut);
    return Array.isArray(liste) ? liste.filter((c) => CLE_TOURNEE.test(c)) : null;
  } catch (err) {
    return null;
  }
}

// La condition SQL d'une selection : "un de ces couples type/transporteur".
function selectionSql(selection) {
  const morceaux = [];
  const params = [];
  for (const cle of selection) {
    const [type, code] = cle.split(":");
    if (!TYPES_TOURNEE.has(type)) continue;
    morceaux.push(`(type = ? AND ${CODE_TOURNEE_SQL} = ?)`);
    params.push(type, code);
  }
  return morceaux.length ? { clause: ` AND (${morceaux.join(" OR ")})`, params } : { clause: " AND 0", params: [] };
}

// `selection` : les cles choisies au depart (null : tout).
function startTour(selection = null) {
  const propre = Array.isArray(selection) ? [...new Set(selection.filter((c) => CLE_TOURNEE.test(c)))] : null;
  if (propre) setSetting("tour_selection", JSON.stringify(propre));
  else db.prepare("DELETE FROM settings WHERE key = 'tour_selection'").run();
  setSetting("tour_started_at", db.prepare("SELECT datetime('now') AS d").get().d);
  return getTourStart();
}

function endTour() {
  db.prepare("DELETE FROM settings WHERE key IN ('tour_started_at', 'tour_selection')").run();
}

// Ce qu'on peut emporter : les colis en attente, ranges comme au depart en
// tournee -- les transporteurs (boite jaune comprise), puis les speciaux et
// les LIT a part, chacun par transporteur. `prets` : deja imprimes (ou sans
// etiquette), les seuls qu'un retour de tournee peut dropper.
function getTourChoix() {
  const lignes = db
    .prepare(
      `SELECT type, ${CODE_TOURNEE_SQL} AS code, COUNT(*) AS count,
              SUM(CASE WHEN ${PRET_SQL} THEN 1 ELSE 0 END) AS prets,
              ROUND(COALESCE(SUM(price), 0), 2) AS value
       FROM colis WHERE status = 'pending'
       GROUP BY type, code ORDER BY count DESC`
    )
    .all();
  const groupes = [
    { id: "normal", nom: "Transporteurs", transporteurs: [] },
    { id: "special", nom: "Spécial", transporteurs: [] },
    { id: "lit", nom: "LIT", transporteurs: [] },
  ];
  for (const l of lignes) {
    const groupe = groupes.find((g) => g.id === (l.type === "bj" ? "normal" : l.type));
    if (!groupe) continue;
    groupe.transporteurs.push({
      cle: `${l.type}:${l.code}`,
      code: l.code,
      nom: l.code === "BJ" ? "Boîte jaune" : l.code === "Inconnu" ? "Non reconnu" : carrierLabel(l.code),
      count: l.count,
      prets: l.prets,
      value: l.value,
    });
  }
  return { groupes: groupes.filter((g) => g.transporteurs.length > 0) };
}

// Les noms de la selection en cours ("Mondial Relay, UPS, LIT DHL"), ou null
// si la tournee prend tout.
function getTourSelectionNoms() {
  const selection = getTourSelection();
  if (!selection) return null;
  return selection.map((cle) => {
    const [type, code] = cle.split(":");
    const nom = code === "BJ" ? "Boîte jaune" : code === "Inconnu" ? "Non reconnu" : carrierLabel(code);
    return type === "lit" ? `LIT ${nom}` : type === "special" ? `Spécial ${nom}` : nom;
  });
}

// Historique des tournees : sert au cumul de la journee (une deuxieme sortie
// s'ajoute a la premiere pour le calcul du taux horaire).
function recordTour({ startedAt, endedAt, seconds, count, value }) {
  db.prepare(
    "INSERT INTO tours (started_at, ended_at, seconds, colis_count, value) VALUES (?, ?, ?, ?, ?)"
  ).run(startedAt, endedAt, Math.max(0, Math.round(seconds)), count, value);
}

// Total des tournees terminees le meme jour (a Paris) que `day` (date UTC de
// la base) : deux sorties de part et d'autre de minuit UTC restent le meme
// apres-midi francais.
function getDayTours(day) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(seconds), 0) AS seconds,
              COALESCE(SUM(colis_count), 0) AS count, ROUND(COALESCE(SUM(value), 0), 2) AS value
       FROM tours WHERE jour_paris(ended_at) = jour_paris(?)`
    )
    .get(day);
  return row;
}

// Resume de la derniere tournee terminee, affiche sur le dashboard jusqu'a ce
// qu'on le ferme (il survit donc a un rechargement de la page).
function saveLastTour(summary) {
  setSetting("last_tour", JSON.stringify(summary));
}

function getLastTour() {
  const raw = getSetting("last_tour", null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function clearLastTour() {
  db.prepare("DELETE FROM settings WHERE key = 'last_tour'").run();
}

// Heure du serveur, pour que le chrono du navigateur ne derive pas si les
// deux horloges ne sont pas d'accord.
function serverNow() {
  return db.prepare("SELECT datetime('now') AS d").get().d;
}

// Condition SQL a coller apres un WHERE existant, plus ses parametres : le
// sac de la tournee en cours (arrive avant le depart, et dans la selection).
function tourScope() {
  const start = getTourStart();
  if (!start) return { clause: "", params: [] };
  const selection = getTourSelection();
  const choix = selection ? selectionSql(selection) : { clause: "", params: [] };
  return { clause: ` AND created_at <= ?${choix.clause}`, params: [start, ...choix.params] };
}

// Les colis en attente qui ne sont pas dans le sac : arrives depuis le
// depart, ou d'un transporteur qu'on n'a pas emporte.
function getHorsTournee() {
  if (!getTourStart()) return { count: 0, value: 0 };
  const { clause, params } = tourScope();
  return db
    .prepare(
      `SELECT COUNT(*) AS count, ROUND(COALESCE(SUM(price), 0), 2) AS value FROM colis
       WHERE status = 'pending' AND id NOT IN (SELECT id FROM colis WHERE status = 'pending'${clause})`
    )
    .get(...params);
}

// Colis arrives depuis le depart : ils restent en attente pour la prochaine
// tournee.
function getArrivedDuringTour() {
  const start = getTourStart();
  if (!start) return { count: 0, value: 0 };
  return db
    .prepare(
      "SELECT COUNT(*) AS count, ROUND(COALESCE(SUM(price), 0), 2) AS value FROM colis WHERE status = 'pending' AND created_at > ?"
    )
    .get(start);
}

// Termine la tournee automatiquement quand le sac est vide : plus aucun colis
// en attente datant d'avant le depart.
function endTourIfEmpty() {
  const start = getTourStart();
  if (!start) return false;
  const { clause, params } = tourScope();
  const left = db.prepare(`SELECT COUNT(*) AS c FROM colis WHERE status = 'pending'${clause}`).get(...params).c;
  if (left > 0) return false;
  endTour();
  journalise("tournee", "Sac vide : tournée refermée");
  return true;
}

module.exports = {
  getTourStart,
  TYPES_TOURNEE,
  CLE_TOURNEE,
  getTourSelection,
  selectionSql,
  startTour,
  endTour,
  getTourChoix,
  getTourSelectionNoms,
  recordTour,
  getDayTours,
  saveLastTour,
  getLastTour,
  clearLastTour,
  serverNow,
  tourScope,
  getHorsTournee,
  getArrivedDuringTour,
  endTourIfEmpty,
};
