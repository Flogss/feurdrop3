const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || "./data/drop.db";
const DEFAULT_PRICE = Number(process.env.DEFAULT_PRICE || 4);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS senders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    price REAL NOT NULL DEFAULT ${DEFAULT_PRICE},
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS colis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_name TEXT NOT NULL,
    price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    dropped_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_colis_status ON colis(status);
`);

function getOrCreateSender(name) {
  const clean = (name || "Inconnu").trim().slice(0, 120) || "Inconnu";
  const existing = db.prepare("SELECT * FROM senders WHERE name = ?").get(clean);
  if (existing) return existing;
  db.prepare("INSERT INTO senders (name, price) VALUES (?, ?)").run(clean, DEFAULT_PRICE);
  return db.prepare("SELECT * FROM senders WHERE name = ?").get(clean);
}

function addColis(senderName) {
  const sender = getOrCreateSender(senderName);
  const info = db
    .prepare("INSERT INTO colis (sender_name, price, status) VALUES (?, ?, 'pending')")
    .run(sender.name, sender.price);
  return { id: info.lastInsertRowid, sender_name: sender.name, price: sender.price };
}

module.exports = { db, getOrCreateSender, addColis, DEFAULT_PRICE };
