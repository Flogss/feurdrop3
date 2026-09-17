const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { suiviDbPath } = require("./paths");

// Lecture de la base du bot de suivi (projet suivi-colissimo). Ce module ne
// fait que LIRE : le bot reste seul maitre de ses donnees, et le dashboard ne
// peut rien casser de ce qu'il a collecte.
//
// Un numero verifie plusieurs fois existe dans plusieurs jobs : rien n'est
// jamais efface, on garde simplement l'actualisation la plus recente pour
// chaque numero. Relancer une verification enrichit l'historique au lieu de
// le remplacer.

const MILESTONE_FR = {
  pending: "En attente",
  info_received: "Pris en charge",
  in_transit: "En transit",
  out_for_delivery: "En cours de livraison",
  delivered: "Livré",
  final_other: "Clôturé (retour/échec)",
  expired: "Expiré (sans suite)",
  not_found: "Introuvable",
  unknown: "Inconnu",
};

const MILESTONE_ICON = {
  delivered: "✅",
  out_for_delivery: "🚚",
  in_transit: "📦",
  info_received: "📥",
  pending: "🕓",
  final_other: "↩️",
  expired: "⌛",
  not_found: "❓",
  unknown: "❔",
};

// Le bot ecrit ici, nous lisons ici : une seule verite, voir paths.js.
function candidatePaths() {
  return [suiviDbPath()];
}

let db = null;
let dbPath = null;
let openError = null;

function open() {
  if (db) return db;
  for (const candidate of candidatePaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      // readonly : le bot ecrit, nous seulement lisons
      db = new DatabaseSync(candidate, { readOnly: true });
      dbPath = candidate;
      openError = null;
      return db;
    } catch (err) {
      openError = `${candidate} : ${err.message}`;
    }
  }
  if (!openError) openError = "base du bot de suivi introuvable";
  return null;
}

function isReady() {
  return Boolean(open());
}

function status() {
  const ready = isReady();
  if (!ready) {
    return { ready: false, path: null, reason: openError, tried: candidatePaths() };
  }
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM jobs) AS jobs,
              (SELECT COUNT(*) FROM job_results) AS results,
              (SELECT COUNT(DISTINCT tracking_number) FROM job_results) AS numbers`
    )
    .get();
  return { ready: true, path: dbPath, ...counts };
}

// Derniere actualisation connue de chaque numero, tous jobs confondus.
const LATEST = `
  WITH latest AS (
    SELECT tracking_number, milestone, rank, last_label, last_event_at, event_ts,
           delivery_date, job_id,
           ROW_NUMBER() OVER (
             PARTITION BY tracking_number
             ORDER BY COALESCE(event_ts, 0) DESC, rowid DESC
           ) AS rn
    FROM job_results
    WHERE found = 1
  )
`;

function decorate(row) {
  return {
    ...row,
    milestoneLabel: MILESTONE_FR[row.milestone] || row.milestone,
    icon: MILESTONE_ICON[row.milestone] || "❔",
  };
}

// Les libelles de derniere actualisation, du plus recemment vu au plus ancien.
function labels() {
  if (!isReady()) return [];
  const rows = db
    .prepare(
      // MAX() accompagne de colonnes nues : SQLite renvoie alors les valeurs
      // de la ligne qui porte ce maximum, donc l'actualisation la plus
      // recente de ce libelle.
      `${LATEST}
       SELECT last_label AS label,
              COUNT(*) AS count,
              MIN(rank) AS rank,
              MAX(COALESCE(event_ts, 0)) AS last_ts,
              last_event_at,
              milestone
       FROM latest
       WHERE rn = 1
       GROUP BY last_label
       ORDER BY last_ts DESC`
    )
    .all();
  return rows.map(decorate);
}

// Repartition par categorie de statut.
function summary() {
  if (!isReady()) return [];
  return db
    .prepare(
      `${LATEST}
       SELECT milestone, COUNT(*) AS count, MIN(rank) AS rank, MAX(event_ts) AS last_ts
       FROM latest WHERE rn = 1
       GROUP BY milestone ORDER BY rank`
    )
    .all()
    .map(decorate);
}

// Les numeros portant un libelle donne, du plus recent au plus ancien.
function byLabel(label, { limit = 200, offset = 0 } = {}) {
  if (!isReady()) return { rows: [], total: 0 };

  const total = db
    .prepare(`${LATEST} SELECT COUNT(*) AS n FROM latest WHERE rn = 1 AND last_label IS ?`)
    .get(label).n;

  const rows = db
    .prepare(
      `${LATEST}
       SELECT tracking_number, milestone, last_label, last_event_at, event_ts, delivery_date
       FROM latest WHERE rn = 1 AND last_label IS ?
       ORDER BY COALESCE(event_ts, 0) DESC
       LIMIT ? OFFSET ?`
    )
    .all(label, limit, offset);

  return { total, rows: rows.map(decorate) };
}

// Categories qu'il vaut la peine de reinterroger : un colis livre ou clos ne
// bougera plus, le redemander gaspille le quota.
const RECHECKABLE = ["pending", "info_received", "in_transit", "out_for_delivery"];

// Combien de numeros sont reinterrogeables, par categorie.
function recheckable() {
  if (!isReady()) return [];
  const marks = RECHECKABLE.map(() => "?").join(",");
  return db
    .prepare(
      `${LATEST}
       SELECT milestone, COUNT(*) AS count, MIN(rank) AS rank
       FROM latest WHERE rn = 1 AND milestone IN (${marks})
       GROUP BY milestone ORDER BY rank`
    )
    .all(...RECHECKABLE)
    .map(decorate);
}

// Les numeros eux-memes, pour une ou plusieurs categories. Les plus anciennement
// actualises d'abord : ce sont eux qui ont le plus de chances d'avoir bouge.
function numbersToRecheck(milestones) {
  if (!isReady()) return [];
  const wanted = (milestones || []).filter((m) => RECHECKABLE.includes(m));
  if (wanted.length === 0) return [];
  const marks = wanted.map(() => "?").join(",");
  return db
    .prepare(
      `${LATEST}
       SELECT tracking_number FROM latest
       WHERE rn = 1 AND milestone IN (${marks})
       ORDER BY COALESCE(event_ts, 0) ASC`
    )
    .all(...wanted)
    .map((r) => r.tracking_number);
}

// Total de numeros distincts deja verifies, toutes verifications confondues.
function totalChecked() {
  if (!isReady()) return 0;
  return db.prepare("SELECT COUNT(DISTINCT tracking_number) AS n FROM job_results").get().n;
}

// Recherche d'un numero precis, avec tout son historique de verifications.
function search(query) {
  if (!isReady()) return [];
  const clean = String(query || "").replace(/\s+/g, "").toUpperCase();
  if (clean.length < 4) return [];
  return db
    .prepare(
      `SELECT r.tracking_number, r.milestone, r.last_label, r.last_event_at, r.event_ts,
              r.found, r.job_id, j.file_name, j.started_at
       FROM job_results r LEFT JOIN jobs j ON j.id = r.job_id
       WHERE r.tracking_number LIKE ?
       ORDER BY COALESCE(r.event_ts, 0) DESC LIMIT 50`
    )
    .all(`%${clean}%`)
    .map(decorate);
}

// Etat des verifications : celles en cours d'abord, avec de quoi afficher une
// progression honnete (rien n'est extrapole, tout vient du bot).
function jobs(limit = 30) {
  if (!isReady()) return [];
  return db
    .prepare(
      `SELECT j.*,
              (SELECT COUNT(*) FROM job_results r WHERE r.job_id = j.id AND r.found = 1) AS found,
              (SELECT COUNT(*) FROM job_results r WHERE r.job_id = j.id AND r.found = 0) AS missing
       FROM jobs j
       ORDER BY (j.state = 'running') DESC, j.started_at DESC
       LIMIT ?`
    )
    .all(limit)
    .map((job) => {
      const started = Date.parse(job.started_at);
      const finished = job.finished_at ? Date.parse(job.finished_at) : Date.now();
      const elapsed = Math.max(0, Math.round((finished - started) / 1000));
      const rate = elapsed > 0 ? job.checked / elapsed : 0;
      const left = Math.max(0, job.total - job.checked);
      return {
        ...job,
        running: job.state === "running",
        percent: job.total > 0 ? Math.round((job.checked / job.total) * 100) : 0,
        elapsed,
        rate: Math.round(rate * 10) / 10,
        // estimation affichee seulement si elle repose sur un debit mesure
        eta: job.state === "running" && rate > 0 ? Math.round(left / rate) : null,
      };
    });
}

module.exports = {
  status,
  labels,
  summary,
  byLabel,
  search,
  jobs,
  recheckable,
  numbersToRecheck,
  totalChecked,
  RECHECKABLE,
  MILESTONE_FR,
  MILESTONE_ICON,
};
