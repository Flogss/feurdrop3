const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH =
  process.env.DB_PATH ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "drop.db")
    : "./data/drop.db");
const DEFAULT_PRICE = Number(process.env.DEFAULT_PRICE || 4);
const DEFAULT_LIT_PRICE = Number(process.env.DEFAULT_LIT_PRICE || 5.5);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS senders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    price REAL NOT NULL DEFAULT ${DEFAULT_PRICE},
    lit_price REAL NOT NULL DEFAULT ${DEFAULT_LIT_PRICE},
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    dropped_at TEXT,
    paid_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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

const senderColumns = db.prepare("PRAGMA table_info(senders)").all().map((c) => c.name);
if (!senderColumns.includes("lit_price")) {
  db.exec(`ALTER TABLE senders ADD COLUMN lit_price REAL NOT NULL DEFAULT ${DEFAULT_LIT_PRICE}`);
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
  return type === "lit" ? sender.lit_price : sender.price;
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
  db.prepare("INSERT INTO senders (name, price, lit_price) VALUES (?, ?, ?)").run(
    clean,
    DEFAULT_PRICE,
    DEFAULT_LIT_PRICE
  );
  return db.prepare("SELECT * FROM senders WHERE name = ?").get(clean);
}

function updateSenderPrices(id, { price, litPrice }) {
  const current = db.prepare("SELECT * FROM senders WHERE id = ?").get(id);
  if (!current) return null;

  const nextPrice = price === undefined ? current.price : price;
  const nextLitPrice = litPrice === undefined ? current.lit_price : litPrice;
  db.prepare("UPDATE senders SET price = ?, lit_price = ? WHERE id = ?").run(nextPrice, nextLitPrice, id);

  // les colis BJ suivent le meme tarif que les colis normaux ; les prix fixes
  // manuellement via /prix ne sont pas ecrases
  db.prepare(
    "UPDATE colis SET price = ? WHERE status = 'pending' AND price_locked = 0 AND type IN ('normal', 'bj') AND sender_name = ?"
  ).run(nextPrice, current.name);
  db.prepare(
    "UPDATE colis SET price = ? WHERE status = 'pending' AND price_locked = 0 AND type = 'lit' AND sender_name = ?"
  ).run(nextLitPrice, current.name);

  return db.prepare("SELECT * FROM senders WHERE id = ?").get(id);
}

function createBatch(chatId) {
  const info = db.prepare("INSERT INTO batches (chat_id) VALUES (?)").run(chatId);
  return info.lastInsertRowid;
}

function addColis(senderName, { chatId, messageId, batchId, type = "normal" } = {}) {
  const sender = getOrCreateSender(senderName);
  const price = priceForType(sender, type);
  const info = db
    .prepare(
      "INSERT INTO colis (sender_name, type, price, status, chat_id, message_id, batch_id) VALUES (?, ?, ?, 'pending', ?, ?, ?)"
    )
    .run(sender.name, type, price, chatId || null, messageId || null, batchId || null);
  return { id: info.lastInsertRowid, sender_name: sender.name, price, type };
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

function getRevenueLast7Days() {
  const rows = db
    .prepare(
      `SELECT date(dropped_at) AS d, SUM(price) AS value, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' AND dropped_at >= datetime('now', '-6 days', 'start of day')
       GROUP BY d`
    )
    .all();
  const byDate = new Map(rows.map((r) => [r.d, r]));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = byDate.get(key);
    days.push({ date: key, value: row ? row.value : 0, count: row ? row.count : 0 });
  }
  return days;
}

function getRevenueWeeksThisMonth() {
  const rows = db
    .prepare(
      `SELECT CAST((CAST(strftime('%d', dropped_at) AS INTEGER) - 1) / 7 AS INTEGER) AS week_index,
              SUM(price) AS value, COUNT(*) AS count
       FROM colis
       WHERE status = 'dropped' AND strftime('%Y-%m', dropped_at) = strftime('%Y-%m', 'now')
       GROUP BY week_index ORDER BY week_index ASC`
    )
    .all();
  const byWeek = new Map(rows.map((r) => [r.week_index, r]));
  const weeks = [];
  for (let i = 0; i <= 4; i++) {
    const row = byWeek.get(i);
    weeks.push({ label: `Semaine ${i + 1}`, value: row ? row.value : 0, count: row ? row.count : 0 });
  }
  return weeks;
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
  createBatch,
  findColisByMessage,
  getLatestBatchId,
  setColisType,
  setBatchType,
  setColisPrice,
  setBatchPrice,
  quickAddColis,
  quickRemoveColis,
  getRevenueLast7Days,
  getRevenueWeeksThisMonth,
  getBestDay,
  getDebtsBySender,
  markSenderPaid,
  getStock,
  adjustStock,
  getPendingSummary,
  getStatsMessageId,
  setStatsMessageId,
  DEFAULT_PRICE,
  DEFAULT_LIT_PRICE,
};
