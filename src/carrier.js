// Devine le transporteur d'un colis a partir du nom de fichier du PDF et de
// la description/legende envoyee avec. Les deux sont fouilles de la meme
// maniere : le numero de suivi peut se trouver dans l'un comme dans l'autre
// (ex. fichier "safari.pdf" avec "8569588855" en description).
function normalize(str) {
  return (str || "").toUpperCase();
}

// Decoupe une chaine en jetons alphanumeriques, pour isoler un eventuel
// numero de suivi noye au milieu d'autre texte.
function tokensOf(str) {
  return normalize(str).split(/[^A-Z0-9]+/).filter(Boolean);
}

// Reconnait un transporteur a partir d'un seul jeton (numero de suivi).
function carrierFromToken(token) {
  if (/^1Z[0-9A-Z]{10,}$/.test(token)) return "UPS";
  if (/^8R\d{8,}$/.test(token)) return "LP";
  if (/^[A-Z]{2}\d{9}FR$/.test(token)) return "LP";
  if (/^0\d{13}$/.test(token)) return "DPD";
  if (/^\d{8,10}[A-Z]{0,3}$/.test(token)) return "MR";
  return null;
}

// Ordre de confiance quand plusieurs numeros sont presents.
const TOKEN_PRIORITY = ["UPS", "LP", "DPD", "MR"];

function detectCarrier(fileName, caption) {
  const combined = `${normalize(fileName)} ${normalize(caption)}`;

  // 1. Mention explicite du transporteur, ou motif tres distinctif.
  //    Mondial Relay passe avant GLS : "PR MONDIAL RELAY & GLS" -> MR.
  if (/UPS/.test(combined) || /1Z[0-9A-Z]{14,}/.test(combined)) return "UPS";
  if (/LA POSTE|COLISSIMO|CHRONOPOST/.test(combined) || (caption || "").includes("📮")) return "LP";
  if (/\bDPD\b/.test(combined)) return "DPD";
  if (/MONDIAL RELAY|\bMR\b/.test(combined)) return "MR";
  if (/\bGLS\b/.test(combined)) return "GLS";

  // 2. Motif de numero de suivi, cherche dans le nom ET dans la description.
  const found = [...tokensOf(fileName), ...tokensOf(caption)].map(carrierFromToken).filter(Boolean);
  for (const carrier of TOKEN_PRIORITY) {
    if (found.includes(carrier)) return carrier;
  }

  return null;
}

module.exports = { detectCarrier };
