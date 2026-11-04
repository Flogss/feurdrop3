// Les boites aux lettres de rue de La Poste : le jeu de donnees ouvertes
// « laposte-boiterue » (data.laposte.fr, licence ODbL) -- identifiant,
// adresse, coordonnees GPS et heure limite de depot (semaine, samedi).
//
// Une copie locale, dans une petite base SQLite a cote de celle de FeurDrop
// (jamais dans la base principale : elle se retelecharge, elle n'a pas a
// grossir les sauvegardes). Le fichier (13 Mo, 111 726 boites) n'est
// retelecharge que quand La Poste publie une nouvelle version : une fois par
// jour, seules les metadonnees sont relues. Sans copie (premier lancement,
// telechargement en echec), la recherche interroge l'API du jeu de donnees
// directement, autour du point demande.
//
// La cle de l'API open data (LAPOSTE_OPENDATA_KEY), si elle est configuree,
// part en en-tete x-apiKey ; le jeu est public, elle n'est pas obligatoire.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { cheminBase } = require("../db/connexion");

const SOURCE = () => (process.env.BOITES_SOURCE_URL || "https://data.laposte.fr/data-fair/api/v1/datasets/laposte-boiterue").replace(/\/+$/, "");
const UN_JOUR = 24 * 3600 * 1000;

// France metropolitaine et outre-mer : une coordonnee hors de ces cadres est fausse
const CADRES = [
  { lat: [41, 51.6], lon: [-5.5, 10] }, // metropole et Corse
  { lat: [15.8, 16.6], lon: [-61.9, -60.9] }, // Guadeloupe
  { lat: [14.3, 14.9], lon: [-61.3, -60.7] }, // Martinique
  { lat: [2, 6], lon: [-54.7, -51.5] }, // Guyane
  { lat: [-21.5, -20.8], lon: [55.1, 55.9] }, // La Reunion
  { lat: [-13.1, -12.6], lon: [44.9, 45.4] }, // Mayotte
  { lat: [17.8, 18.2], lon: [-63.2, -62.7] }, // Saint-Martin, Saint-Barthelemy
  { lat: [46.7, 47.2], lon: [-56.5, -56.1] }, // Saint-Pierre-et-Miquelon
];
const dansUnCadre = (lat, lon) => CADRES.some((c) => lat >= c.lat[0] && lat <= c.lat[1] && lon >= c.lon[0] && lon <= c.lon[1]);
// moins de 4 decimales : la position est a 10 m pres au mieux, souvent bien pire
const decimales = (texte) => (String(texte).split(/[.,]/)[1] || "").length;

function entetes() {
  const h = { "User-Agent": "FeurDrop/1.0 (itineraire boites jaunes)", Accept: "*/*" };
  if (process.env.LAPOSTE_OPENDATA_KEY) h["x-apiKey"] = process.env.LAPOSTE_OPENDATA_KEY;
  return h;
}

// Un appel au jeu de donnees. Une cle refusee (401/403) n'empeche rien : le
// jeu est public, on reessaie sans.
async function appelSource(url, { delai = 30000 } = {}) {
  let r = await fetch(url, { headers: entetes(), signal: AbortSignal.timeout(delai) });
  if ((r.status === 401 || r.status === 403) && process.env.LAPOSTE_OPENDATA_KEY) {
    console.warn("[boites] cle LAPOSTE_OPENDATA_KEY refusee : le jeu public est lu sans");
    const { "x-apiKey": _cle, ...sans } = entetes();
    r = await fetch(url, { headers: sans, signal: AbortSignal.timeout(delai) });
  }
  if (!r.ok) throw new Error(`données La Poste : HTTP ${r.status}`);
  return r;
}

// --- La copie locale ------------------------------------------------------------

let base = null;
let cheminOuvert = null;

function cheminCopie() {
  if (process.env.BOITES_DB_PATH) return process.env.BOITES_DB_PATH;
  const principale = cheminBase().chemin;
  return path.join(path.dirname(principale === ":memory:" ? "./data/x" : principale), "boites-rue.db");
}

function ouvre() {
  const chemin = cheminCopie();
  if (base && cheminOuvert === chemin) return base;
  if (base) base.close();
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  base = new DatabaseSync(chemin);
  cheminOuvert = chemin;
  base.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS boites (
      id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL,
      numero TEXT, voie TEXT, commune TEXT, cp TEXT,
      limite_semaine TEXT, limite_samedi TEXT, imprecise INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS boites_lat ON boites(lat);
    CREATE TABLE IF NOT EXISTS meta (cle TEXT PRIMARY KEY, valeur TEXT);
  `);
  return base;
}

function ferme() {
  if (base) base.close();
  base = null;
  cheminOuvert = null;
}

const meta = (cle) => ouvre().prepare("SELECT valeur FROM meta WHERE cle = ?").get(cle)?.valeur ?? null;
const metaPose = (cle, valeur) => ouvre().prepare("INSERT INTO meta (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").run(cle, String(valeur));
const nombreBoites = () => ouvre().prepare("SELECT COUNT(*) AS n FROM boites").get().n;

function etat() {
  return {
    boites: nombreBoites(),
    imprecises: ouvre().prepare("SELECT COUNT(*) AS n FROM boites WHERE imprecise = 1").get().n,
    ecartees: Number(meta("ecartees") || 0),
    miseAJourSource: meta("source_maj"),
    importeLe: meta("importe_le"),
    verifieLe: meta("verifie_le"),
  };
}

// --- Lecture du fichier ------------------------------------------------------------

// « T09:00:00+00:00 » -> « 09:00 » (l'heure locale du bureau, malgre le +00:00)
function heureLimite(brut) {
  const m = String(brut || "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

const propre = (v) => {
  const t = String(v ?? "").trim();
  return !t || t.toUpperCase() === "NULL" ? null : t;
};

// Une ligne du fichier en boite, ou null si sa position est inutilisable.
function boiteDeLigne(c) {
  const id = propre(c.CO_MUP ?? c.co_mup);
  const x = String(c.VA_COORD_ADR_X ?? c.va_coord_adr_x ?? "").replace(",", ".");
  const y = String(c.VA_COORD_ADR_Y ?? c.va_coord_adr_y ?? "").replace(",", ".");
  const lon = Number(x);
  const lat = Number(y);
  if (!id || !x || !y || !Number.isFinite(lat) || !Number.isFinite(lon) || !dansUnCadre(lat, lon)) return null;
  return {
    id,
    lat,
    lon,
    numero: propre(c.VA_NO_VOIE ?? c.va_no_voie),
    extension: propre(c.LB_EXTENSION ?? c.lb_extension),
    voie: propre(c.LB_VOIE_EXT ?? c.lb_voie_ext),
    commune: propre(c.LB_COM ?? c.lb_com),
    cp: propre(c.CO_POSTAL ?? c.co_postal)?.padStart(5, "0") ?? null,
    limiteSemaine: heureLimite(c.HDL_SEMAINE_EXTRA ?? c.hdl_semaine_extra),
    limiteSamedi: heureLimite(c.HDL_SAMEDI_EXTRA ?? c.hdl_samedi_extra),
    imprecise: decimales(x) < 4 || decimales(y) < 4,
  };
}

// Les champs d'une ligne CSV (separateur « ; », guillemets doubles).
function champs(ligne) {
  const sortie = [];
  let courant = "";
  let entre = false;
  for (let i = 0; i < ligne.length; i += 1) {
    const ch = ligne[i];
    if (entre) {
      if (ch === '"' && ligne[i + 1] === '"') {
        courant += '"';
        i += 1;
      } else if (ch === '"') entre = false;
      else courant += ch;
    } else if (ch === '"') entre = true;
    else if (ch === ";") {
      sortie.push(courant);
      courant = "";
    } else courant += ch;
  }
  sortie.push(courant);
  return sortie;
}

// Telecharge le fichier et le range dans une table neuve, qui remplace
// l'ancienne d'un coup : une recherche pendant l'import lit l'ancienne.
async function importe(urlFichier) {
  const r = await appelSource(urlFichier, { delai: 180000 });
  const db = ouvre();
  db.exec(`
    DROP TABLE IF EXISTS boites_neuves;
    CREATE TABLE boites_neuves (
      id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL,
      numero TEXT, voie TEXT, commune TEXT, cp TEXT,
      limite_semaine TEXT, limite_samedi TEXT, imprecise INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insere = db.prepare(
    `INSERT OR IGNORE INTO boites_neuves (id, lat, lon, numero, voie, commune, cp, limite_semaine, limite_samedi, imprecise)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // le fichier est en ISO-8859-1 : decode au fil de l'eau, ligne a ligne
  const decodeur = new TextDecoder("latin1");
  let reste = "";
  let entete = null;
  let lues = 0;
  let ecartees = 0;
  const range = (ligne) => {
    if (!ligne.trim()) return;
    const valeurs = champs(ligne);
    if (!entete) {
      entete = valeurs.map((v) => v.trim());
      return;
    }
    lues += 1;
    const b = boiteDeLigne(Object.fromEntries(entete.map((k, i) => [k, valeurs[i]])));
    if (!b) {
      ecartees += 1;
      return;
    }
    const voie = [b.extension, b.voie].filter(Boolean).join(" ") || null;
    insere.run(b.id, b.lat, b.lon, b.numero, voie, b.commune, b.cp, b.limiteSemaine, b.limiteSamedi, b.imprecise ? 1 : 0);
  };
  db.exec("BEGIN");
  try {
    for await (const morceau of r.body) {
      reste += decodeur.decode(morceau, { stream: true });
      const lignes = reste.split(/\r?\n/);
      reste = lignes.pop();
      for (const l of lignes) range(l);
    }
    reste += decodeur.decode();
    range(reste);
    if (lues === 0 || !entete?.includes("CO_MUP")) throw new Error("fichier des boîtes illisible");
    // Plusieurs boites d'adresses differentes posees sur le meme point : la
    // position est celle d'un centre (rue, commune), pas des boites.
    db.exec(`
      UPDATE boites_neuves SET imprecise = 1 WHERE (round(lat, 5), round(lon, 5)) IN (
        SELECT round(lat, 5), round(lon, 5) FROM boites_neuves
        GROUP BY round(lat, 5), round(lon, 5)
        HAVING COUNT(*) >= 3 AND COUNT(DISTINCT COALESCE(numero, '') || ' ' || COALESCE(voie, '')) >= 2
      );
      DROP TABLE boites;
      ALTER TABLE boites_neuves RENAME TO boites;
      CREATE INDEX IF NOT EXISTS boites_lat ON boites(lat);
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.exec("DROP TABLE IF EXISTS boites_neuves");
    throw err;
  }
  metaPose("ecartees", ecartees);
  metaPose("importe_le", new Date().toISOString());
  return { lues, gardees: lues - ecartees, ecartees };
}

// Relit les metadonnees ; retelecharge si La Poste a publie une autre version
// (ou si la copie est vide). Un seul a la fois.
let enCours = null;
function actualise({ force = false } = {}) {
  if (enCours) return enCours;
  enCours = (async () => {
    const r = await appelSource(SOURCE(), { delai: 20000 });
    const d = await r.json();
    const fichier = d.storage?.dataFiles?.find((f) => f.key === "original") || d.storage?.dataFiles?.[0];
    const empreinte = d.file?.md5 || d.dataUpdatedAt || fichier?.updatedAt || null;
    metaPose("verifie_le", new Date().toISOString());
    if (!force && nombreBoites() > 0 && empreinte && empreinte === meta("empreinte")) return { change: false, ...etat() };
    if (!fichier?.name) throw new Error("données La Poste : fichier introuvable dans les métadonnées");
    const bilan = await importe(`${SOURCE()}/data-files/${encodeURIComponent(fichier.name)}`);
    if (empreinte) metaPose("empreinte", empreinte);
    if (d.dataUpdatedAt) metaPose("source_maj", d.dataUpdatedAt);
    console.log(`[boites] copie La Poste a jour : ${bilan.gardees} boites (${bilan.ecartees} sans position utilisable)`);
    return { change: true, ...bilan, ...etat() };
  })().finally(() => {
    enCours = null;
  });
  return enCours;
}

// Au demarrage du serveur : une premiere verification un peu apres, puis une
// fois par jour (les metadonnees seulement, le fichier si La Poste l'a change).
function demarreActualisation() {
  const essaie = () =>
    actualise().catch((err) => console.warn(`[boites] actualisation impossible : ${err.message}`));
  setTimeout(essaie, 45 * 1000).unref();
  setInterval(essaie, UN_JOUR).unref();
}

// --- Recherche -------------------------------------------------------------------

const RAYON_TERRE = 6371008.8;
function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * RAYON_TERRE * Math.asin(Math.min(1, Math.sqrt(h)));
}

const versBoite = (r) => ({
  id: r.id,
  lat: r.lat,
  lon: r.lon,
  adresse: [r.numero, r.voie].filter(Boolean).join(" ") || null,
  commune: r.commune || null,
  cp: r.cp || null,
  limiteSemaine: r.limite_semaine || null,
  limiteSamedi: r.limite_samedi || null,
  imprecise: Boolean(r.imprecise),
});

function autourDansLaCopie(centre, rayonM) {
  const dLat = rayonM / 111320;
  const dLon = rayonM / (111320 * Math.max(0.1, Math.cos((centre.lat * Math.PI) / 180)));
  return ouvre()
    .prepare("SELECT * FROM boites WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?")
    .all(centre.lat - dLat, centre.lat + dLat, centre.lon - dLon, centre.lon + dLon)
    .map(versBoite);
}

// Sans copie locale : l'API du jeu de donnees, autour du point (10 000 au plus).
async function autourParLApi(centre, rayonM) {
  const url = `${SOURCE()}/lines?geo_distance=${centre.lon},${centre.lat},${Math.round(rayonM)}&size=10000`;
  const r = await appelSource(url, { delai: 30000 });
  const d = await r.json();
  const boites = [];
  for (const ligne of d.results || []) {
    const b = boiteDeLigne(ligne);
    if (b) boites.push(versBoite({ ...b, limite_semaine: b.limiteSemaine, limite_samedi: b.limiteSamedi, voie: [b.extension, b.voie].filter(Boolean).join(" ") }));
  }
  // la meme regle que l'import : plusieurs adresses sur un meme point
  const groupes = new Map();
  for (const b of boites) {
    const cle = `${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(b);
  }
  for (const g of groupes.values()) {
    if (g.length >= 3 && new Set(g.map((b) => b.adresse)).size >= 2) for (const b of g) b.imprecise = true;
  }
  return boites;
}

/**
 * Les boites dans le rayon, de la plus proche a la plus loin (a vol
 * d'oiseau), avec leur distance. `imprecises` : celles ecartees parce que
 * leur position n'est pas fiable.
 */
async function boitesAutour(centre, rayonM) {
  let brutes;
  let source = "copie";
  if (nombreBoites() === 0) {
    // premier passage : on tente la copie, sinon l'API autour du point
    try {
      await actualise();
    } catch (err) {
      console.warn(`[boites] copie indisponible (${err.message}) : lecture directe`);
    }
  }
  if (nombreBoites() > 0) brutes = autourDansLaCopie(centre, rayonM);
  else {
    brutes = await autourParLApi(centre, rayonM);
    source = "api";
  }
  const dansLeRayon = brutes.map((b) => ({ ...b, distanceM: distanceM(centre, b) })).filter((b) => b.distanceM <= rayonM);
  const imprecises = dansLeRayon.filter((b) => b.imprecise).length;
  return {
    boites: dansLeRayon.filter((b) => !b.imprecise).sort((a, b) => a.distanceM - b.distanceM),
    imprecises,
    source,
    miseAJourSource: source === "copie" ? meta("source_maj") : null,
  };
}

module.exports = {
  boitesAutour,
  actualise,
  demarreActualisation,
  etat,
  ferme,
  distanceM,
  heureLimite,
  boiteDeLigne,
  champs,
};
