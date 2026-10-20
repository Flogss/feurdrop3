// Drops : ce qui part, groupe ou a l'unite, et son annulation.
const { EventEmitter } = require("events");
const { db, transaction } = require("./connexion");
const { journalise, colisJournal, plurielJournal } = require("./journal");
const { adjustStock, getStocks } = require("./reglages");
const { tourScope, endTourIfEmpty } = require("./tournee");
const { CARRIER_GROUP_SQL, PRET_SQL } = require("./sql");
const { carrierLabel } = require("../carrier");

// Les speciaux ont leur propre ligne (« SPECIAL ») : « Dropper » sur La Poste
// ne les emporte plus avec les etiquettes classiques. La ligne des speciaux
// detaille ses transporteurs (`detail`), pour choisir lesquels dropper.
const SPECIAL_GROUP_SQL = `CASE WHEN type = 'special' THEN 'SPECIAL' ELSE ${CARRIER_GROUP_SQL} END`;

function getCarrierSummary() {
  const { clause, params } = tourScope();
  const lignes = db
    .prepare(
      `SELECT ${SPECIAL_GROUP_SQL} AS carrier, COUNT(*) AS pending_count, ROUND(SUM(price), 2) AS pending_value
       FROM colis WHERE status = 'pending'${clause}
       GROUP BY ${SPECIAL_GROUP_SQL} ORDER BY pending_count DESC`
    )
    .all(...params);
  const special = lignes.find((l) => l.carrier === "SPECIAL");
  if (special) special.detail = getSpecialSummary();
  return lignes;
}

// Les speciaux en attente, par transporteur.
function getSpecialSummary() {
  const { clause, params } = tourScope();
  return db
    .prepare(
      `SELECT COALESCE(carrier, 'Inconnu') AS carrier, COUNT(*) AS pending_count, ROUND(SUM(price), 2) AS pending_value
       FROM colis WHERE status = 'pending' AND type = 'special'${clause}
       GROUP BY COALESCE(carrier, 'Inconnu') ORDER BY pending_count DESC`
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
  // un redrop est deja dans sa pochette (comptee au premier drop) : pas de
  // pochette de plus
  const redrops = db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(type = 'bj'), 0) AS bj FROM colis WHERE ${where} AND redrop_de IS NOT NULL`)
    .get(...args);
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
  return { count: info.changes, bj, value, restants, redrops: { count: redrops.c, bj: redrops.bj } };
}

// « Dropper » sur un transporteur : ses etiquettes classiques (et ses LIT),
// jamais ses speciaux -- ils se droppent a part, transporteur par transporteur
// (dropSpecials). « SPECIAL » : tous les speciaux (anciennes versions de
// l'app, qui n'ont pas le choix).
function dropByCarrier(carrier) {
  const libelle = carrier === "Inconnu" ? "Transporteur inconnu" : carrierLabel(carrier);
  if (carrier === "BJ") return dropWhere(" AND type = 'bj'", [], { libelle: "Boîte jaune" });
  if (carrier === "SPECIAL") return dropWhere(" AND type = 'special'", [], { libelle: "Spéciaux (tous)" });
  if (carrier === "Inconnu") return dropWhere(" AND type NOT IN ('bj', 'special') AND carrier IS NULL", [], { libelle });
  return dropWhere(" AND type NOT IN ('bj', 'special') AND carrier = ?", [carrier], { libelle });
}

// Les speciaux des transporteurs choisis, et eux seuls.
function dropSpecials(carriers) {
  const codes = [...new Set((Array.isArray(carriers) ? carriers : []).map((c) => String(c).trim()).filter(Boolean))].slice(0, 20);
  if (!codes.length) return null;
  const connus = codes.filter((c) => c !== "Inconnu");
  const conds = [];
  if (connus.length) conds.push(`carrier IN (${connus.map(() => "?").join(",")})`);
  if (codes.includes("Inconnu")) conds.push("carrier IS NULL");
  const libelle = `Spéciaux ${codes.map((c) => (c === "Inconnu" ? "sans transporteur" : carrierLabel(c))).join(", ")}`;
  return dropWhere(` AND type = 'special' AND (${conds.join(" OR ")})`, connus, { libelle });
}

// Redrop d'un colis oublie (dropé, mais jamais pris en charge) : il revient
// « à poster » sous la forme d'une NOUVELLE ligne a 0 €, qui pointe vers le
// colis d'origine. L'origine ne bouge pas (prix, paiement, date de drop,
// suivi et preuves) ; l'etiquette, deja imprimee, n'est pas remise dans la
// file d'impression. Un redrop deja en attente pour ce colis est rendu tel
// quel : jamais deux.
function redropColis(id) {
  return transaction(() => {
    const o = db.prepare("SELECT * FROM colis WHERE id = ?").get(id);
    if (!o) return null;
    const racine = (o.redrop_de && db.prepare("SELECT * FROM colis WHERE id = ?").get(o.redrop_de)) || o;
    const enAttente = db.prepare("SELECT * FROM colis WHERE redrop_de = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(racine.id);
    if (enAttente) return { deja: true, colis: enAttente };
    if (o.status !== "dropped") return { pasDrope: true };
    const info = db
      .prepare(
        `INSERT INTO colis (sender_name, type, price, price_locked, status, carrier, file_name, caption, file_id, file_kind,
                            printed_at, printed_by, note, redrop_de)
         VALUES (?, ?, 0, 1, 'pending', ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)`
      )
      .run(o.sender_name, o.type, o.carrier, o.file_name, o.caption, o.file_id, o.file_kind, o.printed_at, o.printed_by ?? null, o.note ?? null, racine.id);
    journalise("drop", "Redrop : colis oublié remis à poster", { detail: [colisJournal(o), "0 €"].join(" · "), valeur: 0, nombre: 1 });
    return { deja: false, colis: db.prepare("SELECT * FROM colis WHERE id = ?").get(info.lastInsertRowid) };
  });
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
  journalise("drop", colis.redrop_de ? "Redrop dropé" : "Colis dropé", { detail: colisJournal(colis), valeur: colis.price, nombre: 1 });
  endTourIfEmpty();
  evenements.emit("dropes", [colis.id]);
  const bj = colis.type === "bj" ? 1 : 0;
  return { count: 1, bj, redrops: colis.redrop_de ? { count: 1, bj } : { count: 0, bj: 0 } };
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
  const bj = colis.type === "bj" ? 1 : 0;
  return { count: 1, bj, redrops: colis.redrop_de ? { count: 1, bj } : { count: 0, bj: 0 } };
}

// Rend au stock les pochettes d'un drop annule (un redrop n'en avait pas pris).
function restoreStock({ count = 0, bj = 0, redrops = null } = {}) {
  count -= redrops?.count || 0;
  bj -= redrops?.bj || 0;
  const normal = count - bj;
  if (normal > 0) adjustStock(normal, "normal");
  if (bj > 0) adjustStock(bj, "bj");
  return getStocks();
}

module.exports = {
  getCarrierSummary,
  getSpecialSummary,
  evenements,
  dropWhere,
  dropByCarrier,
  dropSpecials,
  redropColis,
  dropAll,
  dropAllExceptLit,
  dropBySender,
  dropColis,
  undropColis,
  restoreStock,
};
