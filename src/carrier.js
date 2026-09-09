// Devine le transporteur d'un colis a partir du nom de fichier du PDF et de
// la description/legende envoyee avec. Les deux sont fouilles de la meme
// maniere : le numero de suivi peut se trouver dans l'un comme dans l'autre
// (ex. fichier "safari.pdf" avec "8569588855" en description).

// Reference unique des transporteurs : le bot (commandes /transporteur), les
// alertes et le dashboard s'appuient tous dessus.
// "BJ" n'est pas un transporteur mais un type de colis ; il figure ici parce
// qu'on doit pouvoir le corriger avec la meme commande.
const CARRIERS = [
  { code: "MR", label: "Mondial Relay", aliases: ["mr", "mondial", "mondialrelay", "relay", "relais"] },
  { code: "LP", label: "La Poste", aliases: ["lp", "laposte", "poste", "colissimo"] },
  { code: "CHRONO", label: "Chronopost", aliases: ["chrono", "chronopost", "relaischrono"] },
  { code: "UPS", label: "UPS", aliases: ["ups"] },
  { code: "DPD", label: "DPD", aliases: ["dpd"] },
  { code: "GLS", label: "GLS", aliases: ["gls"] },
  { code: "BJ", label: "BJ", aliases: ["bj"] },
];

// Retrouve un transporteur a partir de ce que l'utilisateur a tape
// ("mondial relay", "MR", "chronopost"...). Renvoie null si rien ne colle.
function parseCarrier(input) {
  const clean = (input || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!clean) return null;
  for (const carrier of CARRIERS) {
    if (carrier.code.toLowerCase() === clean) return carrier;
    if (carrier.aliases.includes(clean)) return carrier;
  }
  // tolerance : "mondialrelaygls" contient "mondialrelay"
  for (const carrier of CARRIERS) {
    if (carrier.aliases.some((alias) => alias.length >= 3 && clean.includes(alias))) return carrier;
  }
  return null;
}

function carrierLabel(code) {
  const found = CARRIERS.find((c) => c.code === code);
  return found ? found.label : code;
}

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
  // 2 lettres + 9 chiffres + 2 lettres : suffixe FR = La Poste (CZ...FR),
  // tout autre suffixe = Chronopost (XT269045554TS, XX110267261JB)
  if (/^[A-Z]{2}\d{9}FR$/.test(token)) return "LP";
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(token)) return "CHRONO";
  if (/^0\d{13}$/.test(token)) return "DPD";
  if (/^\d{8,10}[A-Z]{0,3}$/.test(token)) return "MR";
  return null;
}

// Ordre de confiance quand plusieurs numeros sont presents.
const TOKEN_PRIORITY = ["UPS", "CHRONO", "LP", "DPD", "MR"];

function detectCarrier(fileName, caption) {
  const combined = `${normalize(fileName)} ${normalize(caption)}`;

  // 1. Mention explicite du transporteur, ou motif tres distinctif.
  //    Mondial Relay passe avant GLS : "PR MONDIAL RELAY & GLS" -> MR.
  //    Chronopost passe avant La Poste : c'est un point de depot different.
  if (/UPS/.test(combined) || /1Z[0-9A-Z]{14,}/.test(combined)) return "UPS";
  if (/CHRONOPOST|RELAIS CHRONO|\bCHRONO\b/.test(combined)) return "CHRONO";
  if (/LA POSTE|COLISSIMO/.test(combined) || (caption || "").includes("📮")) return "LP";
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

module.exports = { detectCarrier, CARRIERS, parseCarrier, carrierLabel };
