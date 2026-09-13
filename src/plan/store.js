const { db } = require("../db");
const { looksLikeLocker } = require("./lockers");

// Base des points de depot. Le principe directeur : on ne fait jamais dire a
// un point ce qu'on ne sait pas de lui. Chaque point porte sa SOURCE et son
// NIVEAU DE CONFIANCE, et c'est l'usage reel (y avoir depose) qui fait passer
// un point en "verifie", pas le fait de l'avoir trouve quelque part.
//
//   verified   le point existe et accepte ce transporteur : referentiel
//              officiel du transporteur, ou depot reellement effectue
//   unverified trouve en ligne ou importe sans confirmation : utilisable en
//              dernier recours, jamais a la place d'un point verifie
//   rejected   ferme, disparu, ou a refuse le colis : jamais propose

db.exec(`
  CREATE TABLE IF NOT EXISTS relay_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_ref TEXT,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    postal_code TEXT,
    city TEXT,
    lat REAL,
    lng REAL,
    kind TEXT,
    trust TEXT NOT NULL DEFAULT 'unverified',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS relay_networks (
    point_id INTEGER NOT NULL,
    carrier TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (point_id, carrier)
  );

  -- horaires connus, tels que la source les donne, pour une date precise.
  -- Rien ici = horaires inconnus : on ne devine pas.
  CREATE TABLE IF NOT EXISTS relay_hours (
    point_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    ranges TEXT,
    cutoff_colis TEXT,
    cutoff_chrono TEXT,
    source TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (point_id, day)
  );

  CREATE TABLE IF NOT EXISTS relay_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_id INTEGER NOT NULL,
    carrier TEXT,
    result TEXT NOT NULL,
    note TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ratissage d'une zone par une source lente (Overpass) : inutile de
  -- redemander les memes points relais plusieurs fois par jour, et inutile de
  -- s'acharner sur un serveur qui vient de ne pas repondre
  CREATE TABLE IF NOT EXISTS relay_sweeps (
    cell TEXT PRIMARY KEY,
    retry_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_relay_source ON relay_points(source, source_ref);
  CREATE INDEX IF NOT EXISTS idx_relay_networks ON relay_networks(carrier);
`);

// Une boite aux lettres n'a pas d'horaire d'ouverture : elle a une heure de
// LEVEE. Passer apres n'empeche pas de poster, la lettre part le lendemain.
// Cette nuance merite sa colonne : sans elle on afficherait "ferme" en rouge
// devant une boite parfaitement utilisable.
const hoursColumns = db.prepare("PRAGMA table_info(relay_hours)").all().map((c) => c.name);
if (!hoursColumns.includes("soft")) {
  db.exec("ALTER TABLE relay_hours ADD COLUMN soft INTEGER NOT NULL DEFAULT 0");
}

// Casier automatique ou commerce : la distinction change ce qu'on propose,
// voir lockers.js. La colonne est remplie a l'enregistrement ; les points
// deja en base sont reclasses une fois, sur leur libelle.
const pointColumns = db.prepare("PRAGMA table_info(relay_points)").all().map((c) => c.name);
if (!pointColumns.includes("locker")) {
  db.exec("ALTER TABLE relay_points ADD COLUMN locker INTEGER NOT NULL DEFAULT 0");
  db.exec(
    `UPDATE relay_points SET locker = 1
     WHERE name LIKE '%LOCKER%' OR name LIKE '%locker%' OR name LIKE '%onsigne%'
        OR name LIKE '%asier%' OR kind LIKE '%asier%' OR kind LIKE '%ocker%'`
  );
}

const TRUST = { verified: "verified", unverified: "unverified", rejected: "rejected" };

// --- Lecture ----------------------------------------------------------------

// La source sait parfois qu'il s'agit d'un casier ; sinon on lit le libelle.
function isLocker(point) {
  return point.locker !== undefined ? Boolean(point.locker) : looksLikeLocker(point);
}

function hydrate(row) {
  if (!row) return null;
  const carriers = db
    .prepare("SELECT carrier, confirmed FROM relay_networks WHERE point_id = ?")
    .all(row.id);
  return { ...row, locker: Boolean(row.locker), carriers: carriers.map((c) => c.carrier), networks: carriers };
}

function getPoint(id) {
  return hydrate(db.prepare("SELECT * FROM relay_points WHERE id = ?").get(id));
}

function findBySource(source, ref) {
  return hydrate(
    db.prepare("SELECT * FROM relay_points WHERE source = ? AND source_ref = ?").get(source, ref)
  );
}

// Tous les points connus pour un transporteur, hors points rejetes.
function pointsForCarrier(carrier) {
  const rows = db
    .prepare(
      `SELECT p.* FROM relay_points p
       JOIN relay_networks n ON n.point_id = p.id
       WHERE n.carrier = ? AND p.trust != 'rejected' AND p.lat IS NOT NULL
       ORDER BY p.trust = 'verified' DESC, p.name`
    )
    .all(carrier);
  return rows.map(hydrate);
}

function allPoints() {
  return db.prepare("SELECT * FROM relay_points ORDER BY name").all().map(hydrate);
}

function countBySource(source) {
  return db.prepare("SELECT COUNT(*) AS n FROM relay_points WHERE source = ?").get(source).n;
}

// Repartition par source, pour que l'interface puisse dire d'ou vient chaque
// point plutot que de tout melanger.
function sourceCounts() {
  return db
    .prepare("SELECT source, COUNT(*) AS count FROM relay_points GROUP BY source ORDER BY count DESC")
    .all();
}

function countPoints() {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM relay_points) AS total,
         (SELECT COUNT(*) FROM relay_points WHERE trust = 'verified') AS verified,
         (SELECT COUNT(*) FROM relay_points WHERE trust = 'unverified') AS unverified,
         (SELECT COUNT(*) FROM relay_points WHERE trust = 'rejected') AS rejected`
    )
    .get();
}

// --- Ecriture ---------------------------------------------------------------

// Enregistre un point. Deux points de meme source et meme reference sont le
// meme point : on met a jour au lieu d'empiler des doublons. La confiance
// deja acquise ne redescend jamais toute seule.
function upsertPoint(point) {
  const existing = point.source_ref ? findBySource(point.source, point.source_ref) : null;

  if (existing) {
    db.prepare(
      `UPDATE relay_points
       SET name = ?, address = ?, postal_code = ?, city = ?, lat = ?, lng = ?, kind = ?,
           locker = ?,
           trust = CASE WHEN trust = 'rejected' THEN 'rejected'
                        WHEN trust = 'verified' THEN 'verified'
                        ELSE ? END,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      point.name,
      point.address || "",
      point.postal_code || null,
      point.city || null,
      point.lat ?? null,
      point.lng ?? null,
      point.kind || null,
      isLocker(point) ? 1 : 0,
      point.trust || TRUST.unverified,
      existing.id
    );
    addNetworks(existing.id, point.carriers || []);
    return getPoint(existing.id);
  }

  const info = db
    .prepare(
      `INSERT INTO relay_points (source, source_ref, name, address, postal_code, city, lat, lng, kind, locker, trust, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      point.source,
      point.source_ref || null,
      point.name,
      point.address || "",
      point.postal_code || null,
      point.city || null,
      point.lat ?? null,
      point.lng ?? null,
      point.kind || null,
      isLocker(point) ? 1 : 0,
      point.trust || TRUST.unverified,
      point.note || null
    );
  const id = Number(info.lastInsertRowid);
  addNetworks(id, point.carriers || []);
  return getPoint(id);
}

function addNetworks(pointId, carriers, confirmed = 0) {
  const stmt = db.prepare(
    `INSERT INTO relay_networks (point_id, carrier, confirmed) VALUES (?, ?, ?)
     ON CONFLICT(point_id, carrier) DO UPDATE SET confirmed = MAX(confirmed, excluded.confirmed)`
  );
  for (const carrier of carriers) stmt.run(pointId, carrier, confirmed);
}

function setTrust(pointId, trust) {
  db.prepare("UPDATE relay_points SET trust = ?, updated_at = datetime('now') WHERE id = ?").run(
    trust,
    pointId
  );
  return getPoint(pointId);
}

function deletePoint(pointId) {
  db.prepare("DELETE FROM relay_networks WHERE point_id = ?").run(pointId);
  db.prepare("DELETE FROM relay_hours WHERE point_id = ?").run(pointId);
  db.prepare("DELETE FROM relay_points WHERE id = ?").run(pointId);
}

// Retour d'experience apres un depot : c'est lui qui fait la fiabilite de la
// base. Un depot reussi verifie le point ET la compatibilite du transporteur.
function recordVisit({ pointId, carrier = null, result, note = null }) {
  db.prepare("INSERT INTO relay_visits (point_id, carrier, result, note) VALUES (?, ?, ?, ?)").run(
    pointId,
    carrier,
    result,
    note
  );

  if (result === "ok") {
    setTrust(pointId, TRUST.verified);
    if (carrier) addNetworks(pointId, [carrier], 1);
  } else if (result === "ferme" || result === "refuse" || result === "introuvable") {
    // ferme une fois n'est pas ferme pour toujours : seul un refus ou une
    // disparition condamne le point
    if (result !== "ferme") setTrust(pointId, TRUST.rejected);
  }
  return getPoint(pointId);
}

function lastVisits(pointId, limit = 5) {
  return db
    .prepare("SELECT * FROM relay_visits WHERE point_id = ? ORDER BY at DESC LIMIT ?")
    .all(pointId, limit);
}

// --- Horaires ---------------------------------------------------------------

function saveHours(pointId, day, hours) {
  db.prepare(
    `INSERT INTO relay_hours (point_id, day, ranges, cutoff_colis, cutoff_chrono, soft, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(point_id, day) DO UPDATE SET
       ranges = excluded.ranges, cutoff_colis = excluded.cutoff_colis,
       cutoff_chrono = excluded.cutoff_chrono, soft = excluded.soft,
       source = excluded.source, fetched_at = excluded.fetched_at`
  ).run(
    pointId,
    day,
    hours.ranges ? JSON.stringify(hours.ranges) : null,
    hours.cutoffColis || null,
    hours.cutoffChrono || null,
    hours.soft ? 1 : 0,
    hours.source || null
  );
}

function getHours(pointId, day) {
  const row = db
    .prepare("SELECT * FROM relay_hours WHERE point_id = ? AND day = ?")
    .get(pointId, day);
  if (!row) return null;
  return {
    ranges: row.ranges ? JSON.parse(row.ranges) : null,
    cutoffColis: row.cutoff_colis,
    cutoffChrono: row.cutoff_chrono,
    soft: Boolean(row.soft),
    source: row.source,
    fetchedAt: row.fetched_at,
  };
}

// Zone deja ratissee ? On arrondit a ~1 km : deux departs voisins tombent
// dans la meme case.
function sweptRecently(source, lat, lng) {
  const cell = `${source}:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const row = db
    .prepare("SELECT 1 AS ok FROM relay_sweeps WHERE cell = ? AND retry_at > datetime('now')")
    .get(cell);
  return { cell, fresh: Boolean(row) };
}

// `hours` : dans combien de temps il vaudra la peine de redemander. Long apres
// un succes (les points relais ne bougent pas dans la journee), court apres un
// echec (le serveur peut revenir).
function markSwept(cell, hours = 24) {
  db.prepare(
    `INSERT INTO relay_sweeps (cell, retry_at) VALUES (?, datetime('now', '+${Number(hours)} hours'))
     ON CONFLICT(cell) DO UPDATE SET retry_at = excluded.retry_at`
  ).run(cell);
}

module.exports = {
  TRUST,
  sweptRecently,
  markSwept,
  getPoint,
  findBySource,
  pointsForCarrier,
  allPoints,
  countPoints,
  countBySource,
  sourceCounts,
  upsertPoint,
  addNetworks,
  setTrust,
  deletePoint,
  recordVisit,
  lastVisits,
  saveHours,
  getHours,
};
