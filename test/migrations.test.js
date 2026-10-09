// Migrations versionnees : une base neuve, une base ancienne (schema d'avant
// les colonnes ajoutees au fil du temps), une migration qui echoue.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { appliqueMigrations, VERSION_SCHEMA, versionDe } = require("../src/db/migrations");
const { enregistreFonctionsSql } = require("../src/dates");

const silencieux = { log() {}, warn() {} };
const colonnes = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function baseTemporaire() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "drop-migr-"));
  const db = new DatabaseSync(path.join(dossier, "drop.db"));
  enregistreFonctionsSql(db);
  return db;
}

test("base neuve : toutes les migrations, puis plus rien a faire", () => {
  const db = baseTemporaire();
  assert.deepEqual(appliqueMigrations(db, { journal: silencieux }), [1, 2, 3, 4]);
  assert.equal(versionDe(db), VERSION_SCHEMA);
  for (const c of ["type", "file_id", "printed_at", "note", "source_message_id", "price_locked"]) {
    assert.ok(colonnes(db, "colis").includes(c), c);
  }
  assert.ok(colonnes(db, "senders").includes("portail_jeton"));
  assert.ok(colonnes(db, "push_subscriptions").includes("seen_at"));
  for (const t of ["arrivees", "journal", "paires_special", "tours", "carrier_rules"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
  }
  assert.deepEqual(appliqueMigrations(db, { journal: silencieux }), []);
});

test("base ancienne : les donnees restent, les colonnes manquantes arrivent", () => {
  const db = baseTemporaire();
  // le schema des toutes premieres versions
  db.exec(`
    CREATE TABLE senders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, price REAL NOT NULL DEFAULT 4,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE colis (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_name TEXT NOT NULL, price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), dropped_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO senders (name, price) VALUES ('Alice', 4.5);
    INSERT INTO colis (sender_name, price, status, created_at, dropped_at) VALUES ('Alice', 4.5, 'dropped', datetime('now', '-2 days'), datetime('now', '-1 days'));
    INSERT INTO colis (sender_name, price) VALUES ('Alice', 4.5);
    INSERT INTO settings (key, value) VALUES ('stock', '12'), ('push_seen_at', '2026-01-01 10:00:00');
    INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push/1', 'p', 'a');
  `);
  appliqueMigrations(db, { journal: silencieux });

  assert.equal(versionDe(db), VERSION_SCHEMA);
  const lignes = db.prepare("SELECT sender_name, price, status, type, paid FROM colis ORDER BY id").all();
  assert.deepEqual(
    lignes.map((l) => ({ ...l })),
    [
      { sender_name: "Alice", price: 4.5, status: "dropped", type: "normal", paid: 0 },
      { sender_name: "Alice", price: 4.5, status: "pending", type: "normal", paid: 0 },
    ]
  );
  assert.equal(db.prepare("SELECT lit_price FROM senders").get().lit_price, 5.5);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'stock'").get().value, "12");
  // le "vu le" commun passe a chaque appareil
  assert.equal(db.prepare("SELECT seen_at FROM push_subscriptions").get().seen_at, "2026-01-01 10:00:00");
  // le journal repart des 30 derniers jours
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM journal").get().n >= 2);
});

test("une migration qui echoue ne laisse rien a moitie fait", () => {
  const db = baseTemporaire();
  appliqueMigrations(db, { journal: silencieux });
  const essai = [
    {
      version: VERSION_SCHEMA + 1,
      nom: "essai",
      applique(base) {
        base.exec("ALTER TABLE colis ADD COLUMN essai TEXT");
        throw new Error("panne au milieu");
      },
    },
  ];
  assert.throws(
    () => appliqueMigrations(db, { journal: silencieux, migrations: essai, jusqua: VERSION_SCHEMA + 1 }),
    /migration 5 \(essai\) impossible : panne au milieu/
  );
  assert.equal(versionDe(db), VERSION_SCHEMA);
  assert.ok(!colonnes(db, "colis").includes("essai"));
});

test("ouvrir la base par le module : migrations appliquees, rien au simple chargement", () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "drop-ouvre-"));
  const chemin = path.join(dossier, "drop.db");
  process.env.DB_PATH = chemin;
  const base = require("../src/db");
  assert.equal(fs.existsSync(chemin), false, "charger le module n'ouvre rien");
  base.ouvreBase();
  assert.equal(fs.existsSync(chemin), true);
  assert.equal(base.db.prepare("PRAGMA user_version").get().user_version, VERSION_SCHEMA);
  base.fermeBase();
});

test("base existante a migrer : copie verifiee d'abord, a cote de la base", () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "drop-sauve-"));
  const chemin = path.join(dossier, "drop.db");
  const ancienne = new DatabaseSync(chemin);
  ancienne.exec(`
    CREATE TABLE senders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, price REAL NOT NULL DEFAULT 4,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE colis (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_name TEXT NOT NULL, price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), dropped_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO colis (sender_name, price) VALUES ('Alice', 4), ('Bob', 5.5);
  `);
  ancienne.close();

  process.env.DB_PATH = chemin;
  const base = require("../src/db");
  base.fermeBase();
  base.ouvreBase();
  const copies = fs.readdirSync(path.join(dossier, "sauvegardes"));
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^drop-avant-migration-v0-.*\.db$/);
  const copie = new DatabaseSync(path.join(dossier, "sauvegardes", copies[0]), { readOnly: true });
  assert.equal(copie.prepare("SELECT COUNT(*) AS n FROM colis").get().n, 2);
  assert.equal(copie.prepare("PRAGMA user_version").get().user_version, 0, "la copie est l'etat d'AVANT");
  copie.close();
  assert.equal(base.db.prepare("PRAGMA user_version").get().user_version, VERSION_SCHEMA);

  // rouverte a jour : plus de copie
  base.fermeBase();
  base.ouvreBase();
  assert.equal(fs.readdirSync(path.join(dossier, "sauvegardes")).length, 1);
  base.fermeBase();
});
