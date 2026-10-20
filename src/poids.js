// Un poids ecrit a la main, dans la description d'un colis ou apres /poids :
// « 📦 mondial relay\n5kg », « 5 kg », « 1,5kg », « 750 g », « 2 kilos ».
// Rendu en grammes (entiers), ou null.

// au-dela, c'est une faute de frappe, pas un colis
const POIDS_MAX_G = 100 * 1000;

function enGrammes(valeur, unite) {
  const n = Number(String(valeur).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const g = Math.round(/^(g|gr|grammes?)$/i.test(unite) ? n : n * 1000);
  return g > 0 && g <= POIDS_MAX_G ? g : null;
}

/**
 * @param {string} texte
 * @param {{ nombreSeulEnKg?: boolean }} options  « /poids 5 » : un nombre seul est en kg
 */
function lisPoids(texte, { nombreSeulEnKg = false } = {}) {
  if (!texte) return null;
  // un nombre suivi de son unite, pas le morceau d'un numero de suivi
  const m = String(texte).match(/(?<![A-Za-z0-9.,])(\d+(?:[.,]\d+)?)\s*(kg|kgs|kilos?|grammes?|gr|g)(?![A-Za-z])/i);
  if (m) return enGrammes(m[1], m[2]);
  if (nombreSeulEnKg) {
    const seul = String(texte).trim().match(/^(\d+(?:[.,]\d+)?)$/);
    if (seul) return enGrammes(seul[1], "kg");
  }
  return null;
}

module.exports = { lisPoids, POIDS_MAX_G };
