// A quel topic destiner un fichier envoye au bot en prive.
//
// Les regles sortent des fichiers reellement recus, pas d'une intuition :
//
//   - une PHOTO n'est jamais une etiquette. C'est une capture, un colis
//     photographie, une question. Elle va dans "special", ou elle ne vaut rien
//     et ne se drope pas ;
//   - une boite jaune s'annonce par son nom de fichier : les bordereaux
//     recus s'appellent BOITEJAUNE6N00028490616.pdf. Leur format est celui
//     d'une etiquette ordinaire, 102 x 152 mm, donc seul le nom les trahit ;
//   - un LIT est un gros colis, et son bordereau arrive sur une feuille A4
//     entiere la ou une etiquette ordinaire fait 102 x 152 mm. Le format de
//     page est ici un signal franc, mesurable, et non une supposition ;
//   - le reste part en normaux.
//
// Le classement n'a pas besoin d'etre parfait : /special, /lit et /bj le
// corrigent en un geste, et la correction deplace le message.

const MM = 72 / 25.4;
// A4 fait 210 x 297 ; une etiquette thermique 102 x 152. Le seuil est large
// pour laisser passer les formats voisins (Letter, A4 legerement rogne).
const GRANDE_PAGE_MM = 180;

const BJ_PATTERN = /bo[iî]te?[\s_-]*jaune|^bj[\s_-]/i;

function nomDitBoiteJaune(fileName, caption) {
  const texte = `${fileName || ""} ${caption || ""}`;
  return BJ_PATTERN.test(texte);
}

// Plus grande dimension de la premiere page, en millimetres. Renvoie 0 si on
// ne sait pas lire le PDF : dans le doute on ne classe pas en LIT.
async function plusGrandCote(bytes) {
  try {
    const { PDFDocument } = require("pdf-lib");
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    if (doc.getPageCount() === 0) return 0;
    const { width, height } = doc.getPage(0).getSize();
    return Math.max(width, height) / MM;
  } catch (err) {
    return 0;
  }
}

/**
 * @param {object} fichier { fileName, caption, kind: "pdf"|"image", bytes }
 * @returns {"special"|"bj"|"lit"|"normal"}
 */
async function classifyFile({ fileName, caption, kind, bytes }) {
  if (kind === "image") return "special";
  if (nomDitBoiteJaune(fileName, caption)) return "bj";
  if (bytes && (await plusGrandCote(bytes)) >= GRANDE_PAGE_MM) return "lit";
  return "normal";
}

module.exports = { classifyFile, nomDitBoiteJaune, plusGrandCote, GRANDE_PAGE_MM };
