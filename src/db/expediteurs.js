// Expediteurs : creation, tarifs, dettes, fusions.
const { db, transaction } = require("./connexion");
const { journalise, euroTexte, plurielJournal } = require("./journal");
const { arrondiCentimes, DEFAULT_PRICE, DEFAULT_LIT_PRICE, DEFAULT_BJ_PRICE } = require("./montants");

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

  const nextPrice = price === undefined ? current.price : arrondiCentimes(price);
  const nextLitPrice = litPrice === undefined ? current.lit_price : arrondiCentimes(litPrice);
  const nextBjPrice = bjPrice === undefined ? current.bj_price : arrondiCentimes(bjPrice);
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

function getDebtsBySender() {
  return db
    .prepare(
      `SELECT sender_name, ROUND(SUM(price), 2) AS owed, COUNT(*) AS count
       FROM colis WHERE status = 'dropped' AND paid = 0
       GROUP BY sender_name HAVING owed > 0 ORDER BY owed DESC`
    )
    .all();
}

function markSenderPaid(senderName) {
  const du = db
    .prepare("SELECT COUNT(*) AS c, ROUND(COALESCE(SUM(price), 0), 2) AS v FROM colis WHERE sender_name = ? AND status = 'dropped' AND paid = 0")
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
  return db.prepare("SELECT ROUND(COALESCE(SUM(price), 0), 2) AS t FROM colis WHERE status = 'dropped'").get().t;
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
                ROUND(SUM(CASE WHEN status = 'dropped' THEN price ELSE 0 END), 2) AS ca,
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
// meme si la liste envoyee par le client est perimee). Tout ou rien : une
// erreur en cours de route laisse chaque expediteur comme il etait.
function mergeSendersIntoOther(senderIds) {
  return transaction(() => {
    const total = getTotalRevenue();
    const other = getOrCreateSender("Autre");
    let merged = 0;
    const noms = [];

    for (const id of senderIds) {
      const sender = db.prepare("SELECT * FROM senders WHERE id = ?").get(id);
      if (!sender || sender.name === "Autre") continue;
      const ca = db
        .prepare("SELECT ROUND(COALESCE(SUM(price), 0), 2) AS t FROM colis WHERE sender_name = ? AND status = 'dropped'")
        .get(sender.name).t;
      const pct = total > 0 ? ca / total : 0;
      if (pct > MERGE_SAFETY_THRESHOLD) continue;

      deplaceExpediteur(sender.name, other.name);
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
  });
}

// Tout ce qui porte le nom d'un expediteur passe sous un autre nom : ses
// colis, et ses paires du topic special -- sans quoi un code-barre en attente
// de son PDF ne retrouverait plus son colis (l'appairage se fait par
// expediteur). Les numeros des paires sont uniques pour tous les expediteurs :
// les regrouper ne cree aucun doublon.
function deplaceExpediteur(source, cible) {
  const moved = db.prepare("UPDATE colis SET sender_name = ? WHERE sender_name = ?").run(cible, source).changes;
  db.prepare("UPDATE paires_special SET sender_name = ? WHERE sender_name = ?").run(cible, source);
  return moved;
}

// Fusionne un expediteur dans un autre (cas typique : la meme personne a
// recree un compte Telegram). Tous les colis - dropes comme en attente -
// passent sous le nom cible, puis l'expediteur source est supprime. Le seuil
// de securite de "Autre" ne s'applique pas ici : c'est un choix explicite et
// rien n'est perdu, tout est deplace vers un expediteur existant. Tout ou
// rien, comme ci-dessus.
function mergeSenderInto(sourceId, targetId) {
  return transaction(() => {
    const source = db.prepare("SELECT * FROM senders WHERE id = ?").get(sourceId);
    const target = db.prepare("SELECT * FROM senders WHERE id = ?").get(targetId);
    if (!source) throw new Error("Expéditeur source introuvable");
    if (!target) throw new Error("Expéditeur cible introuvable");
    if (source.id === target.id) throw new Error("Choisis deux expéditeurs différents");

    const moved = deplaceExpediteur(source.name, target.name);
    db.prepare("DELETE FROM senders WHERE id = ?").run(source.id);
    journalise("expediteur", `${source.name} fusionné dans ${target.name}`, { detail: plurielJournal(moved, "colis déplacé", "colis déplacés"), nombre: moved });
    return { moved, source: source.name, target: target.name };
  });
}

module.exports = {
  getOrCreateSender,
  updateSenderPrices,
  getDebtsBySender,
  markSenderPaid,
  MERGE_SAFETY_THRESHOLD,
  getTotalRevenue,
  getMergeCandidates,
  mergeSendersIntoOther,
  deplaceExpediteur,
  mergeSenderInto,
};
