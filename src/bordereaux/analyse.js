const { lisCodes } = require("./decodeur");
const { typeDeFichier, dimensionsImage, nombrePages, rendPage } = require("./rendu");

// L'analyse d'une etiquette : TOUS les codes-barres et QR codes de chaque
// page, avec leur zone exacte. Rien n'est devine : un symbole trouve mais
// indechiffrable est rendu « illisible », sans valeur.
//
// Deux passes : la page rendue a 2400 pixels (assez pour une etiquette
// 10x15 ou une page A4) ; si un symbole y reste illisible, ou si rien n'est
// trouve, une seconde a 3400 pixels pour les petits codes. Les resultats se
// fusionnent (un meme code vu deux fois ne compte qu'une fois).

// a augmenter quand l'analyse change : les etiquettes deja indexees sont
// alors relues, une a une, en fond
const VERSION_ANALYSE = 1;
const TAILLES = [2400, 3400];
const MAX_PAGES = Number(process.env.BORDEREAUX_MAX_PAGES || 30);

const arrondi = (v) => Math.round(v * 1e5) / 1e5;
const borne = (v) => Math.min(1, Math.max(0, v));

// « ChecksumError @ QRDecoder.cpp:349 » -> ce que la page affiche
function raisonIllisible(erreur) {
  const e = String(erreur || "");
  if (/checksum/i.test(e)) return "code abîmé (contrôle d'erreur faux)";
  if (/format/i.test(e)) return "code repéré mais indéchiffrable";
  if (/unsupported/i.test(e)) return "variante non prise en charge";
  return "code repéré mais illisible";
}

// La position d'un code, ramenee a la taille de l'image (0..1).
function zone(position, largeur, hauteur) {
  const points = ["topLeft", "topRight", "bottomRight", "bottomLeft"].map((k) => position?.[k]).filter(Boolean);
  if (points.length !== 4) return null;
  const xs = points.map((p) => borne(p.x / largeur));
  const ys = points.map((p) => borne(p.y / hauteur));
  return {
    x0: arrondi(Math.min(...xs)),
    y0: arrondi(Math.min(...ys)),
    x1: arrondi(Math.max(...xs)),
    y1: arrondi(Math.max(...ys)),
    polygone: xs.map((x, i) => [arrondi(x), arrondi(ys[i])]),
  };
}

function recouvrement(a, b) {
  const l = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = l * h;
  const aire = (z) => Math.max(1e-9, (z.x1 - z.x0) * (z.y1 - z.y0));
  return inter / Math.min(aire(a), aire(b));
}

// Les codes d'une image, positions en 0..1.
async function codesDe(image, largeur, hauteur) {
  const resultats = await lisCodes(image);
  const codes = [];
  for (const r of resultats) {
    const z = zone(r.position, largeur, hauteur);
    if (!z) continue;
    // une ligne de code 1D peut etre tres fine : une hauteur minimale
    // pour qu'elle se voie et se survole
    if (z.y1 - z.y0 < 0.004) {
      const milieu = (z.y0 + z.y1) / 2;
      z.y0 = arrondi(borne(milieu - 0.004));
      z.y1 = arrondi(borne(milieu + 0.004));
    }
    codes.push({
      format: r.format,
      nomFormat: r.nomFormat,
      famille: r.famille,
      lisible: r.valide,
      valeur: r.valide ? r.texte : null,
      erreur: r.valide ? null : raisonIllisible(r.erreur),
      orientation: Number.isFinite(r.orientation) ? r.orientation : 0,
      ...z,
    });
  }
  return codes;
}

// Fusionne deux passes : un code lisible vu deux fois (meme format, meme
// valeur, meme endroit) ne compte qu'une fois ; un symbole « illisible » qui
// recouvre un code lu disparait (la seconde passe l'a dechiffre).
function fusionne(premiers, seconds) {
  const tous = [...premiers, ...seconds];
  const lisibles = [];
  for (const c of tous.filter((c) => c.lisible)) {
    if (!lisibles.some((d) => d.format === c.format && d.valeur === c.valeur && recouvrement(c, d) > 0.3)) lisibles.push(c);
  }
  const illisibles = [];
  for (const c of tous.filter((c) => !c.lisible)) {
    if (lisibles.some((d) => recouvrement(c, d) > 0.2)) continue;
    if (illisibles.some((d) => recouvrement(c, d) > 0.5)) continue;
    illisibles.push(c);
  }
  return [...lisibles, ...illisibles];
}

// Haut en bas, puis gauche a droite : l'ordre de lecture de l'etiquette.
const ordreLecture = (a, b) => (Math.abs(a.y0 - b.y0) > 0.02 ? a.y0 - b.y0 : a.x0 - b.x0);

async function analysePage(pdf, numero) {
  let rendu = await rendPage(pdf, numero, TAILLES[0]);
  let codes = await codesDe(rendu.image, rendu.largeur, rendu.hauteur);
  const format = { largeur: rendu.largeur, hauteur: rendu.hauteur };
  if (codes.length === 0 || codes.some((c) => !c.lisible)) {
    const premiers = codes;
    rendu = null; // libere l'image de la premiere passe
    const fin = await rendPage(pdf, numero, TAILLES[1]);
    codes = fusionne(premiers, await codesDe(fin.image, fin.largeur, fin.hauteur));
  }
  return { page: numero, ...format, codes: codes.sort(ordreLecture) };
}

/**
 * Analyse un fichier d'etiquette (octets d'un PDF ou d'une image) :
 * { type, pages: [{ page, largeur, hauteur, codes: [...] }], nombrePages,
 *   partiel, version, dureeMs }. Leve une erreur si le fichier est illisible.
 */
async function analyseFichier(octets) {
  const debut = Date.now();
  const type = typeDeFichier(octets);
  if (!type) throw new Error("ce fichier n'est ni un PDF ni une image");
  const pages = [];
  let total = 1;
  if (type === "pdf") {
    total = await nombrePages(octets);
    if (total < 1) throw new Error("PDF sans page");
    for (let p = 1; p <= Math.min(total, MAX_PAGES); p += 1) pages.push(await analysePage(octets, p));
  } else {
    const dims = dimensionsImage(octets);
    if (!dims || !["jpeg", "png", "gif"].includes(type)) throw new Error(`image ${type.toUpperCase()} non prise en charge par le lecteur de codes`);
    const codes = await codesDe(octets, dims.largeur, dims.hauteur);
    pages.push({ page: 1, ...dims, codes: codes.sort(ordreLecture) });
  }
  return { type, pages, nombrePages: total, partiel: total > pages.length, version: VERSION_ANALYSE, dureeMs: Date.now() - debut };
}

module.exports = { analyseFichier, fusionne, zone, VERSION_ANALYSE };
