// En-tetes de securite de l'interface du dashboard.
//
// Ils ne remplacent pas une authentification (l'API reste ouverte, c'est un
// choix assume a part) : ils empechent qu'une donnee piegee -- un nom
// d'expediteur venu de Telegram, par exemple -- puisse executer du script
// dans la page, que le dashboard soit affiche dans le cadre d'un autre site,
// ou que son adresse parte chez les sites des transporteurs.

// Tout vient du site lui-meme. Les seules souplesses :
//   - style-src 'unsafe-inline' : les lignes de la liste posent leur teinte
//     et leur rang en attribut style (style="--h:212"), et l'interface en
//     depend partout ;
//   - img-src data: : les icones des feuilles de style sont des SVG en data:.
// Pas de script en ligne, pas d'eval, pas de ressource exterieure.
const CSP_DASHBOARD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  // les particules du fond et le lancement sont dessines dans des workers ;
  // le service worker des notifications aussi
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Sur toutes les reponses.
function entetesSecurite(req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    // l'adresse du dashboard ne part pas chez les transporteurs ou ailleurs
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    // le site vibre, copie et partage ; il n'a besoin de rien d'autre
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  });
  // en HTTPS seulement (Railway) : en local, le site reste joignable en http
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  next();
}

// Pour express.static : la politique de contenu va sur les pages HTML. Les
// PDF d'etiquettes, images et scripts n'en ont pas besoin (une CSP sur un PDF
// peut gener la visionneuse du navigateur).
function entetesFichier(res, chemin) {
  if (/\.html?$/i.test(chemin)) res.set("Content-Security-Policy", CSP_DASHBOARD);
  // le service worker doit toujours etre relu : une ancienne version garderait
  // l'ancienne logique des notifications
  if (/[\\/]sw\.js$/.test(chemin)) res.set("Cache-Control", "no-cache");
}

module.exports = { CSP_DASHBOARD, entetesSecurite, entetesFichier };
