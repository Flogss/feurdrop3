// Colis : arrivee, lots, transporteurs appris, modifications, ajouts et
// retraits a la main.
const { db, transaction } = require("./connexion");
const { journalise, journaliseRecu, colisJournal, euroTexte, plurielJournal, TYPES_JOURNAL } = require("./journal");
const { getOrCreateSender } = require("./expediteurs");
const { priceForType, arrondiCentimes } = require("./montants");
const { VIVANT_SQL, PAR_MESSAGE_SQL } = require("./sql");
const { carrierLabel } = require("../carrier");

function getPendingSummary() {
  const row = db
    .prepare("SELECT COUNT(*) AS count, ROUND(COALESCE(SUM(price), 0), 2) AS value FROM colis WHERE status = 'pending'")
    .get();
  return { count: row.count, value: row.value };
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

function setColisPrice(id, prix) {
  const price = arrondiCentimes(prix);
  const info = db
    .prepare("UPDATE colis SET price = ?, price_locked = 1 WHERE id = ? AND status = 'pending'")
    .run(price, id);
  if (info.changes === 0) return null;
  const colis = db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
  journalise("modif", `Prix forcé à ${euroTexte(price)}`, { detail: colisJournal(colis), nombre: 1 });
  return colis;
}

function setBatchPrice(batchId, prix) {
  const price = arrondiCentimes(prix);
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

// +n colis a la main, en une fois (plusieurs appuis rapides). Tout ou rien :
// une erreur au milieu n'en laisse pas la moitie (la cle d'idempotence de la
// requete est alors liberee, et un nouvel essai refait les n).
function quickAddColis(senderName, n = 1) {
  return transaction(() => {
    let colis = null;
    let valeur = 0;
    for (let i = 0; i < n; i++) {
      colis = addColis(senderName, { journal: false });
      valeur += colis.price;
    }
    journalise("ajout", `+${n} colis à la main`, { detail: colis.sender_name, valeur: arrondiCentimes(valeur), nombre: n });
    return colis;
  });
}

// -n colis a la main : uniquement des colis COMPTES a la main (sans fichier),
// les plus recents d'abord. Une vraie etiquette recue sur Telegram n'est
// jamais retiree par le bouton « − » : elle sortirait de la file d'impression
// alors que son fichier reste dans le groupe. Elle se retire avec /del, Clean,
// Del, ou la corbeille de l'onglet Imprime. Renvoie combien ont ete retires
// (0 : aucun colis a la main en attente).
function quickRemoveColis(senderName, n = 1) {
  return transaction(() => {
    const lignes = db
      .prepare(
        `SELECT id, price, sender_name FROM colis
         WHERE sender_name = ? AND status = 'pending' AND file_id IS NULL
         ORDER BY id DESC LIMIT ?`
      )
      .all(senderName, n);
    if (!lignes.length) return 0;
    const supprime = db.prepare("DELETE FROM colis WHERE id = ? AND file_id IS NULL");
    for (const l of lignes) supprime.run(l.id);
    journalise("retrait", `−${lignes.length} colis à la main`, {
      detail: senderName,
      valeur: arrondiCentimes(lignes.reduce((s, l) => s + l.price, 0)),
      nombre: lignes.length,
    });
    return lignes.length;
  });
}

// Colis enregistres depuis la derniere consultation du site.
function countColisSince(since) {
  if (!since) return null;
  return db
    .prepare("SELECT COUNT(*) AS count, ROUND(COALESCE(SUM(price), 0), 2) AS value FROM colis WHERE created_at > ?")
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
  return { count: lignes.length, value: arrondiCentimes(value), senders };
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
  getPendingSummary,
  createBatch,
  addColis,
  saveCarrierRule,
  getCarrierRules,
  listCarrierRules,
  clearCarrierRules,
  getUnclassifiedPending,
  findColisByMessage,
  findAnyColisByMessage,
  getLatestBatchId,
  setColisType,
  setColisMessage,
  setColisCarrier,
  setBatchCarrier,
  deleteColis,
  getBatchColis,
  getColisById,
  setColisPrice,
  setBatchPrice,
  setColisNote,
  setBatchNote,
  quickAddColis,
  quickRemoveColis,
  countColisSince,
  summarizeNewColis,
  setBatchType,
};
