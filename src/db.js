const path = require("path");
const fs = require("fs");
const { AsyncLocalStorage } = require("node:async_hooks");
const { DatabaseSync } = require("node:sqlite");
const { EventEmitter } = require("events");
const { carrierLabel } = require("./carrier");

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
// Chaque appareil abonne aux notifications a son propre "vu le" : le "+N"
// d'un telephone compte les colis arrives depuis que CE telephone a regarde,
// pas depuis que quelqu'un d'autre l'a fait. Les abonnements existants
// reprennent l'ancien "vu le" commun.
const pushColumns = db.prepare("PRAGMA table_info(push_subscriptions)").all().map((c) => c.name);
if (!pushColumns.includes("seen_at")) {
  db.exec("ALTER TABLE push_subscriptions ADD COLUMN seen_at TEXT");
  const ancien = db.prepare("SELECT value FROM settings WHERE key = 'push_seen_at'").get();
  db.prepare("UPDATE push_subscriptions SET seen_at = COALESCE(?, datetime('now'))").run(ancien ? ancien.value : null);
}
// le "+N" deja affiche sur l'appareil : sans hausse, pas de nouvelle sonnerie
if (!pushColumns.includes("announced")) {
  db.exec("ALTER TABLE push_subscriptions ADD COLUMN announced INTEGER NOT NULL DEFAULT 0");
}

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
// qui a imprime quoi : on est plusieurs a bosser dessus, et le menu de
// reimpression doit pouvoir le dire. print_job regroupe les etiquettes sorties
// dans une meme fournee.
if (!colisColumns.includes("printed_by")) db.exec("ALTER TABLE colis ADD COLUMN printed_by TEXT");
if (!colisColumns.includes("print_job")) db.exec("ALTER TABLE colis ADD COLUMN print_job TEXT");
// note libre posee avec /note : "fragile", "a deposer avant 14h", "client
// rappelle". Un colis annote passe en tete de la file d'impression et sort en
// rouge sur le site -- c'est tout l'interet d'en poser une.
if (!colisColumns.includes("note")) db.exec("ALTER TABLE colis ADD COLUMN note TEXT");
// Le message d'origine, pour un fichier envoye au bot en prive puis republie
// dans le groupe : chat_id/message_id pointent sur la copie, mais repondre
// /lit ou /normal au fichier qu'on vient d'envoyer doit marcher aussi.
if (!colisColumns.includes("source_chat_id")) db.exec("ALTER TABLE colis ADD COLUMN source_chat_id INTEGER");
if (!colisColumns.includes("source_message_id")) {
  db.exec("ALTER TABLE colis ADD COLUMN source_message_id INTEGER");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_colis_source ON colis(source_chat_id, source_message_id)");

// Paires code-barre + PDF du topic special : voir specials.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS paires_special (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero INTEGER NOT NULL,
    sender_name TEXT,
    colis_id INTEGER,
    code_file_id TEXT,
    code_chat_id INTEGER,
    code_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_paires_colis ON paires_special(colis_id);
`);
{
  const colonnes = db.prepare("PRAGMA table_info(paires_special)").all().map((c) => c.name);
  // le code qui ouvre le locker n'est pas toujours une image : parfois un PDF
  if (!colonnes.includes("code_file_kind")) db.exec("ALTER TABLE paires_special ADD COLUMN code_file_kind TEXT");
  // "seul" : un code qui n'attend aucun PDF (/special seul) ; "manuel" : une
  // paire reliee a la main, que le re-appairage automatique ne touche jamais
  if (!colonnes.includes("seul")) db.exec("ALTER TABLE paires_special ADD COLUMN seul INTEGER NOT NULL DEFAULT 0");
  if (!colonnes.includes("manuel")) db.exec("ALTER TABLE paires_special ADD COLUMN manuel INTEGER NOT NULL DEFAULT 0");
}

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

// --- Arrivees -----------------------------------------------------------------
// Chaque fichier recu par le bot est inscrit ici AVANT d'etre traite, et n'en
// sort qu'une fois traite. Avant, la file des fichiers a traiter ne vivait
// qu'en memoire : un redemarrage du serveur (chaque mise a jour) pendant un
// envoi de trente fichiers perdait ceux qui attendaient encore, alors que
// Telegram les considerait comme livres. Au demarrage, ce qui reste est repris
// dans l'ordre. Un meme message livre deux fois par Telegram n'est inscrit
// qu'une fois (cle chat + message). `colis_id` / `paire_id` : ce que le
// traitement a deja cree -- une reprise le reutilise au lieu d'en creer un
// second.
db.exec(`
  CREATE TABLE IF NOT EXISTS arrivees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'attente',
    colis_id INTEGER,
    paire_id INTEGER,
    essais INTEGER NOT NULL DEFAULT 0,
    erreur TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE (chat_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_arrivees_statut ON arrivees(statut);
`);

/** Inscrit un fichier recu ; renvoie son numero, ou null s'il l'etait deja. */
function inscritArrivee(chatId, messageId, message) {
  const info = db
    .prepare("INSERT OR IGNORE INTO arrivees (chat_id, message_id, message) VALUES (?, ?, ?)")
    .run(chatId, messageId, JSON.stringify(message));
  return info.changes ? Number(info.lastInsertRowid) : null;
}

function getArrivee(id) {
  return db.prepare("SELECT * FROM arrivees WHERE id = ?").get(id);
}

function arriveeLiee(id, { colisId, paireId } = {}) {
  if (colisId) db.prepare("UPDATE arrivees SET colis_id = ?, updated_at = datetime('now') WHERE id = ?").run(colisId, id);
  if (paireId) db.prepare("UPDATE arrivees SET paire_id = ?, updated_at = datetime('now') WHERE id = ?").run(paireId, id);
}

function arriveeFaite(id) {
  db.prepare("UPDATE arrivees SET statut = 'fait', erreur = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
}

/** Un essai rate : le compte monte ; `definitif` la sort de la file. */
function arriveeRatee(id, erreur, { definitif = false } = {}) {
  db.prepare(
    `UPDATE arrivees SET essais = essais + 1, erreur = ?, statut = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(String(erreur || "").slice(0, 300), definitif ? "echec" : "attente", id);
  return getArrivee(id);
}

function arriveesEnAttente() {
  return db.prepare("SELECT * FROM arrivees WHERE statut = 'attente' ORDER BY id").all();
}

// les arrivees traitees ne servent plus apres quelques jours
db.prepare("DELETE FROM arrivees WHERE statut != 'attente' AND created_at < datetime('now', '-7 days')").run();

// --- Journal -----------------------------------------------------------------
// Tout ce qui arrive aux colis, dans l'ordre : recus, dropes, imprimes, retires,
// changes de type, de prix ou de transporteur, notes, stock, tournees,
// paiements, expediteurs. Affiche tout en bas du dashboard (site et app).
// Ecrit ici, au plus pres des donnees : quel que soit le chemin (bot, site,
// app, impression auto), rien n'y echappe.
const journalExistait = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal'")
  .get();
db.exec(`
  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL,
    texte TEXT NOT NULL,
    detail TEXT,
    valeur REAL,
    nombre INTEGER,
    source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_journal_kind ON journal(kind);
`);

// D'ou vient l'action : le site, l'app, l'impression automatique (fixe par
// une couche de l'API), sinon le bot Telegram.
const contexteJournal = new AsyncLocalStorage();
function avecSource(source, fn) {
  return contexteJournal.run({ source }, fn);
}
function sourceCourante() {
  return contexteJournal.getStore()?.source || "telegram";
}

const TYPES_JOURNAL = { normal: "Normaux", lit: "LIT", bj: "Boîte jaune", special: "Spécial" };
const colisJournal = (c) => [c.sender_name, c.type === "bj" ? "BJ" : c.carrier ? carrierLabel(c.carrier) : null].filter(Boolean).join(" · ");

const euroJournal = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const euroTexte = (v) => euroJournal.format(Number(v) || 0).replace(/\u202f/g, "\u00a0");
const plurielJournal = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

function journalise(kind, texte, { detail = null, valeur = null, nombre = null } = {}) {
  try {
    db.prepare("INSERT INTO journal (kind, texte, detail, valeur, nombre, source) VALUES (?, ?, ?, ?, ?, ?)").run(
      kind,
      texte,
      detail,
      valeur,
      nombre,
      sourceCourante()
    );
  } catch (err) {
    // le journal ne doit jamais empecher une action d'aboutir
    console.error("[journal]", err.message);
  }
}

// Un lot de fichiers d'un meme expediteur arrive en rafale : une seule ligne
// "5 colis recus" plutot que cinq lignes, tant qu'ils se suivent de pres.
function journaliseRecu(colis) {
  const derniere = db
    .prepare(
      `SELECT * FROM journal WHERE id = (SELECT MAX(id) FROM journal)
       AND kind = 'recu' AND detail = ? AND source = ? AND at >= datetime('now', '-3 minutes')`
    )
    .get(colis.sender_name, sourceCourante());
  if (derniere) {
    const n = (derniere.nombre || 1) + 1;
    db.prepare("UPDATE journal SET nombre = ?, valeur = ?, texte = ?, at = datetime('now') WHERE id = ?").run(
      n,
      (derniere.valeur || 0) + colis.price,
      `${n} colis reçus`,
      derniere.id
    );
    return;
  }
  journalise("recu", "Colis reçu", { detail: colis.sender_name, valeur: colis.price, nombre: 1 });
}

// Une page du journal, du plus recent au plus ancien. `avant` : l'identifiant
// de la derniere ligne deja affichee (pour la suite).
const FILTRES_JOURNAL = {
  recu: "kind IN ('recu', 'ajout')",
  // une fin de tournee est un drop : elle y figure aussi
  drop: "(kind = 'drop' OR (kind = 'tournee' AND texte = 'Tournée terminée'))",
  impression: "kind = 'impression'",
  autres: "kind NOT IN ('recu', 'ajout', 'drop', 'impression') AND NOT (kind = 'tournee' AND texte = 'Tournée terminée')",
};

function getJournal({ avant = null, limite = 40, filtre = null } = {}) {
  const conditions = [];
  const params = [];
  if (avant) {
    conditions.push("id < ?");
    params.push(Number(avant));
  }
  if (FILTRES_JOURNAL[filtre]) conditions.push(FILTRES_JOURNAL[filtre]);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const n = Math.min(Math.max(Number(limite) || 40, 1), 200);
  const lignes = db
    .prepare(`SELECT id, at, kind, texte, detail, valeur, nombre, source FROM journal ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, n + 1);
  return { entrees: lignes.slice(0, n), suite: lignes.length > n };
}

// Premiere mise en place : le journal repart des 30 derniers jours deja en
// base (arrivees par lot, drops, fournees imprimees, tournees, paiements),
// pour ne pas commencer vide.
if (!journalExistait) {
  const depuis = "datetime('now', '-30 days')";
  db.exec(`
    INSERT INTO journal (at, kind, texte, detail, valeur, nombre, source)
    SELECT at, kind, texte, detail, valeur, nombre, source FROM (
      SELECT MAX(created_at) AS at, 'recu' AS kind,
             CASE WHEN COUNT(*) > 1 THEN COUNT(*) || ' colis reçus' ELSE 'Colis reçu' END AS texte,
             sender_name AS detail, SUM(price) AS valeur, COUNT(*) AS nombre, 'telegram' AS source
      FROM colis WHERE created_at >= ${depuis}
      GROUP BY sender_name, COALESCE(batch_id, id)
      UNION ALL
      SELECT dropped_at, 'drop',
             CASE WHEN COUNT(*) > 1 THEN COUNT(*) || ' colis dropés' ELSE 'Colis dropé' END,
             CASE WHEN COUNT(DISTINCT sender_name) = 1 THEN MAX(sender_name)
                  ELSE COUNT(DISTINCT sender_name) || ' expéditeurs' END,
             SUM(price), COUNT(*), NULL
      FROM colis WHERE status = 'dropped' AND dropped_at >= ${depuis}
      GROUP BY dropped_at
      UNION ALL
      SELECT MAX(printed_at), 'impression',
             CASE WHEN COUNT(*) > 1 THEN COUNT(*) || ' étiquettes imprimées' ELSE 'Étiquette imprimée' END,
             CASE WHEN MAX(printed_by) IS NOT NULL THEN 'par ' || MAX(printed_by) END,
             NULL, COUNT(*), NULL
      FROM colis WHERE print_job IS NOT NULL AND printed_at >= ${depuis}
      GROUP BY print_job
      UNION ALL
      SELECT ended_at, 'tournee', 'Tournée terminée',
             colis_count || ' colis · ' || CASE WHEN seconds < 3600 THEN MAX(1, seconds / 60) || ' min'
               ELSE (seconds / 3600) || ' h ' || printf('%02d', (seconds % 3600) / 60) END,
             value, colis_count, NULL
      FROM tours WHERE ended_at >= ${depuis}
      UNION ALL
      SELECT paid_at, 'paiement', 'Paiement enregistré', sender_name, SUM(price), COUNT(*), NULL
      FROM colis WHERE paid = 1 AND paid_at >= ${depuis}
      GROUP BY sender_name, paid_at
    ) ORDER BY at, kind
  `);
  const n = db.prepare("SELECT COUNT(*) AS c FROM journal").get().c;
  if (n) console.log(`[journal] ${n} evenements des 30 derniers jours repris`);
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
  return sender.price; // "special" suit le tarif normal
}

// Statut des anciennes images de "special", qui valaient 0 EUR. Depuis que le
// code-barre d'un locker n'est plus un colis du tout (voir specials.js), plus
// rien n'est cree avec ce statut ; il reste pour les lignes d'avant, qui
// sortent de tous les comptes puisque tout filtre sur status = 'pending'.
const FREE_STATUS = "free";

// Jour comptable : rien ne se poste le dimanche, donc l'argent fait ce jour-la
// est compte sur le lundi qui suit. La courbe quotidienne n'a d'ailleurs pas de
// colonne dimanche : sans ce report, ces gains disparaissaient purement et
// simplement des statistiques.
const BUSINESS_DAY_SQL =
  "date(dropped_at, CASE strftime('%w', dropped_at) WHEN '0' THEN '+1 day' ELSE '+0 day' END)";

// Deux stocks independants : les pochettes normales et les BJ ne se piochent
// pas dans le meme carton.
const STOCK_KEYS = { normal: "stock", bj: "stock_bj" };

function stockKey(kind) {
  return STOCK_KEYS[kind] || STOCK_KEYS.normal;
}

function getStock(kind = "normal") {
  return Number(getSetting(stockKey(kind), 0));
}

function getStocks() {
  return { normal: getStock("normal"), bj: getStock("bj") };
}

function adjustStock(delta, kind = "normal") {
  const next = getStock(kind) + Number(delta);
  setSetting(stockKey(kind), next);
  return next;
}

// Retire du stock ce qui vient d'etre drope, chaque type sur son propre
// compteur.
function consumeStock({ count = 0, bj = 0 } = {}) {
  const normal = count - bj;
  if (normal > 0) adjustStock(-normal, "normal");
  if (bj > 0) adjustStock(-bj, "bj");
  return getStocks();
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
  if (nextPrice !== current.price || nextLitPrice !== current.lit_price || nextBjPrice !== current.bj_price) {
    journalise("expediteur", `Tarifs de ${current.name}`, {
      detail: `${euroTexte(nextPrice)} · LIT ${euroTexte(nextLitPrice)} · BJ ${euroTexte(nextBjPrice)}`,
    });
  }

  return db.prepare("SELECT * FROM senders WHERE id = ?").get(id);
}

function createBatch(chatId) {
  const info = db.prepare("INSERT INTO batches (chat_id) VALUES (?)").run(chatId);
  return info.lastInsertRowid;
}

function addColis(
  senderName,
  {
    chatId,
    messageId,
    batchId,
    type = "normal",
    carrier = null,
    fileName,
    caption,
    fileId,
    fileKind,
    sourceChatId = null,
    sourceMessageId = null,
    journal = true,
  } = {}
) {
  const sender = getOrCreateSender(senderName);
  const price = priceForType(sender, type);
  const info = db
    .prepare(
      `INSERT INTO colis (sender_name, type, price, status, chat_id, message_id, batch_id, carrier,
                          file_name, caption, file_id, file_kind, source_chat_id, source_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sender.name,
      type,
      price,
      "pending",
      chatId || null,
      messageId || null,
      batchId || null,
      carrier || null,
      fileName || null,
      caption || null,
      fileId || null,
      fileKind || null,
      sourceChatId,
      sourceMessageId
    );
  const colis = {
    id: info.lastInsertRowid,
    sender_name: sender.name,
    price,
    type,
    carrier,
    status: "pending",
  };
  if (journal) journaliseRecu(colis);
  return colis;
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
// Les LIT ont leur propre file : colis trop gros pour l'imprimante thermique,
// ils sortent sur le rouleau 210 mm. Les deux files sont donc disjointes.
const HAS_FILE_SQL = "status = 'pending' AND file_id IS NOT NULL";
const PRINTABLE_SQL = `${HAS_FILE_SQL} AND type != 'lit'`;
const LIT_PRINTABLE_SQL = `${HAS_FILE_SQL} AND type = 'lit'`;

// Trois lectures de la file d'impression :
//   "new"     (defaut) ce qui n'est jamais sorti de l'imprimante. Imprimer
//             10 MR, en recevoir 2 et faire "tout" ne ressort que les 2 ;
//   "printed" ce qui est deja sorti, pour le menu de reimpression ;
//   "all"     les deux.
function printableScope(scope) {
  if (scope === "all") return PRINTABLE_SQL;
  if (scope === "printed") return `${PRINTABLE_SQL} AND printed_at IS NOT NULL`;
  return `${PRINTABLE_SQL} AND printed_at IS NULL`;
}

// Un colis annote sort le premier : la note dit qu'il y a quelque chose a
// faire avec celui-la, autant l'avoir en haut de la pile.
const PRINT_ORDER_SQL = "ORDER BY note IS NULL, id";

function getPrintableColis(carrier, { scope = "new" } = {}) {
  const base = `SELECT id, sender_name, file_id, file_kind, file_name, note, price, carrier, type,
                       ${PRINT_GROUP_SQL} AS carrier_group
                FROM colis WHERE ${printableScope(scope)}`;
  if (carrier === "SPECIAL") {
    // dans l'ordre de leur numero de paire : la liasse imprimee suit l'ordre
    // des codes-barres, 1, 2, 3... (les annotes restent devant)
    return db
      .prepare(
        `${base} AND type = 'special'
         ORDER BY note IS NULL,
                  COALESCE((SELECT p.numero FROM paires_special p WHERE p.colis_id = colis.id
                            ORDER BY p.id DESC LIMIT 1), 1000000),
                  id`
      )
      .all();
  }
  if (carrier === "BJ") return db.prepare(`${base} AND type = 'bj' ${PRINT_ORDER_SQL}`).all();
  // un special ou une BJ a aussi un transporteur, mais il est deja range
  // dans sa propre categorie : il ne doit pas sortir une deuxieme fois ici
  const ailleurs = "type NOT IN ('bj', 'special')";
  if (carrier === "Inconnu") {
    return db.prepare(`${base} AND ${ailleurs} AND carrier IS NULL ${PRINT_ORDER_SQL}`).all();
  }
  return db.prepare(`${base} AND ${ailleurs} AND carrier = ? ${PRINT_ORDER_SQL}`).all(carrier);
}

// File d'impression des LIT, meme logique de scope que la file thermique.
function litScope(scope) {
  if (scope === "all") return LIT_PRINTABLE_SQL;
  if (scope === "printed") return `${LIT_PRINTABLE_SQL} AND printed_at IS NOT NULL`;
  return `${LIT_PRINTABLE_SQL} AND printed_at IS NULL`;
}

function getLitPrintable({ scope = "new" } = {}) {
  return db
    .prepare(
      `SELECT id, sender_name, file_id, file_kind, file_name, note, price, carrier, type, 'LIT' AS carrier_group
       FROM colis WHERE ${litScope(scope)} ${PRINT_ORDER_SQL}`
    )
    .all();
}

function countLitPrintable({ scope = "new" } = {}) {
  return db.prepare(`SELECT COUNT(*) AS c FROM colis WHERE ${litScope(scope)}`).get().c;
}

// Combien de colis annotes par LIT : le site signale la categorie en rouge
// sans avoir a la deplier.
function countLitNoted({ scope = "new" } = {}) {
  return db.prepare(`SELECT COUNT(*) AS c FROM colis WHERE ${litScope(scope)} AND note IS NOT NULL`)
    .get().c;
}

// Combien d'etiquettes en attente ont deja ete imprimees une fois : sert a
// proposer (ou non) la reimpression.
function countAlreadyPrinted() {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM colis WHERE ${PRINTABLE_SQL} AND printed_at IS NOT NULL`)
    .get().c;
}

// Repartition des etiquettes imprimables (celles dont on a encore le fichier).
function getPrintableSummary({ scope = "new" } = {}) {
  return db
    .prepare(
      `SELECT ${PRINT_GROUP_SQL} AS carrier, COUNT(*) AS count,
              SUM(note IS NOT NULL) AS noted
       FROM colis WHERE ${printableScope(scope)}
       GROUP BY ${PRINT_GROUP_SQL} ORDER BY noted DESC, count DESC`
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

// La file d'impression range en plus les speciaux a part, comme les LIT : on
// veut pouvoir les sortir seuls. Seulement ici -- sur le dashboard, un special
// reste range sous son transporteur, puisque c'est la qu'on le poste.
const PRINT_GROUP_SQL = `CASE WHEN type = 'special' THEN 'SPECIAL' ELSE ${CARRIER_GROUP_SQL} END`;

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
  journalise("tournee", "Sac vide : tournée refermée");
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

// Signale les colis qui viennent de passer en drope, d'ou que vienne le drop
// (site, fin de tournee, bouton Telegram) : le bot ecoute pour remettre
// "Drope" sous leurs fichiers. Un seul point d'emission, ici, plutot qu'un
// rappel a ne pas oublier dans chaque route.
const evenements = new EventEmitter();

// Un drop groupe (tout, tout sauf les LIT, un transporteur, un expediteur, la
// fin de tournee) ne solde que ce qui est pret a partir : les etiquettes deja
// imprimees, et les colis sans fichier (comptes a la main : rien a imprimer).
// Une etiquette qui n'est jamais sortie de l'imprimante ne peut pas etre dans
// le sac : elle reste en attente, et la reponse dit combien (`restants`).
const PRET_SQL = "(printed_at IS NOT NULL OR file_id IS NULL)";

// Toutes les operations de drop renvoient { count, bj, value, restants } : le
// stock normal et le stock BJ se decrementent separement.
function dropWhere(extraSql, extraParams = [], { libelle = "", finDeTournee = false } = {}) {
  const { clause, params } = tourScope();
  const tous = `status = 'pending'${extraSql}${clause}`;
  const where = `${tous} AND ${PRET_SQL}`;
  const args = [...extraParams, ...params];

  // les identifiants avant la mise a jour : apres, plus rien ne les distingue
  // des colis dropes avant. Les lectures se suivent sans rien entre elles.
  const ids = db.prepare(`SELECT id FROM colis WHERE ${where}`).all(...args).map((r) => r.id);
  const bj = db.prepare(`SELECT COUNT(*) AS c FROM colis WHERE ${where} AND type = 'bj'`).get(...args).c;
  const value = db.prepare(`SELECT COALESCE(SUM(price), 0) AS v FROM colis WHERE ${where}`).get(...args).v;
  const restants = db.prepare(`SELECT COUNT(*) AS c FROM colis WHERE ${tous} AND NOT ${PRET_SQL}`).get(...args).c;
  const info = db
    .prepare(`UPDATE colis SET status = 'dropped', dropped_at = datetime('now') WHERE ${where}`)
    .run(...args);

  const resteTexte = restants
    ? plurielJournal(restants, "colis pas encore imprimé reste", "colis pas encore imprimés restent")
    : null;
  if (!finDeTournee) {
    if (info.changes > 0) {
      journalise("drop", info.changes > 1 ? `${info.changes} colis dropés` : "Colis dropé", {
        detail: [libelle, resteTexte].filter(Boolean).join(" · ") || null,
        valeur: value,
        nombre: info.changes,
      });
    } else if (restants > 0) {
      journalise("drop", "Rien de dropé", { detail: [libelle, resteTexte].filter(Boolean).join(" · ") });
    }
    endTourIfEmpty();
  }
  if (ids.length) evenements.emit("dropes", ids);
  return { count: info.changes, bj, value, restants };
}

function dropByCarrier(carrier) {
  const libelle = carrier === "Inconnu" ? "Transporteur inconnu" : carrierLabel(carrier);
  if (carrier === "BJ") return dropWhere(" AND type = 'bj'", [], { libelle: "Boîte jaune" });
  if (carrier === "Inconnu") return dropWhere(" AND type != 'bj' AND carrier IS NULL", [], { libelle });
  return dropWhere(" AND type != 'bj' AND carrier = ?", [carrier], { libelle });
}

// Drop de tous les colis du sac (ou de tout ce qui est en attente hors
// tournee). `finDeTournee` : la route de fin de tournee ecrit elle-meme son
// resume au journal et referme la tournee.
function dropAll({ finDeTournee = false } = {}) {
  return dropWhere("", [], { libelle: "Tout", finDeTournee });
}

// Les LIT partent sur une autre imprimante et souvent un autre jour : pouvoir
// solder le reste sans les emporter evite de les marquer dropes avant l'heure.
function dropAllExceptLit() {
  return dropWhere(" AND type != 'lit'", [], { libelle: "Tout sauf les LIT" });
}

function dropBySender(name) {
  return dropWhere(" AND sender_name = ?", [name], { libelle: name });
}

// Drop d'un seul colis, depuis la liste du site.
function dropColis(id) {
  const colis = db.prepare("SELECT * FROM colis WHERE id = ? AND status = 'pending'").get(id);
  if (!colis) return null;
  db.prepare("UPDATE colis SET status = 'dropped', dropped_at = datetime('now') WHERE id = ?").run(id);
  journalise("drop", "Colis dropé", { detail: colisJournal(colis), valeur: colis.price, nombre: 1 });
  endTourIfEmpty();
  evenements.emit("dropes", [colis.id]);
  return { count: 1, bj: colis.type === "bj" ? 1 : 0 };
}

// Annule le drop d'un colis (re-appui sur "Drope" sous son fichier) : il
// repasse en attente comme s'il n'etait jamais parti, et revient dans la file
// d'impression s'il n'avait pas ete imprime. Un colis deja paye reste drope :
// son argent est deja compte. Renvoie { count, bj } pour rendre le stock.
function undropColis(id) {
  const colis = db.prepare("SELECT * FROM colis WHERE id = ? AND status = 'dropped'").get(id);
  if (!colis) return null;
  if (colis.paid) return { paye: true };
  db.prepare("UPDATE colis SET status = 'pending', dropped_at = NULL WHERE id = ?").run(id);
  journalise("drop", "Drop annulé : colis remis en attente", { detail: colisJournal(colis), nombre: 1 });
  evenements.emit("remis", [colis.id]);
  return { count: 1, bj: colis.type === "bj" ? 1 : 0 };
}

// Rend au stock les pochettes d'un drop annule.
function restoreStock({ count = 0, bj = 0 } = {}) {
  const normal = count - bj;
  if (normal > 0) adjustStock(normal, "normal");
  if (bj > 0) adjustStock(bj, "bj");
  return getStocks();
}

// Les images de "special" ont le statut "free" : elles ne comptent nulle part,
// mais on doit pouvoir les retirer comme les autres.
const VIVANT_SQL = `status IN ('pending', '${FREE_STATUS}')`;

// Un message designe un colis de deux facons : c'est sa copie dans le groupe,
// ou c'est le fichier d'origine envoye au bot en prive. Les deux doivent
// repondre a /lit, /normal, /note... sinon repondre a son propre envoi en prive
// ne trouve rien.
const PAR_MESSAGE_SQL =
  "((chat_id = ? AND message_id = ?) OR (source_chat_id = ? AND source_message_id = ?))";

function findColisByMessage(chatId, messageId) {
  return db
    .prepare(`SELECT * FROM colis WHERE ${PAR_MESSAGE_SQL} AND ${VIVANT_SQL} ORDER BY id DESC`)
    .get(chatId, messageId, chatId, messageId);
}

// Sans filtre de statut : /note doit marcher meme sur un colis deja drope.
function findAnyColisByMessage(chatId, messageId) {
  return db
    .prepare(`SELECT * FROM colis WHERE ${PAR_MESSAGE_SQL} ORDER BY id DESC`)
    .get(chatId, messageId, chatId, messageId);
}

// Le dernier lot vu depuis un chat. Un fichier envoye en prive est republie
// dans le groupe et son lot y est rattache : depuis le prive, le dernier lot
// est donc celui du dernier fichier qu'on y a envoye, pas un lot "du prive"
// qui n'existe plus. Sans ca, /litall ou /prix sans reponse tapes en prive
// ne trouvaient rien. C'est bien le lot du DERNIER fichier : un envoi mixte
// ouvre un lot par topic, et le plus grand numero de lot n'est pas forcement
// celui qu'on vient de toucher.
function getLatestBatchId(chatId) {
  const row = db
    .prepare(
      `SELECT COALESCE(
         (SELECT batch_id FROM colis WHERE source_chat_id = ? AND batch_id IS NOT NULL ORDER BY id DESC LIMIT 1),
         (SELECT id FROM batches WHERE chat_id = ? ORDER BY id DESC LIMIT 1)
       ) AS id`
    )
    .get(chatId, chatId);
  return row && row.id ? row.id : null;
}

function setColisType(id, type) {
  const colis = db.prepare(`SELECT * FROM colis WHERE id = ? AND ${VIVANT_SQL}`).get(id);
  if (!colis) return null;

  const price = priceForType(getOrCreateSender(colis.sender_name), type);
  const status = "pending";

  // changer de type reapplique le tarif de l'expediteur, meme si un prix avait
  // ete fixe manuellement
  db.prepare(
    "UPDATE colis SET type = ?, price = ?, status = ?, price_locked = 0 WHERE id = ?"
  ).run(type, price, status, id);
  if (colis.type !== type) {
    journalise("modif", `Colis passé en ${TYPES_JOURNAL[type] || type}`, { detail: colisJournal(colis), valeur: price, nombre: 1 });
  }
  return { ...colis, type, price, status };
}

// Un colis deplace change de message : /del et les boutons doivent agir sur le
// nouveau, pas sur celui qui vient d'etre efface.
function setColisMessage(id, chatId, messageId) {
  db.prepare("UPDATE colis SET chat_id = ?, message_id = ? WHERE id = ?").run(chatId, messageId, id);
  return db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
}

// `journal` : un transporteur choisi a la main (commande, bouton) ; une
// reconnaissance automatique ne remplit pas l'historique.
function setColisCarrier(id, carrier, { journal = false } = {}) {
  db.prepare("UPDATE colis SET carrier = ? WHERE id = ?").run(carrier, id);
  const colis = db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
  if (journal && colis) {
    journalise("modif", carrier ? `Transporteur : ${carrierLabel(carrier)}` : "Transporteur retiré", { detail: colis.sender_name, nombre: 1 });
  }
  return colis;
}

// Applique un transporteur a tout un lot (commande /transporteur sans reponse
// a un colis precis).
function setBatchCarrier(batchId, carrier) {
  const n = db
    .prepare("UPDATE colis SET carrier = ? WHERE batch_id = ? AND status = 'pending'")
    .run(carrier, batchId).changes;
  if (n) journalise("modif", `${plurielJournal(n, "colis", "colis")} → ${carrierLabel(carrier)}`, { nombre: n });
  return n;
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
  const avant = isAutoPrintEnabled();
  if (enabled && !avant) markPendingAsPrinted();
  setSetting("auto_print", enabled ? "1" : "0");
  if (avant !== Boolean(enabled)) journalise("reglage", enabled ? "Impression auto activée" : "Impression auto désactivée");
  return isAutoPrintEnabled();
}

function markPendingAsPrinted() {
  const n = db
    .prepare(`UPDATE colis SET printed_at = datetime('now') WHERE ${AUTOPRINT_SQL}`)
    .run().changes;
  if (n) {
    journalise("impression", `${plurielJournal(n, "étiquette considérée", "étiquettes considérées")} comme imprimée${n > 1 ? "s" : ""}`, {
      detail: "à l'activation de l'impression auto",
      nombre: n,
    });
  }
  return n;
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

// Marque une fournee comme imprimee. `by` est le nom affiche dans le menu de
// reimpression ("Flo", "Impression auto"...). Renvoie l'identifiant de la
// fournee, qui permet de la reimprimer telle quelle.
function markPrinted(ids, by = null) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const job = require("crypto").randomBytes(6).toString("hex");
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE colis SET printed_at = datetime('now'), printed_by = ?, print_job = ?
     WHERE id IN (${placeholders})`
  ).run(by, job, ...ids);
  // ce que contient la fournee : "Mondial Relay ×6, UPS ×3"
  const groupes = db
    .prepare(
      `SELECT CASE WHEN type = 'lit' THEN 'LIT' ELSE ${PRINT_GROUP_SQL} END AS g, COUNT(*) AS c
       FROM colis WHERE id IN (${placeholders}) GROUP BY g ORDER BY c DESC`
    )
    .all(...ids)
    .map((r) => `${r.g === "LIT" ? "LIT" : carrierLabel(r.g)} ×${r.c}`)
    .join(", ");
  journalise("impression", ids.length > 1 ? `${ids.length} étiquettes imprimées` : "Étiquette imprimée", {
    detail: [by ? `par ${by}` : null, groupes].filter(Boolean).join(" · "),
    nombre: ids.length,
  });
  return job;
}

// Fournees deja imprimees encore en attente de depot : qui, quand, combien et
// pour quelles compagnies.
function getPrintJobs(limit = 8) {
  return db
    .prepare(
      `SELECT print_job AS job,
              MAX(printed_at) AS printed_at,
              COALESCE(printed_by, 'Inconnu') AS printed_by,
              COUNT(*) AS count,
              MAX(CASE WHEN type = 'lit' THEN 1 ELSE 0 END) AS lit,
              GROUP_CONCAT(DISTINCT CASE WHEN type = 'lit' THEN 'LIT' ELSE ${PRINT_GROUP_SQL} END) AS carriers
       FROM colis
       WHERE ${HAS_FILE_SQL} AND print_job IS NOT NULL
       GROUP BY print_job
       ORDER BY printed_at DESC
       LIMIT ?`
    )
    .all(limit);
}

function getPrintJobColis(job) {
  return db
    .prepare(
      `SELECT id, sender_name, file_id, file_kind, file_name, type,
              CASE WHEN type = 'lit' THEN 'LIT' ELSE ${PRINT_GROUP_SQL} END AS carrier_group
       FROM colis WHERE ${HAS_FILE_SQL} AND print_job = ? ORDER BY id`
    )
    .all(job);
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
  journalise("retrait", "Colis retiré du suivi", { detail: colisJournal(colis), valeur: colis.price, nombre: 1 });
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
  const colis = db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
  journalise("modif", `Prix forcé à ${euroTexte(price)}`, { detail: colisJournal(colis), nombre: 1 });
  return colis;
}

function setBatchPrice(batchId, price) {
  const info = db
    .prepare("UPDATE colis SET price = ?, price_locked = 1 WHERE batch_id = ? AND status = 'pending'")
    .run(price, batchId);
  if (info.changes) journalise("modif", `${plurielJournal(info.changes, "colis", "colis")} à ${euroTexte(price)}`, { nombre: info.changes });
  return info.changes;
}

// --- Notes -------------------------------------------------------------------
// /note pose un mot sur un colis. Contrairement au prix, une note s'applique
// aussi a un colis deja drope ou deja imprime : "le client rappelle" reste
// vrai apres coup. Une note vide efface la note.
function setColisNote(id, note) {
  const propre = (note || "").trim() || null;
  const info = db.prepare("UPDATE colis SET note = ? WHERE id = ?").run(propre, id);
  if (info.changes === 0) return null;
  const colis = db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
  journalise("note", propre ? `Note « ${propre.slice(0, 80)} »` : "Note effacée", { detail: colisJournal(colis), nombre: 1 });
  return colis;
}

function setBatchNote(batchId, note) {
  const propre = (note || "").trim() || null;
  const n = db.prepare("UPDATE colis SET note = ? WHERE batch_id = ?").run(propre, batchId).changes;
  if (n) journalise("note", propre ? `Note « ${propre.slice(0, 80)} »` : "Notes effacées", { detail: plurielJournal(n, "colis", "colis"), nombre: n });
  return n;
}

// +n colis a la main, en une fois (plusieurs appuis rapides)
function quickAddColis(senderName, n = 1) {
  let colis = null;
  let valeur = 0;
  for (let i = 0; i < n; i++) {
    colis = addColis(senderName, { journal: false });
    valeur += colis.price;
  }
  journalise("ajout", `+${n} colis à la main`, { detail: colis.sender_name, valeur, nombre: n });
  return colis;
}

// -n colis a la main : les plus recents de l'expediteur. Renvoie combien ont
// ete retires (0 : aucun en attente).
function quickRemoveColis(senderName, n = 1) {
  const lignes = db
    .prepare("SELECT id, price, sender_name FROM colis WHERE sender_name = ? AND status = 'pending' ORDER BY id DESC LIMIT ?")
    .all(senderName, n);
  if (!lignes.length) return 0;
  const supprime = db.prepare("DELETE FROM colis WHERE id = ?");
  for (const l of lignes) supprime.run(l.id);
  journalise("retrait", `−${lignes.length} colis à la main`, {
    detail: senderName,
    valeur: lignes.reduce((s, l) => s + l.price, 0),
    nombre: lignes.length,
  });
  return lignes.length;
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
      `SELECT ${BUSINESS_DAY_SQL} AS d, SUM(price) AS value, COUNT(*) AS count
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
  // Une seule lecture, jour par jour, repartie ensuite dans les semaines. Une
  // requete par semaine relisait toute la table a chaque fois : 26 semaines,
  // 26 lectures completes -- l'appel le plus lent du site.
  const parJour = db
    .prepare(
      `SELECT ${BUSINESS_DAY_SQL} AS d, SUM(price) AS value, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' AND ${BUSINESS_DAY_SQL} BETWEEN ? AND ?
       GROUP BY d`
    )
    .all(capped[0].start, capped[capped.length - 1].end);
  const weeks = capped.map((w) => ({ start: w.start, end: w.end, value: 0, count: 0 }));
  for (const jour of parJour) {
    // les semaines sont triees et disjointes : on cherche celle du jour
    const semaine = weeks.find((w) => jour.d >= w.start && jour.d <= w.end);
    if (!semaine) continue;
    semaine.value += jour.value || 0;
    semaine.count += jour.count || 0;
  }
  return { weeks };
}

function getBestDay() {
  return db
    .prepare(
      `SELECT ${BUSINESS_DAY_SQL} AS date, SUM(price) AS value, COUNT(*) AS count
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
  const du = db
    .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(price), 0) AS v FROM colis WHERE sender_name = ? AND status = 'dropped' AND paid = 0")
    .get(senderName);
  if (du.c) journalise("paiement", "Paiement enregistré", { detail: `${senderName} · ${plurielJournal(du.c, "colis", "colis")}`, valeur: du.v, nombre: du.c });
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
  // une seule lecture groupee plutot que deux sous-requetes par expediteur
  const rows = db
    .prepare(
      `SELECT s.id, s.name, COALESCE(t.ca, 0) AS ca, COALESCE(t.colisCount, 0) AS colisCount
       FROM senders s
       LEFT JOIN (
         SELECT sender_name,
                SUM(CASE WHEN status = 'dropped' THEN price ELSE 0 END) AS ca,
                COUNT(*) AS colisCount
         FROM colis GROUP BY sender_name
       ) t ON t.sender_name = s.name
       WHERE s.name != 'Autre' ORDER BY s.name ASC`
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
  const noms = [];

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
    noms.push(sender.name);
  }
  if (merged) {
    journalise("expediteur", `${plurielJournal(merged, "expéditeur regroupé", "expéditeurs regroupés")} dans « Autre »`, {
      detail: noms.join(", ").slice(0, 200),
      nombre: merged,
    });
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
  journalise("expediteur", `${source.name} fusionné dans ${target.name}`, { detail: plurielJournal(moved, "colis déplacé", "colis déplacés"), nombre: moved });
  return { moved, source: source.name, target: target.name };
}

// Cet appareil vient de regarder le dashboard : son "+N" repart de zero. Les
// autres appareils gardent le leur. Sert aussi a cumuler : tant que cet
// appareil n'a pas regarde, le "+N" compte tous les colis arrives depuis, pas
// seulement le dernier lot.
function markPushSeen(endpoint) {
  if (!endpoint) return 0;
  return db
    .prepare("UPDATE push_subscriptions SET seen_at = datetime('now'), announced = 0 WHERE endpoint = ?")
    .run(endpoint).changes;
}

// Le "+N" que cet appareil affiche desormais.
function setPushAnnounced(endpoint, count) {
  db.prepare("UPDATE push_subscriptions SET announced = ? WHERE endpoint = ?").run(count, endpoint);
}

// Colis enregistres depuis la derniere consultation du site.
function countColisSince(since) {
  if (!since) return null;
  return db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE created_at > ?")
    .get(since);
}

// Le detail des colis arrives depuis `since` (ou, faute de date, des
// `dernier` derniers) : nombre, valeur, et qui les a envoyes.
function summarizeNewColis({ since = null, dernier = 0 } = {}) {
  const lignes = since
    ? db.prepare("SELECT sender_name, price FROM colis WHERE created_at > ?").all(since)
    : db.prepare("SELECT sender_name, price FROM colis ORDER BY id DESC LIMIT ?").all(Math.max(0, dernier));
  const parExpediteur = new Map();
  let value = 0;
  for (const l of lignes) {
    value += l.price;
    parExpediteur.set(l.sender_name, (parExpediteur.get(l.sender_name) || 0) + 1);
  }
  const senders = [...parExpediteur.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { count: lignes.length, value, senders };
}

// --- Notifications push (PWA iOS/Android) -----------------------------------
// Un abonnement = un appareil. iOS peut le revoquer silencieusement, donc le
// client se reabonne a chaque ouverture et on supprime les endpoints morts
// des que le service de push repond 404/410.
function saveSubscription({ endpoint, keys, label }) {
  // un nouvel appareil part de maintenant ; un appareil qui se reabonne
  // garde son "vu le"
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, seen_at)
     VALUES (?, ?, ?, ?, datetime('now'))
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
    .prepare("SELECT endpoint, p256dh, auth, seen_at, announced FROM push_subscriptions")
    .all()
    .map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth }, seenAt: r.seen_at, announced: r.announced }));
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
  if (count) journalise("modif", `${plurielJournal(count, "colis passé", "colis passés")} en ${TYPES_JOURNAL[type] || type}`, { nombre: count });
  return count;
}

module.exports = {
  db,
  evenements,
  inscritArrivee,
  getArrivee,
  arriveeLiee,
  arriveeFaite,
  arriveeRatee,
  arriveesEnAttente,
  journalise,
  avecSource,
  getJournal,
  undropColis,
  restoreStock,
  getOrCreateSender,
  updateSenderPrices,
  addColis,
  getCarrierSummary,
  dropByCarrier,
  dropAll,
  dropAllExceptLit,
  dropBySender,
  dropColis,
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
  findAnyColisByMessage,
  FREE_STATUS,
  getLatestBatchId,
  setColisType,
  setBatchType,
  setColisPrice,
  setColisCarrier,
  setColisMessage,
  saveCarrierRule,
  getCarrierRules,
  listCarrierRules,
  clearCarrierRules,
  getUnclassifiedPending,
  getPrintableColis,
  getPrintableSummary,
  countAlreadyPrinted,
  getLitPrintable,
  countLitPrintable,
  countLitNoted,
  isAutoPrintEnabled,
  setAutoPrintEnabled,
  getUnprintedLabels,
  countUnprintedLabels,
  markPrinted,
  getPrintJobs,
  getPrintJobColis,
  getPrintToken,
  setBatchCarrier,
  getColisById,
  getBatchColis,
  deleteColis,
  setBatchPrice,
  setColisNote,
  setBatchNote,
  quickAddColis,
  quickRemoveColis,
  getDailySeries,
  getWeeklySeries,
  getBestDay,
  getDebtsBySender,
  markSenderPaid,
  getStock,
  getStocks,
  adjustStock,
  consumeStock,
  getPendingSummary,
  getStatsMessageId,
  setStatsMessageId,
  getMergeCandidates,
  mergeSendersIntoOther,
  mergeSenderInto,
  getSetting,
  setSetting,
  markPushSeen,
  setPushAnnounced,
  countColisSince,
  summarizeNewColis,
  saveSubscription,
  deleteSubscription,
  listSubscriptions,
  countSubscriptions,
  DEFAULT_PRICE,
  DEFAULT_LIT_PRICE,
  DEFAULT_BJ_PRICE,
};
