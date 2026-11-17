// Outils HTTP communs aux routes du dashboard.

// Express 4 ne rattrape pas les promesses rejetees : une erreur dans un
// gestionnaire async devenait un rejet non gere, et Node arretait tout le
// processus -- le site ET le bot. Chaque route async passe donc par ici :
// l'erreur est remise a Express, qui repond au lieu de mourir.
function routeAsync(gestionnaire) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => gestionnaire(req, res, next))
      .catch(next);
  };
}

// Une erreur attendue (donnee invalide, rien a faire) : un message lisible,
// en 400 par defaut.
function echec(res, err, status = 400) {
  res.status(status).json({ error: err?.message || String(err) });
}

function tailleLisible(octets) {
  if (!Number.isFinite(octets)) return "?";
  if (octets >= 1024 * 1024) return `${Math.round(octets / (1024 * 1024))} Mo`;
  return `${Math.round(octets / 1024)} Ko`;
}

// Dernier recours, monte apres toutes les routes : toute erreur remontee a
// Express (corps trop gros, JSON illisible, exception imprevue) devient une
// reponse JSON que le site et l'app savent afficher, au lieu d'une page HTML.
// (Express reconnait un gestionnaire d'erreurs a ses quatre arguments.)
function gestionErreurs(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  let message = err.message || "Erreur interne";
  if (err.type === "entity.too.large") message = `Requête trop volumineuse (maximum ${tailleLisible(err.limit)})`;
  else if (err.type === "entity.parse.failed") message = "Corps de requête JSON illisible";
  if (status >= 500) {
    // le detail (message SQL, chemin de fichier, pile) reste dans les
    // journaux : la reponse, qui peut partir vers une page publique (le
    // portail), n'en dit rien -- sauf erreur faite pour etre lue (expose)
    console.error(`[http] ${req.method} ${req.originalUrl} :`, err.stack || err.message);
    if (err.expose !== true) message = "Erreur interne";
  }
  res.status(status).json({ error: message });
}

module.exports = { routeAsync, echec, gestionErreurs };
