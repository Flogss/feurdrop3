const { horloge } = require("./sessions");

// Les essais de connexion : un delai qui double a chaque echec, par adresse,
// et un plafond pour l'ensemble des adresses (contre une attaque repartie).
//
//   - par adresse : les 3 premiers echecs passent ; ensuite, il faut attendre
//     2 s, 4 s, 8 s... (15 min au plus) avant de pouvoir reessayer. Une
//     connexion reussie efface le compte ; il s'oublie aussi apres 24 h ;
//   - pour tout le monde : au-dela de 60 echecs en 15 minutes, plus aucun
//     essai n'est accepte pendant le reste de la fenetre. Les appareils deja
//     connectes ne sont pas concernes.
//
// En memoire : un redemarrage remet les compteurs a zero, ce qui ne donne
// rien d'exploitable (un mot de passe de 12 caracteres et plus, verifie par
// Argon2id, ne se devine pas en quelques dizaines d'essais).

const ESSAIS_LIBRES = 3;
const ATTENTE_MAX_MS = 15 * 60 * 1000;
const OUBLI_MS = 24 * 3600 * 1000;
const FENETRE_GLOBALE_MS = 15 * 60 * 1000;
const MAX_GLOBAL = 60;

const parAdresse = new Map(); // ip -> { echecs, bloqueJusqua, dernier }
let globaux = []; // heures des echecs recents, toutes adresses confondues

function nettoie(t) {
  for (const [ip, e] of parAdresse) if (t - e.dernier > OUBLI_MS) parAdresse.delete(ip);
  globaux = globaux.filter((h) => t - h < FENETRE_GLOBALE_MS);
}

/** Peut-on essayer maintenant ? Sinon, combien de secondes attendre. */
function attente(ip) {
  const t = horloge.maintenant();
  nettoie(t);
  if (globaux.length >= MAX_GLOBAL) return Math.ceil((globaux[0] + FENETRE_GLOBALE_MS - t) / 1000);
  const e = parAdresse.get(ip);
  if (e && e.bloqueJusqua > t) return Math.ceil((e.bloqueJusqua - t) / 1000);
  return 0;
}

function echec(ip) {
  const t = horloge.maintenant();
  const e = parAdresse.get(ip) || { echecs: 0, bloqueJusqua: 0, dernier: t };
  e.echecs += 1;
  e.dernier = t;
  if (e.echecs >= ESSAIS_LIBRES) e.bloqueJusqua = t + Math.min(ATTENTE_MAX_MS, 1000 * 2 ** (e.echecs - ESSAIS_LIBRES + 1));
  parAdresse.set(ip, e);
  globaux.push(t);
}

function reussite(ip) {
  parAdresse.delete(ip);
}

/** pour les tests */
function remiseAZero() {
  parAdresse.clear();
  globaux = [];
}

module.exports = { attente, echec, reussite, remiseAZero, ESSAIS_LIBRES, MAX_GLOBAL };
