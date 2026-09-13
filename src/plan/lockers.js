// Casiers automatiques.
//
// Par defaut un trajet n'en propose aucun : un casier ne rend pas les memes
// services qu'un commerce (pas de preuve de depot en main propre, formats
// limites, colis refuse si le casier est plein), et pour la plupart des
// reseaux ce n'est tout simplement pas la ou on depose.
//
// Deux reseaux font exception, et seulement quand on le demande
// explicitement : UPS et Mondial Relay, dont les casiers acceptent vraiment
// les depots.

const LOCKER_CARRIERS = new Set(["UPS", "MR"]);

// Reconnaissance sur le nom et le type. Les sources qui savent le dire
// (OpenStreetMap avec amenity=parcel_locker, la liste Mondial Relay dont les
// casiers s'appellent "LOCKER ...") passent un drapeau explicite ; pour les
// autres il ne reste que le libelle.
const PATTERN = /\b(locker|consigne|casier|automate|packstation|abricolis)\b/i;

function looksLikeLocker({ name = "", kind = "" } = {}) {
  return PATTERN.test(`${name} ${kind}`);
}

// Ce point peut-il servir pour ce transporteur, compte tenu du reglage ?
function allowedFor(point, carrier, includeLockers) {
  if (!point.locker) return true;
  return Boolean(includeLockers) && LOCKER_CARRIERS.has(carrier);
}

module.exports = { LOCKER_CARRIERS, looksLikeLocker, allowedFor };
