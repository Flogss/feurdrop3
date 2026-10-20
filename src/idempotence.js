// Une meme operation recue deux fois n'est appliquee qu'une fois. Le site et
// l'app joignent une cle unique (en-tete Idempotency-Key) a chaque operation
// qui compte (ajout de colis, stock, drop, « Fait » devant le locker) : si le
// reseau coupe APRES que le serveur l'a appliquee, ils peuvent la renvoyer
// sans risque -- la reponse d'origine est rejouee au lieu de refaire l'action.
//
// Les reponses sont gardees en base (30 min) : un renvoi apres un redemarrage
// du serveur -- un deploiement pendant qu'on est devant le locker -- est
// reconnu lui aussi (avant, la memoire du processus repartait de zero et
// l'ajout de colis passait deux fois). Les operations EN COURS restent en
// memoire : sur ce serveur, l'ecriture et la reponse se font dans le meme
// instant, une operation ne peut pas etre « en cours » a travers un
// redemarrage.
//
// Une seule memoire pour tous les routeurs : une cle est unique, d'ou qu'elle
// vienne.
const { db } = require("./db/connexion");

const enCours = new Set();
const OPERATION_TTL_MS = 30 * 60 * 1000;

// (preparees a chaque fois : la base peut etre rouverte, apres une restauration)
const lire = (cle, depuis) => db.prepare("SELECT statut, corps FROM idempotence WHERE cle = ? AND a > ?").get(cle, depuis);
const garder = (cle, a, statut, corps) =>
  db
    .prepare(
      "INSERT INTO idempotence (cle, a, statut, corps) VALUES (?, ?, ?, ?) ON CONFLICT(cle) DO UPDATE SET a = excluded.a, statut = excluded.statut, corps = excluded.corps"
    )
    .run(cle, a, statut, corps);
const purger = (avant) => db.prepare("DELETE FROM idempotence WHERE a <= ?").run(avant);
let dernierePurge = 0;

function idempotence() {
  return (req, res, next) => {
    const cle = String(req.get("idempotency-key") || "").slice(0, 200);
    // (une requete traverse parfois deux routeurs : /api puis /api/print --
    // elle n'est enregistree qu'une fois)
    if (!cle || req.method === "GET" || req.idempotenceVue) return next();
    req.idempotenceVue = true;
    const maintenant = Date.now();
    if (maintenant - dernierePurge > 60 * 1000) {
      dernierePurge = maintenant;
      purger(maintenant - OPERATION_TTL_MS);
    }
    if (enCours.has(cle)) return res.status(409).json({ error: "Opération déjà en cours" });
    const deja = lire(cle, maintenant - OPERATION_TTL_MS);
    if (deja) {
      res.set("Idempotent-Replay", "true");
      return res.status(deja.statut).json(JSON.parse(deja.corps));
    }
    enCours.add(cle);
    const envoie = res.json.bind(res);
    res.json = (corps) => {
      enCours.delete(cle);
      // une erreur du serveur n'a rien applique (les ecritures groupees sont
      // dans une transaction) : la cle reste libre pour qu'un nouvel essai
      // refasse l'operation au lieu de rejouer l'erreur
      if (res.statusCode < 500) garder(cle, Date.now(), res.statusCode, JSON.stringify(corps ?? null));
      return envoie(corps);
    };
    // une reponse qui n'est pas du JSON (erreur imprevue) libere la cle
    res.on("finish", () => enCours.delete(cle));
    res.on("close", () => enCours.delete(cle));
    next();
  };
}

module.exports = { idempotence };
