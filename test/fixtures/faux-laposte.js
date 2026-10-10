// Un faux serveur de l'API Suivi v2 de La Poste, aux formats observes sur la
// vraie API (octobre 2026) : 200 avec shipment.event[], 404 inconnu, 400
// numero mal forme, 401 cle refusee ou "au piquet", 429, 403, 5xx, lenteur.
const http = require("http");

function creeFauxLaPoste({ cle = "cle-okapi-test" } = {}) {
  const suivis = new Map(); // numero -> { events, product, isFinal }
  const comportements = new Map(); // numero -> "invalide" | "inconnu" | "panne" | "lent"
  const forces = []; // reponses forcees (globales), dans l'ordre : { status, corps, entetes }
  const appels = [];

  const serveur = http.createServer(async (req, res) => {
    const m = /^\/suivi\/v2\/idships\/([^/?]+)/.exec(req.url);
    const numero = m ? decodeURIComponent(m[1]) : null;
    appels.push({ numero, at: Date.now(), cle: req.headers["x-okapi-key"] });
    const envoie = (status, corps, entetes = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...entetes });
      res.end(JSON.stringify(corps));
    };
    if (req.headers["x-okapi-key"] !== cle) return envoie(401, { code: "UNAUTHORIZED", message: "Invalid key" });
    const f = forces.shift();
    if (f) return envoie(f.status, f.corps || {}, f.entetes);
    const c = comportements.get(numero);
    if (c === "lent") return setTimeout(() => envoie(200, {}), 5000);
    if (c === "panne") return envoie(503, { message: "Service Unavailable" });
    if (c === "invalide") return envoie(400, { returnCode: 400, returnMessage: "Le numéro que vous avez saisi n’est pas valide." });
    const s = suivis.get(numero);
    if (!s || c === "inconnu") return envoie(404, { returnCode: 404, returnMessage: "Numéro de suivi inconnu" });
    return envoie(200, {
      lang: "fr_FR",
      returnCode: 200,
      returnMessage: "transaction OK.",
      shipment: { idShip: numero, product: s.product || "colissimo", isFinal: Boolean(s.isFinal), event: s.events.map((e, i) => ({ order: e.order ?? s.events.length - i, ...e })) },
    });
  });

  return {
    cle,
    demarre: () => new Promise((r) => serveur.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${serveur.address().port}/suivi/v2`))),
    ferme: () =>
      new Promise((r) => {
        serveur.closeAllConnections();
        serveur.close(r);
      }),
    appels,
    // ce que La Poste sait d'un numero : evenements du plus recent au plus ancien
    suivi: (numero, events, { product, isFinal } = {}) => suivis.set(numero, { events, product, isFinal }),
    comporte: (numero, c) => comportements.set(numero, c),
    force: (status, corps, entetes) => forces.push({ status, corps, entetes }),
    vide: () => {
      forces.length = 0;
      comportements.clear();
    },
    appelsPour: (numero) => appels.filter((a) => a.numero === numero),
  };
}

module.exports = { creeFauxLaPoste };
