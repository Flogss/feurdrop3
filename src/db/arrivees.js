// Les fichiers recus par le bot, inscrits AVANT d'etre traites (voir la
// migration 2) : un redemarrage en plein envoi ne perd plus rien.
const { db } = require("./connexion");

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

module.exports = {
  inscritArrivee,
  getArrivee,
  arriveeLiee,
  arriveeFaite,
  arriveeRatee,
  arriveesEnAttente,
};
