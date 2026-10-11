const { db, transaction, getSetting, setSetting } = require("../db");
const { suiviDuColis } = require("../suiviColis");
const { transporteur: infoTransporteurBrut, METHODES_AUTOMATIQUES, NON_CONTROLES, LISIBLES } = require("./transporteurs");
const { analyseDepot, versMs } = require("./analyse");
const { lisPage } = require("./pages");
const laposte = require("./laposte");

// Controle des depots : pour chaque colis DROPE qui a un numero de suivi, ce
// que le transporteur en dit, a cote du statut FeurDrop -- les deux restent
// separes, rien n'est ecrit dans la table des colis.
//
// Deux facons de lire :
//   - le serveur interroge l'API La Poste (La Poste, Colissimo, Chronopost,
//     DPD) a son rythme : une file, un numero a la fois, espaces, jamais plus
//     de CONTROLE_MAX_PAR_PASSAGE par passage ; chaque numero a son heure de
//     prochaine verification, gardee en base (un redemarrage reprend la ou on
//     en etait, ouvrir la page ne declenche rien) ;
//   - l'app Drop du Mac lit les pages officielles (Mondial Relay, DHL, FedEx,
//     GLS) quand on lance « Tout verifier » : elle prend les numeros par
//     petits lots (un bail de quelques minutes), envoie le texte de chaque
//     page, et le serveur le lit (controle/pages.js). Chaque resultat est
//     rattache a SON numero.
// Un transporteur qui ralentit ou refuse (429, 403, defi anti-robot) est mis
// en pause, de plus en plus longue s'il recommence : on n'insiste jamais
// contre une protection. Un echec n'efface jamais une preuve deja lue.

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
});

const MINUTE = 60 * 1000;
const HEURE = 60 * MINUTE;
const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const maintenantSql = () => sql(Date.now());
const sqlVersMs = (s) => (s ? Date.parse(`${String(s).replace(" ", "T")}Z`) : null);
const attends = (ms) => new Promise((r) => setTimeout(r, ms));
const ADAPTATEURS = { laposte };

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

// --- Pauses (disjoncteur) : par methode pour l'API, par transporteur pour le Mac -------

// "laposte", ou "navigateur:MR"
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

// --- Prochaine verification (file du serveur) -------------------------------------------

// D'apres ce que l'on sait deja : rien de plus une fois le depot prouve ou le
// colis livre ; souvent tant qu'il ne l'est pas (les premiers jours), puis
// plus calmement.
function planifie(numero, { encoreAffiche = true, dropeMs = null } = {}) {
  if (!encoreAffiche) return null;
  const s = db.prepare("SELECT final, methode FROM controle_suivis WHERE numero = ?").get(numero);
  if (s?.methode !== "laposte") return null;
  const evts = db.prepare("SELECT etape, physique, incident, code FROM controle_evenements WHERE numero = ?").all(numero);
  // la question est le depot : une fois prouve, plus rien a relire
  if (s?.final || evts.some((e) => e.physique)) return null;
  const age = dropeMs ? Date.now() - dropeMs : 0;
  const minutes = age < 72 * HEURE ? 2 * 60 : 6 * 60;
  return sql(Date.now() + minutes * MINUTE);
}

function noteErreurNumero(numero, err, { methodeLecture = null, statutBrut = undefined, pageUrl = null } = {}) {
  const l = db.prepare("SELECT essais, methode FROM controle_suivis WHERE numero = ?").get(numero);
  const essais = (l?.essais || 0) + 1;
  // un numero refuse n'est pas redemande ; une panne passagere, de plus en
  // plus tard (la file du serveur seulement : le Mac relit a la demande)
  const relire = l?.methode === "laposte" && !["invalide", "ambigu", "bloque"].includes(err.type);
  const prochaine = relire ? sql(Date.now() + Math.min(6 * 60, 15 * 2 ** (essais - 1)) * MINUTE) : null;
  db.prepare(
    `UPDATE controle_suivis SET erreur = ?, code_erreur = ?, essais = ?, essai_le = ?, prochaine_le = ?,
       methode_lecture = COALESCE(?, methode_lecture), statut_brut = COALESCE(?, statut_brut), page_url = COALESCE(?, page_url) WHERE numero = ?`
  ).run(String(err.message || err).slice(0, 300), err.type || "erreur", essais, maintenantSql(), prochaine, methodeLecture, statutBrut ?? null, pageUrl, numero);
}

// La ligne d'un numero, creee a sa premiere apparition.
function suiviDe(numero, { suivi, transporteur }) {
  db.prepare("INSERT OR IGNORE INTO controle_suivis (numero, transporteur, methode, prochaine_le) VALUES (?, ?, ?, ?)").run(
    numero,
    suivi.transporteur,
    transporteur.methode,
    transporteur.methode === "laposte" ? maintenantSql() : null
  );
  // la methode d'un transporteur a pu changer (Mondial Relay lu sur le Mac,
  // lecture coupee...) : la ligne suit
  db.prepare("UPDATE controle_suivis SET methode = ? WHERE numero = ? AND methode != ?").run(transporteur.methode, numero, transporteur.methode);
  return db.prepare("SELECT * FROM controle_suivis WHERE numero = ?").get(numero);
}

/**
 * Enregistre une lecture du transporteur. Les evenements deja connus sont
 * ignores (une relecture ne double rien) ; l'etat est toujours recalcule a
 * partir de TOUS les evenements gardes -- une lecture plus pauvre n'efface
 * jamais une preuve deja lue.
 */
function enregistreLecture(numero, lecture, { encoreAffiche = true, dropeMs = null, methodeLecture = "laposte", statutBrut = null, pageUrl = null, luPar = null } = {}) {
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
    db.prepare("UPDATE controle_suivis SET prochaine_le = ? WHERE numero = ?").run(planifie(numero, { encoreAffiche, dropeMs }), numero);
    return nouveaux;
  });
}

// le statut normalise d'un numero, garde avec sa derniere lecture
function memoriseStatut(numero, connu = null) {
  const x = connu || colisDuNumero(numero);
  if (!x) return null;
  const { suivis, evenements } = lignesSuivis([numero]);
  const l = ligneDe(x, suivis.get(numero), evenements.get(numero), contexte());
  db.prepare("UPDATE controle_suivis SET statut = ? WHERE numero = ?").run(l.controle.categorie, numero);
  return l.controle.categorie;
}

function colisDuNumero(numero) {
  return colisDropes().avec.find((x) => x.suivi.numero === numero) || null;
}

// --- Passages du serveur (API La Poste) ----------------------------------------------------

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
    const porteurs = affiches.get(numero) || [];
    const dropeMs = porteurs.length ? Math.min(...porteurs.map((p) => sqlVersMs(p.colis.dropped_at))) : null;
    if (i > 0) await attends(intervalleMs);
    try {
      const lecture = await adaptateur.verifie(numero);
      bilan.nouveauxEvenements += enregistreLecture(numero, lecture, { encoreAffiche: porteurs.length > 0, dropeMs, methodeLecture: methode });
      if (porteurs.length) memoriseStatut(numero, porteurs[0]);
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
 * Un passage : les numeros dont l'heure est venue, au rythme de l'API. Jamais
 * deux passages a la fois. `force` (« Relancer » ou « Tout verifier ») avance
 * l'heure de tous les suivis encore ouverts, sauf ceux lus il y a moins de
 * 10 minutes.
 */
function synchronise({ declencheur = "auto", force = false } = {}) {
  // le verrou est leve par .finally, toujours APRES l'affectation : un passage
  // qui n'attend rien (transporteur en pause) ne doit pas le laisser coince
  if (!enCours) enCours = passe({ declencheur, force }).finally(() => (enCours = null));
  return enCours;
}

async function passe({ declencheur, force }) {
  const bilan = { declencheur, debut: new Date().toISOString(), verifies: 0, nouveauxEvenements: 0, erreurs: 0, reportes: 0, pauses: [] };
  try {
    const { avec } = colisDropes();
    const affiches = parNumero(avec);
    // les nouveaux numeros entrent dans la file ; ceux qui ont quitte la
    // fenetre (ou ont ete "undropes") n'y sont plus relus
    for (const [numero, porteurs] of affiches) suiviDe(numero, porteurs[0]);
    if (force) {
      db.prepare(
        `UPDATE controle_suivis SET prochaine_le = datetime('now') WHERE methode = 'laposte' AND prochaine_le IS NOT NULL
           AND (verifie_le IS NULL OR verifie_le <= datetime('now', '-10 minutes'))`
      ).run();
    }
    const { parPassage } = reglages();
    for (const methode of Object.keys(ADAPTATEURS)) {
      if (!ADAPTATEURS[methode].estConfigure()) continue;
      if (pauseDe(methode)) continue;
      const dus = db
        .prepare(
          `SELECT numero FROM controle_suivis WHERE methode = ? AND prochaine_le IS NOT NULL AND prochaine_le <= datetime('now')
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
 * prend des qu'il est ouvert).
 */
async function verifieColis(colisId, { par = null } = {}) {
  const x = colisAvecSuivi(colisId);
  const { transporteur } = x;
  suiviDe(x.suivi.numero, x);
  if (transporteur.methode === "manuel") {
    throw Object.assign(new Error(transporteur.raison || `${transporteur.nom} se vérifie à la main : ouvre le suivi officiel`), { status: 409 });
  }
  if (transporteur.methode === "navigateur") {
    levePause(clePause(transporteur));
    lanceCampagne({ par, numeros: [x.suivi.numero], force: true });
    return detail(colisId);
  }
  const adaptateur = ADAPTATEURS[transporteur.methode];
  if (!adaptateur.estConfigure()) throw Object.assign(new Error("L'API La Poste n'est pas configurée (OKAPI_KEY)"), { status: 503 });
  const pause = pauseDe(transporteur.methode);
  if (pause) throw Object.assign(new Error(`${transporteur.nom} en pause jusqu'à ${pause.jusqua.slice(11, 16)} UTC : ${pause.motif}`), { status: 429 });
  const s = db.prepare("SELECT verifie_le FROM controle_suivis WHERE numero = ?").get(x.suivi.numero);
  // lu il y a moins de 2 minutes : la reponse serait la meme
  if (!s?.verifie_le || Date.now() - sqlVersMs(s.verifie_le) > 2 * MINUTE) {
    try {
      const lecture = await adaptateur.verifie(x.suivi.numero);
      enregistreLecture(x.suivi.numero, lecture, { dropeMs: sqlVersMs(x.colis.dropped_at), methodeLecture: transporteur.methode });
      memoriseStatut(x.suivi.numero);
      noteReussite(transporteur.methode);
    } catch (err) {
      if (err.type === "limite" || err.type === "bloque") metEnPause(transporteur.methode, err);
      else if (err.type !== "config") noteErreurNumero(x.suivi.numero, err, { methodeLecture: transporteur.methode });
    }
  }
  return detail(colisId);
}

/** « Relancer les vérifications en attente » : en fond, la reponse part tout de suite. */
function relance() {
  synchronise({ declencheur: "manuel", force: true }).catch(() => {});
  return etat();
}

// --- « Tout verifier » : les campagnes ------------------------------------------------------

function campagneActive() {
  return db.prepare("SELECT * FROM controle_campagnes WHERE statut = 'active' ORDER BY id DESC LIMIT 1").get() || null;
}

/**
 * Lance une campagne : les numeros qui ont besoin d'etre lus -- pas ceux dont
 * le depot est deja prouve, pas ceux lus il y a moins de 30 min (sauf
 * `force`). L'API La Poste s'en occupe aussitot sur le serveur ; les pages
 * officielles attendent le Mac. Une campagne deja active est completee, pas
 * dupliquee.
 */
function lanceCampagne({ par = null, force = false, numeros = null } = {}) {
  const { avec } = colisDropes();
  const affiches = parNumero(avec);
  const { suivis, evenements } = lignesSuivis(new Set(affiches.keys()));
  const ctx = contexte();
  const fraicheur = reglages().fraicheurMinutes * MINUTE;
  const choisis = [];
  for (const [numero, porteurs] of affiches) {
    if (numeros && !numeros.includes(numero)) continue;
    const x = porteurs[0];
    suiviDe(numero, x);
    const s = suivis.get(numero);
    const l = ligneDe(x, s, evenements.get(numero), ctx);
    // la question est le depot : une fois prouve, rien a relire
    if (l.controle.categorie === "confirme") continue;
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
    const laposteANumeros = [];
    for (const { numero, x } of choisis) {
      const m = x.transporteur.methode;
      ajoute.run(c.id, numero, x.suivi.transporteur, m, m === "manuel" ? "manuel" : "attente", maintenantSql());
      if (m === "laposte") laposteANumeros.push(numero);
    }
    // l'API La Poste : ces numeros passent en tete de la file du serveur
    if (laposteANumeros.length) {
      const marque = db.prepare("UPDATE controle_suivis SET prochaine_le = datetime('now') WHERE numero = ? AND (verifie_le IS NULL OR verifie_le <= datetime('now', '-2 minutes') OR ?)");
      for (const n of laposteANumeros) marque.run(n, force ? 1 : 0);
    }
    // une demande explicite redonne une chance aux transporteurs en pause sur le
    // Mac (on a peut-etre resolu le defi dans le navigateur entre-temps)
    for (const code of new Set(choisis.filter((y) => y.x.transporteur.methode === "navigateur").map((y) => y.x.transporteur.code))) {
      levePause(`navigateur:${code}`);
    }
    return c.id;
  });
}

function nouvelleCampagne({ par = null, force = false } = {}) {
  const id = lanceCampagne({ par, force });
  // l'API La Poste, sans attendre
  synchronise({ declencheur: "campagne" }).catch(() => {});
  return campagne(id);
}

// les numeros La Poste d'une campagne suivent la file du serveur : leur etat se
// lit dans controle_suivis (lu apres le debut de la campagne ? en erreur ?)
function actualiseItemsLaposte(c) {
  const items = db.prepare("SELECT numero FROM controle_campagne_items WHERE campagne_id = ? AND methode = 'laposte' AND etat IN ('attente', 'en_cours')").all(c.id);
  if (!items.length) return;
  // sans cle, l'API ne lira jamais ces numeros : on le dit, la campagne ne
  // reste pas suspendue a eux
  if (!laposte.estConfigure()) {
    db.prepare("UPDATE controle_campagne_items SET etat = 'erreur', message = ?, maj_le = ? WHERE campagne_id = ? AND methode = 'laposte' AND etat IN ('attente', 'en_cours')").run(
      "API La Poste non configurée (OKAPI_KEY)",
      maintenantSql(),
      c.id
    );
    return;
  }
  const depuis = sqlVersMs(c.cree_le) - 5000;
  const affiches = parNumero(colisDropes().avec);
  const memorise = (numero) => (affiches.has(numero) ? memoriseStatut(numero, affiches.get(numero)[0]) : null);
  const marque = db.prepare("UPDATE controle_campagne_items SET etat = ?, resultat = ?, message = ?, maj_le = ? WHERE campagne_id = ? AND numero = ?");
  for (const { numero } of items) {
    const s = db.prepare("SELECT verifie_le, essai_le, code_erreur, erreur FROM controle_suivis WHERE numero = ?").get(numero);
    if (!s) continue;
    if (s.verifie_le && sqlVersMs(s.verifie_le) >= depuis) {
      marque.run("fait", memorise(numero), null, maintenantSql(), c.id, numero);
    } else if (s.code_erreur && s.essai_le && sqlVersMs(s.essai_le) >= depuis) {
      marque.run(s.code_erreur === "bloque" || s.code_erreur === "limite" ? "bloque" : "erreur", memorise(numero), s.erreur, maintenantSql(), c.id, numero);
    } else if (pauseDe("laposte")) {
      marque.run("bloque", null, pauseDe("laposte").motif, maintenantSql(), c.id, numero);
    }
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

/** L'etat d'une campagne : la progression, par transporteur, et le Mac. */
function campagne(id = null) {
  let c = id ? db.prepare("SELECT * FROM controle_campagnes WHERE id = ?").get(id) : campagneActive();
  if (!c) c = db.prepare("SELECT * FROM controle_campagnes ORDER BY id DESC LIMIT 1").get();
  const agent = safeJson(getSetting("controle_agent_vu", ""));
  const agentActif = Boolean(agent?.le && Date.now() - Date.parse(agent.le) < 30 * 1000);
  if (!c) return { campagne: null, agent: agent ? { ...agent, actif: agentActif } : null };
  if (c.statut === "active") {
    actualiseItemsLaposte(c);
    termineSiFini(c);
    c = db.prepare("SELECT * FROM controle_campagnes WHERE id = ?").get(c.id);
  }
  const items = db.prepare("SELECT * FROM controle_campagne_items WHERE campagne_id = ?").all(c.id);
  const compteurs = { total: items.length, verifies: 0, restants: 0, confirmes: 0, nonConfirmes: 0, aVerifier: 0, bloques: 0, erreurs: 0, aConstater: 0, annules: 0 };
  const parTransporteur = {};
  for (const it of items) {
    const t = (parTransporteur[it.transporteur] ||= { code: it.transporteur, nom: infoTransporteur(it.transporteur).nom, methode: it.methode, total: 0, faits: 0, restants: 0, bloques: 0, erreurs: 0, aConstater: 0, message: null });
    t.total += 1;
    if (it.etat === "fait") {
      compteurs.verifies += 1;
      t.faits += 1;
      if (it.resultat === "confirme") compteurs.confirmes += 1;
      else if (it.resultat === "non_confirme") compteurs.nonConfirmes += 1;
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
    attendMac,
    agent: agent ? { ...agent, actif: agentActif } : null,
  };
}

// --- Le Mac : un lot de pages a lire, puis ce qu'il a vu ----------------------------------

/**
 * Le Mac demande du travail : quelques numeros a lire, du meme transporteur
 * d'abord (une seule page ouverte, reutilisee), avec un bail. Un transporteur
 * en pause (defi affiche) n'est pas redonne : ses numeros passent « bloque ».
 */
function travail({ agent = "Mac", lot = 6 } = {}) {
  setSetting("controle_agent_vu", JSON.stringify({ le: new Date().toISOString(), nom: String(agent).slice(0, 60) }));
  const c = campagneActive();
  if (!c) return { campagne: null, items: [] };
  const { bailMinutes } = reglages();
  return transaction(() => {
    // les baux expires reviennent dans la file (un Mac qui s'est endormi)
    db.prepare("UPDATE controle_campagne_items SET etat = 'attente', bail_jusqua = NULL WHERE campagne_id = ? AND etat = 'en_cours' AND bail_jusqua < ?").run(c.id, maintenantSql());
    const candidats = db
      .prepare("SELECT * FROM controle_campagne_items WHERE campagne_id = ? AND methode = 'navigateur' AND etat = 'attente' ORDER BY transporteur, numero")
      .all(c.id);
    const items = [];
    for (const it of candidats) {
      const pause = pauseDe(`navigateur:${it.transporteur}`);
      if (pause) {
        db.prepare("UPDATE controle_campagne_items SET etat = 'bloque', message = ?, maj_le = ? WHERE campagne_id = ? AND numero = ?").run(pause.motif, maintenantSql(), c.id, it.numero);
        continue;
      }
      // un lot ne melange pas les transporteurs : une page, un site
      if (items.length && items[0].transporteur !== it.transporteur) continue;
      if (items.length >= Math.min(Math.max(Number(lot) || 6, 1), 12)) break;
      items.push(it);
    }
    const bail = sql(Date.now() + bailMinutes * MINUTE);
    const prend = db.prepare("UPDATE controle_campagne_items SET etat = 'en_cours', bail_jusqua = ?, tentatives = tentatives + 1, maj_le = ? WHERE campagne_id = ? AND numero = ?");
    for (const it of items) prend.run(bail, maintenantSql(), c.id, it.numero);
    termineSiFini(c);
    return {
      campagne: c.id,
      // une pause entre deux pages : le rythme d'une personne, pas d'un robot
      pauseMs: 2500,
      items: items.map((it) => {
        const t = infoTransporteur(it.transporteur);
        return { numero: it.numero, transporteur: it.transporteur, nom: t.nom, url: t.pageLue(it.numero) };
      }),
    };
  });
}

/**
 * Ce que le Mac a vu sur la page officielle d'un numero. Chaque resultat est
 * rattache a SON numero (et verifie : un numero dope, de ce transporteur).
 *   { numero, transporteur, url, titre, texte, erreur? }
 */
function recoitResultat(r, { agent = "Mac" } = {}) {
  const numero = String(r.numero || "");
  const x = colisDuNumero(numero);
  if (!x) return { numero, etat: "ignore", message: "numéro inconnu des colis dropés" };
  if (r.transporteur && r.transporteur !== x.suivi.transporteur) return { numero, etat: "ignore", message: "transporteur différent" };
  const t = infoTransporteurBrut(x.suivi.transporteur);
  if (!t.lisible) return { numero, etat: "ignore", message: "ce transporteur ne se lit pas automatiquement" };
  suiviDe(numero, x);
  const c = campagneActive();
  const marqueItem = (etat, resultat, message) => {
    if (!c) return;
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

  // le Mac n'a pas pu lire la page (reseau, delai) : rien n'est conclu
  if (r.erreur) {
    noteErreurNumero(numero, { type: "passagere", message: `page non lue sur le Mac : ${String(r.erreur).slice(0, 200)}` }, { methodeLecture: "navigateur", pageUrl: url });
    const it = c ? db.prepare("SELECT tentatives FROM controle_campagne_items WHERE campagne_id = ? AND numero = ?").get(c.id, numero) : null;
    // un deuxieme essai plus tard, pas une boucle
    if (it && it.tentatives < 2) marqueItem("attente", null, String(r.erreur).slice(0, 200));
    else marqueItem("erreur", memoriseStatut(numero), String(r.erreur).slice(0, 200));
    return { numero, etat: "erreur" };
  }

  const lu = lisPage(x.suivi.transporteur, { titre: r.titre, texte: r.texte, url });
  const options = { dropeMs: sqlVersMs(x.colis.dropped_at), methodeLecture: "navigateur", pageUrl: url, luPar: String(agent).slice(0, 60) };
  if (lu.etat === "bloque") {
    // une protection : on arrete ce transporteur (pause), ses autres numeros
    // de la campagne aussi -- jamais d'insistance
    noteErreurNumero(numero, { type: "bloque", message: lu.motif }, { methodeLecture: "navigateur", statutBrut: lu.statutBrut, pageUrl: url });
    metEnPause(cle, { type: "bloque", message: lu.motif, pauseMs: 3 * HEURE });
    marqueItem("bloque", memoriseStatut(numero), lu.motif);
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
  if (lu.etat === "illisible" || lu.etat === "ambigu") {
    noteErreurNumero(numero, { type: lu.etat === "ambigu" ? "ambigu" : "illisible", message: lu.motif }, { methodeLecture: "navigateur", statutBrut: lu.statutBrut, pageUrl: url });
    noteReussite(cle);
    marqueItem("fait", memoriseStatut(numero), lu.motif);
    return { numero, etat: lu.etat };
  }
  enregistreLecture(numero, { trouve: lu.etat === "trouve", evenements: lu.evenements, final: false }, { ...options, statutBrut: lu.statutBrut });
  noteReussite(cle);
  const resultat = memoriseStatut(numero);
  marqueItem("fait", resultat, null);
  return { numero, etat: lu.etat, resultat };
}

function recoitResultats(liste, { agent = "Mac" } = {}) {
  setSetting("controle_agent_vu", JSON.stringify({ le: new Date().toISOString(), nom: String(agent).slice(0, 60) }));
  const sortie = (Array.isArray(liste) ? liste : []).slice(0, 20).map((r) => recoitResultat(r, { agent }));
  const c = campagneActive();
  if (c) termineSiFini(c);
  return { resultats: sortie, ...campagne() };
}

// --- Constats a la main (UPS, ou une page bloquee) ------------------------------------------

const CONSTATS = {
  pris: { code: "MANUEL_PRIS", libelle: "Pris en charge (constaté sur la page officielle)", etape: "in_transit", physique: 1, incident: null },
  pas_encore: { code: "MANUEL_PAS_ENCORE", libelle: "Pas encore pris en charge (constaté sur la page officielle)", etape: "info_received", physique: 0, incident: null },
  probleme: { code: "MANUEL_PROBLEME", libelle: "Problème signalé sur la page officielle", etape: "exception", physique: 0, incident: "Problème signalé" },
};

function constate(colisId, resultat, { par = null } = {}) {
  const x = colisAvecSuivi(colisId);
  suiviDe(x.suivi.numero, x);
  if (resultat === "annule") {
    db.prepare("DELETE FROM controle_evenements WHERE numero = ? AND source = 'manuel'").run(x.suivi.numero);
    memoriseStatut(x.suivi.numero);
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
  const categorie = memoriseStatut(x.suivi.numero);
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
  if (controle.categorie === "confirme") return false;
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
    configure: t.methode === "laposte" ? configure.laposte : true,
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
    lien: t.lien(x.suivi.numero),
  };
}

function contexte() {
  const pauses = { laposte: pauseDe("laposte") };
  for (const code of LISIBLES) pauses[`navigateur:${code}`] = pauseDe(`navigateur:${code}`);
  return { pauses, configure: { laposte: laposte.estConfigure() } };
}

function vue() {
  const { avec, sansNumero, horsControle } = colisDropes();
  const { suivis, evenements } = lignesSuivis(new Set(avec.map((x) => x.suivi.numero)));
  const ctx = contexte();
  const lignes = avec.map((x) => ligneDe(x, suivis.get(x.suivi.numero), evenements.get(x.suivi.numero), ctx));
  // `anomalie` reste a 0 pour les anciennes versions de l'app
  const compteurs = { confirme: 0, non_confirme: 0, a_verifier: 0, bloque: 0, anomalie: 0, nonConfirmeHorsDelai: 0, aConstater: 0, attention: 0, total: lignes.length, sansNumero };
  compteurs.horsControle = Object.entries(horsControle).map(([code, colis]) => ({ code, nom: infoTransporteur(code).nom, colis }));
  for (const l of lignes) {
    compteurs[l.controle.categorie] += 1;
    if (l.controle.categorie === "non_confirme" && l.controle.enRetard) compteurs.nonConfirmeHorsDelai += 1;
    if (l.aConstater) compteurs.aConstater += 1;
    if (l.attention) compteurs.attention += 1;
  }
  return { etat: etat(lignes), compteurs, lignes };
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

// L'etat de la file et des transporteurs, pour l'en-tete de la page.
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
      `SELECT COUNT(*) AS enAttente, MIN(prochaine_le) AS prochaine FROM controle_suivis
       WHERE methode = 'laposte' AND prochaine_le IS NOT NULL AND prochaine_le <= datetime('now')`
    )
    .get();
  const methodes = {};
  for (const m of Object.keys(METHODES_AUTOMATIQUES)) {
    const cle = m === "navigateur" ? null : m;
    const t = cle ? db.prepare("SELECT derniere_reussite FROM controle_transporteurs WHERE code = ?").get(cle) : null;
    methodes[m] = {
      nom: METHODES_AUTOMATIQUES[m].nom,
      configure: m === "laposte" ? ctx.configure.laposte : true,
      pause: cle ? ctx.pauses[cle] : null,
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
    campagne: campagne(),
    affichageJours: reglages().affichageJours,
    delaiScanHeures: reglages().delaiScanHeures,
  };
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
  console.log(
    `[controle] controle des depots : passage toutes les ${cycle / MINUTE} min (La Poste${laposte.estConfigure() ? "" : " NON configurée : OKAPI_KEY manquante"}) ; pages officielles lues par le Mac (« Tout vérifier »)`
  );
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
  recoitResultats,
  coupeLecture,
};
