// Statistiques de revenus : series par jour et par semaine (jours de Paris).
const { db } = require("./connexion");
const { BUSINESS_DAY_SQL } = require("./sql");
const { arrondiCentimes } = require("./montants");
const { aujourdhuiParis, ajouteJours, jourDeLaSemaine, lundiDe } = require("../dates");

function getEarliestDroppedDate() {
  const row = db
    .prepare(`SELECT MIN(${BUSINESS_DAY_SQL}) AS d FROM colis WHERE status = 'dropped'`)
    .get();
  return row.d;
}

// Serie continue jour par jour (dimanche exclu) depuis le tout premier colis
// drope jusqu'a aujourd'hui, pour un scroll/swipe libre cote client (pas de
// pagination par semaine).
function getDailySeries() {
  const earliest = getEarliestDroppedDate();
  const today = aujourdhuiParis();
  const start = earliest && earliest < today ? earliest : today;

  const dateKeys = [];
  for (let d = start; d <= today; d = ajouteJours(d, 1)) {
    if (jourDeLaSemaine(d) === 0) continue; // dimanche exclu
    dateKeys.push(d);
  }
  const capped = dateKeys.slice(-420); // ~ un peu plus d'un an, garde-fou

  if (capped.length === 0) return { days: [] };
  const rows = db
    .prepare(
      `SELECT ${BUSINESS_DAY_SQL} AS d, ROUND(SUM(price), 2) AS value, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' AND ${BUSINESS_DAY_SQL} BETWEEN ? AND ?
       GROUP BY d`
    )
    .all(capped[0], capped[capped.length - 1]);
  const byDate = new Map(rows.map((r) => [r.d, r]));
  const days = capped.map((key) => {
    const row = byDate.get(key);
    return { date: key, value: row ? row.value : 0, count: row ? row.count : 0 };
  });
  return { days };
}

// Serie continue semaine par semaine (lundi -> samedi) depuis la semaine du
// premier colis drope jusqu'a la semaine en cours.
function getWeeklySeries() {
  const earliest = getEarliestDroppedDate();
  const currentMonday = lundiDe(aujourdhuiParis());
  const startMonday = earliest && lundiDe(earliest) < currentMonday ? lundiDe(earliest) : currentMonday;

  const weekRanges = [];
  for (let lundi = startMonday; lundi <= currentMonday; lundi = ajouteJours(lundi, 7)) {
    weekRanges.push({ start: lundi, end: ajouteJours(lundi, 5) });
  }
  const capped = weekRanges.slice(-104); // 2 ans, garde-fou

  if (capped.length === 0) return { weeks: [] };
  // Une seule lecture, jour par jour, repartie ensuite dans les semaines. Une
  // requete par semaine relisait toute la table a chaque fois : 26 semaines,
  // 26 lectures completes -- l'appel le plus lent du site.
  const parJour = db
    .prepare(
      `SELECT ${BUSINESS_DAY_SQL} AS d, ROUND(SUM(price), 2) AS value, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' AND ${BUSINESS_DAY_SQL} BETWEEN ? AND ?
       GROUP BY d`
    )
    .all(capped[0].start, capped[capped.length - 1].end);
  const weeks = capped.map((w) => ({ start: w.start, end: w.end, value: 0, count: 0 }));
  for (const jour of parJour) {
    // les semaines sont triees et disjointes : on cherche celle du jour
    const semaine = weeks.find((w) => jour.d >= w.start && jour.d <= w.end);
    if (!semaine) continue;
    semaine.value = arrondiCentimes(semaine.value + (jour.value || 0));
    semaine.count += jour.count || 0;
  }
  return { weeks };
}

function getBestDay() {
  return db
    .prepare(
      `SELECT ${BUSINESS_DAY_SQL} AS date, ROUND(SUM(price), 2) AS value, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' GROUP BY date ORDER BY value DESC LIMIT 1`
    )
    .get();
}

module.exports = {
  getEarliestDroppedDate,
  getDailySeries,
  getWeeklySeries,
  getBestDay,
};
