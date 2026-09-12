const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

// Un DB_PATH relatif pointe vers le systeme de fichiers du conteneur, qui est
// recree a chaque deploiement : si un volume est monte, il gagne toujours.
// C'est le seul cas ou on ignore une variable d'environnement, parce que la
// respecter revient a perdre la base a chaque mise en ligne.
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const ENV_DB_PATH = process.env.DB_PATH;
const ENV_DB_PATH_IGNORED = Boolean(VOLUME && ENV_DB_PATH && !path.isAbsolute(ENV_DB_PATH));

const DB_PATH =
  (ENV_DB_PATH_IGNORED ? null : ENV_DB_PATH) ||
  (VOLUME ? path.join(VOLUME, "drop.db") : "./data/drop.db");
const DEFAULT_PRICE = Number(process.env.DEFAULT_PRICE || 4);
const DEFAULT_LIT_PRICE = Number(process.env.DEFAULT_LIT_PRICE || 5.5);
const DEFAULT_BJ_PRICE = Number(process.env.DEFAULT_BJ_PRICE || DEFAULT_PRICE);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// La base existait-elle deja avant d'ouvrir la connexion ? C'est la question
// qui distingue "on a perdu les donnees" de "on ecrit dans un autre fichier".
const dbExisted = fs.existsSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS senders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    price REAL NOT NULL DEFAULT ${DEFAULT_PRICE},
    lit_price REAL NOT NULL DEFAULT ${DEFAULT_LIT_PRICE},
    bj_price REAL NOT NULL DEFAULT ${DEFAULT_BJ_PRICE},
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS colis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'normal',
    price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    chat_id INTEGER,
    message_id INTEGER,
    batch_id INTEGER,
    paid INTEGER NOT NULL DEFAULT 0,
    carrier TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    dropped_at TEXT,
    paid_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS carrier_rules (
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    carrier TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, value)
  );

  CREATE TABLE IF NOT EXISTS tours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    colis_count INTEGER NOT NULL,
    value REAL NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_colis_status ON colis(status);
  CREATE INDEX IF NOT EXISTS idx_colis_message ON colis(chat_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_colis_batch ON colis(batch_id);
`);

// migration guard for existing databases created before type/chat_id/message_id/batch_id existed
const colisColumns = db.prepare("PRAGMA table_info(colis)").all().map((c) => c.name);
if (!colisColumns.includes("type")) db.exec("ALTER TABLE colis ADD COLUMN type TEXT NOT NULL DEFAULT 'normal'");
if (!colisColumns.includes("chat_id")) db.exec("ALTER TABLE colis ADD COLUMN chat_id INTEGER");
if (!colisColumns.includes("message_id")) db.exec("ALTER TABLE colis ADD COLUMN message_id INTEGER");
if (!colisColumns.includes("batch_id")) db.exec("ALTER TABLE colis ADD COLUMN batch_id INTEGER");
if (!colisColumns.includes("paid")) db.exec("ALTER TABLE colis ADD COLUMN paid INTEGER NOT NULL DEFAULT 0");
if (!colisColumns.includes("paid_at")) db.exec("ALTER TABLE colis ADD COLUMN paid_at TEXT");
// prix fixe manuellement via /prix : ne doit pas etre ecrase par une mise a
// jour du tarif de l'expediteur
if (!colisColumns.includes("price_locked")) {
  db.exec("ALTER TABLE colis ADD COLUMN price_locked INTEGER NOT NULL DEFAULT 0");
}
if (!colisColumns.includes("carrier")) db.exec("ALTER TABLE colis ADD COLUMN carrier TEXT");
// nom de fichier, legende et identifiant Telegram du fichier : indispensables
// pour apprendre des regles de transporteur apres coup et pour re-telecharger
// les etiquettes au moment de les imprimer
if (!colisColumns.includes("file_name")) db.exec("ALTER TABLE colis ADD COLUMN file_name TEXT");
if (!colisColumns.includes("caption")) db.exec("ALTER TABLE colis ADD COLUMN caption TEXT");
if (!colisColumns.includes("file_id")) db.exec("ALTER TABLE colis ADD COLUMN file_id TEXT");
if (!colisColumns.includes("file_kind")) db.exec("ALTER TABLE colis ADD COLUMN file_kind TEXT");
// date d'impression automatique : une etiquette deja sortie de l'imprimante ne
// doit jamais ressortir toute seule
if (!colisColumns.includes("printed_at")) db.exec("ALTER TABLE colis ADD COLUMN printed_at TEXT");

const senderColumns = db.prepare("PRAGMA table_info(senders)").all().map((c) => c.name);
if (!senderColumns.includes("lit_price")) {
  db.exec(`ALTER TABLE senders ADD COLUMN lit_price REAL NOT NULL DEFAULT ${DEFAULT_LIT_PRICE}`);
}
if (!senderColumns.includes("bj_price")) {
  db.exec(`ALTER TABLE senders ADD COLUMN bj_price REAL NOT NULL DEFAULT ${DEFAULT_BJ_PRICE}`);
}

// Diagnostic au demarrage : sans volume persistant, le fichier vit dans le
// conteneur et disparait a chaque deploiement. Le compte de lignes permet de
// verifier d'un coup d'oeil dans les logs que la base est bien celle d'avant.
{
  const colisCount = db.prepare("SELECT COUNT(*) AS c FROM colis").get().c;
  const senderCount = db.prepare("SELECT COUNT(*) AS c FROM senders").get().c;
  console.log(
    `[db] ${path.resolve(DB_PATH)} (${dbExisted ? "existante" : "NOUVELLE"}) :` +
      ` ${colisCount} colis, ${senderCount} expediteurs`
  );
  if (!process.env.RAILWAY_VOLUME_MOUNT_PATH && process.env.RAILWAY_ENVIRONMENT) {
    console.warn(
      "[db] ATTENTION : aucun volume Railway monte, la base sera perdue au prochain deploiement."
    );
  }
  if (ENV_DB_PATH_IGNORED) {
    console.warn(
      `[db] DB_PATH="${ENV_DB_PATH}" ignore : chemin relatif, donc efface a chaque deploiement.` +
        ` Le volume ${VOLUME} est utilise a la place. Supprime la variable DB_PATH pour faire taire cet avertissement.`
    );
  }
}

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

// Prix applique a un colis selon son type : les LIT ont leur propre tarif par
// expediteur, les BJ suivent le tarif normal.
function priceForType(sender, type) {
  if (type === "lit") return sender.lit_price;
  if (type === "bj") return sender.bj_price;
  return sender.price;
}

function getStock() {
  return Number(getSetting("stock", 0));
}

function adjustStock(delta) {
  const next = getStock() + Number(delta);
  setSetting("stock", next);
  return next;
}

function getPendingSummary() {
  const row = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending'")
    .get();
  return { count: row.count, value: row.value };
}

function getStatsMessageId(key) {
  const value = getSetting(`stats_msg_${key}`, null);
  return value ? Number(value) : null;
}

function setStatsMessageId(key, messageId) {
  setSetting(`stats_msg_${key}`, messageId);
}

function getOrCreateSender(name) {
  const clean = (name || "Inconnu").trim().slice(0, 120) || "Inconnu";
  const existing = db.prepare("SELECT * FROM senders WHERE name = ?").get(clean);
  if (existing) return existing;
  db.prepare("INSERT INTO senders (name, price, lit_price, bj_price) VALUES (?, ?, ?, ?)").run(
    clean,
    DEFAULT_PRICE,
    DEFAULT_LIT_PRICE,
    DEFAULT_BJ_PRICE
  );
  return db.prepare("SELECT * FROM senders WHERE name = ?").get(clean);
}

function updateSenderPrices(id, { price, litPrice, bjPrice }) {
  const current = db.prepare("SELECT * FROM senders WHERE id = ?").get(id);
  if (!current) return null;

  const nextPrice = price === undefined ? current.price : price;
  const nextLitPrice = litPrice === undefined ? current.lit_price : litPrice;
  const nextBjPrice = bjPrice === undefined ? current.bj_price : bjPrice;
  db.prepare("UPDATE senders SET price = ?, lit_price = ?, bj_price = ? WHERE id = ?").run(
    nextPrice,
    nextLitPrice,
    nextBjPrice,
    id
  );

  // chaque type suit son propre tarif ; les prix fixes manuellement via /prix
  // ne sont pas ecrases
  const applyTo = db.prepare(
    "UPDATE colis SET price = ? WHERE status = 'pending' AND price_locked = 0 AND type = ? AND sender_name = ?"
  );
  applyTo.run(nextPrice, "normal", current.name);
  applyTo.run(nextLitPrice, "lit", current.name);
  applyTo.run(nextBjPrice, "bj", current.name);

  return db.prepare("SELECT * FROM senders WHERE id = ?").get(id);
}

function createBatch(chatId) {
  const info = db.prepare("INSERT INTO batches (chat_id) VALUES (?)").run(chatId);
  return info.lastInsertRowid;
}

function addColis(
  senderName,
  { chatId, messageId, batchId, type = "normal", carrier = null, fileName, caption, fileId, fileKind } = {}
) {
  const sender = getOrCreateSender(senderName);
  const price = priceForType(sender, type);
  const info = db
    .prepare(
      `INSERT INTO colis (sender_name, type, price, status, chat_id, message_id, batch_id, carrier,
                          file_name, caption, file_id, file_kind)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sender.name,
      type,
      price,
      chatId || null,
      messageId || null,
      batchId || null,
      carrier || null,
      fileName || null,
      caption || null,
      fileId || null,
      fileKind || null
    );
  return { id: info.lastInsertRowid, sender_name: sender.name, price, type, carrier };
}

// --- Regles de transporteur apprises ---------------------------------------
// Corriger un colis avec /transporteur enseigne au bot la forme du numero de
// suivi et le mot-cle de la description, pour que les suivants soient reconnus
// tout seuls.
function saveCarrierRule(kind, value, carrier) {
  db.prepare(
    `INSERT INTO carrier_rules (kind, value, carrier) VALUES (?, ?, ?)
     ON CONFLICT(kind, value) DO UPDATE SET carrier = excluded.carrier, created_at = datetime('now')`
  ).run(kind, value, carrier);
}

function getCarrierRules() {
  return db.prepare("SELECT kind, value, carrier FROM carrier_rules").all();
}

function listCarrierRules() {
  return db.prepare("SELECT kind, value, carrier, created_at FROM carrier_rules ORDER BY created_at DESC").all();
}

function clearCarrierRules() {
  return db.prepare("DELETE FROM carrier_rules").run().changes;
}

// Colis en attente sans transporteur, pour les repasser a la moulinette quand
// une nouvelle regle vient d'etre apprise.
function getUnclassifiedPending() {
  return db
    .prepare(
      "SELECT id, file_name, caption FROM colis WHERE status = 'pending' AND carrier IS NULL AND type != 'bj'"
    )
    .all();
}

// Etiquettes en attente pour un transporteur donne, dans l'ordre d'arrivee.
// Les LIT sont imprimes a la main : ils sont exclus de /imprime.
const PRINTABLE_SQL = "status = 'pending' AND file_id IS NOT NULL AND type != 'lit'";

// Par defaut on ne propose que ce qui n'est jamais sorti de l'imprimante :
// apres avoir imprime 10 MR, en recevoir 2 et faire "tout imprimer" ne doit
// ressortir que les 2. `includePrinted` sert au bouton de reimpression.
function printableScope(includePrinted) {
  return includePrinted ? PRINTABLE_SQL : `${PRINTABLE_SQL} AND printed_at IS NULL`;
}

function getPrintableColis(carrier, { includePrinted = false } = {}) {
  const base = `SELECT id, sender_name, file_id, file_kind, file_name FROM colis WHERE ${printableScope(
    includePrinted
  )}`;
  if (carrier === "BJ") return db.prepare(`${base} AND type = 'bj' ORDER BY id`).all();
  if (carrier === "Inconnu") {
    return db.prepare(`${base} AND type != 'bj' AND carrier IS NULL ORDER BY id`).all();
  }
  return db.prepare(`${base} AND type != 'bj' AND carrier = ? ORDER BY id`).all(carrier);
}

// Combien d'etiquettes en attente ont deja ete imprimees une fois : sert a
// proposer (ou non) la reimpression.
function countAlreadyPrinted() {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM colis WHERE ${PRINTABLE_SQL} AND printed_at IS NOT NULL`)
    .get().c;
}

// Repartition des etiquettes imprimables (celles dont on a encore le fichier).
function getPrintableSummary({ includePrinted = false } = {}) {
  return db
    .prepare(
      `SELECT ${CARRIER_GROUP_SQL} AS carrier, COUNT(*) AS count
       FROM colis WHERE ${printableScope(includePrinted)}
       GROUP BY ${CARRIER_GROUP_SQL} ORDER BY count DESC`
    )
    .all();
}

// Colis en attente groupes par transporteur detecte (nom de fichier /
// description). "Autre" regroupe les colis dont le transporteur n'a pas pu
// etre determine.
// Les colis BJ forment leur propre ligne dans "compagnies a poster" : ils se
// deposent differemment, meme s'ils portent un numero de suivi transporteur.
// "Inconnu" ne devrait quasiment jamais apparaitre : le bot previent sur
// Telegram des qu'un fichier n'est pas reconnu, pour affiner les regles.
const CARRIER_GROUP_SQL = "CASE WHEN type = 'bj' THEN 'BJ' ELSE COALESCE(carrier, 'Inconnu') END";

// --- Tournee ----------------------------------------------------------------
// Quand on part poster, on fige l'instant du depart : tout ce qui arrive
// pendant qu'on est dehors n'est pas dans le sac, donc ne doit pas pouvoir
// etre drope. Toutes les vues et actions "a dropper" se limitent alors aux
// colis anterieurs au depart.
function getTourStart() {
  return getSetting("tour_started_at", null) || null;
}

function startTour() {
  setSetting("tour_started_at", db.prepare("SELECT datetime('now') AS d").get().d);
  return getTourStart();
}

function endTour() {
  db.prepare("DELETE FROM settings WHERE key = 'tour_started_at'").run();
}

// Historique des tournees : sert au cumul de la journee (une deuxieme sortie
// s'ajoute a la premiere pour le calcul du taux horaire).
function recordTour({ startedAt, endedAt, seconds, count, value }) {
  db.prepare(
    "INSERT INTO tours (started_at, ended_at, seconds, colis_count, value) VALUES (?, ?, ?, ?, ?)"
  ).run(startedAt, endedAt, Math.max(0, Math.round(seconds)), count, value);
}

// Total des tournees terminees le meme jour que `day` (date SQLite).
function getDayTours(day) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(seconds), 0) AS seconds,
              COALESCE(SUM(colis_count), 0) AS count, COALESCE(SUM(value), 0) AS value
       FROM tours WHERE date(ended_at) = date(?)`
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

// Condition SQL a coller apres un WHERE existant, plus ses parametres.
function tourScope() {
  const start = getTourStart();
  return start ? { clause: " AND created_at <= ?", params: [start] } : { clause: "", params: [] };
}

// Colis arrives depuis le depart : ils restent en attente pour la prochaine
// tournee.
function getArrivedDuringTour() {
  const start = getTourStart();
  if (!start) return { count: 0, value: 0 };
  return db
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending' AND created_at > ?"
    )
    .get(start);
}

// Termine la tournee automatiquement quand le sac est vide : plus aucun colis
// en attente datant d'avant le depart.
function endTourIfEmpty() {
  const start = getTourStart();
  if (!start) return false;
  const left = db
    .prepare("SELECT COUNT(*) AS c FROM colis WHERE status = 'pending' AND created_at <= ?")
    .get(start).c;
  if (left > 0) return false;
  endTour();
  return true;
}

function getCarrierSummary() {
  const { clause, params } = tourScope();
  return db
    .prepare(
      `SELECT ${CARRIER_GROUP_SQL} AS carrier, COUNT(*) AS pending_count, SUM(price) AS pending_value
       FROM colis WHERE status = 'pending'${clause}
       GROUP BY ${CARRIER_GROUP_SQL} ORDER BY pending_count DESC`
    )
    .all(...params);
}

function dropByCarrier(carrier) {
  const { clause, params } = tourScope();
  const base = "UPDATE colis SET status = 'dropped', dropped_at = datetime('now') WHERE status = 'pending'";

  let info;
  if (carrier === "BJ") {
    info = db.prepare(`${base} AND type = 'bj'${clause}`).run(...params);
  } else if (carrier === "Inconnu") {
    info = db.prepare(`${base} AND type != 'bj' AND carrier IS NULL${clause}`).run(...params);
  } else {
    info = db.prepare(`${base} AND type != 'bj' AND carrier = ?${clause}`).run(carrier, ...params);
  }
  endTourIfEmpty();
  return info.changes;
}

// Drop de tous les colis du sac (ou de tout ce qui est en attente hors tournee).
function dropAll() {
  const { clause, params } = tourScope();
  const info = db
    .prepare(
      `UPDATE colis SET status = 'dropped', dropped_at = datetime('now') WHERE status = 'pending'${clause}`
    )
    .run(...params);
  endTourIfEmpty();
  return info.changes;
}

function dropBySender(name) {
  const { clause, params } = tourScope();
  const info = db
    .prepare(
      `UPDATE colis SET status = 'dropped', dropped_at = datetime('now') WHERE status = 'pending' AND sender_name = ?${clause}`
    )
    .run(name, ...params);
  endTourIfEmpty();
  return info.changes;
}

function findColisByMessage(chatId, messageId) {
  return db
    .prepare("SELECT * FROM colis WHERE chat_id = ? AND message_id = ? AND status = 'pending'")
    .get(chatId, messageId);
}

function getLatestBatchId(chatId) {
  const row = db
    .prepare("SELECT id FROM batches WHERE chat_id = ? ORDER BY id DESC LIMIT 1")
    .get(chatId);
  return row ? row.id : null;
}

function setColisType(id, type) {
  const colis = db.prepare("SELECT * FROM colis WHERE id = ? AND status = 'pending'").get(id);
  if (!colis) return null;
  const price = priceForType(getOrCreateSender(colis.sender_name), type);
  // changer de type reapplique le tarif de l'expediteur, meme si un prix avait
  // ete fixe manuellement
  db.prepare("UPDATE colis SET type = ?, price = ?, price_locked = 0 WHERE id = ?").run(type, price, id);
  return { ...colis, type, price };
}

function setColisCarrier(id, carrier) {
  db.prepare("UPDATE colis SET carrier = ? WHERE id = ?").run(carrier, id);
  return db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
}

// Applique un transporteur a tout un lot (commande /transporteur sans reponse
// a un colis precis).
function setBatchCarrier(batchId, carrier) {
  return db
    .prepare("UPDATE colis SET carrier = ? WHERE batch_id = ? AND status = 'pending'")
    .run(carrier, batchId).changes;
}

// --- Impression automatique -------------------------------------------------
// L'agent installe sur le Mac vient chercher ici ce qui n'est pas encore
// sorti de l'imprimante. Les LIT en sont exclus comme pour /imprime : ils se
// font a la main.
const AUTOPRINT_SQL = `${PRINTABLE_SQL} AND printed_at IS NULL`;

function isAutoPrintEnabled() {
  return getSetting("auto_print", "0") === "1";
}

// En activant, on considere tout ce qui est deja en attente comme deja
// imprime : sinon la premiere execution sortirait tout le stock d'un coup.
function setAutoPrintEnabled(enabled) {
  if (enabled && !isAutoPrintEnabled()) markPendingAsPrinted();
  setSetting("auto_print", enabled ? "1" : "0");
  return isAutoPrintEnabled();
}

function markPendingAsPrinted() {
  return db
    .prepare(`UPDATE colis SET printed_at = datetime('now') WHERE ${AUTOPRINT_SQL}`)
    .run().changes;
}

// Triees par transporteur : meme en impression continue, la pile reste
// groupee par compagnie, ce qui est l'ordre de la tournee.
function getUnprintedLabels(limit = 40) {
  return db
    .prepare(
      `SELECT id, sender_name, file_id, file_kind, file_name, carrier, type
       FROM colis WHERE ${AUTOPRINT_SQL}
       ORDER BY ${CARRIER_GROUP_SQL}, id LIMIT ?`
    )
    .all(limit);
}

function countUnprintedLabels() {
  return db.prepare(`SELECT COUNT(*) AS c FROM colis WHERE ${AUTOPRINT_SQL}`).get().c;
}

function markPrinted(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`UPDATE colis SET printed_at = datetime('now') WHERE id IN (${placeholders})`)
    .run(...ids).changes;
}

// Jeton partage avec l'agent d'impression. Genere au premier demarrage et
// garde en base, comme les cles VAPID.
function getPrintToken() {
  const fromEnv = process.env.PRINT_TOKEN;
  if (fromEnv) return fromEnv;
  let token = getSetting("print_token", null);
  if (!token) {
    token = require("crypto").randomBytes(24).toString("hex");
    setSetting("print_token", token);
  }
  return token;
}

// Retire un colis du suivi (site, compagnies a poster et file d'impression).
// Le fichier Telegram, lui, n'est pas touche ici.
function deleteColis(id) {
  const colis = db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
  if (!colis) return null;
  db.prepare("DELETE FROM colis WHERE id = ?").run(id);
  return colis;
}

// Colis d'un lot, pour apprendre des regles a partir de tout le groupe.
function getBatchColis(batchId) {
  return db.prepare("SELECT * FROM colis WHERE batch_id = ? AND status = 'pending'").all(batchId);
}

function getColisById(id) {
  return db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
}

function setColisPrice(id, price) {
  const info = db
    .prepare("UPDATE colis SET price = ?, price_locked = 1 WHERE id = ? AND status = 'pending'")
    .run(price, id);
  if (info.changes === 0) return null;
  return db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
}

function setBatchPrice(batchId, price) {
  const info = db
    .prepare("UPDATE colis SET price = ?, price_locked = 1 WHERE batch_id = ? AND status = 'pending'")
    .run(price, batchId);
  return info.changes;
}

function quickAddColis(senderName) {
  return addColis(senderName);
}

function quickRemoveColis(senderName) {
  const colis = db
    .prepare("SELECT id FROM colis WHERE sender_name = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
    .get(senderName);
  if (!colis) return false;
  db.prepare("DELETE FROM colis WHERE id = ?").run(colis.id);
  return true;
}

// Lundi (UTC) de la semaine contenant `dateStr` (ou aujourd'hui si omis).
function mondayOf(dateStr) {
  const d = dateStr ? new Date(`${dateStr}T00:00:00Z`) : new Date();
  const utcDow = d.getUTCDay(); // 0=dim .. 6=sam
  const isoDow = utcDow === 0 ? 7 : utcDow; // 1=lun .. 7=dim
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - (isoDow - 1));
  return monday;
}

function getEarliestDroppedDate() {
  const row = db.prepare("SELECT MIN(date(dropped_at)) AS d FROM colis WHERE status = 'dropped'").get();
  return row.d;
}

// Serie continue jour par jour (dimanche exclu) depuis le tout premier colis
// drope jusqu'a aujourd'hui, pour un scroll/swipe libre cote client (pas de
// pagination par semaine).
function getDailySeries() {
  const earliest = getEarliestDroppedDate();
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = earliest ? new Date(`${earliest}T00:00:00Z`) : todayUTC;

  const dateKeys = [];
  for (let d = new Date(start); d <= todayUTC; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0) continue; // dimanche exclu
    dateKeys.push(d.toISOString().slice(0, 10));
  }
  const capped = dateKeys.slice(-420); // ~ un peu plus d'un an, garde-fou

  if (capped.length === 0) return { days: [] };
  const rows = db
    .prepare(
      `SELECT date(dropped_at) AS d, SUM(price) AS value, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' AND date(dropped_at) BETWEEN ? AND ?
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
  const currentMonday = mondayOf();
  const startMonday = earliest ? mondayOf(earliest) : currentMonday;

  const weekRanges = [];
  for (let m = new Date(startMonday); m <= currentMonday; m.setUTCDate(m.getUTCDate() + 7)) {
    const monday = new Date(m);
    const saturday = new Date(m);
    saturday.setUTCDate(saturday.getUTCDate() + 5);
    weekRanges.push({ start: monday.toISOString().slice(0, 10), end: saturday.toISOString().slice(0, 10) });
  }
  const capped = weekRanges.slice(-104); // 2 ans, garde-fou

  if (capped.length === 0) return { weeks: [] };
  const weeks = capped.map((w) => {
    const row = db
      .prepare(
        `SELECT SUM(price) AS value, COUNT(*) AS count FROM colis
         WHERE status = 'dropped' AND date(dropped_at) BETWEEN ? AND ?`
      )
      .get(w.start, w.end);
    return { start: w.start, end: w.end, value: row.value || 0, count: row.count || 0 };
  });
  return { weeks };
}

function getBestDay() {
  return db
    .prepare(
      `SELECT date(dropped_at) AS date, SUM(price) AS value, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' GROUP BY date ORDER BY value DESC LIMIT 1`
    )
    .get();
}

function getDebtsBySender() {
  return db
    .prepare(
      `SELECT sender_name, SUM(price) AS owed, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' AND paid = 0
       GROUP BY sender_name HAVING owed > 0 ORDER BY owed DESC`
    )
    .all();
}

function markSenderPaid(senderName) {
  const info = db
    .prepare("UPDATE colis SET paid = 1, paid_at = datetime('now') WHERE sender_name = ? AND status = 'dropped' AND paid = 0")
    .run(senderName);
  return info.changes;
}

const MERGE_SAFETY_THRESHOLD = 0.25; // un expediteur au-dessus de 25% du CA ne peut pas etre fusionne

// Chiffre d'affaires total (colis drops) servant de reference pour le seuil
// de securite des fusions vers "Autre".
function getTotalRevenue() {
  return db.prepare("SELECT COALESCE(SUM(price), 0) AS t FROM colis WHERE status = 'dropped'").get().t;
}

// Liste des expediteurs (hors "Autre") avec leur part du CA total, et si oui
// ou non ils peuvent etre fusionnes dans "Autre" sans risque.
function getMergeCandidates() {
  const total = getTotalRevenue();
  const rows = db
    .prepare(
      `SELECT s.id, s.name,
              COALESCE((SELECT SUM(price) FROM colis WHERE sender_name = s.name AND status = 'dropped'), 0) AS ca,
              COALESCE((SELECT COUNT(*) FROM colis WHERE sender_name = s.name), 0) AS colisCount
       FROM senders s WHERE s.name != 'Autre' ORDER BY s.name ASC`
    )
    .all();
  return rows.map((r) => {
    const pct = total > 0 ? r.ca / total : 0;
    return { id: r.id, name: r.name, ca: r.ca, colisCount: r.colisCount, pct, mergeable: pct <= MERGE_SAFETY_THRESHOLD };
  });
}

// Fusionne les expediteurs donnes dans un expediteur generique "Autre",
// en ignorant silencieusement ceux qui depassent le seuil de securite (protection
// meme si la liste envoyee par le client est perimee).
function mergeSendersIntoOther(senderIds) {
  const total = getTotalRevenue();
  const other = getOrCreateSender("Autre");
  let merged = 0;

  for (const id of senderIds) {
    const sender = db.prepare("SELECT * FROM senders WHERE id = ?").get(id);
    if (!sender || sender.name === "Autre") continue;
    const ca = db
      .prepare("SELECT COALESCE(SUM(price), 0) AS t FROM colis WHERE sender_name = ? AND status = 'dropped'")
      .get(sender.name).t;
    const pct = total > 0 ? ca / total : 0;
    if (pct > MERGE_SAFETY_THRESHOLD) continue;

    db.prepare("UPDATE colis SET sender_name = ? WHERE sender_name = ?").run(other.name, sender.name);
    db.prepare("DELETE FROM senders WHERE id = ?").run(sender.id);
    merged += 1;
  }
  return merged;
}

// Fusionne un expediteur dans un autre (cas typique : la meme personne a
// recree un compte Telegram). Tous les colis - dropes comme en attente -
// passent sous le nom cible, puis l'expediteur source est supprime. Le seuil
// de securite de "Autre" ne s'applique pas ici : c'est un choix explicite et
// rien n'est perdu, tout est deplace vers un expediteur existant.
function mergeSenderInto(sourceId, targetId) {
  const source = db.prepare("SELECT * FROM senders WHERE id = ?").get(sourceId);
  const target = db.prepare("SELECT * FROM senders WHERE id = ?").get(targetId);
  if (!source) throw new Error("Expéditeur source introuvable");
  if (!target) throw new Error("Expéditeur cible introuvable");
  if (source.id === target.id) throw new Error("Choisis deux expéditeurs différents");

  const moved = db
    .prepare("UPDATE colis SET sender_name = ? WHERE sender_name = ?")
    .run(target.name, source.name).changes;
  db.prepare("DELETE FROM senders WHERE id = ?").run(source.id);
  return { moved, source: source.name, target: target.name };
}

// Horodatage de la derniere fois que le dashboard a ete regarde. Sert a
// cumuler les notifications : tant que le site n'a pas ete rouvert, le "+N"
// compte tous les colis arrives depuis, pas seulement le dernier lot.
function markPushSeen() {
  setSetting("push_seen_at", db.prepare("SELECT datetime('now') AS d").get().d);
}

// Colis enregistres depuis la derniere consultation du site.
function countColisSince(since) {
  if (!since) return null;
  return db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE created_at > ?")
    .get(since);
}

// --- Notifications push (PWA iOS/Android) -----------------------------------
// Un abonnement = un appareil. iOS peut le revoquer silencieusement, donc le
// client se reabonne a chaque ouverture et on supprime les endpoints morts
// des que le service de push repond 404/410.
function saveSubscription({ endpoint, keys, label }) {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       label = COALESCE(excluded.label, push_subscriptions.label),
       last_seen_at = datetime('now')`
  ).run(endpoint, keys.p256dh, keys.auth, label || null);
}

function deleteSubscription(endpoint) {
  return db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes;
}

function listSubscriptions() {
  return db
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
    .all()
    .map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

function countSubscriptions() {
  return db.prepare("SELECT COUNT(*) AS c FROM push_subscriptions").get().c;
}

function setBatchType(batchId, type) {
  const rows = db.prepare("SELECT * FROM colis WHERE batch_id = ? AND status = 'pending'").all(batchId);
  const update = db.prepare("UPDATE colis SET type = ?, price = ?, price_locked = 0 WHERE id = ?");
  let count = 0;
  for (const c of rows) {
    const price = priceForType(getOrCreateSender(c.sender_name), type);
    update.run(type, price, c.id);
    count += 1;
  }
  return count;
}

module.exports = {
  db,
  getOrCreateSender,
  updateSenderPrices,
  addColis,
  getCarrierSummary,
  dropByCarrier,
  dropAll,
  dropBySender,
  getTourStart,
  startTour,
  endTour,
  recordTour,
  getDayTours,
  saveLastTour,
  getLastTour,
  clearLastTour,
  serverNow,
  tourScope,
  getArrivedDuringTour,
  createBatch,
  findColisByMessage,
  getLatestBatchId,
  setColisType,
  setBatchType,
  setColisPrice,
  setColisCarrier,
  saveCarrierRule,
  getCarrierRules,
  listCarrierRules,
  clearCarrierRules,
  getUnclassifiedPending,
  getPrintableColis,
  getPrintableSummary,
  countAlreadyPrinted,
  isAutoPrintEnabled,
  setAutoPrintEnabled,
  getUnprintedLabels,
  countUnprintedLabels,
  markPrinted,
  getPrintToken,
  setBatchCarrier,
  getColisById,
  getBatchColis,
  deleteColis,
  setBatchPrice,
  quickAddColis,
  quickRemoveColis,
  getDailySeries,
  getWeeklySeries,
  getBestDay,
  getDebtsBySender,
  markSenderPaid,
  getStock,
  adjustStock,
  getPendingSummary,
  getStatsMessageId,
  setStatsMessageId,
  getMergeCandidates,
  mergeSendersIntoOther,
  mergeSenderInto,
  getSetting,
  setSetting,
  markPushSeen,
  countColisSince,
  saveSubscription,
  deleteSubscription,
  listSubscriptions,
  countSubscriptions,
  DEFAULT_PRICE,
  DEFAULT_LIT_PRICE,
  DEFAULT_BJ_PRICE,
};
