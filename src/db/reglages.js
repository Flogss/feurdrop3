// Reglages et compteurs gardes dans la table settings : stocks de pochettes,
// message de stats du groupe, jeton de l'agent d'impression.
const { db } = require("./connexion");

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

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

function getStatsMessageId(key) {
  const value = getSetting(`stats_msg_${key}`, null);
  return value ? Number(value) : null;
}

function setStatsMessageId(key, messageId) {
  setSetting(`stats_msg_${key}`, messageId);
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
    console.log("[print] nouveau jeton de l'agent d'impression genere : npm run jeton-impression pour l'afficher");
  }
  return token;
}

module.exports = {
  getSetting,
  setSetting,
  STOCK_KEYS,
  stockKey,
  getStock,
  getStocks,
  adjustStock,
  consumeStock,
  getStatsMessageId,
  setStatsMessageId,
  getPrintToken,
};
