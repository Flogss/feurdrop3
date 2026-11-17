const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { cheminBase } = require("../db/connexion");

// L'index des codes lus sur les etiquettes : une base a part, a cote de la
// base principale (comme la copie des boites jaunes). Elle ne garde QUE ce qui
// a ete lu -- formats, valeurs, positions -- jamais le fichier : les PDF et
// photos restent la ou ils sont deja, sur Telegram (colis.file_id). La perdre
// ne perd rien : tout se relit.
//
//   fichiers       un fichier analyse, reconnu a son empreinte SHA-256 (un
//                  meme fichier n'est jamais relu deux fois, meme partage par
//                  plusieurs colis -- un redrop garde l'etiquette d'origine)
//   codes          les codes de ce fichier : page, format, valeur (null si
//                  illisible), zone en 0..1 de la page
//   colis_fichiers quel fichier pour quel colis (et son file_id Telegram)

let base = null;
let cheminOuvert = null;

function chemin() {
  if (process.env.BORDEREAUX_DB_PATH) return process.env.BORDEREAUX_DB_PATH;
  const principale = cheminBase().chemin;
  return path.join(path.dirname(principale === ":memory:" ? "./data/x" : principale), "bordereaux.db");
}

function ouvre() {
  const c = chemin();
  if (base && cheminOuvert === c) return base;
  if (base) base.close();
  fs.mkdirSync(path.dirname(c), { recursive: true });
  base = new DatabaseSync(c);
  cheminOuvert = c;
  base.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS fichiers (
      empreinte TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      octets INTEGER NOT NULL,
      pages INTEGER NOT NULL DEFAULT 0,
      pages_lues INTEGER NOT NULL DEFAULT 0,
      formats TEXT,
      version INTEGER NOT NULL,
      analyse_le TEXT NOT NULL,
      duree_ms INTEGER,
      erreur TEXT
    );
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY,
      empreinte TEXT NOT NULL REFERENCES fichiers(empreinte) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      format TEXT NOT NULL,
      nom_format TEXT,
      famille TEXT NOT NULL,
      lisible INTEGER NOT NULL,
      valeur TEXT,
      norme TEXT,
      erreur TEXT,
      x0 REAL NOT NULL, y0 REAL NOT NULL, x1 REAL NOT NULL, y1 REAL NOT NULL,
      polygone TEXT,
      orientation INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS codes_empreinte ON codes(empreinte, page);
    CREATE INDEX IF NOT EXISTS codes_norme ON codes(norme);
    CREATE TABLE IF NOT EXISTS colis_fichiers (
      colis_id INTEGER PRIMARY KEY,
      file_id TEXT NOT NULL,
      empreinte TEXT,
      lie_le TEXT NOT NULL,
      erreur TEXT,
      essais INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS colis_fichiers_file ON colis_fichiers(file_id);
    CREATE INDEX IF NOT EXISTS colis_fichiers_empreinte ON colis_fichiers(empreinte);
    CREATE TABLE IF NOT EXISTS annotations (
      colis_id INTEGER PRIMARY KEY,
      texte TEXT NOT NULL,
      modifie_le TEXT NOT NULL
    );
    -- les categories de l'utilisateur (« Retours », « À vérifier »...) :
    -- un classement a part, jamais ecrit dans les etiquettes ni les colis
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      nom TEXT NOT NULL,
      couleur TEXT NOT NULL,
      cree_le TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS categories_nom ON categories(nom COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS colis_categories (
      colis_id INTEGER PRIMARY KEY,
      categorie_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      classe_le TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS colis_categories_cat ON colis_categories(categorie_id);
    -- le document de travail de l'editeur (un par etiquette) : les elements
    -- ajoutes ou modifies, a part ; l'etiquette d'origine n'est jamais touchee
    CREATE TABLE IF NOT EXISTS travaux (
      colis_id INTEGER PRIMARY KEY,
      modele TEXT NOT NULL,
      modifie_le TEXT NOT NULL
    );
  `);
  return base;
}

function ferme() {
  if (base) base.close();
  base = null;
  cheminOuvert = null;
}

// Les lettres et chiffres seuls, en majuscules : « 6a 1234-5 » -> « 6A12345 »
const norme = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const maintenant = () => new Date().toISOString();

/** Le fichier deja analyse sous cette empreinte (avec ses codes), ou null. */
function fichier(empreinte) {
  const f = ouvre().prepare("SELECT * FROM fichiers WHERE empreinte = ?").get(empreinte);
  if (!f) return null;
  const codes = ouvre().prepare("SELECT * FROM codes WHERE empreinte = ? ORDER BY page, id").all(empreinte);
  return { ...f, formats: f.formats ? JSON.parse(f.formats) : [], codes: codes.map(codeLu) };
}

const codeLu = (c) => ({
  id: c.id,
  page: c.page,
  format: c.format,
  nomFormat: c.nom_format || c.format,
  famille: c.famille,
  lisible: c.lisible === 1,
  valeur: c.valeur,
  erreur: c.erreur,
  zone: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
  polygone: c.polygone ? JSON.parse(c.polygone) : null,
  orientation: c.orientation,
});

/** Enregistre (ou remplace) l'analyse d'un fichier et ses codes. */
function enregistreAnalyse(empreinte, octets, analyse) {
  const b = ouvre();
  const ajouteCode = b.prepare(`
    INSERT INTO codes (empreinte, page, format, nom_format, famille, lisible, valeur, norme, erreur, x0, y0, x1, y1, polygone, orientation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  b.exec("BEGIN");
  try {
    b.prepare("DELETE FROM codes WHERE empreinte = ?").run(empreinte);
    b.prepare(`
      INSERT INTO fichiers (empreinte, type, octets, pages, pages_lues, formats, version, analyse_le, duree_ms, erreur)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(empreinte) DO UPDATE SET type = excluded.type, octets = excluded.octets, pages = excluded.pages,
        pages_lues = excluded.pages_lues, formats = excluded.formats, version = excluded.version,
        analyse_le = excluded.analyse_le, duree_ms = excluded.duree_ms, erreur = excluded.erreur
    `).run(
      empreinte,
      analyse.type,
      octets,
      analyse.nombrePages || 0,
      analyse.pages?.length || 0,
      JSON.stringify((analyse.pages || []).map((p) => [p.largeur, p.hauteur])),
      analyse.version,
      maintenant(),
      analyse.dureeMs ?? null,
      analyse.erreur || null
    );
    for (const p of analyse.pages || []) {
      for (const c of p.codes) {
        ajouteCode.run(
          empreinte,
          p.page,
          c.format,
          c.nomFormat || c.format,
          c.famille,
          c.lisible ? 1 : 0,
          c.valeur,
          c.valeur ? norme(c.valeur) : null,
          c.erreur,
          c.x0,
          c.y0,
          c.x1,
          c.y1,
          c.polygone ? JSON.stringify(c.polygone) : null,
          c.orientation || 0
        );
      }
    }
    b.exec("COMMIT");
  } catch (err) {
    b.exec("ROLLBACK");
    throw err;
  }
}

/** Le lien colis -> fichier (empreinte null : pas encore telecharge, ou echec). */
function lien(colisId) {
  return ouvre().prepare("SELECT * FROM colis_fichiers WHERE colis_id = ?").get(colisId) || null;
}

function lie(colisId, fileId, empreinte) {
  ouvre()
    .prepare(`
      INSERT INTO colis_fichiers (colis_id, file_id, empreinte, lie_le, erreur, essais) VALUES (?, ?, ?, ?, NULL, 0)
      ON CONFLICT(colis_id) DO UPDATE SET file_id = excluded.file_id, empreinte = excluded.empreinte,
        lie_le = excluded.lie_le, erreur = NULL, essais = 0
    `)
    .run(colisId, fileId, empreinte, maintenant());
}

function noteEchec(colisId, fileId, message) {
  ouvre()
    .prepare(`
      INSERT INTO colis_fichiers (colis_id, file_id, empreinte, lie_le, erreur, essais) VALUES (?, ?, NULL, ?, ?, 1)
      ON CONFLICT(colis_id) DO UPDATE SET file_id = excluded.file_id, empreinte = NULL, lie_le = excluded.lie_le,
        erreur = excluded.erreur, essais = colis_fichiers.essais + 1
    `)
    .run(colisId, fileId, maintenant(), String(message).slice(0, 300));
}

/** Un autre colis a-t-il deja ce file_id, analyse ? -> son empreinte. */
function empreinteDuFileId(fileId) {
  return (
    ouvre()
      .prepare(
        "SELECT cf.empreinte FROM colis_fichiers cf JOIN fichiers f ON f.empreinte = cf.empreinte WHERE cf.file_id = ? AND cf.empreinte IS NOT NULL LIMIT 1"
      )
      .get(fileId)?.empreinte || null
  );
}

/** Tous les liens (pour l'indexation en fond et la liste). */
const tousLesLiens = () =>
  ouvre()
    .prepare("SELECT cf.colis_id, cf.file_id, cf.empreinte, cf.erreur, cf.essais, f.version FROM colis_fichiers cf LEFT JOIN fichiers f ON f.empreinte = cf.empreinte")
    .all();

/** Les codes lisibles et leur colis, pour la recherche. */
const codesIndexes = () =>
  ouvre()
    .prepare(
      `SELECT c.id, c.empreinte, c.page, c.format, c.nom_format, c.famille, c.valeur, c.norme, cf.colis_id
       FROM codes c JOIN colis_fichiers cf ON cf.empreinte = c.empreinte
       WHERE c.lisible = 1 AND c.norme IS NOT NULL AND c.norme != ''`
    )
    .all();

/** Le nombre de codes lisibles rattaches a un colis. */
const nombreCodes = () =>
  ouvre()
    .prepare("SELECT COUNT(*) AS n FROM codes c JOIN colis_fichiers cf ON cf.empreinte = c.empreinte WHERE c.lisible = 1")
    .get().n;

/** Nombre de codes par empreinte (lisibles, illisibles). */
const resumeCodes = () =>
  ouvre()
    .prepare("SELECT empreinte, SUM(lisible) AS lisibles, SUM(1 - lisible) AS illisibles, COUNT(*) AS total FROM codes GROUP BY empreinte")
    .all();

/** La note d'etude d'une etiquette : { texte, modifieLe } ou null. */
function annotation(colisId) {
  const a = ouvre().prepare("SELECT texte, modifie_le FROM annotations WHERE colis_id = ?").get(colisId);
  return a ? { texte: a.texte, modifieLe: a.modifie_le } : null;
}

/** Pose (ou efface, texte vide) la note d'etude d'une etiquette. */
function annote(colisId, texte) {
  const propre = String(texte || "").trim().slice(0, 2000);
  if (!propre) {
    ouvre().prepare("DELETE FROM annotations WHERE colis_id = ?").run(colisId);
    return null;
  }
  ouvre()
    .prepare("INSERT INTO annotations (colis_id, texte, modifie_le) VALUES (?, ?, ?) ON CONFLICT(colis_id) DO UPDATE SET texte = excluded.texte, modifie_le = excluded.modifie_le")
    .run(colisId, propre, maintenant());
  return annotation(colisId);
}

// --- Categories -------------------------------------------------------------------------

const COULEURS = ["violet", "bleu", "turquoise", "vert", "jaune", "orange", "rose", "rouge", "gris"];

const categorieLue = (c) => (c ? { id: c.id, nom: c.nom, couleur: c.couleur } : null);

function categories() {
  return ouvre()
    .prepare(
      `SELECT c.id, c.nom, c.couleur, COUNT(cc.colis_id) AS n FROM categories c
       LEFT JOIN colis_categories cc ON cc.categorie_id = c.id GROUP BY c.id ORDER BY c.nom COLLATE NOCASE`
    )
    .all()
    .map((c) => ({ ...categorieLue(c), etiquettes: c.n }));
}

const categorie = (id) => categorieLue(ouvre().prepare("SELECT * FROM categories WHERE id = ?").get(id));

function nomPropre(nom) {
  // eslint-disable-next-line no-control-regex -- on retire justement les caracteres de controle
  return String(nom || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

/** Cree une categorie : { categorie } ou { erreur }. */
function creeCategorie(nom, couleur) {
  const propre = nomPropre(nom);
  if (!propre) return { erreur: "Donne un nom à la catégorie." };
  const c = COULEURS.includes(couleur) ? couleur : COULEURS[categories().length % COULEURS.length];
  try {
    const r = ouvre().prepare("INSERT INTO categories (nom, couleur, cree_le) VALUES (?, ?, ?)").run(propre, c, maintenant());
    return { categorie: categorie(Number(r.lastInsertRowid)) };
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return { erreur: "Cette catégorie existe déjà." };
    throw err;
  }
}

function modifieCategorie(id, { nom, couleur } = {}) {
  if (!categorie(id)) return { erreur: "Catégorie introuvable.", status: 404 };
  if (nom !== undefined) {
    const propre = nomPropre(nom);
    if (!propre) return { erreur: "Donne un nom à la catégorie." };
    try {
      ouvre().prepare("UPDATE categories SET nom = ? WHERE id = ?").run(propre, id);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) return { erreur: "Cette catégorie existe déjà." };
      throw err;
    }
  }
  if (couleur !== undefined && COULEURS.includes(couleur)) ouvre().prepare("UPDATE categories SET couleur = ? WHERE id = ?").run(couleur, id);
  return { categorie: categorie(id) };
}

/** Supprime une categorie : ses etiquettes restent, simplement sans categorie. */
function supprimeCategorie(id) {
  return ouvre().prepare("DELETE FROM categories WHERE id = ?").run(id).changes > 0;
}

/** Classe (ou declasse, null) une etiquette. */
function classe(colisId, categorieId) {
  if (categorieId == null) {
    ouvre().prepare("DELETE FROM colis_categories WHERE colis_id = ?").run(colisId);
    return null;
  }
  if (!categorie(categorieId)) return undefined;
  ouvre()
    .prepare("INSERT INTO colis_categories (colis_id, categorie_id, classe_le) VALUES (?, ?, ?) ON CONFLICT(colis_id) DO UPDATE SET categorie_id = excluded.categorie_id, classe_le = excluded.classe_le")
    .run(colisId, categorieId, maintenant());
  return categorie(categorieId);
}

/** colis_id -> categorie, pour une liste d'etiquettes. */
function categoriesDesColis() {
  const parId = new Map(ouvre().prepare("SELECT * FROM categories").all().map((c) => [c.id, categorieLue(c)]));
  return new Map(ouvre().prepare("SELECT colis_id, categorie_id FROM colis_categories").all().map((r) => [r.colis_id, parId.get(r.categorie_id) || null]));
}

/** Les colis d'une categorie. */
const colisDeLaCategorie = (id) => ouvre().prepare("SELECT colis_id FROM colis_categories WHERE categorie_id = ?").all(id).map((r) => r.colis_id);
const colisClasses = () => ouvre().prepare("SELECT colis_id FROM colis_categories").all().map((r) => r.colis_id);

// --- Documents de travail (editeur) ---------------------------------------------------------

function travail(colisId) {
  const t = ouvre().prepare("SELECT modele, modifie_le FROM travaux WHERE colis_id = ?").get(colisId);
  return t ? { modele: JSON.parse(t.modele), modifieLe: t.modifie_le } : null;
}

function gardeTravail(colisId, modele) {
  const quand = maintenant();
  ouvre()
    .prepare("INSERT INTO travaux (colis_id, modele, modifie_le) VALUES (?, ?, ?) ON CONFLICT(colis_id) DO UPDATE SET modele = excluded.modele, modifie_le = excluded.modifie_le")
    .run(colisId, JSON.stringify(modele), quand);
  return { modifieLe: quand };
}

const effaceTravail = (colisId) => ouvre().prepare("DELETE FROM travaux WHERE colis_id = ?").run(colisId).changes > 0;

const resumeFichiers = () => ouvre().prepare("SELECT empreinte, type, pages, version, erreur, analyse_le FROM fichiers").all();

module.exports = {
  ouvre,
  ferme,
  chemin,
  norme,
  fichier,
  enregistreAnalyse,
  lien,
  lie,
  noteEchec,
  empreinteDuFileId,
  tousLesLiens,
  codesIndexes,
  nombreCodes,
  resumeCodes,
  resumeFichiers,
  annotation,
  annote,
  COULEURS,
  categories,
  categorie,
  creeCategorie,
  modifieCategorie,
  supprimeCategorie,
  classe,
  categoriesDesColis,
  colisDeLaCategorie,
  colisClasses,
  travail,
  gardeTravail,
  effaceTravail,
};
