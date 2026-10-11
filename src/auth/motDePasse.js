const crypto = require("crypto");
const argon2 = require("argon2");

// Le mot de passe du dashboard n'existe nulle part en clair -- ni dans le
// code, ni dans GitHub, ni dans la base, ni sur Railway. Le serveur ne
// connait que son empreinte Argon2id, dans la variable DASHBOARD_PASSWORD_HASH
// (generee sur ton ordinateur par `npm run mot-de-passe`, voir SECURITE.md).
//
// Changer le mot de passe change l'empreinte : toutes les sessions ouvertes
// avec l'ancien tombent d'elles-memes (voir sessions.js, colonne `mdp`).

// Une empreinte Argon2id au format PHC, et rien d'autre : une variable qui
// contiendrait un mot de passe en clair (ou un autre algorithme) est refusee.
// (les parametres m, t, p peuvent venir dans n'importe quel ordre)
const FORME = /^\$argon2id\$v=\d+\$[mtp]=\d+(?:,[mtp]=\d+){2}\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

// Les reglages de l'empreinte : Argon2id, 64 Mio, 3 passes (au-dessus du
// minimum recommande par l'OWASP : 19 Mio, 2 passes). Une verification prend
// une fraction de seconde au serveur, et rend toute attaque par force brute
// sans espoir.
const REGLAGES = { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 };

// Un mot de passe trop court ne se protege pas, quelle que soit l'empreinte.
const LONGUEUR_MIN = 12;
const LONGUEUR_MAX = 256;

function empreinteConfiguree() {
  const brut = String(process.env.DASHBOARD_PASSWORD_HASH || "").trim();
  return FORME.test(brut) ? brut : null;
}

const estConfigure = () => Boolean(empreinteConfiguree());

/** La version du mot de passe en vigueur : une signature courte de son empreinte. */
function versionMotDePasse() {
  const h = empreinteConfiguree();
  return h ? crypto.createHash("sha256").update(h).digest("hex").slice(0, 16) : null;
}

/** Le mot de passe propose correspond-il ? (false si rien n'est configure) */
async function verifie(motDePasse) {
  const h = empreinteConfiguree();
  if (!h || typeof motDePasse !== "string" || !motDePasse || motDePasse.length > LONGUEUR_MAX) return false;
  try {
    return await argon2.verify(h, motDePasse);
  } catch {
    return false;
  }
}

/** L'empreinte d'un nouveau mot de passe (pour `npm run mot-de-passe`). */
async function empreinte(motDePasse) {
  if (typeof motDePasse !== "string" || motDePasse.length < LONGUEUR_MIN) {
    throw new Error(`le mot de passe doit faire au moins ${LONGUEUR_MIN} caractères`);
  }
  if (motDePasse.length > LONGUEUR_MAX) throw new Error(`le mot de passe ne doit pas dépasser ${LONGUEUR_MAX} caractères`);
  return argon2.hash(motDePasse, REGLAGES);
}

module.exports = { estConfigure, versionMotDePasse, verifie, empreinte, FORME, LONGUEUR_MIN, LONGUEUR_MAX };
