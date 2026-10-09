const crypto = require("crypto");
const { db } = require("./db");

// /save : une sauvegarde des donnees de FeurDrop en un seul fichier JSON.
//
// Tout ce qui fait marcher le metier y est -- expediteurs, colis (statuts,
// prix, impression, paiement), stock, tournees, journal, paires du topic
// special, regles apprises, reglages -- et rien d'autre :
//   - pas de fichier : les PDF et images vivent chez Telegram, la base ne
//     garde que leur reference (file_id), qui suffit pour les reimprimer ;
//   - pas de secret : jeton de l'agent d'impression, cles VAPID, secret des
//     references du portail, liens prives des expediteurs, cles des
//     abonnements push. Ils se regenerent (voir `exclusions` dans le fichier).
//
// L'export se fait dans une seule transaction de lecture : toutes les tables
// sont lues au meme instant, aucune ecriture ne peut s'intercaler. Rien n'est
// modifie. Le texte produit est relu et controle (comptes et empreinte
// SHA-256 des donnees) avant d'etre rendu.

const FORMAT = "feurdrop-sauvegarde";
const VERSION_FORMAT = 1;

// Les reglages qui sont des secrets : jamais dans le fichier.
const REGLAGES_SECRETS = /token|secret|private|password|vapid/i;

// table -> categorie du fichier, et ce qu'on garde de chaque ligne
const CATEGORIES = [
  {
    table: "senders",
    nom: "expediteurs",
    libelle: "expéditeurs",
    ordre: "id",
    // le jeton du lien prive est la cle de l'espace de l'expediteur : on ne
    // garde que le fait qu'il existe (le recreer donne un nouveau lien)
    ligne: ({ portail_jeton, ...reste }) => ({ ...reste, portail_actif: Boolean(portail_jeton) }),
  },
  { table: "colis", nom: "colis", libelle: "colis", ordre: "id" },
  { table: "batches", nom: "lots", libelle: "lots", ordre: "id" },
  { table: "tours", nom: "tournees", libelle: "tournées", ordre: "id" },
  { table: "paires_special", nom: "pairesSpeciales", libelle: "paires spéciales", ordre: "id" },
  { table: "carrier_rules", nom: "reglesTransporteurs", libelle: "règles", ordre: "kind, value" },
  {
    table: "settings",
    nom: "reglages",
    libelle: "réglages",
    ordre: "key",
    garde: (l) => !REGLAGES_SECRETS.test(l.key),
  },
  { table: "journal", nom: "journal", libelle: "journal", ordre: "id" },
  {
    // la file des fichiers recus : seulement ce qui n'est pas encore traite
    // (ou en echec) -- le reste n'est qu'un historique technique
    table: "arrivees",
    nom: "arriveesEnAttente",
    libelle: "arrivées en attente",
    ordre: "id",
    garde: (l) => l.statut !== "fait",
  },
  {
    // un appareil se reabonne tout seul a l'ouverture : on ne garde ni son
    // adresse de push ni ses cles, seulement ce qui sert au "+N"
    table: "push_subscriptions",
    nom: "appareilsNotifies",
    libelle: "appareils",
    ordre: "created_at",
    ligne: ({ label, created_at, last_seen_at, seen_at, announced }) => ({ label, created_at, last_seen_at, seen_at, announced }),
  },
];

// tables internes de SQLite, rien a sauvegarder
const TABLES_INTERNES = new Set(["sqlite_sequence"]);

const EXCLUSIONS = [
  "fichiers PDF et images des etiquettes (gardes chez Telegram : file_id dans les colis)",
  "reglages secrets : print_token, vapid_private_key, vapid_public_key, portail_secret (regeneres au demarrage)",
  "senders.portail_jeton (lien prive : a recreer depuis le dashboard)",
  "push_subscriptions.endpoint/p256dh/auth (les appareils se reabonnent a l'ouverture)",
  "arrivees deja traitees (historique technique)",
  "sqlite_sequence (compteurs internes, recalcules a partir des identifiants)",
  "base du bot de suivi (suivi.db) : resultats de verification, regenerables",
  "variables d'environnement (seuls leurs noms sont listes)",
];

// Les variables dont la sauvegarde liste le NOM (jamais la valeur) : de quoi
// savoir quoi redefinir lors d'une remise en route.
const VARIABLES_CONNUES = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
  "TELEGRAM_GROUP_MEMBERS",
  "TELEGRAM_BACKUP_CHAT_ID",
  "SPECIAL_TOPIC_ID",
  "PRINT_TOKEN",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "PUSH_CONTACT",
  "PORTAIL_URL",
  "DEFAULT_PRICE",
  "DEFAULT_LIT_PRICE",
  "DEFAULT_BJ_PRICE",
  "SMIC_HOURLY",
  "BATCH_DEBOUNCE_MS",
  "SUIVI_BOT_TOKEN",
  "OKAPI_KEY",
  "SUIVI_ALLOWED_CHATS",
  "SUIVI_DB_PATH",
  "FEDEX_API_KEY",
  "FEDEX_API_SECRET",
  "UPS_CLIENT_ID",
  "UPS_CLIENT_SECRET",
  "DHL_API_KEY",
];

const sha256 = (texte) => crypto.createHash("sha256").update(texte).digest("hex");

// Lit tout dans une seule transaction de lecture (meme instant pour toutes les
// tables, aucune ecriture).
function instantane(fn) {
  db.exec("BEGIN");
  try {
    return fn();
  } finally {
    db.exec("COMMIT");
  }
}

function tablesDeLaBase() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((t) => t.name)
    .filter((t) => !TABLES_INTERNES.has(t));
}

// Une valeur binaire n'a rien a faire dans le JSON (il n'y en a pas
// aujourd'hui : garde-fou si une colonne en recevait un jour).
function sansBinaire(ligne) {
  const propre = {};
  for (const [k, v] of Object.entries(ligne)) propre[k] = v instanceof Uint8Array ? null : v;
  return propre;
}

function lisDonnees() {
  const tables = tablesDeLaBase();
  const connues = new Set(CATEGORIES.map((c) => c.table));
  const donnees = {};
  const schema = {};
  for (const t of tables) schema[t] = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

  for (const cat of CATEGORIES) {
    if (!tables.includes(cat.table)) {
      donnees[cat.nom] = [];
      continue;
    }
    const lignes = db.prepare(`SELECT * FROM "${cat.table}" ORDER BY ${cat.ordre}`).all().map((l) => sansBinaire({ ...l }));
    donnees[cat.nom] = lignes.filter(cat.garde || (() => true)).map(cat.ligne || ((l) => l));
  }
  // une table ajoutee plus tard et pas encore classee : sauvegardee telle
  // quelle plutot qu'oubliee
  const autres = tables.filter((t) => !connues.has(t));
  if (autres.length) {
    donnees.autresTables = {};
    for (const t of autres) donnees.autresTables[t] = db.prepare(`SELECT * FROM "${t}"`).all().map((l) => sansBinaire({ ...l }));
  }

  const un = (sql) => db.prepare(sql).get();
  const resume = {
    colisEnAttente: un("SELECT COUNT(*) AS nombre, ROUND(COALESCE(SUM(price), 0), 2) AS valeur FROM colis WHERE status = 'pending'"),
    colisDropes: un("SELECT COUNT(*) AS nombre, ROUND(COALESCE(SUM(price), 0), 2) AS valeur FROM colis WHERE status = 'dropped'"),
    etiquettesAImprimer: un("SELECT COUNT(*) AS nombre FROM colis WHERE status = 'pending' AND file_id IS NOT NULL AND printed_at IS NULL").nombre,
    dettes: db
      .prepare(
        `SELECT sender_name AS expediteur, ROUND(SUM(price), 2) AS du, COUNT(*) AS colis
         FROM colis WHERE status = 'dropped' AND paid = 0 GROUP BY sender_name HAVING du > 0 ORDER BY du DESC`
      )
      .all()
      .map((l) => ({ ...l })),
    stock: {
      normal: Number(un("SELECT value FROM settings WHERE key = 'stock'")?.value || 0),
      bj: Number(un("SELECT value FROM settings WHERE key = 'stock_bj'")?.value || 0),
    },
    tourneeEnCours: un("SELECT value FROM settings WHERE key = 'tour_started_at'")?.value || null,
  };
  const versionSchema = un("PRAGMA user_version").user_version;
  return { donnees, schema, resume, versionSchema };
}

function compte(donnees) {
  const comptes = {};
  for (const [nom, valeur] of Object.entries(donnees)) {
    if (Array.isArray(valeur)) comptes[nom] = valeur.length;
    else for (const [t, lignes] of Object.entries(valeur)) comptes[`autresTables.${t}`] = lignes.length;
  }
  return comptes;
}

function nomDeFichier(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return {
    fichier: `feurdrop-backup-${p.year}-${p.month}-${p.day}-${p.hour}h${p.minute}.json`,
    lisible: `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`,
  };
}

/**
 * Cree la sauvegarde. Renvoie { fichier, contenu (Buffer), date, comptes,
 * total, sha256, taille } -- deja relue et controlee (verifieSauvegarde).
 */
function creeSauvegarde({ maintenant = new Date() } = {}) {
  const lu = instantane(lisDonnees);
  const texteDonnees = JSON.stringify(lu.donnees);
  const comptes = compte(lu.donnees);
  const total = Object.values(comptes).reduce((a, b) => a + b, 0);
  const { fichier, lisible } = nomDeFichier(maintenant);
  const presentes = VARIABLES_CONNUES.filter((v) => process.env[v] != null && process.env[v] !== "");

  const sauvegarde = {
    format: FORMAT,
    versionFormat: VERSION_FORMAT,
    creeLe: maintenant.toISOString(),
    creeLeParis: lisible,
    versionSchema: lu.versionSchema,
    application: {
      nom: require("../package.json").name,
      version: require("../package.json").version,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      node: process.version,
    },
    // les dates de la base sont en UTC ("AAAA-MM-JJ HH:MM:SS") ; les montants
    // en euros
    conventions: { dates: "UTC, format SQLite AAAA-MM-JJ HH:MM:SS", montants: "euros" },
    configuration: {
      tarifsParDefaut: {
        normal: Number(process.env.DEFAULT_PRICE || 4),
        lit: Number(process.env.DEFAULT_LIT_PRICE || 5.5),
        bj: Number(process.env.DEFAULT_BJ_PRICE || process.env.DEFAULT_PRICE || 4),
      },
      smicHoraire: Number(process.env.SMIC_HOURLY || 9.4),
      portail: process.env.PORTAIL_URL || null,
      variablesDefinies: presentes,
    },
    schema: lu.schema,
    exclusions: EXCLUSIONS,
    resume: lu.resume,
    controle: { enregistrements: comptes, total, sha256Donnees: sha256(texteDonnees) },
    donnees: lu.donnees,
  };

  const texte = JSON.stringify(sauvegarde, null, 2);
  verifieSauvegarde(texte, { comptes, sha256Donnees: sauvegarde.controle.sha256Donnees });
  const contenu = Buffer.from(texte, "utf8");
  return {
    fichier,
    contenu,
    date: lisible,
    comptes,
    total,
    sha256: sha256(contenu),
    sha256Donnees: sauvegarde.controle.sha256Donnees,
    taille: contenu.length,
  };
}

/**
 * Relit un fichier de sauvegarde et controle qu'il est complet. Leve une
 * erreur explicite sinon. `attendu` : les comptes et l'empreinte calcules a
 * la creation (sinon, ceux qu'annonce le fichier lui-meme).
 */
function verifieSauvegarde(texte, attendu = null) {
  let lu;
  try {
    lu = JSON.parse(texte);
  } catch (err) {
    throw new Error(`le fichier n'est pas un JSON valide : ${err.message}`);
  }
  if (lu.format !== FORMAT) throw new Error("ce n'est pas une sauvegarde FeurDrop");
  if (lu.versionFormat !== VERSION_FORMAT) throw new Error(`version de format inconnue : ${lu.versionFormat}`);
  if (!lu.donnees || !lu.controle) throw new Error("donnees ou controle manquants");
  for (const cat of CATEGORIES) {
    if (!Array.isArray(lu.donnees[cat.nom])) throw new Error(`categorie manquante : ${cat.nom}`);
  }
  const comptes = compte(lu.donnees);
  const voulus = attendu?.comptes || lu.controle.enregistrements;
  for (const [nom, n] of Object.entries(voulus)) {
    if (comptes[nom] !== n) throw new Error(`${nom} : ${comptes[nom] ?? 0} enregistrement(s) au lieu de ${n}`);
  }
  const empreinte = sha256(JSON.stringify(lu.donnees));
  const voulue = attendu?.sha256Donnees || lu.controle.sha256Donnees;
  if (empreinte !== voulue) throw new Error("empreinte des donnees differente : fichier altere ou incomplet");
  return { comptes, total: Object.values(comptes).reduce((a, b) => a + b, 0), versionSchema: lu.versionSchema };
}

// "1,2 Mo", "840 Ko"
function tailleLisible(octets) {
  if (octets >= 1024 * 1024) return `${(octets / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
  return `${Math.max(1, Math.round(octets / 1024))} Ko`;
}

module.exports = { creeSauvegarde, verifieSauvegarde, tailleLisible, CATEGORIES, EXCLUSIONS, FORMAT, VERSION_FORMAT };
