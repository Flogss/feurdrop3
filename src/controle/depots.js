const { db, transaction, getSetting, setSetting } = require("../db");
const { suiviDuColis } = require("../suiviColis");
const { transporteur: infoTransporteurBrut, METHODES_AUTOMATIQUES, NON_CONTROLES, LISIBLES } = require("./transporteurs");
const { analyseDepot, versMs } = require("./analyse");
const { lisPage } = require("./pages");
const laposte = require("./laposte");
const ups = require("./ups");
const dhl = require("./dhl");

// Controle des depots : pour chaque colis DROPE qui a un numero de suivi, le
// transporteur l'a-t-il pris en charge ? Le statut FeurDrop et ce que dit le
// transporteur restent separes : rien n'est ecrit dans la table des colis.
//
// La file active ne garde que ce qui reste a trancher : un depot prouve en
// sort tout seul (sa date de confirmation et sa preuve restent dans
// l'historique), un numero que le transporteur dit inconnu a plusieurs
// reprises en est retire (avec la raison, gardee en base et dans le journal
// du serveur). Le colis et son etiquette ne sont jamais touches.
//
// Qui lit :
//   - le serveur, par les API officielles (La Poste/Colissimo/Chronopost/DPD,
//     UPS et DHL quand leurs cles sont posees) : une file, un numero a la
//     fois, espaces, jamais plus de CONTROLE_MAX_PAR_PASSAGE par passage ;
//   - l'app Drop du Mac, par les pages officielles (Mondial Relay, GLS, DHL
//     sans cle) : elle prend les numeros dus par petits lots d'un meme
//     transporteur (un bail de quelques minutes), seule tant qu'elle est
//     ouverte, et tout de suite apres « Tout vérifier » ; le serveur lit le
//     texte de chaque page (controle/pages.js) et le range sous SON numero.
// Chaque numero a son heure de prochaine lecture, gardee en base : un
// redemarrage reprend la ou on en etait, ouvrir la page ne lit rien. Un
// transporteur qui ralentit ou refuse (429, 403, defi anti-robot) est mis en
// pause : on n'insiste jamais contre une protection. Un echec n'efface
// jamais une preuve deja lue.

const reglages = () => ({
  affichageJours: Number(process.env.CONTROLE_AFFICHAGE_JOURS || 30),
  intervalleMs: Number(process.env.CONTROLE_LAPOSTE_INTERVALLE_MS || 1100),
  parPassage: Number(process.env.CONTROLE_MAX_PAR_PASSAGE || 80),
  delaiScanHeures: Number(process.env.CONTROLE_DELAI_SCAN_HEURES || 48),
  cycleMinutes: Number(process.env.CONTROLE_CYCLE_MINUTES || 5),
  // « Tout verifier » : ce qui a ete lu il y a moins de 30 min n'est pas relu
  fraicheurMinutes: Number(process.env.CONTROLE_FRAICHEUR_MINUTES || 30),
  // un numero pris par le Mac lui revient s'il n'a rien rendu apres 3 min
  bailMinutes: Number(process.env.CONTROLE_BAIL_MINUTES || 3),
  // un numero inconnu n'est retire qu'apres 2 lectures « inconnu », a 12 h
  // d'ecart au moins, et 72 h apres le drop (le premier scan a eu le temps)
  inconnuLectures: Number(process.env.CONTROLE_INCONNU_LECTURES || 2),
  inconnuEcartHeures: Number(process.env.CONTROLE_INCONNU_ECART_HEURES || 12),
  inconnuAgeHeures: Number(process.env.CONTROLE_INCONNU_AGE_HEURES || 72),
  // le Mac est « en ligne » s'il s'est signale il y a moins de 45 s
  agentSecondes: Number(process.env.CONTROLE_AGENT_SECONDES || 45),
});

const MINUTE = 60 * 1000;
const HEURE = 60 * MINUTE;
const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const maintenantSql = () => sql(Date.now());
const sqlVersMs = (s) => (s ? Date.parse(`${String(s).replace(" ", "T")}Z`) : null);
const attends = (ms) => new Promise((r) => setTimeout(r, ms));
// les methodes lues par le serveur (API officielles)
const ADAPTATEURS = { laposte, ups, dhl };
const estServeur = (methode) => Object.hasOwn(ADAPTATEURS, methode);

// --- Reglages : la lecture automatique par transporteur ------------------------------

function lectureCoupee() {
  return String(getSetting("controle_lecture_coupee", "") || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

function coupeLecture(code, coupee) {
  if (!LISIBLES.includes(code)) throw Object.assign(new Error("Ce transporteur ne se lit pas sur le Mac"), { status: 400 });
  const liste = new Set(lectureCoupee());
  if (coupee) liste.add(code);
  else liste.delete(code);
  setSetting("controle_lecture_coupee", [...liste].join(","));
  // la file suit tout de suite (sans attendre le prochain passage) : rallumee,
  // les pages de ce transporteur sont dues et le Mac les prend dans les 10 s
  if (coupee) {
    db.prepare("UPDATE controle_suivis SET methode = 'manuel', prochaine_le = NULL WHERE transporteur = ? AND methode = 'navigateur'").run(code);
  } else {
    db.prepare(
      `UPDATE controle_suivis SET methode = 'navigateur', prochaine_le = datetime('now')
       WHERE transporteur = ? AND methode = 'manuel' AND archive_le IS NULL AND COALESCE(statut, '') != 'confirme'`
    ).run(code);
    levePause(`navigateur:${code}`);
  }
}

const infoTransporteur = (code) => infoTransporteurBrut(code, { lectureCoupee: lectureCoupee() });

// --- Les colis a controler ------------------------------------------------------------

const COLONNES_COLIS = "id, sender_name, type, carrier, status, file_name, caption, created_at, dropped_at, printed_at, paid";

function colisDropes() {
  const lignes = db
    .prepare(`SELECT ${COLONNES_COLIS} FROM colis WHERE status = 'dropped' AND dropped_at >= datetime('now', ?) ORDER BY dropped_at DESC, id DESC`)
    .all(`-${reglages().affichageJours} days`);
  const avec = [];
  let sansNumero = 0;
  const horsControle = {};
  const coupees = lectureCoupee();
  for (const colis of lignes) {
    const suivi = suiviDuColis(colis);
    if (!suivi) sansNumero += 1;
    else if (NON_CONTROLES[suivi.transporteur]) horsControle[suivi.transporteur] = (horsControle[suivi.transporteur] || 0) + 1;
    else avec.push({ colis, suivi, transporteur: infoTransporteurBrut(suivi.transporteur, { lectureCoupee: coupees }) });
  }
  return { avec, sansNumero, horsControle };
}

function parNumero(liste) {
  const m = new Map();
  for (const x of liste) {
    if (!m.has(x.suivi.numero)) m.set(x.suivi.numero, []);
    m.get(x.suivi.numero).push(x);
  }
  return m;
}

// le colis drope (affiche) d'un numero ; le plus recent s'il y en a plusieurs
function colisDuNumero(numero) {
  return colisDropes().avec.find((x) => x.suivi.numero === numero) || null;
}

const versEvenement = (e) => ({
  id: e.id,
  survenuLe: e.survenu_le,
  ordre: e.ordre,
  code: e.code,
  libelle: e.libelle,
  lieu: e.lieu,
  etape: e.etape,
  physique: Boolean(e.physique),
  incident: e.incident,
  resolu: Boolean(e.resolu),
  source: e.source,
  par: e.par,
});

function lignesSuivis(numeros) {
  const suivis = new Map();
  const evenements = new Map();
  const liste = [...numeros];
  for (let i = 0; i < liste.length; i += 400) {
    const tranche = liste.slice(i, i + 400);
    const marques = tranche.map(() => "?").join(",");
    for (const s of db.prepare(`SELECT * FROM controle_suivis WHERE numero IN (${marques})`).all(...tranche)) suivis.set(s.numero, s);
    for (const e of db.prepare(`SELECT * FROM controle_evenements WHERE numero IN (${marques})`).all(...tranche)) {
      if (!evenements.has(e.numero)) evenements.set(e.numero, []);
      evenements.get(e.numero).push(versEvenement(e));
    }
  }
  return { suivis, evenements };
}

// --- Pauses (disjoncteur) : par methode pour les API, par transporteur pour le Mac -----

// "laposte", "ups", "dhl", ou "navigateur:MR"
const clePause = (t) => (t.methode === "navigateur" ? `navigateur:${t.code}` : t.methode);

function pauseDe(cle) {
  const t = db.prepare("SELECT * FROM controle_transporteurs WHERE code = ?").get(cle);
  if (!t?.bloque_jusqua || sqlVersMs(t.bloque_jusqua) <= Date.now()) return null;
  return { jusqua: t.bloque_jusqua, motif: t.motif, type: t.type };
}

function noteReussite(cle) {
  db.prepare(
    `INSERT INTO controle_transporteurs (code, echecs, derniere_reussite, maj_le) VALUES (?, 0, ?, ?)
     ON CONFLICT(code) DO UPDATE SET echecs = 0, bloque_jusqua = NULL, motif = NULL, type = NULL,
       derniere_reussite = excluded.derniere_reussite, maj_le = excluded.maj_le`
  ).run(cle, maintenantSql(), maintenantSql());
}

// Une protection ou une limite : pause, doublee a chaque recidive (12 h au plus).
function metEnPause(cle, err) {
  const t = db.prepare("SELECT echecs FROM controle_transporteurs WHERE code = ?").get(cle);
  const echecs = (t?.echecs || 0) + 1;
  const base = err.pauseMs || 15 * MINUTE;
  const duree = Math.min(12 * HEURE, base * 2 ** (echecs - 1));
  const motif = err.type === "bloque" ? `accès refusé (${err.message})` : err.type === "limite" ? "trop de vérifications : pause demandée par le transporteur" : err.message;
  db.prepare(
    `INSERT INTO controle_transporteurs (code, bloque_jusqua, motif, type, echecs, derniere_erreur, maj_le) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET bloque_jusqua = excluded.bloque_jusqua, motif = excluded.motif, type = excluded.type,
       echecs = excluded.echecs, derniere_erreur = excluded.derniere_erreur, maj_le = excluded.maj_le`
  ).run(cle, sql(Date.now() + duree), motif, err.type, echecs, err.message, maintenantSql());
  console.warn(`[controle] ${cle} en pause ${Math.round(duree / MINUTE)} min : ${err.message}`);
}

function levePause(cle) {
  db.prepare("UPDATE controle_transporteurs SET bloque_jusqua = NULL WHERE code = ?").run(cle);
}

// --- La ligne d'un numero ---------------------------------------------------------------

function suiviDe(numero, { suivi, transporteur }) {
  const auto = transporteur.methode !== "manuel";
  db.prepare("INSERT OR IGNORE INTO controle_suivis (numero, transporteur, methode, prochaine_le) VALUES (?, ?, ?, ?)").run(
    numero,
    suivi.transporteur,
    transporteur.methode,
    auto ? maintenantSql() : null
  );
  // la methode d'un transporteur a pu changer (cle d'API posee, lecture
  // coupee ou rallumee) : la ligne suit, et une lecture automatique est due
  db.prepare(
    `UPDATE controle_suivis SET methode = ?, prochaine_le = CASE WHEN ? AND archive_le IS NULL AND COALESCE(statut, '') != 'confirme' THEN datetime('now') ELSE NULL END
     WHERE numero = ? AND methode != ?`
  ).run(transporteur.methode, auto ? 1 : 0, numero, transporteur.methode);
  return db.prepare("SELECT * FROM controle_suivis WHERE numero = ?").get(numero);
}

/**
 * Enregistre une lecture du transporteur. Les evenements deja connus sont
 * ignores (une relecture ne double rien) ; l'etat est toujours recalcule a
 * partir de TOUS les evenements gardes -- une lecture plus pauvre n'efface
 * jamais une preuve deja lue.
 */
function enregistreLecture(numero, lecture, { methodeLecture = "laposte", statutBrut = null, pageUrl = null, luPar = null } = {}) {
  return transaction(() => {
    const ajoute = db.prepare(
      `INSERT OR IGNORE INTO controle_evenements
         (numero, cle, survenu_le, survenu_utc, ordre, code, libelle, lieu, etape, physique, incident, resolu, source, brut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let nouveaux = 0;
    for (const e of lecture.evenements) {
      const ms = versMs(e.survenuLe);
      nouveaux += ajoute.run(
        numero,
        e.cle,
        e.survenuLe,
        ms == null ? null : new Date(ms).toISOString(),
        e.ordre,
        e.code,
        e.libelle,
        e.lieu,
        e.etape,
        e.physique ? 1 : 0,
        e.incident,
        e.resolu ? 1 : 0,
        e.source,
        JSON.stringify(e.brut ?? null)
      ).changes;
    }
    const brut = statutBrut ?? lecture.evenements.find((e) => e.source !== "manuel")?.libelle ?? (lecture.trouve ? null : "Numéro inconnu du transporteur");
    db.prepare(
      `UPDATE controle_suivis SET trouve = ?, final = ?, produit = COALESCE(?, produit), verifie_le = ?, essai_le = ?,
         essais = 0, erreur = NULL, code_erreur = NULL, methode_lecture = ?, statut_brut = COALESCE(?, statut_brut),
         page_url = COALESCE(?, page_url), lu_par = COALESCE(?, lu_par) WHERE numero = ?`
    ).run(lecture.trouve ? 1 : 0, lecture.final ? 1 : 0, lecture.produit ?? null, maintenantSql(), maintenantSql(), methodeLecture, brut, pageUrl, luPar, numero);
    // « inconnu » : on compte les lectures (pour ne retirer qu'a coup sur)
    if (lecture.trouve) db.prepare("UPDATE controle_suivis SET inconnu_lectures = 0, inconnu_premier_le = NULL WHERE numero = ?").run(numero);
    else db.prepare("UPDATE controle_suivis SET inconnu_lectures = inconnu_lectures + 1, inconnu_premier_le = COALESCE(inconnu_premier_le, ?) WHERE numero = ?").run(maintenantSql(), numero);
    return nouveaux;
  });
}

// le statut d'un numero, garde avec sa derniere lecture ; un depot prouve
// garde sa date de confirmation et sa preuve (il sort de la file active)
function memoriseStatut(numero, x) {
  if (!x) return null;
  const { suivis, evenements } = lignesSuivis([numero]);
  const l = ligneDe(x, suivis.get(numero), evenements.get(numero), contexte());
  const c = l.controle;
  if (c.categorie === "confirme") {
    db.prepare("UPDATE controle_suivis SET statut = 'confirme', confirme_le = COALESCE(confirme_le, verifie_le, ?), preuve_le = ?, preuve_libelle = ? WHERE numero = ?").run(
      maintenantSql(),
      c.preuve?.le || null,
      c.preuve?.statut || null,
      numero
    );
  } else {
    db.prepare("UPDATE controle_suivis SET statut = ?, confirme_le = NULL, preuve_le = NULL, preuve_libelle = NULL WHERE numero = ?").run(c.categorie, numero);
  }
  // livre : le suivi de ce colis est fini (plus de lecture, meme pour l'espace expediteur)
  if (c.livre) db.prepare("UPDATE controle_suivis SET final = 1 WHERE numero = ?").run(numero);
  return c.categorie;
}

// Retire un numero de la file active, avec sa raison. Le colis n'est jamais touche.
function archive(numero, motif, detail = {}) {
  db.prepare("UPDATE controle_suivis SET archive_le = ?, archive_motif = ?, archive_detail = ?, prochaine_le = NULL WHERE numero = ? AND archive_le IS NULL").run(
    maintenantSql(),
    motif,
    JSON.stringify(detail),
    numero
  );
  console.log(`[controle] suivi ${numero} retiré de la file : ${motif}`);
}

function desarchive(numero) {
  db.prepare("UPDATE controle_suivis SET archive_le = NULL, archive_motif = NULL, archive_detail = NULL, inconnu_lectures = 0, inconnu_premier_le = NULL WHERE numero = ?").run(numero);
}

/**
 * Un numero inconnu du transporteur est-il a retirer ? Seulement a coup sur :
 *   - refuse comme invalide par l'API (format faux) : tout de suite ;
 *   - « inconnu » lu au moins 2 fois, a 12 h d'ecart, 72 h apres le drop, et
 *     jamais aucun evenement connu pour ce numero.
 * Jamais sur une erreur reseau, un delai, une page bloquee ou incomplete :
 * ce ne sont pas des lectures « inconnu ».
 */
function verifieInconnu(numero, x) {
  const s = db.prepare("SELECT * FROM controle_suivis WHERE numero = ?").get(numero);
  if (!s || s.archive_le) return false;
  const connus = db.prepare("SELECT COUNT(*) AS n FROM controle_evenements WHERE numero = ? AND source != 'manuel'").get(numero).n;
  if (connus > 0) return false;
  const t = x?.transporteur || infoTransporteur(s.transporteur);
  if (s.code_erreur === "invalide") {
    archive(numero, `numéro refusé par ${t.nom} (${s.erreur || "format invalide"})`, { regle: "invalide", erreur: s.erreur, colisId: x?.colis.id ?? null });
    return true;
  }
  const r = reglages();
  const age = x ? Date.now() - sqlVersMs(x.colis.dropped_at) : 0;
  const ecart = s.inconnu_premier_le ? Date.now() - sqlVersMs(s.inconnu_premier_le) : 0;
  if (s.trouve === 0 && s.inconnu_lectures >= r.inconnuLectures && ecart >= r.inconnuEcartHeures * HEURE && age >= r.inconnuAgeHeures * HEURE) {
    archive(numero, `inconnu de ${t.nom} : ${s.inconnu_lectures} lectures sur ${Math.round(ecart / HEURE)} h, drop il y a ${Math.round(age / HEURE)} h`, {
      regle: "inconnu",
      lectures: s.inconnu_lectures,
      premiere: s.inconnu_premier_le,
      derniere: s.verifie_le,
      methode: s.methode_lecture,
      colisId: x?.colis.id ?? null,
    });
    return true;
  }
  return false;
}

// La prochaine lecture, d'apres ce que l'on sait : jamais plus une fois le
// depot prouve ou le numero retire ; souvent tant qu'il ne l'est pas (les
// premiers jours), puis plus calmement ; un « inconnu » est relu 12 h plus
// tard (pour etre sur avant de le retirer).
//
// Un depot prouve n'est plus controle ; mais un colis lu par une API
// officielle (La Poste...) reste suivi, calmement, jusqu'a sa livraison :
// l'espace expediteur montre toutes les actualites de son suivi.
function planifie(numero, { categorie, dropeMs = null }) {
  const s = db.prepare("SELECT methode, archive_le, trouve, final FROM controle_suivis WHERE numero = ?").get(numero);
  if (!s || s.archive_le || s.methode === "manuel") return null;
  if (categorie === "confirme") return estServeur(s.methode) && !s.final ? sql(Date.now() + 4 * HEURE) : null;
  const age = dropeMs ? Date.now() - dropeMs : 0;
  const minutes = s.trouve === 0 ? 12 * 60 : categorie === "non_confirme" ? (age < 72 * HEURE ? 2 * 60 : 6 * 60) : 6 * 60;
  return sql(Date.now() + minutes * MINUTE);
}

// Apres une lecture reussie : le statut, l'eventuel retrait, la prochaine lecture.
function apresLecture(numero, x) {
  const categorie = memoriseStatut(numero, x);
  const retire = verifieInconnu(numero, x);
  if (!retire) db.prepare("UPDATE controle_suivis SET prochaine_le = ? WHERE numero = ?").run(x ? planifie(numero, { categorie, dropeMs: sqlVersMs(x.colis.dropped_at) }) : null, numero);
  return retire ? "retire" : categorie;
}

// Une lecture en echec : rien n'est conclu, une preuve deja lue reste. Un
// nouvel essai de plus en plus tard (15 min, 30 min... 6 h au plus).
function noteErreurNumero(numero, err, { methodeLecture = null, statutBrut = undefined, pageUrl = null } = {}) {
  const l = db.prepare("SELECT essais, statut, archive_le, methode, final FROM controle_suivis WHERE numero = ?").get(numero);
  const essais = (l?.essais || 0) + 1;
  // un depot deja prouve (ou un numero retire) n'est pas remis dans la file
  // -- sauf un colis La Poste encore en route, dont le suivi continue
  const prochaine =
    (l?.statut === "confirme" && (!estServeur(l.methode) || l.final)) || l?.archive_le || err.type === "invalide"
      ? null
      : err.type === "ambigu"
        ? sql(Date.now() + 24 * HEURE)
        : err.type === "bloque"
          ? sql(Date.now() + 3 * HEURE)
          : sql(Date.now() + Math.min(6 * 60, 15 * 2 ** (essais - 1)) * MINUTE);
  db.prepare(
    `UPDATE controle_suivis SET erreur = ?, code_erreur = ?, essais = ?, essai_le = ?, prochaine_le = ?,
       methode_lecture = COALESCE(?, methode_lecture), statut_brut = COALESCE(?, statut_brut), page_url = COALESCE(?, page_url) WHERE numero = ?`
  ).run(String(err.message || err).slice(0, 300), err.type || "erreur", essais, maintenantSql(), prochaine, methodeLecture, statutBrut ?? null, pageUrl, numero);
}

// Les lignes a remettre d'aplomb : un « confirmé » garde par l'ancienne regle
// (qui prenait une etiquette ou un ancien parcours pour un depot) n'etait plus
// jamais relu -- s'il ne l'est plus d'apres l'analyse actuelle, il revient
// dans la file ; un confirme sans date de confirmation la recoit.
function recaleFile(affiches) {
  const a = db
    .prepare(
      `SELECT numero FROM controle_suivis WHERE archive_le IS NULL AND (
         (prochaine_le IS NULL AND methode != 'manuel' AND COALESCE(statut, '') != 'confirme') OR (statut = 'confirme' AND confirme_le IS NULL))`
    )
    .all()
    .map((r) => r.numero)
    .filter((n) => affiches.has(n));
  for (const numero of a) {
    const x = affiches.get(numero)[0];
    const categorie = memoriseStatut(numero, x);
    if (categorie !== "confirme" && x.transporteur.methode !== "manuel") {
      const s = db.prepare("SELECT code_erreur FROM controle_suivis WHERE numero = ?").get(numero);
      // (un numero refuse comme invalide ne se relit pas)
      if (s?.code_erreur !== "invalide") db.prepare("UPDATE controle_suivis SET prochaine_le = datetime('now') WHERE numero = ? AND prochaine_le IS NULL").run(numero);
    }
  }
  // les colis lus par une API, prouves mais pas encore livres : leur suivi
  // continue pour l'espace expediteur (l'ancienne version l'arretait a la preuve)
  const enRoute = db.prepare(
    `UPDATE controle_suivis SET prochaine_le = datetime('now') WHERE numero = ? AND methode IN ('laposte', 'ups', 'dhl')
       AND statut = 'confirme' AND final = 0 AND prochaine_le IS NULL AND archive_le IS NULL`
  );
  for (const numero of affiches.keys()) enRoute.run(numero);
  return a.length;
}

// --- Passages du serveur (API officielles) ------------------------------------------------

let enCours = null;

async function verifieNumeros(methode, numeros, { bilan, affiches }) {
  const adaptateur = ADAPTATEURS[methode];
  const { intervalleMs } = reglages();
  let passageres = 0;
  for (let i = 0; i < numeros.length; i++) {
    if (pauseDe(methode)) {
      bilan.reportes += numeros.length - i;
      break;
    }
    const numero = numeros[i];
    const x = affiches.get(numero)?.[0] || null;
    if (i > 0) await attends(intervalleMs);
    try {
      const lecture = await adaptateur.verifie(numero);
      bilan.nouveauxEvenements += enregistreLecture(numero, lecture, { methodeLecture: methode });
      const r = apresLecture(numero, x);
      if (r === "retire") bilan.retires += 1;
      bilan.verifies += 1;
      passageres = 0;
      noteReussite(methode);
    } catch (err) {
      bilan.erreurs += 1;
      if (err.type === "limite" || err.type === "bloque") {
        // le transporteur demande d'arreter : le numero n'y est pour rien
        db.prepare("UPDATE controle_suivis SET essai_le = ? WHERE numero = ?").run(maintenantSql(), numero);
        metEnPause(methode, err);
        bilan.pauses.push({ methode, motif: err.message });
        bilan.reportes += numeros.length - i - 1;
        break;
      }
      if (err.type === "config") {
        setSetting("controle_derniere_erreur", JSON.stringify({ at: new Date().toISOString(), message: err.message }));
        bilan.reportes += numeros.length - i - 1;
        break;
      }
      noteErreurNumero(numero, err, { methodeLecture: methode });
      if (err.type === "invalide" && verifieInconnu(numero, x)) bilan.retires += 1;
      if (err.type === "passagere" && ++passageres >= 3) {
        // trois pannes de suite : le transporteur a un souci, on revient plus tard
        metEnPause(methode, { type: "passagere", message: "plusieurs échecs de suite", pauseMs: 15 * MINUTE });
        bilan.reportes += numeros.length - i - 1;
        break;
      }
    }
  }
}

/**
 * Un passage : les numeros dont l'heure est venue, methode par methode, au
 * rythme de chacune. Jamais deux passages a la fois. `force` (« Relancer »
 * ou « Tout vérifier ») avance l'heure de tous les suivis encore ouverts,
 * sauf ceux lus il y a moins de 10 minutes.
 */
function synchronise({ declencheur = "auto", force = false } = {}) {
  // le verrou est leve par .finally, toujours APRES l'affectation : un passage
  // qui n'attend rien (transporteur en pause) ne doit pas le laisser coince
  if (!enCours) enCours = passe({ declencheur, force }).finally(() => (enCours = null));
  return enCours;
}

async function passe({ declencheur, force }) {
  const bilan = { declencheur, debut: new Date().toISOString(), verifies: 0, nouveauxEvenements: 0, erreurs: 0, reportes: 0, retires: 0, pauses: [] };
  try {
    const { avec } = colisDropes();
    const affiches = parNumero(avec);
    // les nouveaux numeros entrent dans la file ; ceux qui ont quitte la
    // fenetre (ou ont ete "undropes") n'y sont plus relus
    for (const [numero, porteurs] of affiches) suiviDe(numero, porteurs[0]);
    recaleFile(affiches);
    if (force) {
      db.prepare(
        `UPDATE controle_suivis SET prochaine_le = datetime('now') WHERE methode != 'manuel' AND prochaine_le IS NOT NULL AND archive_le IS NULL
           AND (verifie_le IS NULL OR verifie_le <= datetime('now', '-10 minutes'))`
      ).run();
    }
    const { parPassage } = reglages();
    for (const methode of Object.keys(ADAPTATEURS)) {
      if (!ADAPTATEURS[methode].estConfigure()) continue;
      if (pauseDe(methode)) continue;
      const dus = db
        .prepare(
          `SELECT numero FROM controle_suivis WHERE methode = ? AND archive_le IS NULL AND prochaine_le IS NOT NULL AND prochaine_le <= datetime('now')
           ORDER BY verifie_le IS NOT NULL, prochaine_le LIMIT ?`
        )
        .all(methode, parPassage)
        .map((r) => r.numero);
      const aLire = [];
      for (const n of dus) {
        if (affiches.has(n)) aLire.push(n);
        else db.prepare("UPDATE controle_suivis SET prochaine_le = NULL WHERE numero = ?").run(n);
      }
      await verifieNumeros(methode, aLire, { bilan, affiches });
    }
    // une lecture reussie efface l'alerte de configuration
    if (bilan.verifies) setSetting("controle_derniere_erreur", "");
  } catch (err) {
    bilan.erreurGenerale = err.message;
    console.error(`[controle] passage interrompu : ${err.message}`);
  } finally {
    bilan.fin = new Date().toISOString();
    setSetting("controle_derniere_synchro", bilan.fin);
    setSetting("controle_dernier_bilan", JSON.stringify(bilan));
  }
  return bilan;
}

function colisAvecSuivi(colisId) {
  const colis = db.prepare(`SELECT ${COLONNES_COLIS} FROM colis WHERE id = ?`).get(colisId);
  if (!colis) throw Object.assign(new Error("Colis introuvable"), { status: 404 });
  if (colis.status !== "dropped") throw Object.assign(new Error("Ce colis n'est pas dropé : rien à contrôler"), { status: 409 });
  const suivi = suiviDuColis(colis);
  if (!suivi) throw Object.assign(new Error("Aucun numéro de suivi lisible pour ce colis"), { status: 409 });
  if (NON_CONTROLES[suivi.transporteur]) throw Object.assign(new Error(NON_CONTROLES[suivi.transporteur]), { status: 409 });
  return { colis, suivi, transporteur: infoTransporteur(suivi.transporteur) };
}

/**
 * « Vérifier » sur un colis : une lecture tout de suite par l'API ; pour un
 * transporteur lu sur le Mac, une petite campagne d'un numero (le Mac la
 * prend des qu'il est en ligne). Un numero retire de la file y revient.
 */
async function verifieColis(colisId, { par = null } = {}) {
  const x = colisAvecSuivi(colisId);
  const { transporteur } = x;
  suiviDe(x.suivi.numero, x);
  desarchive(x.suivi.numero);
  if (transporteur.methode === "manuel") {
    throw Object.assign(new Error(transporteur.raison || `${transporteur.nom} se vérifie à la main : ouvre le suivi officiel`), { status: 409 });
  }
  if (transporteur.methode === "navigateur") {
    levePause(clePause(transporteur));
    lanceCampagne({ par, numeros: [x.suivi.numero], force: true });
    return detail(colisId);
  }
  const adaptateur = ADAPTATEURS[transporteur.methode];
  if (!adaptateur.estConfigure()) throw Object.assign(new Error(`${METHODES_AUTOMATIQUES[transporteur.methode].nom} n'est pas configurée`), { status: 503 });
  const pause = pauseDe(transporteur.methode);
  if (pause) throw Object.assign(new Error(`${transporteur.nom} en pause jusqu'à ${pause.jusqua.slice(11, 16)} UTC : ${pause.motif}`), { status: 429 });
  const s = db.prepare("SELECT verifie_le FROM controle_suivis WHERE numero = ?").get(x.suivi.numero);
  // lu il y a moins de 2 minutes : la reponse serait la meme
  if (!s?.verifie_le || Date.now() - sqlVersMs(s.verifie_le) > 2 * MINUTE) {
    try {
      const lecture = await adaptateur.verifie(x.suivi.numero);
      enregistreLecture(x.suivi.numero, lecture, { methodeLecture: transporteur.methode });
      apresLecture(x.suivi.numero, x);
      noteReussite(transporteur.methode);
    } catch (err) {
      if (err.type === "limite" || err.type === "bloque") metEnPause(transporteur.methode, err);
      else if (err.type !== "config") {
        noteErreurNumero(x.suivi.numero, err, { methodeLecture: transporteur.methode });
        if (err.type === "invalide") verifieInconnu(x.suivi.numero, x);
      }
    }
  }
  return detail(colisId);
}

/** « Relancer les vérifications en attente » : en fond, la reponse part tout de suite. */
function relance() {
  synchronise({ declencheur: "manuel", force: true }).catch(() => {});
  return etat();
}

// --- « Tout verifier » : les campagnes (la progression d'un lot) --------------------------

function campagneActive() {
  return db.prepare("SELECT * FROM controle_campagnes WHERE statut = 'active' ORDER BY id DESC LIMIT 1").get() || null;
}

/**
 * Lance une campagne : les numeros qui ont besoin d'etre lus -- jamais ceux
 * dont le depot est prouve ou qui ont ete retires, pas ceux lus il y a moins
 * de 30 min (sauf `force`). Les API partent aussitot sur le serveur ; les
 * pages officielles attendent le Mac. Une campagne deja active est completee,
 * pas dupliquee.
 */
function lanceCampagne({ par = null, force = false, numeros = null } = {}) {
  const { avec } = colisDropes();
  const affiches = parNumero(avec);
  for (const [numero, porteurs] of affiches) if (!numeros || numeros.includes(numero)) suiviDe(numero, porteurs[0]);
  const { suivis, evenements } = lignesSuivis(new Set(affiches.keys()));
  const ctx = contexte();
  const fraicheur = reglages().fraicheurMinutes * MINUTE;
  const choisis = [];
  for (const [numero, porteurs] of affiches) {
    if (numeros && !numeros.includes(numero)) continue;
    const x = porteurs[0];
    const s = suivis.get(numero);
    if (s?.archive_le) continue;
    const l = ligneDe(x, s, evenements.get(numero), ctx);
    // la question est le depot : une fois prouve, rien a relire (sauf
    // demande sur ce colis precis : « Vérifier »)
    if (!numeros && l.controle.categorie === "confirme") continue;
    if (!force && !numeros && s?.verifie_le && Date.now() - sqlVersMs(s.verifie_le) < fraicheur) continue;
    choisis.push({ numero, x });
  }
  return transaction(() => {
    let c = campagneActive();
    if (!c) {
      const id = db.prepare("INSERT INTO controle_campagnes (par, force) VALUES (?, ?)").run(par, force ? 1 : 0).lastInsertRowid;
      c = db.prepare("SELECT * FROM controle_campagnes WHERE id = ?").get(id);
    }
    const ajoute = db.prepare(
      `INSERT INTO controle_campagne_items (campagne_id, numero, transporteur, methode, etat, maj_le) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(campagne_id, numero) DO UPDATE SET etat = CASE WHEN controle_campagne_items.etat IN ('fait', 'en_cours') THEN controle_campagne_items.etat ELSE excluded.etat END,
         methode = excluded.methode, maj_le = excluded.maj_le`
    );
    const marque = db.prepare(
      "UPDATE controle_suivis SET prochaine_le = datetime('now') WHERE numero = ? AND archive_le IS NULL AND (verifie_le IS NULL OR verifie_le <= datetime('now', '-2 minutes') OR ?)"
    );
    for (const { numero, x } of choisis) {
      const m = x.transporteur.methode;
      ajoute.run(c.id, numero, x.suivi.transporteur, m, m === "manuel" ? "manuel" : "attente", maintenantSql());
      // les API : ces numeros passent en tete de la file du serveur
      if (estServeur(m)) marque.run(numero, force ? 1 : 0);
    }
    // une demande explicite redonne une chance aux transporteurs en pause sur le
    // Mac (on a peut-etre resolu le defi dans la fenetre entre-temps)
    for (const code of new Set(choisis.filter((y) => y.x.transporteur.methode === "navigateur").map((y) => y.x.transporteur.code))) {
      levePause(`navigateur:${code}`);
    }
    return c.id;
  });
}

function nouvelleCampagne({ par = null, force = false } = {}) {
  const id = lanceCampagne({ par, force });
  // les API, sans attendre
  synchronise({ declencheur: "campagne" }).catch(() => {});
  return campagne(id);
}

// les numeros lus par le serveur suivent sa file : leur etat se lit dans
// controle_suivis (lu apres le debut de la campagne ? en erreur ? retire ?)
function actualiseItemsServeur(c) {
  const items = db
    .prepare("SELECT numero, methode FROM controle_campagne_items WHERE campagne_id = ? AND methode IN ('laposte', 'ups', 'dhl') AND etat IN ('attente', 'en_cours')")
    .all(c.id);
  if (!items.length) return;
  const depuis = sqlVersMs(c.cree_le) - 5000;
  const marque = db.prepare("UPDATE controle_campagne_items SET etat = ?, resultat = ?, message = ?, maj_le = ? WHERE campagne_id = ? AND numero = ?");
  for (const { numero, methode } of items) {
    // sans cle, l'API ne lira jamais ces numeros : on le dit, la campagne ne
    // reste pas suspendue a eux
    if (!ADAPTATEURS[methode].estConfigure()) {
      marque.run("erreur", null, `${METHODES_AUTOMATIQUES[methode].nom} non configurée`, maintenantSql(), c.id, numero);
      continue;
    }
    const s = db.prepare("SELECT verifie_le, essai_le, code_erreur, erreur, statut, archive_le, archive_motif FROM controle_suivis WHERE numero = ?").get(numero);
    if (!s) continue;
    if (s.archive_le) marque.run("fait", "retire", s.archive_motif, maintenantSql(), c.id, numero);
    else if (s.verifie_le && sqlVersMs(s.verifie_le) >= depuis) marque.run("fait", s.statut, null, maintenantSql(), c.id, numero);
    else if (s.code_erreur && s.essai_le && sqlVersMs(s.essai_le) >= depuis) {
      marque.run(s.code_erreur === "bloque" || s.code_erreur === "limite" ? "bloque" : "erreur", s.statut, s.erreur, maintenantSql(), c.id, numero);
    } else if (pauseDe(methode)) marque.run("bloque", null, pauseDe(methode).motif, maintenantSql(), c.id, numero);
  }
}

function termineSiFini(c) {
  const reste = db.prepare("SELECT COUNT(*) AS n FROM controle_campagne_items WHERE campagne_id = ? AND etat IN ('attente', 'en_cours')").get(c.id).n;
  if (!reste) db.prepare("UPDATE controle_campagnes SET statut = 'terminee', fin_le = ? WHERE id = ? AND statut = 'active'").run(maintenantSql(), c.id);
}

function annuleCampagne() {
  const c = campagneActive();
  if (!c) return null;
  db.prepare("UPDATE controle_campagne_items SET etat = 'annule', maj_le = ? WHERE campagne_id = ? AND etat IN ('attente', 'en_cours')").run(maintenantSql(), c.id);
  db.prepare("UPDATE controle_campagnes SET statut = 'annulee', fin_le = ? WHERE id = ?").run(maintenantSql(), c.id);
  return campagne(c.id);
}

// --- Le Mac : en ligne ? ------------------------------------------------------------

function agentVu() {
  const a = safeJson(getSetting("controle_agent_vu", ""));
  if (!a?.le) return null;
  const depuis = Date.now() - Date.parse(a.le);
  return { nom: a.nom, le: a.le, actif: depuis < reglages().agentSecondes * 1000 };
}

function signaleAgent(nom) {
  setSetting("controle_agent_vu", JSON.stringify({ le: new Date().toISOString(), nom: String(nom || "Mac").slice(0, 60) }));
}

// les pages dues pour le Mac : campagne en cours et file persistante
// (un numero compte une fois, qu'il soit dans la campagne, dans la file, ou les deux)
function pagesDues() {
  const c = campagneActive();
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT numero FROM controle_campagne_items WHERE campagne_id = ? AND methode = 'navigateur' AND etat = 'attente'
         UNION
         SELECT numero FROM controle_suivis WHERE methode = 'navigateur' AND archive_le IS NULL AND prochaine_le IS NOT NULL AND prochaine_le <= datetime('now')
       )`
    )
    .get(c?.id ?? -1);
  return { total: n };
}

/** Le Mac se signale (toutes les 10 s) : a-t-il quelque chose a lire ? */
function agent({ nom = "Mac" } = {}) {
  signaleAgent(nom);
  const c = campagneActive();
  return { aLire: pagesDues().total, campagne: c ? { id: c.id, par: c.par } : null };
}

/** L'etat d'une campagne : la progression, par transporteur, et le Mac. */
function campagne(id = null) {
  let c = id ? db.prepare("SELECT * FROM controle_campagnes WHERE id = ?").get(id) : campagneActive();
  if (!c) c = db.prepare("SELECT * FROM controle_campagnes ORDER BY id DESC LIMIT 1").get();
  const agentEtat = agentVu();
  if (!c) return { campagne: null, agent: agentEtat };
  if (c.statut === "active") {
    actualiseItemsServeur(c);
    termineSiFini(c);
    c = db.prepare("SELECT * FROM controle_campagnes WHERE id = ?").get(c.id);
  }
  const items = db.prepare("SELECT * FROM controle_campagne_items WHERE campagne_id = ?").all(c.id);
  const compteurs = { total: items.length, verifies: 0, restants: 0, confirmes: 0, nonConfirmes: 0, aVerifier: 0, bloques: 0, erreurs: 0, aConstater: 0, annules: 0, retires: 0 };
  const parTransporteur = {};
  for (const it of items) {
    const t = (parTransporteur[it.transporteur] ||= { code: it.transporteur, nom: infoTransporteur(it.transporteur).nom, methode: it.methode, total: 0, faits: 0, restants: 0, bloques: 0, erreurs: 0, aConstater: 0, message: null });
    t.total += 1;
    if (it.etat === "fait") {
      compteurs.verifies += 1;
      t.faits += 1;
      if (it.resultat === "confirme") compteurs.confirmes += 1;
      else if (it.resultat === "non_confirme") compteurs.nonConfirmes += 1;
      else if (it.resultat === "retire") compteurs.retires += 1;
      else compteurs.aVerifier += 1;
    } else if (it.etat === "attente" || it.etat === "en_cours") {
      compteurs.restants += 1;
      t.restants += 1;
    } else if (it.etat === "bloque") {
      compteurs.bloques += 1;
      t.bloques += 1;
      t.message ||= it.message;
    } else if (it.etat === "erreur") {
      compteurs.erreurs += 1;
      t.erreurs += 1;
      t.message ||= it.message;
    } else if (it.etat === "manuel") {
      compteurs.aConstater += 1;
      t.aConstater += 1;
    } else if (it.etat === "annule") compteurs.annules += 1;
  }
  const attendMac = items.some((it) => it.methode === "navigateur" && (it.etat === "attente" || it.etat === "en_cours"));
  return {
    campagne: { id: c.id, statut: c.statut, creeLe: c.cree_le, finLe: c.fin_le, par: c.par, force: Boolean(c.force) },
    compteurs,
    parTransporteur: Object.values(parTransporteur).sort((a, b) => b.total - a.total),
    // a constater sur la page officielle (UPS sans API) : le Mac les ouvre
    // un par un dans le navigateur, on note ce qu'on y voit
    numerosAConstater: items.filter((it) => it.etat === "manuel").map((it) => it.numero).slice(0, 300),
    attendMac,
    agent: agentEtat,
  };
}

// --- Le Mac : un lot de pages a lire, puis ce qu'il a vu ----------------------------------

/**
 * Le Mac demande du travail : quelques numeros d'un meme transporteur (une
 * seule page, reutilisee), ceux de la campagne en cours d'abord, puis ceux
 * dont l'heure est venue (la file persistante). Chaque numero donne a un bail
 * (3 min) : un Mac qui s'endort le rend a la file. Un transporteur en pause
 * (defi affiche) n'est pas redonne.
 */
function travail({ agent: nom = "Mac", lot = 6 } = {}) {
  signaleAgent(nom);
  const { bailMinutes } = reglages();
  const taille = Math.min(Math.max(Number(lot) || 6, 1), 12);
  const affiches = parNumero(colisDropes().avec);
  return transaction(() => {
    const c = campagneActive();
    const bail = sql(Date.now() + bailMinutes * MINUTE);
    let items = [];
    if (c) {
      // les baux expires reviennent dans la file (un Mac qui s'est endormi)
      db.prepare("UPDATE controle_campagne_items SET etat = 'attente', bail_jusqua = NULL WHERE campagne_id = ? AND etat = 'en_cours' AND bail_jusqua < ?").run(c.id, maintenantSql());
      const candidats = db
        .prepare("SELECT numero, transporteur FROM controle_campagne_items WHERE campagne_id = ? AND methode = 'navigateur' AND etat = 'attente' ORDER BY transporteur, numero")
        .all(c.id);
      for (const it of candidats) {
        const pause = pauseDe(`navigateur:${it.transporteur}`);
        if (pause) {
          db.prepare("UPDATE controle_campagne_items SET etat = 'bloque', message = ?, maj_le = ? WHERE campagne_id = ? AND numero = ?").run(pause.motif, maintenantSql(), c.id, it.numero);
          continue;
        }
        if (!affiches.has(it.numero)) {
          // le colis n'est plus drope (remis en attente) : plus rien a lire
          db.prepare("UPDATE controle_campagne_items SET etat = 'annule', message = 'colis plus dropé', maj_le = ? WHERE campagne_id = ? AND numero = ?").run(maintenantSql(), c.id, it.numero);
          continue;
        }
        // un lot ne melange pas les transporteurs : une page, un site
        if (items.length && items[0].transporteur !== it.transporteur) continue;
        if (items.length >= taille) break;
        items.push(it);
      }
      const prend = db.prepare("UPDATE controle_campagne_items SET etat = 'en_cours', bail_jusqua = ?, tentatives = tentatives + 1, maj_le = ? WHERE campagne_id = ? AND numero = ?");
      for (const it of items) prend.run(bail, maintenantSql(), c.id, it.numero);
      termineSiFini(c);
    }
    if (!items.length) {
      // la file persistante : les pages dont l'heure est venue
      const dus = db
        .prepare(
          `SELECT numero, transporteur FROM controle_suivis WHERE methode = 'navigateur' AND archive_le IS NULL AND prochaine_le IS NOT NULL
             AND prochaine_le <= datetime('now') ORDER BY transporteur, verifie_le IS NOT NULL, prochaine_le LIMIT 200`
        )
        .all();
      for (const it of dus) {
        if (!affiches.has(it.numero)) {
          db.prepare("UPDATE controle_suivis SET prochaine_le = NULL WHERE numero = ?").run(it.numero);
          continue;
        }
        if (pauseDe(`navigateur:${it.transporteur}`)) continue;
        if (items.length && items[0].transporteur !== it.transporteur) continue;
        if (items.length >= taille) break;
        items.push(it);
      }
    }
    // le bail dans la file persistante : la prochaine lecture est repoussee de
    // 3 min (le resultat la remet a sa vraie heure)
    const repousse = db.prepare("UPDATE controle_suivis SET prochaine_le = ? WHERE numero = ? AND archive_le IS NULL");
    for (const it of items) repousse.run(bail, it.numero);
    const t = items.length ? infoTransporteur(items[0].transporteur) : null;
    return {
      campagne: c?.id ?? null,
      // une pause entre deux pages : le rythme d'une personne, propre a chaque site
      pauseMs: t?.rythmeMs ?? 3000,
      items: items.map((it) => {
        const tr = infoTransporteur(it.transporteur);
        return { numero: it.numero, transporteur: it.transporteur, nom: tr.nom, url: tr.pageLue(it.numero) };
      }),
    };
  });
}

/**
 * Ce que le Mac a vu sur la page officielle d'un numero. Chaque resultat est
 * rattache a SON numero : le numero doit etre un colis drope de ce
 * transporteur, et la page doit afficher ce numero.
 *   { numero, transporteur, url, titre, texte, erreur? }
 */
function recoitResultat(r, { agent: nom = "Mac" } = {}) {
  const numero = String(r.numero || "");
  const x = colisDuNumero(numero);
  if (!x) return { numero, etat: "ignore", message: "numéro inconnu des colis dropés" };
  if (r.transporteur && r.transporteur !== x.suivi.transporteur) return { numero, etat: "ignore", message: "transporteur différent" };
  const t = infoTransporteurBrut(x.suivi.transporteur);
  if (!t.lisible) return { numero, etat: "ignore", message: "ce transporteur ne se lit pas sur le Mac" };
  suiviDe(numero, x);
  const c = campagneActive();
  const item = c ? db.prepare("SELECT etat, tentatives FROM controle_campagne_items WHERE campagne_id = ? AND numero = ?").get(c.id, numero) : null;
  const marqueItem = (etat, resultat, message) => {
    if (!item) return;
    db.prepare("UPDATE controle_campagne_items SET etat = ?, resultat = ?, message = ?, bail_jusqua = NULL, maj_le = ? WHERE campagne_id = ? AND numero = ?").run(
      etat,
      resultat,
      message,
      maintenantSql(),
      c.id,
      numero
    );
  };
  const cle = `navigateur:${x.suivi.transporteur}`;
  const url = r.url ? String(r.url).slice(0, 500) : null;
  // une erreur technique : rien n'est conclu, la preuve deja lue reste ; un
  // deuxieme essai, pas une boucle
  const erreurTechnique = (type, message) => {
    noteErreurNumero(numero, { type, message }, { methodeLecture: "navigateur", pageUrl: url });
    if (item && item.tentatives < 2) marqueItem("attente", null, message);
    else marqueItem("erreur", memoriseStatut(numero, x), message);
    return { numero, etat: "erreur", message };
  };

  if (r.erreur) return erreurTechnique("passagere", `page non lue sur le Mac : ${String(r.erreur).slice(0, 200)}`);

  const lu = lisPage(x.suivi.transporteur, { titre: r.titre, texte: r.texte, url }, numero);
  if (lu.etat === "bloque") {
    // une protection : on arrete ce transporteur (pause), ses autres numeros
    // de la campagne aussi -- jamais d'insistance
    noteErreurNumero(numero, { type: "bloque", message: lu.motif }, { methodeLecture: "navigateur", statutBrut: lu.statutBrut, pageUrl: url });
    metEnPause(cle, { type: "bloque", message: lu.motif, pauseMs: 3 * HEURE });
    marqueItem("bloque", memoriseStatut(numero, x), lu.motif);
    if (c) {
      db.prepare("UPDATE controle_campagne_items SET etat = 'bloque', message = ?, maj_le = ? WHERE campagne_id = ? AND transporteur = ? AND etat IN ('attente', 'en_cours')").run(
        `${t.nom} a affiché une vérification anti-robot : arrêt pour ce transporteur`,
        maintenantSql(),
        c.id,
        x.suivi.transporteur
      );
    }
    return { numero, etat: "bloque" };
  }
  // une page incomplete ou d'un autre numero : une erreur de lecture, pas un statut
  if (lu.etat === "incomplet" || lu.etat === "autre_numero") return { ...erreurTechnique(lu.etat, lu.motif), etat: lu.etat };
  if (lu.etat === "illisible" || lu.etat === "ambigu") {
    noteErreurNumero(numero, { type: lu.etat, message: lu.motif }, { methodeLecture: "navigateur", statutBrut: lu.statutBrut, pageUrl: url });
    noteReussite(cle);
    marqueItem("fait", memoriseStatut(numero, x), lu.motif);
    return { numero, etat: lu.etat };
  }
  enregistreLecture(numero, { trouve: lu.etat === "trouve", evenements: lu.evenements, final: false }, { methodeLecture: "navigateur", pageUrl: url, luPar: String(nom).slice(0, 60), statutBrut: lu.statutBrut });
  noteReussite(cle);
  const resultat = apresLecture(numero, x);
  marqueItem("fait", resultat, null);
  return { numero, etat: lu.etat, resultat };
}

function recoitResultats(liste, { agent: nom = "Mac" } = {}) {
  signaleAgent(nom);
  const sortie = (Array.isArray(liste) ? liste : []).slice(0, 20).map((r) => recoitResultat(r, { agent: nom }));
  const c = campagneActive();
  if (c) termineSiFini(c);
  return { resultats: sortie, ...campagne() };
}

// --- Constats a la main (UPS sans API, ou une page bloquee) --------------------------------

// Les etats qu'on peut lire soi-meme sur la page officielle (UPS sans API :
// ses conditions interdisent la lecture automatisee). Seuls « pris »,
// « transit » et « livre » prouvent le depot : une prise en charge vue de ses
// yeux. Le reste n'est jamais « Posté confirmé ».
const CONSTATS = {
  etiquette: { code: "MANUEL_ETIQUETTE", libelle: "Étiquette créée, rien de plus (constaté sur la page officielle)", etape: "info_received", physique: 0, incident: null },
  pas_encore: { code: "MANUEL_PAS_ENCORE", libelle: "En attente de dépôt (constaté sur la page officielle)", etape: "info_received", physique: 0, incident: null },
  pris: { code: "MANUEL_PRIS", libelle: "Prise en charge physique confirmée (constatée sur la page officielle)", etape: "in_transit", physique: 1, incident: null },
  transit: { code: "MANUEL_TRANSIT", libelle: "En transit (constaté sur la page officielle)", etape: "in_transit", physique: 1, incident: null },
  livre: { code: "MANUEL_LIVRE", libelle: "Livré après prise en charge (constaté sur la page officielle)", etape: "delivered", physique: 1, incident: null },
  inconnu: { code: "MANUEL_INCONNU", libelle: "Statut inconnu sur la page officielle", etape: "unknown", physique: 0, incident: null },
  bloque: { code: "MANUEL_BLOQUE", libelle: "Vérification bloquée (page officielle inaccessible)", etape: "unknown", physique: 0, incident: null },
  probleme: { code: "MANUEL_PROBLEME", libelle: "Problème signalé sur la page officielle", etape: "exception", physique: 0, incident: "Problème signalé" },
};

function constate(colisId, resultat, { par = null } = {}) {
  const x = colisAvecSuivi(colisId);
  suiviDe(x.suivi.numero, x);
  desarchive(x.suivi.numero);
  if (resultat === "annule") {
    db.prepare("DELETE FROM controle_evenements WHERE numero = ? AND source = 'manuel'").run(x.suivi.numero);
    apresLecture(x.suivi.numero, x);
    return detail(colisId);
  }
  const c = CONSTATS[resultat];
  if (!c) throw Object.assign(new Error("Constat inconnu"), { status: 400 });
  const maintenant = new Date().toISOString();
  db.prepare(
    `INSERT INTO controle_evenements (numero, cle, survenu_le, survenu_utc, code, libelle, etape, physique, incident, source, par)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manuel', ?)`
  ).run(x.suivi.numero, `manuel|${maintenant}`, maintenant, maintenant, c.code, c.libelle, c.etape, c.physique, c.incident, par);
  db.prepare("UPDATE controle_suivis SET methode_lecture = 'manuel', statut_brut = ? WHERE numero = ?").run(c.libelle, x.suivi.numero);
  const categorie = apresLecture(x.suivi.numero, x);
  // le constat resout aussi la ligne de la campagne (« à constater », « bloqué »)
  const camp = campagneActive();
  if (camp) {
    db.prepare("UPDATE controle_campagne_items SET etat = 'fait', resultat = ?, maj_le = ? WHERE campagne_id = ? AND numero = ? AND etat != 'fait'").run(
      categorie,
      maintenantSql(),
      camp.id,
      x.suivi.numero
    );
  }
  return detail(colisId);
}

// --- Ce que la page affiche ------------------------------------------------------------

function demandeAttention(controle, x) {
  if (controle.categorie === "confirme" || controle.categorie === "en_attente") return false;
  if (controle.manuel) {
    // un colis a verifier a la main l'est une fois les scans remontes (24 h)
    return Date.now() - sqlVersMs(x.colis.dropped_at) > 24 * HEURE;
  }
  return controle.enRetard;
}

function ligneDe(x, s, evenements, { pauses, configure }) {
  const t = x.transporteur;
  const controle = analyseDepot({
    colis: x.colis,
    suivi: s || null,
    evenements: evenements || [],
    transporteur: t,
    pause: t.methode === "manuel" ? null : pauses[clePause(t)] ?? null,
    configure: estServeur(t.methode) ? configure[t.methode] : true,
    delaiHeures: reglages().delaiScanHeures,
  });
  const attention = demandeAttention(controle, x);
  return {
    colisId: x.colis.id,
    numero: x.suivi.numero,
    expediteur: x.colis.sender_name,
    transporteur: { code: t.code, nom: t.nom, methode: t.methode },
    statutInterne: { status: x.colis.status, libelle: "Dropé", dropeLe: x.colis.dropped_at, imprimeLe: x.colis.printed_at, paye: Boolean(x.colis.paid) },
    controle,
    attention,
    // a regarder sur la page officielle : jamais constate, ou "pas encore" perime
    aConstater: t.methode === "manuel" && attention,
    verifieLe: s?.verifie_le || null,
    essaiLe: s?.essai_le || null,
    prochaineLe: s?.prochaine_le || null,
    erreur: s?.code_erreur ? { code: s.code_erreur, message: s.erreur } : null,
    // la memoire de la derniere lecture
    lecture: s ? { methode: s.methode_lecture || null, statutBrut: s.statut_brut || null, page: s.page_url || null, par: s.lu_par || null } : null,
    confirmeLe: controle.categorie === "confirme" ? s?.confirme_le || null : null,
    retire: s?.archive_le ? { le: s.archive_le, motif: s.archive_motif } : null,
    lien: t.lien(x.suivi.numero),
  };
}

function contexte() {
  const pauses = {};
  for (const m of Object.keys(ADAPTATEURS)) pauses[m] = pauseDe(m);
  for (const code of LISIBLES) pauses[`navigateur:${code}`] = pauseDe(`navigateur:${code}`);
  const configure = {};
  for (const m of Object.keys(ADAPTATEURS)) configure[m] = ADAPTATEURS[m].estConfigure();
  return { pauses, configure };
}

// une ligne d'historique : legere (le detail s'ouvre a la demande)
const resume = (l) => ({
  colisId: l.colisId,
  numero: l.numero,
  expediteur: l.expediteur,
  transporteur: l.transporteur,
  dropeLe: l.statutInterne.dropeLe,
  confirmeLe: l.confirmeLe,
  preuve: l.controle.preuve ? { le: l.controle.preuve.le, statut: l.controle.preuve.statut, source: l.controle.preuve.source } : null,
  suite: l.controle.suite,
  livre: l.controle.livre,
  retire: l.retire,
  lien: l.lien,
});

/**
 * La page : la file active (ce qui reste a trancher), et l'historique (les
 * depots prouves, avec leur date de confirmation et leur preuve ; les numeros
 * retires, avec leur raison).
 */
function vue() {
  const { avec, sansNumero, horsControle } = colisDropes();
  const { suivis, evenements } = lignesSuivis(new Set(avec.map((x) => x.suivi.numero)));
  const ctx = contexte();
  const toutes = avec.map((x) => ligneDe(x, suivis.get(x.suivi.numero), evenements.get(x.suivi.numero), ctx));
  const lignes = [];
  const confirmes = [];
  const retires = [];
  for (const l of toutes) {
    if (l.retire) retires.push(resume(l));
    else if (l.controle.categorie === "confirme") confirmes.push(resume(l));
    else lignes.push(l);
  }
  confirmes.sort((a, b) => String(b.confirmeLe || b.dropeLe).localeCompare(String(a.confirmeLe || a.dropeLe)));
  // `anomalie` reste a 0 pour les anciennes versions de l'app
  const compteurs = {
    confirme: confirmes.length,
    non_confirme: 0,
    a_verifier: 0,
    bloque: 0,
    en_attente: 0,
    anomalie: 0,
    nonConfirmeHorsDelai: 0,
    aConstater: 0,
    // parmi les « bloques » seulement : c'est ce que dit la carte
    // « Verification bloquee » (aConstater compte aussi des non confirmes)
    aConstaterBloques: 0,
    attention: 0,
    actifs: lignes.length,
    retires: retires.length,
    total: toutes.length,
    sansNumero,
  };
  compteurs.horsControle = Object.entries(horsControle).map(([code, colis]) => ({ code, nom: infoTransporteur(code).nom, colis }));
  for (const l of lignes) {
    compteurs[l.controle.categorie] += 1;
    if (l.controle.categorie === "non_confirme" && l.controle.enRetard) compteurs.nonConfirmeHorsDelai += 1;
    if (l.aConstater) compteurs.aConstater += 1;
    if (l.aConstater && l.controle.categorie === "bloque") compteurs.aConstaterBloques += 1;
    if (l.attention) compteurs.attention += 1;
  }
  return { etat: etat(toutes), compteurs, lignes, historique: { confirmes: confirmes.slice(0, 500), retires } };
}

function detail(colisId) {
  const x = colisAvecSuivi(colisId);
  const { suivis, evenements } = lignesSuivis([x.suivi.numero]);
  const s = suivis.get(x.suivi.numero);
  const evts = (evenements.get(x.suivi.numero) || [])
    .map((e) => ({ ...e, ms: versMs(e.survenuLe) }))
    .sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || (b.ordre ?? 0) - (a.ordre ?? 0));
  const c = campagneActive();
  const enCampagne = c ? db.prepare("SELECT etat FROM controle_campagne_items WHERE campagne_id = ? AND numero = ?").get(c.id, x.suivi.numero) : null;
  return {
    ...ligneDe(x, s, evts, contexte()),
    statutInterneFeurDrop: x.colis.status,
    evenements: evts.map(({ ms, ...e }) => e),
    raisonManuel: x.transporteur.methode === "manuel" ? x.transporteur.raison : null,
    liens: { transporteur: x.transporteur.lien(x.suivi.numero), page: x.transporteur.page },
    // le Mac va lire (ou lit) sa page
    enAttenteDuMac: Boolean(enCampagne && ["attente", "en_cours"].includes(enCampagne.etat)),
  };
}

function safeJson(t) {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

// L'etat des files, des transporteurs et du Mac, pour l'en-tete de la page.
function etat(lignes = null) {
  const ctx = contexte();
  const transporteurs = {};
  for (const l of lignes || []) {
    const t = l.transporteur;
    transporteurs[t.code] ||= { code: t.code, nom: t.nom, methode: t.methode, colis: 0, pause: ctx.pauses[clePause(t)] || null };
    transporteurs[t.code].colis += 1;
  }
  const file = db
    .prepare(
      `SELECT COUNT(*) AS enAttente FROM controle_suivis
       WHERE methode IN ('laposte', 'ups', 'dhl') AND archive_le IS NULL AND prochaine_le IS NOT NULL AND prochaine_le <= datetime('now')`
    )
    .get();
  const methodes = {};
  for (const m of Object.keys(METHODES_AUTOMATIQUES)) {
    const serveur = estServeur(m);
    const t = serveur ? db.prepare("SELECT derniere_reussite FROM controle_transporteurs WHERE code = ?").get(m) : null;
    methodes[m] = {
      nom: METHODES_AUTOMATIQUES[m].nom,
      configure: serveur ? ctx.configure[m] : true,
      pause: serveur ? ctx.pauses[m] : null,
      derniereReussite: t?.derniere_reussite || null,
    };
  }
  const coupees = lectureCoupee();
  return {
    enCours: Boolean(enCours),
    derniereSynchro: getSetting("controle_derniere_synchro", "") || null,
    dernierBilan: safeJson(getSetting("controle_dernier_bilan", "")),
    derniereErreur: safeJson(getSetting("controle_derniere_erreur", "")),
    file: { enAttente: file.enAttente },
    methodes,
    transporteurs: Object.values(transporteurs).sort((a, b) => b.colis - a.colis),
    // les transporteurs que le Mac sait lire, et ceux dont la lecture est coupee
    lecture: LISIBLES.map((code) => ({ code, nom: infoTransporteurBrut(code).nom, active: !coupees.includes(code), pause: ctx.pauses[`navigateur:${code}`] || null })),
    // le Mac : en ligne ? combien de pages l'attendent ?
    mac: { ...(agentVu() || { actif: false }), pagesDues: pagesDues().total },
    campagne: campagne(),
    affichageJours: reglages().affichageJours,
    delaiScanHeures: reglages().delaiScanHeures,
  };
}

// --- Le portail des expediteurs ------------------------------------------------------------

// Ce qu'un expediteur voit de ses colis dropes, sans rien d'interne (ni
// raison, ni methode, ni erreur) :
//   "pris"         pris en charge par le transporteur (preuve lue ou constatee)
//   "livre"        pris en charge, puis livre
//   "pas_encore"   le transporteur ne l'a pas encore scanne
//   "verification" une lecture La Poste est en cours (ouverture de la page)
//   null           rien a dire de plus que « Drop » (a regarder, bloque,
//                  retire, ou transporteur sans lecture)
// A la visite, les colis lus par une API officielle (La Poste, Colissimo,
// Chronopost, DPD ; UPS et DHL si leurs cles sont posees) et pas encore
// prouves sont relus -- au plus une fois toutes les 10 minutes par
// expediteur, au rythme de la file. Les autres montrent ce qui est deja su :
// les pages lues sur le Mac et les constats faits a la main.
const VISITE_MS = () => Number(process.env.CONTROLE_PORTAIL_MINUTES || 10) * MINUTE;
const visites = new Map(); // cle de l'espace -> dernier declenchement

function depotsPourPortail(colisListe, { cle = null } = {}) {
  const sortie = new Map();
  const coupees = lectureCoupee();
  const dropes = [];
  for (const colis of colisListe) {
    if (colis.status !== "dropped") continue;
    const suivi = suiviDuColis(colis);
    if (!suivi || NON_CONTROLES[suivi.transporteur]) continue;
    dropes.push({ colis, suivi, transporteur: infoTransporteurBrut(suivi.transporteur, { lectureCoupee: coupees }) });
  }
  if (!dropes.length) return sortie;
  const { suivis, evenements } = lignesSuivis(new Set(dropes.map((x) => x.suivi.numero)));
  const ctx = contexte();
  const fenetre = Date.now() - reglages().affichageJours * 24 * HEURE;
  const aLire = [];
  for (const x of dropes) {
    const s = suivis.get(x.suivi.numero);
    const dansLaFenetre = sqlVersMs(x.colis.dropped_at) >= fenetre;
    // un vieux colis jamais controle : rien a dire
    if (!s && !dansLaFenetre) continue;
    const c = ligneDe(x, s, evenements.get(x.suivi.numero), ctx).controle;
    const api = estServeur(x.transporteur.methode) && ctx.configure[x.transporteur.methode] && !ctx.pauses[x.transporteur.methode];
    let etat = null;
    if (s?.archive_le) etat = null;
    else if (c.categorie === "confirme") etat = c.livre ? "livre" : "pris";
    else if (c.categorie === "non_confirme") etat = "pas_encore";
    else if (c.categorie === "en_attente" && api) etat = "verification";
    const actus = s?.archive_le ? [] : actusLaPoste(x, evenements.get(x.suivi.numero));
    if (etat || actus.length) sortie.set(x.colis.id, { etat, le: etat === "pris" || etat === "livre" ? c.preuve?.le || null : null, constate: c.preuve?.source === "manuel", actus });
    // a relire : pas encore prouve, ou prouve mais encore en route (ses actualites)
    const enRoute = c.categorie === "confirme" && !c.livre && !s?.final;
    if (api && dansLaFenetre && (c.categorie !== "confirme" || enRoute) && !s?.archive_le && s?.code_erreur !== "invalide") aLire.push(x);
  }
  if (cle && aLire.length) lisALaVisite(cle, aLire);
  return sortie;
}

// Toutes les actualites d'un colis La Poste (Colissimo, Chronopost, DPD : la
// meme API), telles que La Poste les ecrit, de la plus recente a la plus
// ancienne. Un numero deja servi a un autre colis (ancien parcours avant la
// reception de l'etiquette) ne montre que ce qui suit : jamais le parcours
// d'un autre.
const MARGE_ANCIEN_MS = 6 * HEURE;
function actusLaPoste(x, evenements = []) {
  const lus = evenements.filter((e) => e.source === "laposte" && e.libelle).map((e) => ({ ...e, ms: versMs(e.survenuLe) }));
  if (!lus.length) return [];
  const recu = sqlVersMs(x.colis.created_at);
  const seuil = recu != null ? recu - MARGE_ANCIEN_MS : null;
  const reutilise = seuil != null && lus.some((e) => e.physique && e.ms != null && e.ms < seuil);
  return lus
    .filter((e) => !reutilise || (e.ms != null && e.ms >= seuil))
    .sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || (b.ordre ?? 0) - (a.ordre ?? 0))
    .slice(0, 40)
    .map((e) => ({ le: e.survenuLe, libelle: e.libelle }));
}

function lisALaVisite(cle, aLire) {
  const derniere = visites.get(cle) || 0;
  if (Date.now() - derniere < VISITE_MS()) return;
  visites.set(cle, Date.now());
  if (visites.size > 5000) visites.delete(visites.keys().next().value);
  let marques = 0;
  for (const x of aLire) {
    suiviDe(x.suivi.numero, x);
    // (lu il y a moins de 10 minutes : la reponse serait la meme)
    marques += db
      .prepare(
        `UPDATE controle_suivis SET prochaine_le = datetime('now') WHERE numero = ? AND archive_le IS NULL
           AND (verifie_le IS NULL OR verifie_le <= datetime('now', '-10 minutes'))`
      )
      .run(x.suivi.numero).changes;
  }
  if (!marques) return;
  // un passage en cours : le suivant prend ces numeros des qu'il est fini
  const lance = () => synchronise({ declencheur: "portail" }).catch(() => {});
  if (enCours) enCours.then(lance, lance);
  else lance();
}

// --- « Actualiser statuts La Poste » (espace expediteur) -----------------------------------

// Une vraie nouvelle lecture par l'API officielle La Poste, pour les colis
// dropes de CET expediteur seulement (ceux qui ne sont pas encore livres),
// au rythme de la file. Une seule actualisation a la fois par expediteur, et
// pas plus d'une toutes les 2 minutes (les quotas de La Poste).
const actualisations = new Map(); // cle de l'espace -> { etat, total, traites, misAJour, indisponibles, erreurs, debut, fin, message }
const ACTUALISATION_PAUSE_MS = () => Number(process.env.CONTROLE_ACTUALISATION_PAUSE_S || 120) * 1000;

function etatActualisation(cle) {
  const a = actualisations.get(cle);
  if (!a) return { etat: "aucune" };
  const { promesse: _promesse, ...vue } = a;
  return vue;
}

function lanceActualisation(cle, colisListe) {
  const deja = actualisations.get(cle);
  if (deja?.etat === "en_cours") return etatActualisation(cle);
  if (deja?.fin && Date.now() - deja.fin < ACTUALISATION_PAUSE_MS()) {
    return { ...etatActualisation(cle), refuse: `Déjà actualisé il y a moins de ${Math.round(ACTUALISATION_PAUSE_MS() / 60000)} min` };
  }
  if (!laposte.estConfigure()) return { etat: "erreur", message: "Le suivi La Poste n'est pas disponible pour le moment" };
  const pause = pauseDe("laposte");
  if (pause) return { etat: "erreur", message: "La Poste demande une pause : réessaie un peu plus tard" };
  const coupees = lectureCoupee();
  const fenetre = Date.now() - reglages().affichageJours * 24 * HEURE;
  const aLire = [];
  const vus = new Set();
  for (const colis of colisListe) {
    if (colis.status !== "dropped" || sqlVersMs(colis.dropped_at) < fenetre) continue;
    const suivi = suiviDuColis(colis);
    if (!suivi || vus.has(suivi.numero)) continue;
    const transporteur = infoTransporteurBrut(suivi.transporteur, { lectureCoupee: coupees });
    if (transporteur.methode !== "laposte") continue;
    const s = db.prepare("SELECT final FROM controle_suivis WHERE numero = ?").get(suivi.numero);
    if (s?.final) continue;
    vus.add(suivi.numero);
    aLire.push({ colis, suivi, transporteur });
  }
  const a = { etat: "en_cours", total: aLire.length, traites: 0, misAJour: 0, indisponibles: 0, erreurs: 0, debut: Date.now(), fin: null, message: null };
  actualisations.set(cle, a);
  if (actualisations.size > 5000) actualisations.delete(actualisations.keys().next().value);
  a.promesse = (async () => {
    for (const x of aLire) {
      if (a.traites > 0) await attends(reglages().intervalleMs);
      if (pauseDe("laposte")) {
        a.message = "La Poste a demandé une pause : le reste sera relu automatiquement";
        break;
      }
      suiviDe(x.suivi.numero, x);
      const avant = db.prepare("SELECT statut FROM controle_suivis WHERE numero = ?").get(x.suivi.numero)?.statut || null;
      try {
        const lecture = await laposte.verifie(x.suivi.numero);
        const nouveaux = enregistreLecture(x.suivi.numero, lecture, { methodeLecture: "laposte" });
        const apres = apresLecture(x.suivi.numero, x);
        noteReussite("laposte");
        if (!lecture.trouve) a.indisponibles += 1;
        else if (nouveaux > 0 || apres !== avant) a.misAJour += 1;
      } catch (err) {
        a.erreurs += 1;
        if (err.type === "limite" || err.type === "bloque") {
          metEnPause("laposte", err);
          a.message = "La Poste a demandé une pause : le reste sera relu automatiquement";
          a.traites += 1;
          break;
        }
        noteErreurNumero(x.suivi.numero, err, { methodeLecture: "laposte" });
      }
      a.traites += 1;
    }
    a.etat = "terminee";
    a.fin = Date.now();
  })().catch((err) => {
    a.etat = "terminee";
    a.fin = Date.now();
    a.message = err.message;
  });
  return etatActualisation(cle);
}

// --- Minuterie ---------------------------------------------------------------------------

let minuteur = null;
function demarreControleAuto() {
  if (minuteur) return;
  const cycle = reglages().cycleMinutes * MINUTE;
  // un passage ne lit que ce qui est du : le cycle peut etre court sans
  // multiplier les requetes
  setTimeout(() => synchronise().catch(() => {}), 20 * 1000).unref();
  minuteur = setInterval(() => synchronise().catch(() => {}), cycle);
  minuteur.unref();
  const api = Object.entries(ADAPTATEURS)
    .map(([m, a]) => `${METHODES_AUTOMATIQUES[m].nom}${a.estConfigure() ? "" : " (non configurée)"}`)
    .join(", ");
  console.log(`[controle] controle des depots : passage toutes les ${cycle / MINUTE} min (${api}) ; pages officielles lues par l'app du Mac`);
}

module.exports = {
  vue,
  detail,
  synchronise,
  verifieColis,
  relance,
  constate,
  etat,
  demarreControleAuto,
  enregistreLecture,
  reglages,
  CONSTATS,
  nouvelleCampagne,
  lanceCampagne,
  campagne,
  annuleCampagne,
  travail,
  agent,
  recoitResultats,
  coupeLecture,
  depotsPourPortail,
  lanceActualisation,
  etatActualisation,
};
