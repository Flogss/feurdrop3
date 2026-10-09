// Le journal : l'historique affiche en bas du dashboard (site et app).
const { AsyncLocalStorage } = require("node:async_hooks");
const { db } = require("./connexion");
const { carrierLabel } = require("../carrier");

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

module.exports = {
  contexteJournal,
  avecSource,
  sourceCourante,
  TYPES_JOURNAL,
  colisJournal,
  euroJournal,
  euroTexte,
  plurielJournal,
  journalise,
  journaliseRecu,
  FILTRES_JOURNAL,
  getJournal,
};
