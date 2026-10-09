const crypto = require("crypto");
const { db, getSetting, setSetting, tourScope, journalise } = require("./db");
const { suiviDuColis, transporteurDuColis } = require("./suiviColis");
const { carrierLabel } = require("./carrier");
const { FORME_JETON } = require("./portailCommun");

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
// fichier, ni legende, ni rien du dashboard.
function vueColis(colis, dansLeSac) {
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
  // l'expediteur vient du jeton : la requete ne prend rien d'autre
  const lignes = db
    .prepare(
      `SELECT c.id, c.type, c.carrier, c.status, c.file_id, c.file_name, c.caption,
              c.created_at, c.printed_at, c.dropped_at
       FROM colis c JOIN senders s ON s.name = c.sender_name
       WHERE s.portail_jeton = ? AND c.status IN ('pending', 'dropped')
         AND (c.status = 'pending' OR c.id IN (
           SELECT c2.id FROM colis c2 JOIN senders s2 ON s2.name = c2.sender_name
           WHERE s2.portail_jeton = ? AND c2.status IN ('pending', 'dropped')
           ORDER BY c2.created_at DESC, c2.id DESC LIMIT ?))
       ORDER BY c.created_at DESC, c.id DESC`
    )
    .all(jeton, jeton, n);
  const total = db
    .prepare(
      `SELECT COUNT(*) AS c FROM colis c JOIN senders s ON s.name = c.sender_name
       WHERE s.portail_jeton = ? AND c.status IN ('pending', 'dropped')`
    )
    .get(jeton).c;

  const sac = idsDuSac();
  const colis = lignes.map((l) => vueColis(l, sac));
  const compte = { a_imprimer: 0, imprime: 0, en_drop: 0, drope: 0 };
  for (const c of colis) if (c.etape !== "drope") compte[c.etape] += 1;
  // les dropes se comptent sur tout l'historique, pas seulement la page
  compte.drope = total - (compte.a_imprimer + compte.imprime + compte.en_drop);

  return { expediteur: sender.name, compte, colis, total, suite: lignes.length < total };
}

module.exports = { portailPour, portailExiste, creePortail, retirePortail, infoPortail, DOMAINE_PORTAIL, PAR_PAGE };
