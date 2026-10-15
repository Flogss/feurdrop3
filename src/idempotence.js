// Une meme operation recue deux fois n'est appliquee qu'une fois. Le site et
// l'app joignent une cle unique (en-tete Idempotency-Key) a chaque operation
// qui compte (ajout de colis, stock, drop, « Fait » devant le locker) : si le
// reseau coupe APRES que le serveur l'a appliquee, ils peuvent la renvoyer
// sans risque -- la reponse d'origine est rejouee au lieu de refaire l'action.
//
// Une seule memoire pour tous les routeurs : une cle est unique, d'ou qu'elle
// vienne.

const operations = new Map(); // cle -> { at, status, corps } ou { at, enCours }
const OPERATION_TTL_MS = 30 * 60 * 1000;

function idempotence() {
  return (req, res, next) => {
    const cle = req.get("idempotency-key");
    // (une requete traverse parfois deux routeurs : /api puis /api/print --
    // elle n'est enregistree qu'une fois)
    if (!cle || req.method === "GET" || req.idempotenceVue) return next();
    req.idempotenceVue = true;
    const maintenant = Date.now();
    for (const [k, op] of operations) if (maintenant - op.at > OPERATION_TTL_MS) operations.delete(k);
    const deja = operations.get(cle);
    if (deja) {
      if (deja.enCours) return res.status(409).json({ error: "Opération déjà en cours" });
      res.set("Idempotent-Replay", "true");
      return res.status(deja.status).json(deja.corps);
    }
    operations.set(cle, { at: maintenant, enCours: true });
    const envoie = res.json.bind(res);
    res.json = (corps) => {
      // une erreur du serveur n'a rien applique (les ecritures groupees sont
      // dans une transaction) : la cle est liberee pour qu'un nouvel essai
      // refasse l'operation au lieu de rejouer l'erreur
      if (res.statusCode >= 500) operations.delete(cle);
      else operations.set(cle, { at: Date.now(), status: res.statusCode, corps });
      return envoie(corps);
    };
    // une reponse qui n'est pas du JSON (erreur imprevue) libere la cle
    res.on("finish", () => {
      if (operations.get(cle)?.enCours) operations.delete(cle);
    });
    next();
  };
}

module.exports = { idempotence };
