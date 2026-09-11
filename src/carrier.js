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
  { code: "DHL", label: "DHL", aliases: ["dhl"] },
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

// --- Apprentissage ----------------------------------------------------------
// Corriger un colis avec /transporteur apprend deux choses : la FORME du
// numero de suivi et le mot-cle de la description. Les envois suivants qui
// partagent l'une des deux sont classes tout seuls.

// Signature de la forme d'un jeton : "857030747501" -> "D12",
// "8R60235771718" -> "D1L1D11", "XT269045554TS" -> "L2D9L2".
function tokenShape(token) {
  const runs = normalize(token).match(/(\d+|[A-Z]+)/g);
  if (!runs) return null;
  return runs.map((run) => `${/\d/.test(run[0]) ? "D" : "L"}${run.length}`).join("");
}

// Un jeton ressemble a un numero de suivi s'il est long et contient des
// chiffres. Les mots seuls (DHL, SCAN) n'en sont pas.
function looksLikeTracking(token) {
  return token.length >= 8 && /\d/.test(token) && /^[A-Z0-9]+$/.test(token);
}

// Mots trop generiques pour identifier un transporteur a eux seuls : on ne les
// apprend jamais comme mot-cle.
const GENERIC_WORDS = new Set([
  "SCAN", "COLIS", "COLISSIMO", "LABEL", "ETIQUETTE", "ETIQUETTES", "PARIS", "FRANCE", "LYON",
  "MARSEILLE", "PDF", "IMG", "IMAGE", "PHOTO", "DOCUMENT", "RELAIS", "RELAY", "POINT", "SAFARI",
  "ENVOI", "EXPEDITION", "SUIVI", "NUMERO", "DEPOT", "RETOUR", "BON", "COPIE", "DOWNLOAD", "FILE",
  "SANS", "TITRE", "NEW", "SCREENSHOT", "CAPTURE", "ECRAN",
]);

// Ce qu'il y a a retenir d'un colis qu'on vient de corriger a la main.
function deriveRules(fileName, caption) {
  const rules = [];
  const seen = new Set();
  const add = (kind, value) => {
    const key = `${kind}:${value}`;
    if (value && !seen.has(key)) {
      seen.add(key);
      rules.push({ kind, value });
    }
  };

  // 1. la forme de chaque numero de suivi present
  for (const token of [...tokensOf(fileName), ...tokensOf(caption)]) {
    if (looksLikeTracking(token)) add("shape", tokenShape(token));
  }

  // 2. le premier mot significatif de la description ("DHL SCAN" -> DHL)
  for (const token of tokensOf(caption)) {
    if (/^[A-Z]{2,}$/.test(token) && token.length >= 3 && !GENERIC_WORDS.has(token)) {
      add("keyword", token);
      break;
    }
  }

  return rules;
}

// Regles apprises, testees avant les regles internes : elles existent
// justement parce que la detection d'origine s'etait trompee ou avait seche.
function matchLearnedRules(fileName, caption, rules) {
  if (!rules || rules.length === 0) return null;

  const keywords = rules.filter((r) => r.kind === "keyword");
  const shapes = rules.filter((r) => r.kind === "shape");
  const tokens = [...tokensOf(fileName), ...tokensOf(caption)];

  for (const rule of keywords) {
    if (tokens.includes(rule.value)) return rule.carrier;
  }
  for (const token of tokens) {
    if (!looksLikeTracking(token)) continue;
    const shape = tokenShape(token);
    const found = shapes.find((r) => r.value === shape);
    if (found) return found.carrier;
  }
  return null;
}

function detectCarrier(fileName, caption, learnedRules) {
  const learned = matchLearnedRules(fileName, caption, learnedRules);
  if (learned) return learned;

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
  if (/\bDHL\b/.test(combined)) return "DHL";

  // 2. Motif de numero de suivi, cherche dans le nom ET dans la description.
  const found = [...tokensOf(fileName), ...tokensOf(caption)].map(carrierFromToken).filter(Boolean);
  for (const carrier of TOKEN_PRIORITY) {
    if (found.includes(carrier)) return carrier;
  }

  return null;
}

module.exports = { detectCarrier, CARRIERS, parseCarrier, carrierLabel, deriveRules, tokenShape };
