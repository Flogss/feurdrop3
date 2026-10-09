// Les dates metier se comptent a l'heure de Paris.
//
// La base stocke tout en UTC ("2026-10-09 22:30:00", datetime('now')) et ce
// stockage ne change pas. Mais "aujourd'hui", le jour d'un drop, le cumul des
// tournees du jour ou le dimanche reporte au lundi sont des jours FRANCAIS :
// calcules en UTC, ils basculaient a 1 h (hiver) ou 2 h (ete), et un drop fait
// tard le soir tombait sur la veille.
//
// La conversion passe par Intl (fuseaux d'ICU, embarques dans Node) : elle
// suit les changements d'heure sans dependre de la configuration du conteneur
// (TZ, paquet tzdata).

const FUSEAU = "Europe/Paris";

const formatJour = new Intl.DateTimeFormat("en-GB", {
  timeZone: FUSEAU,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const formatHeure = new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, hour: "2-digit", minute: "2-digit" });

// "2026-10-09 22:30:00" (UTC, comme en base), une Date ou des millisecondes.
function enMillisecondes(valeur) {
  if (valeur == null) return NaN;
  if (valeur instanceof Date) return valeur.getTime();
  if (typeof valeur === "number") return valeur;
  const texte = String(valeur).trim();
  if (!texte) return NaN;
  // forme SQLite : sans fuseau, c'est de l'UTC
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(texte)) return Date.parse(`${texte.replace(" ", "T")}Z`);
  return Date.parse(texte);
}

/** Le jour a Paris ("2026-10-10") d'un instant ; null si illisible. */
function jourParis(valeur) {
  const ms = enMillisecondes(valeur);
  if (Number.isNaN(ms)) return null;
  const parties = Object.fromEntries(formatJour.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parties.year}-${parties.month}-${parties.day}`;
}

function aujourdhuiParis() {
  return jourParis(Date.now());
}

/** "14:32" a Paris. */
function heureParis(valeur) {
  const ms = enMillisecondes(valeur);
  return Number.isNaN(ms) ? "?" : formatHeure.format(ms);
}

// Calcul sur des jours calendaires "AAAA-MM-JJ" (sans heure, donc sans
// fuseau) : midi UTC sert de pivot, loin de tout changement de date.
function versDate(jour) {
  return new Date(`${jour}T12:00:00Z`);
}

function ajouteJours(jour, n) {
  const d = versDate(jour);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = dimanche ... 6 = samedi */
function jourDeLaSemaine(jour) {
  return versDate(jour).getUTCDay();
}

/** Le lundi de la semaine d'un jour ("AAAA-MM-JJ"). */
function lundiDe(jour) {
  const dow = jourDeLaSemaine(jour);
  return ajouteJours(jour, -(dow === 0 ? 6 : dow - 1));
}

// La meme conversion, cote SQL : jour_paris(dropped_at).
function enregistreFonctionsSql(db) {
  db.function("jour_paris", { deterministic: true }, (valeur) => jourParis(valeur));
}

module.exports = {
  FUSEAU,
  jourParis,
  aujourdhuiParis,
  heureParis,
  ajouteJours,
  jourDeLaSemaine,
  lundiDe,
  enregistreFonctionsSql,
};
