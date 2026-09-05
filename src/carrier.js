// Devine le transporteur d'un colis a partir du nom de fichier du PDF et de
// la description/legende envoyee avec (les deux sont verifies, car selon les
// cas l'info utile se trouve dans l'un ou l'autre).
//
// Priorite de detection : UPS > La Poste > DPD > Mondial Relay > GLS.
// Mondial Relay est verifie avant GLS car une description du type
// "PR MONDIAL RELAY & GLS" doit etre classee MR, pas GLS.
function normalize(str) {
  return (str || "").toUpperCase();
}

function detectCarrier(fileName, caption) {
  const name = normalize(fileName).replace(/\.PDF$/i, "").trim();
  const desc = normalize(caption);
  const combined = `${name} ${desc}`;

  // UPS : motif de suivi "1Z..." ou mention explicite
  if (/1Z[0-9A-Z]{10,}/.test(combined) || /UPS/.test(combined)) return "UPS";

  // La Poste / Colissimo : prefixe "8R", format universel 2 lettres + 9
  // chiffres + FR, ou mention explicite (texte ou emoji boite aux lettres)
  if (
    /^8R\d{8,}/.test(name) ||
    /^[A-Z]{2}\d{9}FR$/.test(name) ||
    /LA POSTE|COLISSIMO/.test(desc) ||
    (caption || "").includes("📮")
  ) {
    return "LP";
  }

  // DPD : suivi numerique long (14 chiffres) commencant par 0, ou mention
  // explicite
  if (/^0\d{13}$/.test(name) || /\bDPD\b/.test(desc)) return "DPD";

  // Mondial Relay : mention explicite (prioritaire meme si "GLS" est cite
  // dans la meme description), ou suivi numerique court (8-10 chiffres,
  // parfois suivi de 1-3 lettres)
  if (/MONDIAL RELAY|\bMR\b/.test(desc) || /^\d{8,10}[A-Z]{0,3}$/.test(name)) return "MR";

  // GLS : uniquement si mentionne seul, sans Mondial Relay
  if (/\bGLS\b/.test(desc)) return "GLS";

  return null;
}

module.exports = { detectCarrier };
