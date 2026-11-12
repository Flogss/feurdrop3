const crypto = require("crypto");
const { db, getSetting, setSetting, tourScope, journalise, heuresPourGroupes, redropColis } = require("./db");
const { BUSINESS_DAY_SQL } = require("./db/sql");
const { aujourdhuiParis, ajouteJours, jourDeLaSemaine, lundiDe } = require("./dates");
const { suiviDuColis, transporteurDuColis } = require("./suiviColis");
const { carrierLabel } = require("./carrier");
const { FORME_JETON } = require("./portailCommun");
const { depotsPourPortail, lanceActualisation, etatActualisation } = require("./controle/depots");

// L'espace prive d'un expediteur : une adresse a lui ou il voit ses colis et
// ou ils en sont, rien d'autre. En ligne, elle est sur le domaine du portail
// (PORTAIL_URL, un service a part : voir portailSeul.js), jamais sur celui du
// dashboard : https://<portail>/<jeton>.
//
// L'isolement tient ici, cote serveur : l'expediteur n'est JAMAIS designe par
// la requete (ni nom, ni numero), seulement deduit du jeton. Une seule requete
// SQL lie le jeton a son expediteur et l'expediteur a ses colis : changer
// l'adresse, le JavaScript ou l'appel a l'API ne peut rien designer d'autre.
//
// Le jeton est aleatoire (144 bits) : impossible a deviner. Le regenerer
// remplace l'ancien, qui cesse aussitot de marcher ; supprimer ou fusionner
// l'expediteur emporte son jeton avec sa ligne.
//
// Les colis restent ceux du dashboard (meme table, memes statuts) : il n'y a
// pas de seconde base a tenir a jour.

// Les colonnes portail_jeton / portail_cree_le et leurs index : migration 4
// (db/migrations.js).

// "Autre" rassemble plusieurs expediteurs : un lien commun montrerait a chacun
// les colis des autres.
const SANS_PORTAIL = new Set(["Autre"]);

function nouveauJeton() {
  return crypto.randomBytes(18).toString("base64url");
}

// --- Gestion, depuis le dashboard --------------------------------------------

// Le lien a envoyer a l'expediteur. Sans domaine de portail (en local), la
// page est servie par le dashboard lui-meme, sous /expediteur/.
const DOMAINE_PORTAIL = (process.env.PORTAIL_URL || "").trim().replace(/\/+$/, "");
function lienPortail(jeton) {
  if (!jeton) return null;
  return DOMAINE_PORTAIL ? `${DOMAINE_PORTAIL}/${jeton}` : `/expediteur/${jeton}`;
}

// Ce que le dashboard montre de l'espace d'un expediteur.
function infoPortail(sender) {
  if (SANS_PORTAIL.has(sender.name)) return { possible: false, lien: null, creeLe: null };
  return { possible: true, lien: lienPortail(sender.portail_jeton), creeLe: sender.portail_cree_le || null };
}

// Cree l'espace, ou le regenere : le nouveau jeton remplace l'ancien.
function creePortail(senderId) {
  const sender = db.prepare("SELECT * FROM senders WHERE id = ?").get(senderId);
  if (!sender) return { erreur: "Expéditeur introuvable", status: 404 };
  if (SANS_PORTAIL.has(sender.name)) {
    return { erreur: "« Autre » regroupe plusieurs expéditeurs : il ne peut pas avoir d'espace privé", status: 400 };
  }
  const jeton = nouveauJeton();
  db.prepare("UPDATE senders SET portail_jeton = ?, portail_cree_le = datetime('now') WHERE id = ?").run(jeton, sender.id);
  journalise("expediteur", sender.portail_jeton ? `Lien privé de ${sender.name} régénéré` : `Espace privé de ${sender.name} créé`, {
    detail: sender.portail_jeton ? "l'ancien lien ne marche plus" : null,
  });
  return { sender: db.prepare("SELECT * FROM senders WHERE id = ?").get(sender.id) };
}

function retirePortail(senderId) {
  const sender = db.prepare("SELECT * FROM senders WHERE id = ?").get(senderId);
  if (!sender) return { erreur: "Expéditeur introuvable", status: 404 };
  if (sender.portail_jeton) {
    db.prepare("UPDATE senders SET portail_jeton = NULL, portail_cree_le = NULL WHERE id = ?").run(sender.id);
    journalise("expediteur", `Espace privé de ${sender.name} désactivé`, { detail: "son lien ne marche plus" });
  }
  return { sender: db.prepare("SELECT * FROM senders WHERE id = ?").get(sender.id) };
}

// --- Le portail ---------------------------------------------------------------

// Les colis sont designes par une reference opaque, pas par leur numero
// interne : celui-ci compte TOUS les colis, et trahirait le volume des autres.
let secretRefs = null;
function refDe(id) {
  if (!secretRefs) {
    secretRefs = getSetting("portail_secret", null);
    if (!secretRefs) {
      secretRefs = crypto.randomBytes(32).toString("hex");
      setSetting("portail_secret", secretRefs);
    }
  }
  return crypto.createHmac("sha256", secretRefs).update(String(id)).digest("base64url").slice(0, 16);
}

// Les quatre etapes, dans l'ordre :
//   a_imprimer : l'etiquette n'est pas encore sortie ;
//   imprime    : prete a partir (un colis compte a la main n'a rien a imprimer) ;
//   en_drop    : une tournee est en cours et le colis est dans le sac (pret,
//                deja la au depart, d'un transporteur emporte -- la regle meme
//                du dashboard, tourScope) ;
//   drope      : depose.
function etapeDe(colis, dansLeSac) {
  if (colis.status === "dropped") return "drope";
  const pret = Boolean(colis.printed_at || !colis.file_id);
  if (pret && dansLeSac.has(colis.id)) return "en_drop";
  return pret ? "imprime" : "a_imprimer";
}

// Les colis du sac de la tournee en cours (aucun hors tournee).
function idsDuSac() {
  const { clause, params } = tourScope();
  if (!clause) return new Set();
  return new Set(db.prepare(`SELECT id FROM colis WHERE status = 'pending'${clause}`).all(...params).map((r) => r.id));
}

// Uniquement ce qui sert a l'expediteur : ni prix, ni paiement, ni note, ni
// fichier, ni legende, ni rien du dashboard. `depot` : ce que dit le
// controle des depots, en une etape simple (voir controle/depots.js).
function vueColis(colis, dansLeSac, depot = null) {
  const suivi = suiviDuColis(colis);
  const code = suivi ? suivi.transporteur : transporteurDuColis(colis);
  return {
    ref: refDe(colis.id),
    etape: etapeDe(colis, dansLeSac),
    transporteur: code ? { code, nom: suivi ? suivi.nom : carrierLabel(code) } : null,
    boiteJaune: colis.type === "bj",
    suivi: suivi ? { numero: suivi.numero, lien: suivi.lien, page: suivi.page } : null,
    recuLe: colis.created_at,
    imprimeLe: colis.printed_at || null,
    dropeLe: colis.dropped_at || null,
    depot,
    // un colis remis a poster (redrop) : il repart, gratuitement
    redrop: Boolean(colis.redrop_de),
    // depose : l'expediteur peut demander un redrop
    redropPossible: colis.status === "dropped",
  };
}

function portailExiste(jeton) {
  if (typeof jeton !== "string" || !FORME_JETON.test(jeton)) return false;
  const sender = db.prepare("SELECT name FROM senders WHERE portail_jeton = ?").get(jeton);
  return Boolean(sender && !SANS_PORTAIL.has(sender.name));
}

const PAR_PAGE = 60;
const MAX = 2000;

// Le portail d'un jeton : null si le jeton ne designe aucun espace actif.
// `nombre` : combien des colis les plus recents (tous ceux en cours y sont
// toujours, meme anciens).
function portailPour(jeton, { nombre = PAR_PAGE } = {}) {
  if (typeof jeton !== "string" || !FORME_JETON.test(jeton)) return null;
  const sender = db.prepare("SELECT id, name FROM senders WHERE portail_jeton = ?").get(jeton);
  if (!sender || SANS_PORTAIL.has(sender.name)) return null;

  const n = Math.min(MAX, Math.max(PAR_PAGE, Math.floor(Number(nombre)) || PAR_PAGE));
  // l'expediteur vient du jeton : la requete ne prend rien d'autre. Un colis
  // redropé (oublie, remis « à poster ») ne compte qu'une fois : sa derniere
  // ligne (le redrop) remplace l'ancienne.
  const dernier = (a) =>
    `NOT EXISTS (SELECT 1 FROM colis r WHERE COALESCE(r.redrop_de, r.id) = COALESCE(${a}.redrop_de, ${a}.id) AND r.id > ${a}.id AND r.status IN ('pending', 'dropped'))`;
  const lignes = db
    .prepare(
      `SELECT c.id, c.type, c.carrier, c.status, c.file_id, c.file_name, c.caption,
              c.created_at, c.printed_at, c.dropped_at, c.redrop_de,
              (SELECT o.created_at FROM colis o WHERE o.id = c.redrop_de) AS recu_le
       FROM colis c JOIN senders s ON s.name = c.sender_name
       WHERE s.portail_jeton = ? AND c.status IN ('pending', 'dropped') AND ${dernier("c")}
         AND (c.status = 'pending' OR c.id IN (
           SELECT c2.id FROM colis c2 JOIN senders s2 ON s2.name = c2.sender_name
           WHERE s2.portail_jeton = ? AND c2.status IN ('pending', 'dropped') AND ${dernier("c2")}
           ORDER BY c2.created_at DESC, c2.id DESC LIMIT ?))
       ORDER BY c.created_at DESC, c.id DESC`
    )
    .all(jeton, jeton, n);
  const total = db
    .prepare(
      `SELECT COUNT(*) AS c FROM colis c JOIN senders s ON s.name = c.sender_name
       WHERE s.portail_jeton = ? AND c.status IN ('pending', 'dropped') AND ${dernier("c")}`
    )
    .get(jeton).c;

  const sac = idsDuSac();
  // pris en charge ? (a la visite, les colis La Poste pas encore prouves sont relus)
  const depots = depotsPourPortail(lignes, { cle: jeton });
  const colis = lignes.map((l) => vueColis(l, sac, depots.get(l.id) || null));
  const compte = { a_imprimer: 0, imprime: 0, en_drop: 0, drope: 0 };
  for (const c of colis) if (c.etape !== "drope") compte[c.etape] += 1;
  // les dropes se comptent sur tout l'historique, pas seulement la page
  compte.drope = total - (compte.a_imprimer + compte.imprime + compte.en_drop);

  // quand ses colis en attente partent : les heures de drop de leurs
  // transporteurs (« BJ » pour la boite jaune, comme sur le dashboard)
  const groupes = new Map();
  for (const l of lignes) {
    if (l.status !== "pending") continue;
    const g = l.type === "bj" ? "BJ" : l.carrier;
    if (g) groupes.set(g, (groupes.get(g) || 0) + 1);
  }
  const heuresDrop = groupes.size ? heuresPourGroupes(groupes) : [];
  if (heuresDrop.length) {
    lignes.forEach((l, i) => {
      if (l.status !== "pending") return;
      const g = l.type === "bj" ? "BJ" : l.carrier;
      const h = heuresDrop.find((x) => x.transporteurs.some((t) => t.code === g));
      if (h) colis[i].depotPrevu = { a: h.a, heure: h.heure, demain: h.demain };
    });
  }

  return { expediteur: sender.name, compte, colis, total, suite: lignes.length < total, heuresDrop };
}

// L'expediteur designe par le jeton (null si le jeton ne designe aucun espace).
function expediteurDu(jeton) {
  if (typeof jeton !== "string" || !FORME_JETON.test(jeton)) return null;
  const sender = db.prepare("SELECT id, name FROM senders WHERE portail_jeton = ?").get(jeton);
  return sender && !SANS_PORTAIL.has(sender.name) ? sender : null;
}

// --- Redrop demande par l'expediteur -------------------------------------------
// « Redrop » sur un colis depose : il revient « à imprimer » et « à poster »,
// a 0 € (voir redropColis). Le colis est designe par sa reference opaque, et
// cherche UNIQUEMENT parmi ceux de l'expediteur du jeton. Un redrop deja en
// attente est rendu tel quel (jamais deux). Au plus 30 demandes par jour et
// par expediteur : un doigt qui insiste ne remplit pas la file d'impression.
const REDROPS_PAR_JOUR = 30;
const redropsRecents = new Map(); // senderId -> [instants]

function redropPortail(jeton, ref) {
  const sender = expediteurDu(jeton);
  if (!sender) return { introuvable: true };
  if (typeof ref !== "string" || !/^[A-Za-z0-9_-]{8,32}$/.test(ref)) return { erreur: "Colis introuvable.", status: 404 };
  const ligne = db
    .prepare(
      `SELECT c.id FROM colis c JOIN senders s ON s.name = c.sender_name
       WHERE s.portail_jeton = ? AND c.status = 'dropped' ORDER BY c.id DESC`
    )
    .all(jeton)
    .find((c) => refDe(c.id) === ref);
  if (!ligne) return { erreur: "Ce colis n'est pas (ou plus) déposé : rien à redropper.", status: 409 };

  const maintenant = Date.now();
  const recents = (redropsRecents.get(sender.id) || []).filter((t) => maintenant - t < 24 * 3600 * 1000);
  if (recents.length >= REDROPS_PAR_JOUR) {
    return { erreur: `${REDROPS_PAR_JOUR} redrops demandés aujourd'hui : demande directement à la personne qui gère tes colis.`, status: 429 };
  }
  const r = redropColis(ligne.id, { aImprimer: true, par: `demandé par ${sender.name} (espace expéditeur)` });
  if (!r || r.pasDrope) return { erreur: "Ce colis n'est pas déposé : rien à redropper.", status: 409 };
  if (!r.deja) {
    recents.push(maintenant);
    redropsRecents.set(sender.id, recents);
  }
  const origine = db.prepare("SELECT * FROM colis WHERE id = ?").get(ligne.id);
  return { deja: r.deja, colis: r.colis, origine, expediteur: sender.name, vue: vueColis(r.colis, new Set()) };
}

// --- Statistiques de l'expediteur ------------------------------------------------
// Le nombre de colis postes (jamais l'argent) : par jour, par semaine, par
// mois, les meilleures journees, les transporteurs. Un colis redropé compte
// une fois, a son dernier drop. Memes jours que les stats du dashboard (Paris,
// un drop du dimanche compte le lundi).
function statsPortail(jeton) {
  const sender = expediteurDu(jeton);
  if (!sender) return null;
  const lignes = db
    .prepare(
      `SELECT c.id, c.type, c.carrier, c.file_name, c.caption, c.status, c.file_id, ${BUSINESS_DAY_SQL} AS jour
       FROM colis c JOIN senders s ON s.name = c.sender_name
       WHERE s.portail_jeton = ? AND c.status = 'dropped'
         AND NOT EXISTS (SELECT 1 FROM colis r WHERE COALESCE(r.redrop_de, r.id) = COALESCE(c.redrop_de, c.id)
                         AND r.id > c.id AND r.status = 'dropped')`
    )
    .all(jeton);

  const parJour = new Map();
  const parTransporteur = new Map();
  for (const l of lignes) {
    if (!l.jour) continue;
    parJour.set(l.jour, (parJour.get(l.jour) || 0) + 1);
    const suivi = suiviDuColis(l);
    const code = suivi ? suivi.transporteur : transporteurDuColis(l);
    const cle = code || "AUTRE";
    const t = parTransporteur.get(cle) || { code: cle, nom: code ? (suivi ? suivi.nom : carrierLabel(code)) : "Autre", colis: 0 };
    t.colis += 1;
    parTransporteur.set(cle, t);
  }

  const aujourdhui = aujourdhuiParis();
  const premier = [...parJour.keys()].sort()[0] || aujourdhui;
  // jour par jour, sans les dimanches (comptes le lundi), 420 jours au plus
  const jours = [];
  for (let d = premier < aujourdhui ? premier : aujourdhui; d <= aujourdhui; d = ajouteJours(d, 1)) {
    if (jourDeLaSemaine(d) !== 0) jours.push({ date: d, colis: parJour.get(d) || 0 });
  }
  const jourSerie = jours.slice(-420);

  // semaine par semaine (lundi -> samedi), deux ans au plus
  const semaines = [];
  for (let lundi = lundiDe(premier < aujourdhui ? premier : aujourdhui); lundi <= lundiDe(aujourdhui); lundi = ajouteJours(lundi, 7)) {
    let n = 0;
    for (let k = 0; k < 6; k += 1) n += parJour.get(ajouteJours(lundi, k)) || 0;
    semaines.push({ debut: lundi, fin: ajouteJours(lundi, 5), colis: n });
  }

  // mois par mois
  const parMois = new Map();
  for (const [d, n] of parJour) parMois.set(d.slice(0, 7), (parMois.get(d.slice(0, 7)) || 0) + n);
  const mois = [];
  for (let m = (premier < aujourdhui ? premier : aujourdhui).slice(0, 7); m <= aujourdhui.slice(0, 7); ) {
    mois.push({ mois: m, colis: parMois.get(m) || 0 });
    const [a, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${a + 1}-01` : `${a}-${String(mm + 1).padStart(2, "0")}`;
  }

  const meilleursJours = [...parJour]
    .map(([date, colis]) => ({ date, colis }))
    .sort((a, b) => b.colis - a.colis || b.date.localeCompare(a.date))
    .slice(0, 5);
  const semaine = semaines[semaines.length - 1] || { colis: 0 };
  const total = lignes.length;
  return {
    expediteur: sender.name,
    total,
    aujourdhui: parJour.get(aujourdhui) || 0,
    cetteSemaine: semaine.colis,
    semainePassee: semaines[semaines.length - 2]?.colis ?? null,
    ceMois: parMois.get(aujourdhui.slice(0, 7)) || 0,
    // une journee type : les jours depuis le premier drop (sans les dimanches)
    moyenneParJour: jours.length ? Math.round((total / jours.length) * 10) / 10 : 0,
    joursActifs: parJour.size,
    premierJour: parJour.size ? premier : null,
    meilleursJours,
    meilleureSemaine: semaines.reduce((m, w) => (w.colis > (m?.colis || 0) ? w : m), null),
    jours: jourSerie,
    semaines: semaines.slice(-104),
    mois: mois.slice(-60),
    transporteurs: [...parTransporteur.values()].sort((a, b) => b.colis - a.colis),
  };
}

// « Actualiser statuts La Poste » : les colis de l'expediteur designe par le
// jeton (et seulement eux) sont relus par l'API officielle, en tache de fond.
function actualisePortail(jeton) {
  if (typeof jeton !== "string" || !FORME_JETON.test(jeton)) return null;
  const sender = db.prepare("SELECT id, name FROM senders WHERE portail_jeton = ?").get(jeton);
  if (!sender || SANS_PORTAIL.has(sender.name)) return null;
  const lignes = db
    .prepare(
      `SELECT c.id, c.type, c.carrier, c.status, c.file_id, c.file_name, c.caption, c.created_at, c.printed_at, c.dropped_at
       FROM colis c JOIN senders s ON s.name = c.sender_name
       WHERE s.portail_jeton = ? AND c.status = 'dropped'`
    )
    .all(jeton);
  return lanceActualisation(`portail:${sender.id}`, lignes);
}

function etatActualisationPortail(jeton) {
  if (typeof jeton !== "string" || !FORME_JETON.test(jeton)) return null;
  const sender = db.prepare("SELECT id, name FROM senders WHERE portail_jeton = ?").get(jeton);
  if (!sender || SANS_PORTAIL.has(sender.name)) return null;
  return etatActualisation(`portail:${sender.id}`);
}

module.exports = {
  actualisePortail,
  etatActualisationPortail,
  portailPour,
  portailExiste,
  creePortail,
  retirePortail,
  infoPortail,
  redropPortail,
  statsPortail,
  DOMAINE_PORTAIL,
  PAR_PAGE,
};
