// Drops : ce qui part, groupe ou a l'unite, et son annulation.
const { EventEmitter } = require("events");
const { db } = require("./connexion");
const { journalise, colisJournal, plurielJournal } = require("./journal");
const { adjustStock, getStocks } = require("./reglages");
const { tourScope, endTourIfEmpty } = require("./tournee");
const { CARRIER_GROUP_SQL, PRET_SQL } = require("./sql");
const { carrierLabel } = require("../carrier");

function getCarrierSummary() {
  const { clause, params } = tourScope();
  return db
    .prepare(
      `SELECT ${CARRIER_GROUP_SQL} AS carrier, COUNT(*) AS pending_count, ROUND(SUM(price), 2) AS pending_value
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
  const value = db.prepare(`SELECT ROUND(COALESCE(SUM(price), 0), 2) AS v FROM colis WHERE ${where}`).get(...args).v;
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

module.exports = {
  getCarrierSummary,
  evenements,
  dropWhere,
  dropByCarrier,
  dropAll,
  dropAllExceptLit,
  dropBySender,
  dropColis,
  undropColis,
  restoreStock,
};
