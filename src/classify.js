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
//   - un LIT se reconnait au mot "scotch" dans le nom du fichier. Le format de
//     page avait ete essaye -- A4 contre 102 x 152 -- mais il change d'un
//     expediteur a l'autre : un critere qui bouge tout seul ne vaut rien ici.
//     Pour tout le reste, c'est /lit ou /litall qui tranche, a la main ;
//   - le reste part en normaux.
//
// Le classement n'a pas besoin d'etre parfait : /special, /lit et /bj le
// corrigent en un geste, et la correction deplace le message.

const BJ_PATTERN = /bo[iî]te?[\s_-]*jaune|^bj[\s_-]/i;
const LIT_PATTERN = /scotch/i;

function nomDitBoiteJaune(fileName, caption) {
  const texte = `${fileName || ""} ${caption || ""}`;
  return BJ_PATTERN.test(texte);
}

function nomDitLit(fileName, caption) {
  return LIT_PATTERN.test(`${fileName || ""} ${caption || ""}`);
}

/**
 * @param {object} fichier { fileName, caption, kind: "pdf"|"image" }
 * @returns {"special"|"bj"|"lit"|"normal"}
 */
function classifyFile({ fileName, caption, kind }) {
  if (kind === "image") return "special";
  if (nomDitBoiteJaune(fileName, caption)) return "bj";
  if (nomDitLit(fileName, caption)) return "lit";
  return "normal";
}

module.exports = { classifyFile, nomDitBoiteJaune, nomDitLit };
