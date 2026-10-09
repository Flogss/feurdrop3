const { DEFAULT_PRICE, DEFAULT_LIT_PRICE, DEFAULT_BJ_PRICE } = require("./montants");

// Les migrations de la base, numerotees et appliquees une seule fois chacune,
// dans l'ordre, chacune dans sa transaction : si l'une echoue, la base reste
// telle qu'avant elle et le serveur refuse de demarrer plutot que de tourner
// sur un schema a moitie fait. Le numero de la derniere appliquee est garde
// dans la base elle-meme (PRAGMA user_version).
//
// Avant, ces modifications etaient eparpillees (db.js, portail.js) et
// rejouees a chaque demarrage. Les migrations 1 a 4 les reprennent telles
// quelles : elles verifient chaque table et chaque colonne avant de les
// creer, si bien qu'une base deja a jour (la production) les traverse sans
// rien changer d'autre que son numero de version.
//
// Ajouter une migration : une entree de plus a la fin, jamais de
// modification d'une migration deja publiee. Uniquement des ajouts (tables,
// colonnes, index) : une version precedente du code doit pouvoir rouvrir la
// base en cas de retour arriere.

const MIGRATIONS = [
  {
    version: 1,
    nom: "tables de base et colonnes ajoutees au fil du temps",
    applique(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS senders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          price REAL NOT NULL DEFAULT ${DEFAULT_PRICE},
          lit_price REAL NOT NULL DEFAULT ${DEFAULT_LIT_PRICE},
          bj_price REAL NOT NULL DEFAULT ${DEFAULT_BJ_PRICE},
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS colis (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sender_name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'normal',
          price REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          chat_id INTEGER,
          message_id INTEGER,
          batch_id INTEGER,
          paid INTEGER NOT NULL DEFAULT 0,
          carrier TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          dropped_at TEXT,
          paid_at TEXT
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS carrier_rules (
          kind TEXT NOT NULL,
          value TEXT NOT NULL,
          carrier TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (kind, value)
        );

        CREATE TABLE IF NOT EXISTS tours (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          seconds INTEGER NOT NULL,
          colis_count INTEGER NOT NULL,
          value REAL NOT NULL
        );
      `);

      // migration guard for existing databases created before type/chat_id/message_id/batch_id existed
      // Chaque appareil abonne aux notifications a son propre "vu le" : le "+N"
      // d'un telephone compte les colis arrives depuis que CE telephone a regarde,
      // pas depuis que quelqu'un d'autre l'a fait. Les abonnements existants
      // reprennent l'ancien "vu le" commun.
      const pushColumns = db.prepare("PRAGMA table_info(push_subscriptions)").all().map((c) => c.name);
      if (!pushColumns.includes("seen_at")) {
        db.exec("ALTER TABLE push_subscriptions ADD COLUMN seen_at TEXT");
        const ancien = db.prepare("SELECT value FROM settings WHERE key = 'push_seen_at'").get();
        db.prepare("UPDATE push_subscriptions SET seen_at = COALESCE(?, datetime('now'))").run(ancien ? ancien.value : null);
      }
      // le "+N" deja affiche sur l'appareil : sans hausse, pas de nouvelle sonnerie
      if (!pushColumns.includes("announced")) {
        db.exec("ALTER TABLE push_subscriptions ADD COLUMN announced INTEGER NOT NULL DEFAULT 0");
      }

      const colisColumns = db.prepare("PRAGMA table_info(colis)").all().map((c) => c.name);
      if (!colisColumns.includes("type")) db.exec("ALTER TABLE colis ADD COLUMN type TEXT NOT NULL DEFAULT 'normal'");
      if (!colisColumns.includes("chat_id")) db.exec("ALTER TABLE colis ADD COLUMN chat_id INTEGER");
      if (!colisColumns.includes("message_id")) db.exec("ALTER TABLE colis ADD COLUMN message_id INTEGER");
      if (!colisColumns.includes("batch_id")) db.exec("ALTER TABLE colis ADD COLUMN batch_id INTEGER");
      if (!colisColumns.includes("paid")) db.exec("ALTER TABLE colis ADD COLUMN paid INTEGER NOT NULL DEFAULT 0");
      if (!colisColumns.includes("paid_at")) db.exec("ALTER TABLE colis ADD COLUMN paid_at TEXT");
      // prix fixe manuellement via /prix : ne doit pas etre ecrase par une mise a
      // jour du tarif de l'expediteur
      if (!colisColumns.includes("price_locked")) {
        db.exec("ALTER TABLE colis ADD COLUMN price_locked INTEGER NOT NULL DEFAULT 0");
      }
      if (!colisColumns.includes("carrier")) db.exec("ALTER TABLE colis ADD COLUMN carrier TEXT");
      // nom de fichier, legende et identifiant Telegram du fichier : indispensables
      // pour apprendre des regles de transporteur apres coup et pour re-telecharger
      // les etiquettes au moment de les imprimer
      if (!colisColumns.includes("file_name")) db.exec("ALTER TABLE colis ADD COLUMN file_name TEXT");
      if (!colisColumns.includes("caption")) db.exec("ALTER TABLE colis ADD COLUMN caption TEXT");
      if (!colisColumns.includes("file_id")) db.exec("ALTER TABLE colis ADD COLUMN file_id TEXT");
      if (!colisColumns.includes("file_kind")) db.exec("ALTER TABLE colis ADD COLUMN file_kind TEXT");
      // date d'impression automatique : une etiquette deja sortie de l'imprimante ne
      // doit jamais ressortir toute seule
      if (!colisColumns.includes("printed_at")) db.exec("ALTER TABLE colis ADD COLUMN printed_at TEXT");
      // qui a imprime quoi : on est plusieurs a bosser dessus, et le menu de
      // reimpression doit pouvoir le dire. print_job regroupe les etiquettes sorties
      // dans une meme fournee.
      if (!colisColumns.includes("printed_by")) db.exec("ALTER TABLE colis ADD COLUMN printed_by TEXT");
      if (!colisColumns.includes("print_job")) db.exec("ALTER TABLE colis ADD COLUMN print_job TEXT");
      // note libre posee avec /note : "fragile", "a deposer avant 14h", "client
      // rappelle". Un colis annote passe en tete de la file d'impression et sort en
      // rouge sur le site -- c'est tout l'interet d'en poser une.
      if (!colisColumns.includes("note")) db.exec("ALTER TABLE colis ADD COLUMN note TEXT");
      // Le message d'origine, pour un fichier envoye au bot en prive puis republie
      // dans le groupe : chat_id/message_id pointent sur la copie, mais repondre
      // /lit ou /normal au fichier qu'on vient d'envoyer doit marcher aussi.
      if (!colisColumns.includes("source_chat_id")) db.exec("ALTER TABLE colis ADD COLUMN source_chat_id INTEGER");
      if (!colisColumns.includes("source_message_id")) {
        db.exec("ALTER TABLE colis ADD COLUMN source_message_id INTEGER");
      }
      // les index apres les colonnes : une tres vieille base n'avait pas encore
      // chat_id ni batch_id quand la table a ete creee
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_colis_status ON colis(status);
        CREATE INDEX IF NOT EXISTS idx_colis_message ON colis(chat_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_colis_batch ON colis(batch_id);
        CREATE INDEX IF NOT EXISTS idx_colis_source ON colis(source_chat_id, source_message_id);
      `);

      // Paires code-barre + PDF du topic special : voir specials.js.
      db.exec(`
        CREATE TABLE IF NOT EXISTS paires_special (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          numero INTEGER NOT NULL,
          sender_name TEXT,
          colis_id INTEGER,
          code_file_id TEXT,
          code_chat_id INTEGER,
          code_message_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_paires_colis ON paires_special(colis_id);
      `);
      {
      const colonnes = db.prepare("PRAGMA table_info(paires_special)").all().map((c) => c.name);
        // le code qui ouvre le locker n'est pas toujours une image : parfois un PDF
      if (!colonnes.includes("code_file_kind")) db.exec("ALTER TABLE paires_special ADD COLUMN code_file_kind TEXT");
        // "seul" : un code qui n'attend aucun PDF (/special seul) ; "manuel" : une
        // paire reliee a la main, que le re-appairage automatique ne touche jamais
      if (!colonnes.includes("seul")) db.exec("ALTER TABLE paires_special ADD COLUMN seul INTEGER NOT NULL DEFAULT 0");
      if (!colonnes.includes("manuel")) db.exec("ALTER TABLE paires_special ADD COLUMN manuel INTEGER NOT NULL DEFAULT 0");
      }

      const senderColumns = db.prepare("PRAGMA table_info(senders)").all().map((c) => c.name);
      if (!senderColumns.includes("lit_price")) {
        db.exec(`ALTER TABLE senders ADD COLUMN lit_price REAL NOT NULL DEFAULT ${DEFAULT_LIT_PRICE}`);
      }
      if (!senderColumns.includes("bj_price")) {
        db.exec(`ALTER TABLE senders ADD COLUMN bj_price REAL NOT NULL DEFAULT ${DEFAULT_BJ_PRICE}`);
      }
    },
  },
  {
    version: 2,
    nom: "file des arrivees du bot",
    applique(db) {
      // --- Arrivees -----------------------------------------------------------------
      // Chaque fichier recu par le bot est inscrit ici AVANT d'etre traite, et n'en
      // sort qu'une fois traite. Avant, la file des fichiers a traiter ne vivait
      // qu'en memoire : un redemarrage du serveur (chaque mise a jour) pendant un
      // envoi de trente fichiers perdait ceux qui attendaient encore, alors que
      // Telegram les considerait comme livres. Au demarrage, ce qui reste est repris
      // dans l'ordre. Un meme message livre deux fois par Telegram n'est inscrit
      // qu'une fois (cle chat + message). `colis_id` / `paire_id` : ce que le
      // traitement a deja cree -- une reprise le reutilise au lieu d'en creer un
      // second.
      db.exec(`
        CREATE TABLE IF NOT EXISTS arrivees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          message_id INTEGER NOT NULL,
          message TEXT NOT NULL,
          statut TEXT NOT NULL DEFAULT 'attente',
          colis_id INTEGER,
          paire_id INTEGER,
          essais INTEGER NOT NULL DEFAULT 0,
          erreur TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT,
          UNIQUE (chat_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_arrivees_statut ON arrivees(statut);
      `);
    },
  },
  {
    version: 3,
    nom: "journal (et reprise des 30 derniers jours)",
    applique(db) {
      // --- Journal -----------------------------------------------------------------
      // Tout ce qui arrive aux colis, dans l'ordre : recus, dropes, imprimes, retires,
      // changes de type, de prix ou de transporteur, notes, stock, tournees,
      // paiements, expediteurs. Affiche tout en bas du dashboard (site et app).
      // Ecrit ici, au plus pres des donnees : quel que soit le chemin (bot, site,
      // app, impression auto), rien n'y echappe.
      const journalExistait = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal'")
        .get();
      db.exec(`
        CREATE TABLE IF NOT EXISTS journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL DEFAULT (datetime('now')),
          kind TEXT NOT NULL,
          texte TEXT NOT NULL,
          detail TEXT,
          valeur REAL,
          nombre INTEGER,
          source TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_journal_kind ON journal(kind);
      `);

      // Premiere mise en place : le journal repart des 30 derniers jours deja en
      // base (arrivees par lot, drops, fournees imprimees, tournees, paiements),
      // pour ne pas commencer vide.
      if (!journalExistait) {
        const depuis = "datetime('now', '-30 days')";
        db.exec(`
          INSERT INTO journal (at, kind, texte, detail, valeur, nombre, source)
          SELECT at, kind, texte, detail, valeur, nombre, source FROM (
            SELECT MAX(created_at) AS at, 'recu' AS kind,
                   CASE WHEN COUNT(*) > 1 THEN COUNT(*) || ' colis reçus' ELSE 'Colis reçu' END AS texte,
                   sender_name AS detail, ROUND(SUM(price), 2) AS valeur, COUNT(*) AS nombre, 'telegram' AS source
            FROM colis WHERE created_at >= ${depuis}
            GROUP BY sender_name, COALESCE(batch_id, id)
            UNION ALL
            SELECT dropped_at, 'drop',
                   CASE WHEN COUNT(*) > 1 THEN COUNT(*) || ' colis dropés' ELSE 'Colis dropé' END,
                   CASE WHEN COUNT(DISTINCT sender_name) = 1 THEN MAX(sender_name)
                        ELSE COUNT(DISTINCT sender_name) || ' expéditeurs' END,
                   ROUND(SUM(price), 2), COUNT(*), NULL
            FROM colis WHERE status = 'dropped' AND dropped_at >= ${depuis}
            GROUP BY dropped_at
            UNION ALL
            SELECT MAX(printed_at), 'impression',
                   CASE WHEN COUNT(*) > 1 THEN COUNT(*) || ' étiquettes imprimées' ELSE 'Étiquette imprimée' END,
                   CASE WHEN MAX(printed_by) IS NOT NULL THEN 'par ' || MAX(printed_by) END,
                   NULL, COUNT(*), NULL
            FROM colis WHERE print_job IS NOT NULL AND printed_at >= ${depuis}
            GROUP BY print_job
            UNION ALL
            SELECT ended_at, 'tournee', 'Tournée terminée',
                   colis_count || ' colis · ' || CASE WHEN seconds < 3600 THEN MAX(1, seconds / 60) || ' min'
                     ELSE (seconds / 3600) || ' h ' || printf('%02d', (seconds % 3600) / 60) END,
                   value, colis_count, NULL
            FROM tours WHERE ended_at >= ${depuis}
            UNION ALL
            SELECT paid_at, 'paiement', 'Paiement enregistré', sender_name, ROUND(SUM(price), 2), COUNT(*), NULL
            FROM colis WHERE paid = 1 AND paid_at >= ${depuis}
            GROUP BY sender_name, paid_at
          ) ORDER BY at, kind
        `);
        const n = db.prepare("SELECT COUNT(*) AS c FROM journal").get().c;
        if (n) console.log(`[journal] ${n} evenements des 30 derniers jours repris`);
      }
    },
  },
  {
    version: 4,
    nom: "espaces prives des expediteurs",
    applique(db) {
      // L'espace prive d'un expediteur (voir portail.js) : son jeton et sa
      // date de creation, un jeton unique, et l'index qui sert sa page.
      const colonnes = db.prepare("PRAGMA table_info(senders)").all().map((c) => c.name);
      if (!colonnes.includes("portail_jeton")) db.exec("ALTER TABLE senders ADD COLUMN portail_jeton TEXT");
      if (!colonnes.includes("portail_cree_le")) db.exec("ALTER TABLE senders ADD COLUMN portail_cree_le TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_senders_portail ON senders(portail_jeton) WHERE portail_jeton IS NOT NULL");
      db.exec("CREATE INDEX IF NOT EXISTS idx_colis_sender ON colis(sender_name, created_at)");
    },
  },
];

const VERSION_SCHEMA = MIGRATIONS[MIGRATIONS.length - 1].version;

function versionDe(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

// Applique ce qui manque. Renvoie les versions appliquees.
// `migrations` : une autre liste (tests).
function appliqueMigrations(db, { jusqua = VERSION_SCHEMA, journal = console, migrations = MIGRATIONS } = {}) {
  const depart = versionDe(db);
  if (depart > VERSION_SCHEMA && migrations === MIGRATIONS) {
    // base migree par une version plus recente du code (retour arriere) : les
    // migrations n'ajoutant que des tables et des colonnes, elle reste lisible
    journal.warn(`[db] schema v${depart}, plus recent que ce code (v${VERSION_SCHEMA}) : rien a migrer`);
    return [];
  }
  const faites = [];
  for (const migration of migrations) {
    if (migration.version <= depart || migration.version > jusqua) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.applique(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${migration.version} (${migration.nom}) impossible : ${err.message}`);
    }
    faites.push(migration.version);
    journal.log(`[db] migration ${migration.version} appliquee : ${migration.nom}`);
  }
  return faites;
}

// Le menage de chaque demarrage (ce n'est pas une migration : il se refait).
function entretien(db) {
  // les arrivees traitees ne servent plus apres quelques jours
  db.prepare("DELETE FROM arrivees WHERE statut != 'attente' AND created_at < datetime('now', '-7 days')").run();
}

module.exports = { MIGRATIONS, VERSION_SCHEMA, appliqueMigrations, versionDe, entretien };
