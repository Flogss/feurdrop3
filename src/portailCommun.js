const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Ce que partagent le dashboard (qui fournit les colis du portail) et le
// petit serveur du portail (qui sert la page sur son propre domaine) : la
// forme d'un jeton, les en-tetes de securite, le limiteur d'essais. Rien ici
// ne touche a la base : le serveur du portail n'en a pas.

const FORME_JETON = /^[A-Za-z0-9_-]{24,64}$/;

const PAGE = path.join(__dirname, "pages", "portail.html");
const PUBLIC = path.join(__dirname, "..", "public");

// La page, avec l'empreinte du contenu de chacun de ses fichiers dans leur
// adresse (/portail.js?v=3f9a1c2e) : apres une mise a jour, aucun navigateur
// ne melange la nouvelle page et un ancien script garde en cache. Calculee
// une fois : les fichiers ne changent pas tant que le serveur tourne.
let pageVersionnee = null;
function pageHtml() {
  if (!pageVersionnee) {
    pageVersionnee = fs.readFileSync(PAGE, "utf8").replace(/(href|src)="\/(styles\.css|portail\.css|portail\.js)"/g, (tout, attr, fichier) => {
      const empreinte = crypto.createHash("sha1").update(fs.readFileSync(path.join(PUBLIC, fichier))).digest("hex").slice(0, 10);
      return `${attr}="/${fichier}?v=${empreinte}"`;
    });
  }
  return pageVersionnee;
}

const ENTETES = {
  "Cache-Control": "no-store",
  // le lien est la cle : il ne doit pas partir chez le transporteur quand on
  // clique sur "Suivre le colis", ni etre indexe
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  // le fond vivant : ses particules sont dessinees dans un worker
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const ENTETES_PAGE = { ...ENTETES, "Content-Security-Policy": CSP, "X-Frame-Options": "DENY" };

// Par adresse IP : au-dela de `max` echecs dans la fenetre, on refuse jusqu'a
// ce qu'elle se termine. Un jeton est introuvable a l'aveugle (144 bits), mais
// autant ne pas laisser quelqu'un en essayer des milliers.
function limiteur({ fenetreMs, max }) {
  const echecs = new Map();
  const actif = (cle) => {
    const e = echecs.get(cle);
    if (e && Date.now() - e.debut > fenetreMs) {
      echecs.delete(cle);
      return null;
    }
    return e || null;
  };
  return {
    bloque: (cle) => (actif(cle)?.n || 0) >= max,
    echec(cle) {
      const e = actif(cle);
      if (e) e.n += 1;
      else echecs.set(cle, { debut: Date.now(), n: 1 });
      if (echecs.size > 5000) for (const k of echecs.keys()) actif(k);
    },
  };
}

module.exports = { FORME_JETON, PAGE, PUBLIC, pageHtml, ENTETES, ENTETES_PAGE, limiteur };
