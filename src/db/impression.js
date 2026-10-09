// File d'impression : ce qui reste a imprimer, impression automatique,
// fournees deja sorties.
const crypto = require("crypto");
const { db } = require("./connexion");
const { getSetting, setSetting } = require("./reglages");
const { journalise, plurielJournal } = require("./journal");
const {
  HAS_FILE_SQL,
  PRINTABLE_SQL,
  LIT_PRINTABLE_SQL,
  PRINT_ORDER_SQL,
  CARRIER_GROUP_SQL,
  PRINT_GROUP_SQL,
  AUTOPRINT_SQL,
} = require("./sql");
const { carrierLabel } = require("../carrier");

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
  const job = crypto.randomBytes(6).toString("hex");
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

module.exports = {
  printableScope,
  getPrintableColis,
  litScope,
  getLitPrintable,
  countLitPrintable,
  countLitNoted,
  countAlreadyPrinted,
  getPrintableSummary,
  isAutoPrintEnabled,
  setAutoPrintEnabled,
  markPendingAsPrinted,
  getUnprintedLabels,
  countUnprintedLabels,
  markPrinted,
  getPrintJobs,
  getPrintJobColis,
};
