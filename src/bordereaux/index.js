const crypto = require("crypto");
const { db, getColisById } = require("../db");
const { suiviDuColis, trouveSuivi, TRANSPORTEURS } = require("../suiviColis");
const { carrierLabel } = require("../carrier");
const { avecReessais } = require("../throttle");
const { compare } = require("../../public/portail-recherche");
const base = require("./base");
const { analyseFichier, VERSION_ANALYSE } = require("./analyse");
const { typeDeFichier, TYPES_MIME } = require("./rendu");
const { ErreurLecteur } = require("./decodeur");

// Etude des bordereaux : les etiquettes deja dans FeurDrop (le file_id
// Telegram de chaque colis -- aucun second stockage des fichiers), leurs
// codes lus une fois puis indexes (base.js), la recherche d'un numero.
//
// Les fichiers d'origine ne sont JAMAIS modifies : ils sont lus (telecharges
// depuis Telegram comme pour l'impression), analyses en memoire, et servis
// tels quels a la visionneuse. Ni l'impression ni la reception des
// etiquettes ne passent par ici.

// --- Les fichiers (Telegram), gardes un moment en memoire ---------------------------

const CACHE_MAX_OCTETS = Number(process.env.BORDEREAUX_CACHE_OCTETS || 24 * 1024 * 1024);
const CACHE_DUREE_MS = 10 * 60 * 1000;
const cache = new Map(); // file_id -> { octets, empreinte, type, quand }
const telechargements = new Map(); // file_id -> promesse en cours

function rangeEnCache(fileId, entree) {
  cache.delete(fileId);
  cache.set(fileId, entree);
  let total = 0;
  for (const e of cache.values()) total += e.octets.length;
  for (const [cle, e] of cache) {
    if (total <= CACHE_MAX_OCTETS || cache.size <= 1) break;
    total -= e.octets.length;
    cache.delete(cle);
  }
}

/** { octets, empreinte, type } d'un fichier Telegram (cache memoire 10 min). */
async function telecharge(fileId) {
  const deja = cache.get(fileId);
  if (deja && Date.now() - deja.quand < CACHE_DUREE_MS) {
    rangeEnCache(fileId, deja); // le plus recent reste
    return deja;
  }
  if (telechargements.has(fileId)) return telechargements.get(fileId);
  const promesse = (async () => {
    const bot = require("../bot").getBot();
    if (!bot) throw new Error("le bot Telegram n'est pas démarré : fichier inaccessible");
    const octets = await avecReessais(
      async () => {
        const lien = await bot.getFileLink(fileId);
        const res = await fetch(lien);
        if (!res.ok) {
          const err = new Error(res.status === 404 ? "fichier introuvable sur Telegram" : `Telegram : HTTP ${res.status}`);
          err.response = { statusCode: res.status };
          throw err;
        }
        return new Uint8Array(await res.arrayBuffer());
      },
      { essais: 3 }
    );
    const entree = {
      octets,
      empreinte: crypto.createHash("sha256").update(octets).digest("hex"),
      type: typeDeFichier(octets),
      quand: Date.now(),
    };
    rangeEnCache(fileId, entree);
    return entree;
  })();
  telechargements.set(fileId, promesse);
  try {
    return await promesse;
  } finally {
    telechargements.delete(fileId);
  }
}

// --- Le role d'un code sur son etiquette -------------------------------------------
// Jamais « tous les codes sont le numero de suivi » : chaque code est classe
// d'apres sa valeur.
//   suivi           exactement le numero de suivi du colis ;
//   suivi-probable  la forme d'un numero de suivi d'un transporteur (le colis
//                   n'en a pas d'autre de connu, ou celui-ci en differe) ;
//   contient-suivi  contient le numero du colis (code de tri, donnees 2D) ;
//   lien            une adresse web ;
//   donnees         des donnees structurees (norme ISO 15434 : « [)> ») ;
//   autre / illisible.

function roleDu(code, colis, suivi) {
  if (!code.lisible) return { role: "illisible" };
  const valeur = String(code.valeur || "");
  const n = base.norme(valeur);
  const numero = suivi ? base.norme(suivi.numero) : "";
  if (numero && n === numero) return { role: "suivi", suivi };
  if (/^https?:\/\//i.test(valeur.trim())) return { role: "lien", lien: valeur.trim(), contientSuivi: Boolean(numero && n.includes(numero)) };
  if (numero && numero.length >= 8 && n.includes(numero)) return { role: "contient-suivi", suivi };
  if (valeur.startsWith("[)>")) return { role: "donnees" };
  // un code a la forme d'un numero de suivi (meme regles que le portail)
  if (code.famille === "1D" && n.length >= 8 && n.length <= 30) {
    const trouve = trouveSuivi({ file_name: n, carrier: colis?.carrier || null, type: colis?.type });
    if (trouve && base.norme(trouve.numero) === n) {
      const t = TRANSPORTEURS[trouve.code];
      return {
        role: "suivi-probable",
        suivi: { numero: trouve.numero, transporteur: trouve.code, nom: t.nom, lien: t.lien ? t.lien(encodeURIComponent(trouve.numero)) : null, page: t.page },
      };
    }
  }
  return { role: "autre" };
}

// --- Le colis, vu par la page ------------------------------------------------------

function etapeDe(c) {
  if (c.status === "dropped") return "depose";
  return c.printed_at ? "imprime" : "a_imprimer";
}

function resumeColis(c) {
  const suivi = suiviDuColis(c);
  return {
    id: c.id,
    expediteur: c.sender_name,
    transporteur: c.carrier ? { code: c.carrier, nom: carrierLabel(c.carrier) } : null,
    type: c.type,
    fichier: c.file_name || null,
    genre: c.file_kind === "image" ? "image" : "pdf",
    recuLe: c.created_at,
    imprimeLe: c.printed_at,
    deposeLe: c.dropped_at,
    etape: etapeDe(c),
    redrop: Boolean(c.redrop_de),
    suivi,
  };
}

// --- Analyse -----------------------------------------------------------------------

const enCours = new Map(); // colis_id -> promesse
let demandesEnCours = 0; // analyses demandees depuis la page (prioritaires)

/** L'analyse a jour d'un fichier deja connu, ou null. */
function analyseConnue(empreinte) {
  const f = empreinte ? base.fichier(empreinte) : null;
  return f && f.version === VERSION_ANALYSE ? f : null;
}

/**
 * Analyse l'etiquette d'un colis (ou rend celle deja faite) : le fichier
 * n'est telecharge et lu qu'une fois ; un meme fichier partage par plusieurs
 * colis (redrop) n'est lu qu'une fois. `force` : relire quand meme.
 */
function analyseColis(colisId, { force = false, fond = false } = {}) {
  const cle = `${colisId}`;
  if (enCours.has(cle) && !force) return enCours.get(cle);
  const promesse = (async () => {
    if (!fond) demandesEnCours += 1;
    try {
      const colis = getColisById(colisId);
      if (!colis || !colis.file_id) throw Object.assign(new Error("ce colis n'a pas d'étiquette"), { status: 404 });
      if (!force) {
        const lien = base.lien(colis.id);
        const connue = lien && lien.file_id === colis.file_id ? analyseConnue(lien.empreinte) : null;
        if (connue) return connue;
        const partagee = analyseConnue(base.empreinteDuFileId(colis.file_id));
        if (partagee) {
          base.lie(colis.id, colis.file_id, partagee.empreinte);
          return partagee;
        }
      }
      let fichier;
      try {
        fichier = await telecharge(colis.file_id);
      } catch (err) {
        base.noteEchec(colis.id, colis.file_id, err.message);
        throw err;
      }
      if (!force) {
        const memeFichier = analyseConnue(fichier.empreinte);
        if (memeFichier) {
          base.lie(colis.id, colis.file_id, fichier.empreinte);
          return memeFichier;
        }
      }
      let analyse;
      try {
        analyse = await analyseFichier(fichier.octets);
      } catch (err) {
        // le lecteur lui-meme a cale (trop long, arrete) : rien n'est retenu,
        // on reessaiera ; un fichier illisible, lui, est note comme tel
        if (err instanceof ErreurLecteur) throw err;
        analyse = { type: fichier.type || "inconnu", pages: [], nombrePages: 0, version: VERSION_ANALYSE, erreur: err.message, dureeMs: null };
      }
      base.enregistreAnalyse(fichier.empreinte, fichier.octets.length, analyse);
      base.lie(colis.id, colis.file_id, fichier.empreinte);
      return base.fichier(fichier.empreinte);
    } finally {
      if (!fond) demandesEnCours -= 1;
    }
  })();
  enCours.set(cle, promesse);
  promesse.finally(() => enCours.get(cle) === promesse && enCours.delete(cle)).catch(() => {});
  return promesse;
}

// L'analyse, telle que la page l'affiche : pages, codes et role de chacun.
function vueAnalyse(f, colis, suivi) {
  if (!f) return { etat: "attente" };
  const pages = [];
  for (let i = 0; i < Math.max(f.pages_lues, f.formats.length); i += 1) {
    const [largeur, hauteur] = f.formats[i] || [null, null];
    pages.push({ page: i + 1, largeur, hauteur, codes: [] });
  }
  for (const c of f.codes) {
    const page = pages[c.page - 1];
    if (page) page.codes.push({ ...c, ...roleDu(c, colis, suivi) });
  }
  return {
    etat: f.erreur ? "erreur" : "analyse",
    erreur: f.erreur || null,
    empreinte: f.empreinte,
    type: f.type,
    octets: f.octets,
    nombrePages: f.pages,
    partiel: f.pages > f.pages_lues,
    analyseLe: f.analyse_le,
    dureeMs: f.duree_ms,
    lisibles: f.codes.filter((c) => c.lisible).length,
    illisibles: f.codes.filter((c) => !c.lisible).length,
    pages,
  };
}

/** Tout ce que la page montre d'une etiquette (sans la relire). */
function detail(colisId) {
  const colis = getColisById(colisId);
  if (!colis || !colis.file_id) return null;
  const lien = base.lien(colis.id);
  const f = lien && lien.file_id === colis.file_id && lien.empreinte ? base.fichier(lien.empreinte) : null;
  const resume = resumeColis(colis);
  const analyse = f && f.version === VERSION_ANALYSE ? vueAnalyse(f, colis, resume.suivi) : { etat: lien?.erreur ? "echec" : "attente", erreur: lien?.erreur || null };
  return { colis: resume, note: colis.note || null, annotation: base.annotation(colis.id), categorie: base.categoriesDesColis().get(colis.id) || null, analyse };
}

async function analyseEtDetail(colisId, options) {
  await analyseColis(colisId, options);
  return detail(colisId);
}

/** Les octets d'origine d'une etiquette, tels quels. */
async function fichierOriginal(colisId) {
  const colis = getColisById(colisId);
  if (!colis || !colis.file_id) return null;
  const f = await telecharge(colis.file_id);
  return { ...f, mime: TYPES_MIME[f.type] || "application/octet-stream", nom: colis.file_name || null };
}

/** L'empreinte deja connue du fichier d'un colis (pour les ETag), sans le telecharger. */
function empreinteConnue(colisId) {
  const colis = getColisById(colisId);
  const lien = colis ? base.lien(colis.id) : null;
  return lien && colis && lien.file_id === colis.file_id ? lien.empreinte : null;
}

// --- Liste ---------------------------------------------------------------------------

const FILTRES = {
  tous: "",
  a_imprimer: " AND status = 'pending' AND printed_at IS NULL",
  imprimes: " AND status = 'pending' AND printed_at IS NOT NULL",
  deposes: " AND status = 'dropped'",
};

function etatIndex(c, liens, resumes, fichiers) {
  const l = liens.get(c.id);
  if (!l || l.file_id !== c.file_id) return { etat: "attente" };
  if (!l.empreinte) return { etat: "echec", erreur: l.erreur };
  const f = fichiers.get(l.empreinte);
  if (!f || f.version !== VERSION_ANALYSE) return { etat: "attente" };
  if (f.erreur) return { etat: "erreur", erreur: f.erreur };
  const r = resumes.get(l.empreinte) || { lisibles: 0, illisibles: 0 };
  return { etat: "analyse", pages: f.pages, lisibles: r.lisibles || 0, illisibles: r.illisibles || 0 };
}

const TRIS = {
  recent: "id DESC",
  ancien: "id ASC",
  // par transporteur (nom affiche), puis du plus recent au plus ancien
  transporteur: "transporteur_tri ASC, id DESC",
};

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

// Les conditions communes a la liste et a ses compteurs.
function conditions({ filtre = "tous", q = "", transporteur = null, depuis = null, jusqua = null, categorie = null } = {}) {
  let sql = ` WHERE file_id IS NOT NULL AND file_id != ''${FILTRES[filtre] ?? ""}`;
  const params = [];
  const texte = String(q || "").trim();
  if (texte) {
    sql += " AND (sender_name LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\' OR caption LIKE ? ESCAPE '\\')";
    const motif = `%${texte.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(motif, motif, motif);
  }
  if (transporteur === "aucun") sql += " AND (carrier IS NULL OR carrier = '')";
  else if (transporteur) {
    sql += " AND carrier = ?";
    params.push(String(transporteur).slice(0, 20));
  }
  // les jours sont ceux de Paris (une etiquette recue a 0 h 30 compte pour ce jour-la)
  if (JOUR.test(depuis || "")) {
    sql += " AND jour_paris(created_at) >= ?";
    params.push(depuis);
  }
  if (JOUR.test(jusqua || "")) {
    sql += " AND jour_paris(created_at) <= ?";
    params.push(jusqua);
  }
  if (categorie === "aucune") {
    sql += " AND id NOT IN (SELECT value FROM json_each(?))";
    params.push(JSON.stringify(base.colisClasses()));
  } else if (Number.isInteger(categorie) && categorie > 0) {
    sql += " AND id IN (SELECT value FROM json_each(?))";
    params.push(JSON.stringify(base.colisDeLaCategorie(categorie)));
  }
  return { sql, params };
}

/**
 * Les etiquettes, par pages de `limite` : filtrees (etape, texte,
 * transporteur, a partir d'un jour, categorie) et triees (plus recentes,
 * plus anciennes, par transporteur). `decalage` : la suite (`avant`, l'ancien
 * curseur par id, reste compris pour le tri par defaut).
 */
function liste(options = {}) {
  const { avant = null, limite = 60, tri = "recent" } = options;
  const decalage = Number.isInteger(options.decalage) && options.decalage > 0 ? options.decalage : 0;
  const ordre = TRIS[tri] || TRIS.recent;
  const { sql: ou, params } = conditions(options);
  let sql = ou;
  const p = [...params];
  if (Number.isInteger(avant) && avant > 0 && tri === "recent" && !decalage) {
    sql += " AND id < ?";
    p.push(avant);
  }
  // le nom du transporteur (pas son code) pour le tri : « Chronopost » avant « DPD »
  const noms = Object.fromEntries(db.prepare("SELECT DISTINCT carrier FROM colis WHERE carrier IS NOT NULL").all().map((r) => [r.carrier, carrierLabel(r.carrier)]));
  const casNom = Object.keys(noms).length
    ? `CASE carrier ${Object.keys(noms).map(() => "WHEN ? THEN ?").join(" ")} ELSE 'zzz' END`
    : "'zzz'";
  const pNoms = Object.entries(noms).flat();
  const lignes = db
    .prepare(`SELECT *, ${casNom} AS transporteur_tri FROM colis${sql} ORDER BY ${ordre} LIMIT ? OFFSET ?`)
    .all(...pNoms, ...p, limite + 1, decalage);
  const plus = lignes.length > limite;
  const page = lignes.slice(0, limite);
  const liens = new Map(base.tousLesLiens().map((l) => [l.colis_id, l]));
  const resumes = new Map(base.resumeCodes().map((r) => [r.empreinte, r]));
  const fichiers = new Map(base.resumeFichiers().map((f) => [f.empreinte, f]));
  const classees = base.categoriesDesColis();
  // les transporteurs presents (avec les autres filtres) : le choix du filtre
  const sansTransporteur = conditions({ ...options, transporteur: null });
  const transporteurs = db
    .prepare(`SELECT carrier, COUNT(*) AS n FROM colis${sansTransporteur.sql} GROUP BY carrier ORDER BY n DESC`)
    .all(...sansTransporteur.params)
    .map((r) => ({ code: r.carrier || "aucun", nom: r.carrier ? carrierLabel(r.carrier) : "Sans transporteur", n: r.n }));
  return {
    bordereaux: page.map((c) => ({ ...resumeColis(c), categorie: classees.get(c.id) || null, index: etatIndex(c, liens, resumes, fichiers) })),
    // la suite : un decalage (tous les tris), et l'ancien curseur pour le tri par defaut
    suite: plus ? (tri === "recent" && !decalage ? page[page.length - 1].id : null) : null,
    decalageSuivant: plus ? decalage + limite : null,
    total: db.prepare(`SELECT COUNT(*) AS n FROM colis${ou}`).get(...params).n,
    transporteurs,
    categories: base.categories(),
  };
}

// --- Recherche ---------------------------------------------------------------------
// Dans les codes lus sur les etiquettes ET dans les numeros de suivi des colis
// (nom du fichier, legende : une etiquette pas encore analysee se retrouve
// aussi). Meme algorithme que l'espace expediteur : numero entier, debut, fin,
// morceau, une lettre lue pour un chiffre, une ou deux fautes de frappe.

const numerosDesColis = new Map(); // id -> { cle, numero }

function numeroDuColis(c) {
  const cle = `${c.file_name}|${c.caption}|${c.carrier}|${c.type}`;
  const deja = numerosDesColis.get(c.id);
  if (deja && deja.cle === cle) return deja.numero;
  const numero = trouveSuivi(c)?.numero || null;
  numerosDesColis.set(c.id, { cle, numero });
  return numero;
}

const MAX_RESULTATS = 60;

function recherche(q) {
  const requete = base.norme(q);
  if (requete.length < 3) return { requete, resultats: [], total: 0 };
  const parColis = new Map(); // id -> { score, correspondances }
  const note = (colisId, correspondance) => {
    let r = parColis.get(colisId);
    if (!r) parColis.set(colisId, (r = { score: 0, correspondances: [] }));
    r.score = Math.max(r.score, correspondance.score);
    // une meme valeur trouvee a deux endroits de la meme page : une fois
    if (!r.correspondances.some((x) => x.codeId === correspondance.codeId && x.source === correspondance.source)) r.correspondances.push(correspondance);
  };

  for (const code of base.codesIndexes()) {
    const m = compare(requete, code.norme);
    if (!m) continue;
    note(code.colis_id, {
      source: "code",
      codeId: code.id,
      page: code.page,
      format: code.format,
      nomFormat: code.nom_format || code.format,
      famille: code.famille,
      valeur: code.valeur,
      norme: code.norme,
      score: m.score,
      type: m.type,
      debut: m.debut,
      fin: m.fin,
    });
  }
  const colisAvecFichier = db.prepare("SELECT id, file_name, caption, carrier, type FROM colis WHERE file_id IS NOT NULL AND file_id != ''").all();
  for (const c of colisAvecFichier) {
    const numero = numeroDuColis(c);
    if (!numero) continue;
    const m = compare(requete, numero);
    if (!m) continue;
    note(c.id, { source: "suivi", codeId: null, page: null, valeur: numero, norme: base.norme(numero), score: m.score, type: m.type, debut: m.debut, fin: m.fin });
  }

  const ids = [...parColis.keys()];
  if (ids.length === 0) return { requete, resultats: [], total: 0 };
  const colis = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const lot = ids.slice(i, i + 500);
    for (const c of db.prepare(`SELECT * FROM colis WHERE id IN (${lot.map(() => "?").join(",")})`).all(...lot)) colis.set(c.id, c);
  }
  const liens = new Map(base.tousLesLiens().map((l) => [l.colis_id, l]));
  const resumes = new Map(base.resumeCodes().map((r) => [r.empreinte, r]));
  const fichiers = new Map(base.resumeFichiers().map((f) => [f.empreinte, f]));
  const resultats = ids
    .filter((id) => colis.has(id))
    .map((id) => {
      const r = parColis.get(id);
      const c = colis.get(id);
      // le numero du nom de fichier, deja lu tel quel sur l'etiquette : une fois
      const lus = new Set(r.correspondances.filter((m) => m.source === "code").map((m) => m.norme));
      r.correspondances = r.correspondances.filter((m) => m.source === "code" || !lus.has(m.norme));
      // le code lu d'abord (il a une page et une zone), puis le meilleur score
      r.correspondances.sort((a, b) => b.score - a.score || (a.source === "code" ? -1 : 1));
      return { ...resumeColis(c), index: etatIndex(c, liens, resumes, fichiers), score: r.score, correspondances: r.correspondances.slice(0, 6) };
    })
    .sort((a, b) => b.score - a.score || b.id - a.id);
  return { requete, total: resultats.length, resultats: resultats.slice(0, MAX_RESULTATS) };
}

// --- Indexation en fond ------------------------------------------------------------
// Les etiquettes recentes sont lues une a une, doucement, quand personne ne
// demande rien : la recherche les trouve ensuite sans attendre. Les plus
// anciennes le sont a la premiere ouverture.

const JOURS = Number(process.env.BORDEREAUX_JOURS || 45);
const PAUSE_MS = Number(process.env.BORDEREAUX_PAUSE_MS || 1500);
const MAX_ESSAIS = 3;
let indexation = { active: false, restants: 0, faits: 0, echecs: 0, derniere: null };
let minuteurIndexation = null;
let arretDemande = false;

const attends = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

function colisAIndexer() {
  const recents = db
    .prepare(`SELECT id, file_id FROM colis WHERE file_id IS NOT NULL AND file_id != '' AND created_at >= datetime('now', ?) ORDER BY id DESC`)
    .all(`-${JOURS} days`);
  const liens = new Map(base.tousLesLiens().map((l) => [l.colis_id, l]));
  return recents.filter((c) => {
    const l = liens.get(c.id);
    if (!l || l.file_id !== c.file_id) return true;
    if (!l.empreinte) return l.essais < MAX_ESSAIS;
    return l.version !== VERSION_ANALYSE;
  });
}

async function cycleIndexation() {
  minuteurIndexation = null;
  let aFaire = [];
  try {
    aFaire = colisAIndexer();
    indexation = { ...indexation, active: aFaire.length > 0, restants: aFaire.length };
    for (const c of aFaire) {
      if (arretDemande) break;
      // la page passe avant : on attend qu'elle ait fini
      while (demandesEnCours > 0 && !arretDemande) await attends(500);
      try {
        await analyseColis(c.id, { fond: true });
        indexation.faits += 1;
      } catch {
        indexation.echecs += 1;
      }
      indexation.restants -= 1;
      indexation.derniere = new Date().toISOString();
      await attends(PAUSE_MS);
    }
  } catch (err) {
    console.error("[bordereaux] indexation :", err.message);
  } finally {
    indexation.active = false;
    if (!arretDemande) {
      minuteurIndexation = setTimeout(cycleIndexation, aFaire.length > 0 ? 20000 : 3 * 60 * 1000);
      minuteurIndexation.unref?.();
    }
  }
}

function demarreIndexation({ delaiMs = 60000 } = {}) {
  if (process.env.BORDEREAUX_INDEXATION === "0" || minuteurIndexation) return;
  arretDemande = false;
  minuteurIndexation = setTimeout(cycleIndexation, delaiMs);
  minuteurIndexation.unref?.();
}

function arreteIndexation() {
  arretDemande = true;
  clearTimeout(minuteurIndexation);
  minuteurIndexation = null;
}

/** Ou en est l'index : etiquettes recentes lues, a lire, en echec. */
function etat() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM colis WHERE file_id IS NOT NULL AND file_id != ''").get().n;
  const liens = base.tousLesLiens();
  const analyses = liens.filter((l) => l.empreinte && l.version === VERSION_ANALYSE).length;
  const echecs = liens.filter((l) => !l.empreinte && l.essais >= MAX_ESSAIS).length;
  return {
    etiquettes: total,
    analysees: analyses,
    echecs,
    codes: base.nombreCodes(),
    indexation: { active: indexation.active, restants: indexation.restants, jours: JOURS },
  };
}

// --- Notes d'etude ---------------------------------------------------------------------
// Une note a cote d'une etiquette : gardee dans l'index, jamais dans le PDF.

/** Classe une etiquette dans une categorie (null : aucune). */
function classe(colisId, categorieId) {
  const colis = getColisById(colisId);
  if (!colis || !colis.file_id) return { status: 404, erreur: "Étiquette introuvable." };
  const c = base.classe(colis.id, categorieId);
  if (c === undefined) return { status: 404, erreur: "Catégorie introuvable." };
  return { categorie: c };
}

function annote(colisId, texte) {
  const colis = getColisById(colisId);
  if (!colis || !colis.file_id) return null;
  return base.annote(colis.id, texte);
}

module.exports = {
  telecharge,
  analyseColis,
  analyseEtDetail,
  detail,
  fichierOriginal,
  empreinteConnue,
  liste,
  recherche,
  etat,
  annote,
  classe,
  categories: base.categories,
  creeCategorie: base.creeCategorie,
  modifieCategorie: base.modifieCategorie,
  supprimeCategorie: base.supprimeCategorie,
  COULEURS: base.COULEURS,
  TRIS,
  roleDu,
  demarreIndexation,
  arreteIndexation,
  FILTRES,
};
