const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { enregistreFonctionsSql } = require("../dates");

// La connexion a la base, ouverte a la premiere requete (ou par ouvreBase()
// au demarrage du serveur) -- jamais au simple chargement d'un module : un
// script, un test ou le service du portail peuvent charger le code sans
// toucher a aucun fichier.

// Ou vit la base. Un DB_PATH relatif pointe vers le systeme de fichiers du
// conteneur, qui est recree a chaque deploiement : si un volume est monte, il
// gagne toujours. C'est le seul cas ou on ignore une variable
// d'environnement, parce que la respecter revient a perdre la base a chaque
// mise en ligne.
function cheminBase(env = process.env) {
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
  const demande = env.DB_PATH;
  const ignore = Boolean(volume && demande && !path.isAbsolute(demande));
  const chemin = (ignore ? null : demande) || (volume ? path.join(volume, "drop.db") : "./data/drop.db");
  return { chemin, ignore, demande, volume };
}

let connexion = null;
let cheminOuvert = null;

// Diagnostic au demarrage : sans volume persistant, le fichier vit dans le
// conteneur et disparait a chaque deploiement. Le compte de lignes permet de
// verifier d'un coup d'oeil dans les logs que la base est bien celle d'avant.
function diagnostic(base, { chemin, existait, ignore, demande, volume }) {
  const colisCount = base.prepare("SELECT COUNT(*) AS c FROM colis").get().c;
  const senderCount = base.prepare("SELECT COUNT(*) AS c FROM senders").get().c;
  const version = base.prepare("PRAGMA user_version").get().user_version;
  console.log(
    `[db] ${chemin === ":memory:" ? chemin : path.resolve(chemin)} (${existait ? "existante" : "NOUVELLE"}, schema v${version}) :` +
      ` ${colisCount} colis, ${senderCount} expediteurs`
  );
  if (!process.env.RAILWAY_VOLUME_MOUNT_PATH && process.env.RAILWAY_ENVIRONMENT) {
    console.warn("[db] ATTENTION : aucun volume Railway monte, la base sera perdue au prochain deploiement.");
  }
  if (ignore) {
    console.warn(
      `[db] DB_PATH="${demande}" ignore : chemin relatif, donc efface a chaque deploiement.` +
        ` Le volume ${volume} est utilise a la place. Supprime la variable DB_PATH pour faire taire cet avertissement.`
    );
  }
}

// Avant de migrer une base qui contient deja des donnees : une copie complete
// a cote d'elle (dans le volume en production), VERIFIEE -- integrite et
// nombre de lignes de chaque table -- avant qu'on y touche. Si la copie n'est
// pas sure, on ne migre pas : le serveur s'arrete avec l'erreur.
function sauvegardeAvantMigration(base, chemin) {
  const { versionDe, VERSION_SCHEMA } = require("./migrations");
  const version = versionDe(base);
  const tables = base
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((t) => t.name);
  if (chemin === ":memory:" || version >= VERSION_SCHEMA || tables.length === 0) return null;

  const dossier = path.join(path.dirname(chemin), "sauvegardes");
  fs.mkdirSync(dossier, { recursive: true });
  const horodatage = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const copie = path.join(dossier, `drop-avant-migration-v${version}-${horodatage}.db`);
  base.exec(`VACUUM INTO '${copie.replace(/'/g, "''")}'`);

  const verif = new DatabaseSync(copie, { readOnly: true });
  try {
    const integrite = verif.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrite !== "ok") throw new Error(`integrite de la copie : ${integrite}`);
    for (const t of tables) {
      const n = base.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      const m = verif.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      if (n !== m) throw new Error(`copie incomplete : ${t} ${m}/${n} lignes`);
    }
  } finally {
    verif.close();
  }
  console.log(`[db] sauvegarde verifiee avant migration (v${version} -> v${VERSION_SCHEMA}) : ${copie}`);
  return copie;
}

// Ouvre la base (une seule fois), applique les migrations en attente et fait
// le menage. `chemin` : une autre base que celle de l'environnement (outils).
function ouvreBase({ chemin: force } = {}) {
  if (connexion) return connexion;
  const choix = cheminBase();
  const chemin = force || choix.chemin;
  if (chemin !== ":memory:") fs.mkdirSync(path.dirname(chemin), { recursive: true });
  // La base existait-elle deja avant d'ouvrir la connexion ? C'est la
  // question qui distingue "on a perdu les donnees" de "on ecrit dans un
  // autre fichier".
  const existait = chemin !== ":memory:" && fs.existsSync(chemin);

  const base = new DatabaseSync(chemin);
  try {
    base.exec("PRAGMA journal_mode = WAL;");
    // jour_paris(...) : le jour francais d'une date UTC de la base (dates.js)
    enregistreFonctionsSql(base);
    sauvegardeAvantMigration(base, chemin);
    require("./migrations").appliqueMigrations(base);
  } catch (err) {
    base.close();
    throw err;
  }
  connexion = base;
  cheminOuvert = chemin;
  require("./migrations").entretien(base);
  diagnostic(base, { ...choix, chemin, existait });
  return base;
}

function fermeBase() {
  if (!connexion) return;
  connexion.close();
  connexion = null;
  cheminOuvert = null;
}

// `db` s'utilise comme la connexion elle-meme (db.prepare, db.exec...) mais
// ne l'ouvre qu'au premier appel.
const db = new Proxy(
  {},
  {
    get(_, propriete) {
      const base = ouvreBase();
      const valeur = base[propriete];
      return typeof valeur === "function" ? valeur.bind(base) : valeur;
    },
  }
);

// --- Transactions --------------------------------------------------------------
// Une operation faite de plusieurs ecritures liees (fusion d'expediteurs, +n
// colis, fin de tournee) passe en entier ou pas du tout : si une etape echoue,
// tout ce qu'elle avait deja ecrit est annule. `fn` doit etre synchrone --
// node:sqlite l'est, et rien d'autre ne peut s'intercaler entre ses requetes.
// Une transaction ouverte dans une autre devient un point de sauvegarde : elle
// s'annule seule sans defaire celle qui l'englobe.
let profondeurTransaction = 0;
function transaction(fn) {
  const niveau = profondeurTransaction;
  const point = `drop_${niveau}`;
  db.exec(niveau === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${point}`);
  profondeurTransaction += 1;
  let resultat;
  try {
    resultat = fn();
    if (resultat && typeof resultat.then === "function") {
      throw new Error("transaction : la fonction doit etre synchrone");
    }
  } catch (err) {
    profondeurTransaction = niveau;
    try {
      db.exec(niveau === 0 ? "ROLLBACK" : `ROLLBACK TO ${point}; RELEASE ${point}`);
    } catch (erreurAnnulation) {
      console.error("[db] annulation impossible :", erreurAnnulation.message);
    }
    throw err;
  }
  profondeurTransaction = niveau;
  try {
    db.exec(niveau === 0 ? "COMMIT" : `RELEASE ${point}`);
  } catch (err) {
    if (niveau === 0) db.exec("ROLLBACK");
    throw err;
  }
  return resultat;
}

module.exports = { db, transaction, ouvreBase, fermeBase, cheminBase, cheminOuvert: () => cheminOuvert };
