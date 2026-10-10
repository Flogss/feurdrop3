const { db, transaction, getSetting, setSetting } = require("../db");
const { suiviDuColis } = require("../suiviColis");
const { transporteur: infoTransporteur, METHODES_AUTOMATIQUES, NON_CONTROLES } = require("./transporteurs");
const { analyseDepot, versMs } = require("./analyse");
const laposte = require("./laposte");

// Controle des depots : pour chaque colis DROPE qui a un numero de suivi, ce
// que le transporteur en dit, a cote du statut FeurDrop -- les deux restent
// separes, rien n'est ecrit dans la table des colis.
//
// La file d'attente :
//   - un suivi par NUMERO (deux colis au meme numero partagent sa lecture) ;
//   - une requete a la fois par methode, espacees (La Poste : ~1 par seconde,
//     bien sous ses 100 appels/minute), jamais plus de CONTROLE_MAX_PAR_PASSAGE
//     par passage : 100 colis ne partent jamais d'un coup ;
//   - chaque numero a son heure de prochaine verification (prochaine_le),
//     gardee en base : un redemarrage reprend la ou on en etait, et ouvrir la
//     page ne declenche aucune requete ;
//   - un transporteur qui ralentit ou refuse (429, 401 "au piquet", 403) est
//     mis en pause, de plus en plus longue s'il recommence : on n'insiste
//     jamais contre une protection.

const reglages = () => ({
  affichageJours: Number(process.env.CONTROLE_AFFICHAGE_JOURS || 30),
  intervalleMs: Number(process.env.CONTROLE_LAPOSTE_INTERVALLE_MS || 1100),
  parPassage: Number(process.env.CONTROLE_MAX_PAR_PASSAGE || 80),
  delaiScanHeures: Number(process.env.CONTROLE_DELAI_SCAN_HEURES || 48),
  cycleMinutes: Number(process.env.CONTROLE_CYCLE_MINUTES || 5),
});

const MINUTE = 60 * 1000;
const HEURE = 60 * MINUTE;
const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const maintenantSql = () => sql(Date.now());
const sqlVersMs = (s) => (s ? Date.parse(`${String(s).replace(" ", "T")}Z`) : null);
const attends = (ms) => new Promise((r) => setTimeout(r, ms));
const ADAPTATEURS = { laposte };

// --- Les colis a controler ------------------------------------------------------------

const COLONNES_COLIS = "id, sender_name, type, carrier, status, file_name, caption, created_at, dropped_at, printed_at, paid";

function colisDropes() {
  const lignes = db
    .prepare(`SELECT ${COLONNES_COLIS} FROM colis WHERE status = 'dropped' AND dropped_at >= datetime('now', ?) ORDER BY dropped_at DESC, id DESC`)
    .all(`-${reglages().affichageJours} days`);
  const avec = [];
  let sansNumero = 0;
  const horsControle = {};
  for (const colis of lignes) {
    const suivi = suiviDuColis(colis);
    if (!suivi) sansNumero += 1;
    else if (NON_CONTROLES[suivi.transporteur]) horsControle[suivi.transporteur] = (horsControle[suivi.transporteur] || 0) + 1;
    else avec.push({ colis, suivi, transporteur: infoTransporteur(suivi.transporteur) });
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

// --- Pauses par methode (disjoncteur) ------------------------------------------------

function pauseDe(methode) {
  const t = db.prepare("SELECT * FROM controle_transporteurs WHERE code = ?").get(methode);
  if (!t?.bloque_jusqua || sqlVersMs(t.bloque_jusqua) <= Date.now()) return null;
  return { jusqua: t.bloque_jusqua, motif: t.motif, type: t.type };
}

function noteReussite(methode) {
  db.prepare(
    `INSERT INTO controle_transporteurs (code, echecs, derniere_reussite, maj_le) VALUES (?, 0, ?, ?)
     ON CONFLICT(code) DO UPDATE SET echecs = 0, bloque_jusqua = NULL, motif = NULL, type = NULL,
       derniere_reussite = excluded.derniere_reussite, maj_le = excluded.maj_le`
  ).run(methode, maintenantSql(), maintenantSql());
}

// Une protection ou une limite : pause, doublee a chaque recidive (12 h au plus).
function metEnPause(methode, err) {
  const t = db.prepare("SELECT echecs FROM controle_transporteurs WHERE code = ?").get(methode);
  const echecs = (t?.echecs || 0) + 1;
  const base = err.pauseMs || 15 * MINUTE;
  const duree = Math.min(12 * HEURE, base * 2 ** (echecs - 1));
  const motif = err.type === "bloque" ? `accès refusé (${err.message})` : err.type === "limite" ? "trop de vérifications : pause demandée par le transporteur" : err.message;
  db.prepare(
    `INSERT INTO controle_transporteurs (code, bloque_jusqua, motif, type, echecs, derniere_erreur, maj_le) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET bloque_jusqua = excluded.bloque_jusqua, motif = excluded.motif, type = excluded.type,
       echecs = excluded.echecs, derniere_erreur = excluded.derniere_erreur, maj_le = excluded.maj_le`
  ).run(methode, sql(Date.now() + duree), motif, err.type, echecs, err.message, maintenantSql());
  console.warn(`[controle] ${methode} en pause ${Math.round(duree / MINUTE)} min : ${err.message}`);
}

// --- Prochaine verification ----------------------------------------------------------

// D'apres ce que l'on sait deja : rien de plus une fois livre ou en incident
// definitif ; rarement une fois le depot prouve ; souvent tant qu'il ne l'est
// pas (les premiers jours), puis plus calmement.
function planifie(numero, { encoreAffiche = true, dropeMs = null } = {}) {
  if (!encoreAffiche) return null;
  const s = db.prepare("SELECT final FROM controle_suivis WHERE numero = ?").get(numero);
  const evts = db.prepare("SELECT etape, physique, incident, code FROM controle_evenements WHERE numero = ? AND source != 'manuel'").all(numero);
  const fini = s?.final || evts.some((e) => (e.etape === "delivered" && !e.incident) || ["RE1", "DI2"].includes(e.code));
  if (fini) return null;
  const prouve = evts.some((e) => e.physique);
  const age = dropeMs ? Date.now() - dropeMs : 0;
  const minutes = prouve ? 12 * 60 : age < 72 * HEURE ? 2 * 60 : 6 * 60;
  return sql(Date.now() + minutes * MINUTE);
}

function noteErreurNumero(numero, err) {
  const l = db.prepare("SELECT essais FROM controle_suivis WHERE numero = ?").get(numero);
  const essais = (l?.essais || 0) + 1;
  // un numero refuse n'est pas redemande ; une panne passagere, de plus en plus tard
  const prochaine = err.type === "invalide" ? null : sql(Date.now() + Math.min(6 * 60, 15 * 2 ** (essais - 1)) * MINUTE);
  db.prepare("UPDATE controle_suivis SET erreur = ?, code_erreur = ?, essais = ?, essai_le = ?, prochaine_le = ? WHERE numero = ?").run(
    String(err.message || err).slice(0, 300),
    err.type || "erreur",
    essais,
    maintenantSql(),
    prochaine,
    numero
  );
}

// La ligne d'un numero, creee a sa premiere apparition.
function suiviDe(numero, { suivi, transporteur }) {
  db.prepare("INSERT OR IGNORE INTO controle_suivis (numero, transporteur, methode, prochaine_le) VALUES (?, ?, ?, ?)").run(
    numero,
    suivi.transporteur,
    transporteur.methode,
    transporteur.methode === "manuel" ? null : maintenantSql()
  );
  return db.prepare("SELECT * FROM controle_suivis WHERE numero = ?").get(numero);
}

/**
 * Enregistre une lecture du transporteur. Les evenements deja connus sont
 * ignores (une relecture ne double rien) ; l'etat est toujours recalcule a
 * partir de TOUS les evenements gardes.
 */
function enregistreLecture(numero, lecture, { encoreAffiche = true, dropeMs = null } = {}) {
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
    db.prepare(
      `UPDATE controle_suivis SET trouve = ?, final = ?, produit = COALESCE(?, produit), verifie_le = ?, essai_le = ?,
         essais = 0, erreur = NULL, code_erreur = NULL WHERE numero = ?`
    ).run(lecture.trouve ? 1 : 0, lecture.final ? 1 : 0, lecture.produit, maintenantSql(), maintenantSql(), numero);
    db.prepare("UPDATE controle_suivis SET prochaine_le = ? WHERE numero = ?").run(planifie(numero, { encoreAffiche, dropeMs }), numero);
    return nouveaux;
  });
}

// --- Passages -----------------------------------------------------------------------

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
      bilan.nouveauxEvenements += enregistreLecture(numero, lecture, { encoreAffiche: porteurs.length > 0, dropeMs });
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
      noteErreurNumero(numero, err);
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
 * Un passage : les numeros dont l'heure est venue, transporteur par
 * transporteur, au rythme de chacun. Jamais deux passages a la fois.
 * `force` (« Relancer les vérifications en attente ») avance l'heure de tous
 * les suivis encore ouverts, sauf ceux lus il y a moins de 10 minutes.
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
        `UPDATE controle_suivis SET prochaine_le = datetime('now') WHERE methode != 'manuel' AND prochaine_le IS NOT NULL
           AND (verifie_le IS NULL OR verifie_le <= datetime('now', '-10 minutes'))`
      ).run();
    }
    const { parPassage } = reglages();
    for (const methode of Object.keys(METHODES_AUTOMATIQUES)) {
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

/** « Vérifier » sur un colis : une lecture tout de suite (si le transporteur le permet). */
async function verifieColis(colisId) {
  const x = colisAvecSuivi(colisId);
  const { transporteur } = x;
  suiviDe(x.suivi.numero, x);
  if (transporteur.methode === "manuel") {
    throw Object.assign(new Error(`${transporteur.nom} ne permet pas la vérification automatique : ouvre le suivi officiel`), { status: 409 });
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
      enregistreLecture(x.suivi.numero, lecture, { dropeMs: sqlVersMs(x.colis.dropped_at) });
      noteReussite(transporteur.methode);
    } catch (err) {
      if (err.type === "limite" || err.type === "bloque") metEnPause(transporteur.methode, err);
      else if (err.type !== "config") noteErreurNumero(x.suivi.numero, err);
    }
  }
  return detail(colisId);
}

/** « Relancer les vérifications en attente » : en fond, la reponse part tout de suite. */
function relance() {
  synchronise({ declencheur: "manuel", force: true }).catch(() => {});
  return etat();
}

// --- Constats a la main (transporteurs sans verification automatique) ----------------

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
    return detail(colisId);
  }
  const c = CONSTATS[resultat];
  if (!c) throw Object.assign(new Error("Constat inconnu"), { status: 400 });
  const maintenant = new Date().toISOString();
  db.prepare(
    `INSERT INTO controle_evenements (numero, cle, survenu_le, survenu_utc, code, libelle, etape, physique, incident, source, par)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manuel', ?)`
  ).run(x.suivi.numero, `manuel|${maintenant}`, maintenant, maintenant, c.code, c.libelle, c.etape, c.physique, c.incident, par);
  return detail(colisId);
}

// --- Ce que la page affiche ------------------------------------------------------------

function demandeAttention(controle, x) {
  if (controle.categorie === "anomalie") return true;
  if (controle.categorie === "confirme") return false;
  if (controle.manuel) {
    // un colis a verifier a la main l'est une fois les scans remontes (24 h)
    return Date.now() - sqlVersMs(x.colis.dropped_at) > 24 * HEURE;
  }
  return controle.enRetard;
}

function ligneDe(x, s, evenements, pauses, configure) {
  const t = x.transporteur;
  const controle = analyseDepot({
    colis: x.colis,
    suivi: s || null,
    evenements: evenements || [],
    transporteur: t,
    pause: t.methode === "manuel" ? null : pauses[t.methode],
    configure: t.methode === "manuel" ? true : configure[t.methode],
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
    aConstater: t.methode === "manuel" && attention && controle.categorie !== "anomalie",
    verifieLe: s?.verifie_le || null,
    essaiLe: s?.essai_le || null,
    prochaineLe: s?.prochaine_le || null,
    erreur: s?.code_erreur ? { code: s.code_erreur, message: s.erreur } : null,
    lien: t.lien(x.suivi.numero),
  };
}

function contexte() {
  const pauses = {};
  const configure = {};
  for (const m of Object.keys(METHODES_AUTOMATIQUES)) {
    pauses[m] = pauseDe(m);
    configure[m] = ADAPTATEURS[m].estConfigure();
  }
  return { pauses, configure };
}

function vue() {
  const { avec, sansNumero, horsControle } = colisDropes();
  const { suivis, evenements } = lignesSuivis(new Set(avec.map((x) => x.suivi.numero)));
  const { pauses, configure } = contexte();
  const lignes = avec.map((x) => ligneDe(x, suivis.get(x.suivi.numero), evenements.get(x.suivi.numero), pauses, configure));
  const compteurs = { confirme: 0, non_confirme: 0, a_verifier: 0, bloque: 0, anomalie: 0, nonConfirmeHorsDelai: 0, aConstater: 0, attention: 0, total: lignes.length, sansNumero };
  // les transporteurs non controles (Mondial Relay) : seulement comptes
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
  const { pauses, configure } = contexte();
  const s = suivis.get(x.suivi.numero);
  const evts = (evenements.get(x.suivi.numero) || [])
    .map((e) => ({ ...e, ms: versMs(e.survenuLe) }))
    .sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || (b.ordre ?? 0) - (a.ordre ?? 0));
  return {
    ...ligneDe(x, s, evts, pauses, configure),
    statutInterneFeurDrop: x.colis.status,
    evenements: evts.map(({ ms, ...e }) => e),
    raisonManuel: x.transporteur.methode === "manuel" ? x.transporteur.raison : null,
    liens: { transporteur: x.transporteur.lien(x.suivi.numero), page: x.transporteur.page },
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
  const { pauses, configure } = contexte();
  const transporteurs = {};
  for (const l of lignes || []) {
    const t = l.transporteur;
    transporteurs[t.code] ||= { code: t.code, nom: t.nom, methode: t.methode, colis: 0 };
    transporteurs[t.code].colis += 1;
  }
  const file = db
    .prepare(
      `SELECT COUNT(*) AS enAttente, MIN(prochaine_le) AS prochaine FROM controle_suivis
       WHERE methode != 'manuel' AND prochaine_le IS NOT NULL AND prochaine_le <= datetime('now')`
    )
    .get();
  const methodes = {};
  for (const m of Object.keys(METHODES_AUTOMATIQUES)) {
    const t = db.prepare("SELECT derniere_reussite FROM controle_transporteurs WHERE code = ?").get(m);
    methodes[m] = { nom: METHODES_AUTOMATIQUES[m].nom, configure: configure[m], pause: pauses[m], derniereReussite: t?.derniere_reussite || null };
  }
  return {
    enCours: Boolean(enCours),
    derniereSynchro: getSetting("controle_derniere_synchro", "") || null,
    dernierBilan: safeJson(getSetting("controle_dernier_bilan", "")),
    derniereErreur: safeJson(getSetting("controle_derniere_erreur", "")),
    file: { enAttente: file.enAttente },
    methodes,
    transporteurs: Object.values(transporteurs).sort((a, b) => b.colis - a.colis),
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
    `[controle] controle des depots : passage toutes les ${cycle / MINUTE} min (La Poste${laposte.estConfigure() ? "" : " NON configurée : OKAPI_KEY manquante"})`
  );
}

module.exports = { vue, detail, synchronise, verifieColis, relance, constate, etat, demarreControleAuto, enregistreLecture, reglages, CONSTATS };

