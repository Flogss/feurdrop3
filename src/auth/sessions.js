const crypto = require("crypto");
const { db } = require("../db");
const { versionMotDePasse } = require("./motDePasse");

// Les sessions du dashboard : une par appareil (navigateur ou app), chacune
// independante des autres.
//
//   - le jeton (256 bits aleatoires) part chez l'appareil ; la base n'en garde
//     que l'empreinte SHA-256 -- une copie de la base ne permet de se
//     connecter nulle part ;
//   - l'expiration est ABSOLUE : 72 h apres la connexion, quoi qu'il arrive.
//     L'activite ne la repousse jamais (`expire_le` n'est ecrit qu'une fois,
//     a la creation) ; elle est verifiee ici, a chaque requete ;
//   - une session revoquee (deconnexion, « déconnecter tous les appareils »)
//     ou ouverte avec un ancien mot de passe ne vaut plus rien.

const DUREE_MS = 72 * 3600 * 1000;
const NETTOYAGE_MS = 7 * 24 * 3600 * 1000; // les sessions mortes s'effacent apres 7 jours
const TYPES = new Set(["web", "app"]);

// L'heure, remplacable par les tests (pour verifier les 72 h sans attendre).
const horloge = { maintenant: () => Date.now() };

const empreinteJeton = (jeton) => crypto.createHash("sha256").update(jeton).digest("hex");
const FORME_JETON = /^[A-Za-z0-9_-]{43}$/;

function nettoie(t) {
  db.prepare("DELETE FROM sessions WHERE expire_le < ? OR (revoque_le IS NOT NULL AND revoque_le < ?)").run(t - NETTOYAGE_MS, t - NETTOYAGE_MS);
}

/** Ouvre une session neuve. Renvoie le jeton (a donner a l'appareil, jamais garde). */
function cree({ type, appareil = null }) {
  if (!TYPES.has(type)) throw new Error("type de session inconnu");
  const jeton = crypto.randomBytes(32).toString("base64url");
  const id = empreinteJeton(jeton);
  const t = horloge.maintenant();
  nettoie(t);
  db.prepare("INSERT INTO sessions (id, type, appareil, cree_le, expire_le, vu_le, mdp) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    type,
    appareil ? String(appareil).slice(0, 80) : null,
    t,
    t + DUREE_MS,
    t,
    versionMotDePasse()
  );
  return { jeton, id, expireLe: t + DUREE_MS };
}

/**
 * La session d'un jeton, si elle est encore valable : ni expiree, ni
 * revoquee, ni ouverte avec un ancien mot de passe. Sinon null.
 */
function lis(jeton) {
  if (typeof jeton !== "string" || !FORME_JETON.test(jeton)) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(empreinteJeton(jeton));
  if (!s) return null;
  const t = horloge.maintenant();
  if (s.revoque_le != null || t >= s.expire_le || !s.mdp || s.mdp !== versionMotDePasse()) return null;
  // « vue pour la derniere fois » (la liste des appareils), au plus une
  // ecriture par minute -- l'expiration, elle, ne bouge pas
  if (t - (s.vu_le || 0) > 60 * 1000) db.prepare("UPDATE sessions SET vu_le = ? WHERE id = ?").run(t, s.id);
  return s;
}

/** Ferme la session d'un jeton (deconnexion). */
function revoque(jeton) {
  if (typeof jeton !== "string" || !FORME_JETON.test(jeton)) return false;
  return db.prepare("UPDATE sessions SET revoque_le = ? WHERE id = ? AND revoque_le IS NULL").run(horloge.maintenant(), empreinteJeton(jeton)).changes > 0;
}

/** Ferme toutes les sessions ouvertes, sur tous les appareils. Renvoie leur nombre. */
function revoqueTout() {
  return db.prepare("UPDATE sessions SET revoque_le = ? WHERE revoque_le IS NULL AND expire_le > ?").run(horloge.maintenant(), horloge.maintenant()).changes;
}

/** Les sessions encore valables (la liste des appareils connectes). */
function actives() {
  const t = horloge.maintenant();
  const version = versionMotDePasse();
  return db
    .prepare("SELECT id, type, appareil, cree_le, expire_le, vu_le, mdp FROM sessions WHERE revoque_le IS NULL AND expire_le > ? ORDER BY vu_le DESC")
    .all(t)
    .filter((s) => s.mdp && s.mdp === version);
}

module.exports = { cree, lis, revoque, revoqueTout, actives, horloge, DUREE_MS, empreinteJeton };
