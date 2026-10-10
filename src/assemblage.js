const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Le site est ecrit en plusieurs fichiers (public/js/, public/css/), un par
// partie de l'interface, mais le navigateur continue de recevoir UN script
// (/app.js) et UNE feuille de style (/styles.css), exactement comme avant :
// les morceaux sont mis bout a bout, dans l'ordre ci-dessous, sans rien y
// ajouter. Le resultat est identique, octet pour octet, a ce que serait le
// fichier unique -- memes declarations partagees, meme ordre de cascade CSS,
// une seule requete chacun. Pas d'etape de construction a lancer.
//
// Ajouter un fichier : l'inscrire ici, a sa place dans l'ordre.

const PUBLIC = path.join(__dirname, "..", "public");

const PAQUETS = {
  "app.js": {
    type: "application/javascript; charset=UTF-8",
    morceaux: [
      "js/00-base.js", // outils, reseau, retours d'action, feuille de confirmation
      "js/10-interface.js", // fond vivant, barre d'onglets, navigation, chiffres vivants
      "js/20-dashboard.js", // dashboard, tournee, anneau, historique
      "js/30-reglages.js", // reglages, espaces expediteurs, stock
      "js/40-graphiques.js",
      "js/50-actions.js", // rafraichissement, gestes, notifications
      "js/60-suivi.js",
      "js/70-impression.js", // onglet Imprime, edition d'un colis
      "js/75-depots.js", // controle des depots
      "js/80-locker.js",
      "js/90-demarrage.js",
    ],
  },
  "styles.css": {
    type: "text/css; charset=UTF-8",
    morceaux: [
      "css/00-fondations.css", // systeme de design, fond, barres, vues
      "css/10-composants.css", // briques communes, chiffres vivants
      "css/20-dashboard.css",
      "css/30-pages.css", // Imprime, Stats, Reglages, locker, suivi
      "css/35-depots.css", // controle des depots
      "css/40-retours.css", // toasts, feuille de confirmation
      "css/50-adaptations.css", // petits ecrans, bureau, mouvement reduit
      "css/60-historique.css",
    ],
  },
};

// Gardes en memoire, refaits si un morceau change sur le disque (en
// developpement, une modification se voit au rechargement suivant).
const cache = new Map(); // nom -> { signature, contenu, etag }

function signature(chemins) {
  return chemins.map((c) => `${c}:${fs.statSync(c).mtimeMs}:${fs.statSync(c).size}`).join("|");
}

/** { contenu, etag, type } d'un paquet, ou null si `nom` n'en est pas un. */
function paquet(nom) {
  const def = PAQUETS[nom];
  if (!def) return null;
  const chemins = def.morceaux.map((m) => path.join(PUBLIC, m));
  const sig = signature(chemins);
  const deja = cache.get(nom);
  if (deja && deja.signature === sig) return deja;
  const contenu = Buffer.concat(chemins.map((c) => fs.readFileSync(c)));
  const etag = `"${crypto.createHash("sha1").update(contenu).digest("base64url")}"`;
  const pret = { signature: sig, contenu, etag, type: def.type };
  cache.set(nom, pret);
  return pret;
}

// Les octets d'un fichier du site : un paquet assemble, ou un fichier simple.
function contenuPublic(nom) {
  return paquet(nom)?.contenu ?? fs.readFileSync(path.join(PUBLIC, nom));
}

// Middleware Express : sert /app.js et /styles.css (revalides a chaque
// chargement, 304 tant qu'ils n'ont pas change -- comme express.static).
// `seulement` : les paquets servis (le portail n'a besoin que des styles).
function servirPaquets({ seulement = Object.keys(PAQUETS) } = {}) {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const nom = req.path.replace(/^\//, "");
    if (!seulement.includes(nom)) return next();
    const p = paquet(nom);
    if (!p) return next();
    res.set({ "Content-Type": p.type, "Cache-Control": "no-cache", ETag: p.etag });
    if (req.get("if-none-match") === p.etag) return res.status(304).end();
    res.send(p.contenu);
  };
}

module.exports = { PAQUETS, paquet, contenuPublic, servirPaquets };
