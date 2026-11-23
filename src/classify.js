// A quel topic destiner un fichier envoye au bot en prive.
//
// Les regles sortent des fichiers reellement recus, pas d'une intuition :
//
//   - une boite jaune s'annonce par son nom de fichier : les bordereaux
//     recus s'appellent BOITEJAUNE6N00028490616.pdf. Leur format est celui
//     d'une etiquette ordinaire, 102 x 152 mm, donc seul le nom les trahit ;
//   - un LIT se reconnait au mot "scotch" dans le nom du fichier. Le format de
//     page avait ete essaye -- A4 contre 102 x 152 -- mais il change d'un
//     expediteur a l'autre : un critere qui bouge tout seul ne vaut rien ici.
//     Pour tout le reste, c'est /lit ou /litall qui tranche, a la main ;
//   - un special se reconnait a sa legende : "met lui dedans", "mets-le
//     dedans", "MET lui", et les fautes de frappe d'un pouce presse ("met
//     ylui", "mzt lui", "metlui"). Voir legendeDitSpecial ;
//   - le reste part en normaux, image comprise. Une image sans legende n'est
//     pas envoyee d'office dans "special" : c'est seulement une fois la-bas
//     (/special, ou postee directement dans le topic) qu'elle passe a 0 EUR.
//
// Le classement n'a pas besoin d'etre parfait : /special, /lit, /normal et
// /bj le corrigent en un geste, et la correction deplace le message.

const BJ_PATTERN = /bo[iî]te?[\s_-]*jaune|^bj[\s_-]/i;
const LIT_PATTERN = /scotch/i;

function nomDitBoiteJaune(fileName, caption) {
  const texte = `${fileName || ""} ${caption || ""}`;
  return BJ_PATTERN.test(texte);
}

function nomDitLit(fileName, caption) {
  return LIT_PATTERN.test(`${fileName || ""} ${caption || ""}`);
}

// --- "met lui dedans" -------------------------------------------------------
// La legende est tapee vite, au telephone : majuscules, accents, tirets et
// fautes d'une lettre ne doivent rien changer. On compare donc mot a mot, a
// une lettre pres (ajoutee, oubliee ou remplacee).
//
// Il faut un "met" ET, juste apres (deux mots au plus), un "lui" ou un
// "dedans" : "met" seul ("je met le prix demain") ou "lui" seul ("c'est pour
// lui") ne suffisent pas.

function normalise(texte) {
  return String(texte || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// distance d'edition limitee a 1 : vrai si `a` et `b` different d'au plus
// une lettre ajoutee, oubliee ou remplacee
function aUneLettrePres(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [court, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < court.length && court[i] === long[i]) i += 1;
  if (court.length === long.length) return court.slice(i + 1) === long.slice(i + 1);
  return court.slice(i) === long.slice(i + 1);
}

const ressemble = (mot, modeles) => modeles.some((m) => aUneLettrePres(mot, m));

// "me" (de "mé lui") passe a une lettre de "met" ; deux lettres au moins,
// sinon "m" tout seul suffirait
const estMet = (mot) => mot.length >= 2 && (ressemble(mot, ["met", "mets"]) || /^mett/.test(mot));
const estLui = (mot) => mot.length >= 2 && ressemble(mot, ["lui"]);
const estDedans = (mot) => ressemble(mot, ["dedans", "dedan"]);
// "metlui", "metslui", "metylui" : l'espace oublie
const estMetLui = (mot) => ressemble(mot, ["metlui", "metslui"]);

function legendeDitSpecial(caption) {
  const mots = normalise(caption);
  return mots.some((mot, i) => {
    if (estMetLui(mot)) return true;
    if (!estMet(mot)) return false;
    return mots.slice(i + 1, i + 3).some((suivant) => estLui(suivant) || estDedans(suivant));
  });
}

/**
 * @param {object} fichier { fileName, caption }
 * @returns {"special"|"bj"|"lit"|"normal"}
 */
function classifyFile({ fileName, caption }) {
  // ce que la personne ecrit l'emporte sur le nom du fichier
  if (legendeDitSpecial(caption)) return "special";
  if (nomDitBoiteJaune(fileName, caption)) return "bj";
  if (nomDitLit(fileName, caption)) return "lit";
  return "normal";
}

module.exports = { classifyFile, nomDitBoiteJaune, nomDitLit, legendeDitSpecial };
