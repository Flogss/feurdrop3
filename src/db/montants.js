// Montants et tarifs.

// Tarifs par defaut d'un nouvel expediteur (surcharges par l'environnement).
const DEFAULT_PRICE = Number(process.env.DEFAULT_PRICE || 4);
const DEFAULT_LIT_PRICE = Number(process.env.DEFAULT_LIT_PRICE || 5.5);
const DEFAULT_BJ_PRICE = Number(process.env.DEFAULT_BJ_PRICE || DEFAULT_PRICE);

// Montants : des euros au centime pres. Ils restent stockes en REAL (le
// passage en centimes entiers est etudie dans scripts/etude-centimes.js),
// mais sont arrondis au centime a l'ecriture et dans chaque total : une somme
// de prix ne vaut jamais 10,499999999 € a l'ecran ni dans l'app.
function arrondiCentimes(valeur) {
  const v = Number(valeur);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Math.sign(v) * Number.EPSILON) * 100) / 100;
}

// Prix applique a un colis selon son type : les LIT ont leur propre tarif par
// expediteur, les BJ suivent le tarif normal.
function priceForType(sender, type) {
  if (type === "lit") return sender.lit_price;
  if (type === "bj") return sender.bj_price;
  return sender.price; // "special" suit le tarif normal
}

module.exports = {
  arrondiCentimes,
  priceForType,
  DEFAULT_PRICE,
  DEFAULT_LIT_PRICE,
  DEFAULT_BJ_PRICE,
};
