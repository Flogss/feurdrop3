const crypto = require("crypto");
const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, rectangle, clip, endPath } = require("pdf-lib");
const { getColisById } = require("../db");
const { trouveSuivi, TRANSPORTEURS } = require("../suiviColis");
const { chargeImprimable } = require("../pdfLisible");
const base = require("./base");
const { ecritCode, lisCodes } = require("./decodeur");
const { typeDeFichier, dimensionsImage } = require("./rendu");
// les memes calculs que la page de l'editeur : ce qui s'affiche s'exporte
const G = require("../../public/js/bdx/05-geometrie.js");

// L'editeur de bordereaux : un DOCUMENT DE TRAVAIL a part, pose par-dessus
// l'etiquette d'origine -- jamais l'etiquette elle-meme.
//
//   - le document (le « modele ») ne garde que les elements ajoutes ou
//     modifies, en points de la page affichee (origine en haut a gauche) ;
//   - un element de l'etiquette qu'on deplace, redimensionne ou tourne (un
//     code, un texte pas retape, une image pas remplacee) reste un EXTRAIT
//     exact de la page d'origine : rien n'est redessine ni regenere, ses
//     pixels (vectoriels a l'export) suivent le cadre ;
//   - une image deposee (ou mise a la place d'une image de l'etiquette) se
//     pose dans son cadre : remplie ou ajustee, jamais etiree ;
//   - l'export dessine la page d'origine telle quelle (vectorielle), puis les
//     masques (ce qui a ete deplace ou supprime), les textes et les codes
//     (regeneres en vectoriel) : un NOUVEAU PDF. Le fichier d'origine, sur
//     Telegram, et l'impression de FeurDrop ne changent pas ;
//   - les codes lus sur l'etiquette du transporteur gardent leur valeur
//     (verifie ici, jamais confie a la page) : un numero de suivi ou des
//     donnees d'expedition ne se changent pas en redessinant un code. Un
//     nouveau code au format d'un numero de suivi, ou portant des donnees
//     d'expedition (« [)> »), est refuse : il faut une reedition officielle
//     du bordereau chez le transporteur.

const FORMATS = ["Code128", "Code39", "Code93", "EAN13", "EAN8", "UPCA", "ITF", "Codabar", "QRCode", "DataMatrix", "PDF417", "Aztec"];
const POLICES = {
  Helvetica: StandardFonts.Helvetica,
  "Helvetica-Bold": StandardFonts.HelveticaBold,
  Courier: StandardFonts.Courier,
  "Courier-Bold": StandardFonts.CourierBold,
  "Times-Roman": StandardFonts.TimesRoman,
  "Times-Bold": StandardFonts.TimesRomanBold,
};
const TYPES = new Set(["texte", "code", "rect", "image"]);
const MAX_OCTETS_MODELE = 512 * 1024;
const MAX_ELEMENTS = 400;

class ErreurEditeur extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.status = status;
    Object.assign(this, details);
  }
}

const norme = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// --- Ce qu'un code ne peut pas porter ------------------------------------------------------

/**
 * Une valeur peut-elle etre generee dans un code AJOUTE ? null si oui, sinon
 * { raison, transporteur } : les donnees d'expedition et les numeros de suivi
 * viennent du transporteur, pas de l'editeur.
 */
function valeurRefusee(format, valeur, colis) {
  const v = String(valeur || "");
  if (v.trim().startsWith("[)>")) {
    return { raison: "Ces données ont la forme des données d'expédition d'un transporteur (norme « [)> ») : elles ne se génèrent pas ici. Réédite le bordereau chez le transporteur." };
  }
  // tous les formats sont controles (certains points relais deposent un colis
  // en lisant un QR code) ; un lien qui CONTIENT un numero (la page de suivi)
  // reste permis : c'est la valeur entiere qui ne doit pas etre un numero
  const n = norme(v);
  if (n.length < 8) return null;
  const trouve = trouveSuivi({ file_name: n, carrier: colis?.carrier || null, type: colis?.type });
  if (trouve && norme(trouve.numero) === n) {
    const t = TRANSPORTEURS[trouve.code];
    return {
      raison: `« ${v} » a la forme d'un numéro de suivi ${t.nom} : un numéro de suivi ne se crée pas en dessinant un code-barres. Pour changer de numéro, réédite le bordereau chez ${t.nom}.`,
      transporteur: { code: trouve.code, nom: t.nom, page: t.page },
    };
  }
  return null;
}

// Un code de l'etiquette d'origine dont la valeur peut changer : seulement
// ce qui n'est ni le numero de suivi, ni un numero qui en a la forme, ni un
// code qui le contient (tri, lien de suivi), ni des donnees d'expedition --
// une reference de commande, le lien d'une boutique... Le role vient de
// l'analyse (index.js), et la valeur lue repasse par les memes refus qu'un
// code ajoute.
const ROLES_MODIFIABLES = new Set(["autre", "lien"]);
function codeModifiable(lu, colis) {
  if (!lu || !lu.lisible || !ROLES_MODIFIABLES.has(lu.role)) return false;
  if (lu.role === "lien" && lu.contientSuivi) return false;
  return !valeurRefusee(lu.format, lu.valeur, colis);
}

// L'orientation d'un code lu, ramenee a un angle droit (un code tourne de
// 90 degres sur l'etiquette le reste une fois reecrit).
const angleDroit = (deg) => G.angle(Math.round((Number(deg) || 0) / 90) * 90);

// --- Generation d'un code (vectoriel) --------------------------------------------------------

// Les modules noirs en rectangles, ligne par ligne (les lignes identiques
// d'un code 1D n'en font qu'une, sur toute la hauteur).
function rectangles({ largeur, hauteur, modules }) {
  const lignes = [];
  for (let y = 0; y < hauteur; y += 1) lignes.push(modules.subarray(y * largeur, (y + 1) * largeur));
  const identiques = lignes.every((l) => l.every((v, i) => v === lignes[0][i]));
  const sortie = [];
  const parcourt = (ligne, y, h) => {
    let debut = -1;
    for (let x = 0; x <= largeur; x += 1) {
      const noir = x < largeur && ligne[x] === 1;
      if (noir && debut < 0) debut = x;
      if (!noir && debut >= 0) {
        sortie.push([debut, y, x - debut, h]);
        debut = -1;
      }
    }
  };
  if (identiques) parcourt(lignes[0], 0, hauteur);
  else lignes.forEach((l, y) => parcourt(l, y, 1));
  return sortie;
}

/**
 * Un code a partir d'une valeur : { format, largeur, hauteur, chemin } -- le
 * chemin SVG de ses modules (viewBox 0 0 largeur hauteur), pour l'apercu.
 * Leve ErreurEditeur si la valeur est refusee ou impossible dans ce format.
 */
async function genereCode(format, valeur, { colis = null, original = false } = {}) {
  if (!FORMATS.includes(format)) throw new ErreurEditeur("Format de code inconnu.");
  const v = String(valeur ?? "");
  if (!v || v.length > 500) throw new ErreurEditeur("Valeur vide ou trop longue (500 caractères au plus).");
  if (!original) {
    const refus = valeurRefusee(format, v, colis);
    if (refus) throw new ErreurEditeur(refus.raison, 422, { protege: true, transporteur: refus.transporteur || null });
  }
  let matrice;
  try {
    matrice = await ecritCode(format, v);
  } catch (err) {
    throw new ErreurEditeur(`Valeur impossible dans ce format : ${String(err.message).replace(/^Error \d+: /, "").replace(/ \(retval.*$/, "")}`);
  }
  const chemin = rectangles(matrice)
    .map(([x, y, l, h]) => `M${x} ${y}h${l}v${h}h${-l}z`)
    .join("");
  return { format, valeur: v, largeur: matrice.largeur, hauteur: matrice.hauteur, chemin, matrice };
}

// --- Le document de travail ------------------------------------------------------------------

const nombre = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
const COULEUR = /^#[0-9a-f]{6}$/i;
const EMPREINTE = /^[0-9a-f]{64}$/;

// une zone de la page ({ x, y, l, h }, et sa rotation pour un cadre de depart)
function zone(z, quoi, { rotation = false } = {}) {
  if (!z || typeof z !== "object" || !["x", "y", "l", "h"].every((k) => nombre(z[k], -10000, 20000)) || z.l <= 0 || z.h <= 0) {
    throw new ErreurEditeur(`${quoi} invalide.`);
  }
  const r = { x: z.x, y: z.y, l: z.l, h: z.h };
  if (rotation) r.rotation = G.angle(z.rotation);
  return r;
}

/** Verifie (et nettoie) un modele envoye par la page. Leve ErreurEditeur. */
function valideModele(modele) {
  if (!modele || typeof modele !== "object" || !Array.isArray(modele.pages)) throw new ErreurEditeur("Document de travail invalide.");
  if (JSON.stringify(modele).length > MAX_OCTETS_MODELE) throw new ErreurEditeur("Document de travail trop gros.");
  if (modele.pages.length > 30) throw new ErreurEditeur("Trop de pages.");
  let total = 0;
  const pages = modele.pages.map((p) => {
    if (!p || !Number.isInteger(p.page) || p.page < 1 || !Array.isArray(p.elements)) throw new ErreurEditeur("Page invalide.");
    total += p.elements.length;
    if (total > MAX_ELEMENTS) throw new ErreurEditeur("Trop d'éléments.");
    return {
      page: p.page,
      elements: p.elements.map((e) => {
        if (!e || !TYPES.has(e.type) || typeof e.id !== "string" || e.id.length > 40) throw new ErreurEditeur("Élément invalide.");
        for (const k of ["x", "y", "l", "h"]) if (!nombre(e[k], -10000, 20000)) throw new ErreurEditeur(`Élément ${e.id} : position invalide.`);
        const propre = {
          id: e.id,
          type: e.type,
          x: e.x,
          y: e.y,
          l: Math.max(0.5, e.l),
          h: Math.max(0.5, e.h),
          origine: e.origine === "original" ? "original" : "ajout",
          modifie: e.origine === "original" ? e.modifie === true : true,
          supprime: e.supprime === true,
          verrou: e.verrou === true,
          nom: typeof e.nom === "string" ? e.nom.slice(0, 60) : undefined,
          // l'element de l'etiquette d'origine qu'il remplace (texte, code ou image)
          cle: typeof e.cle === "string" && /^[tci]\d{1,9}$/.test(e.cle) ? e.cle : undefined,
        };
        // un element de l'etiquette : la zone d'origine copiee (source) et son
        // cadre d'origine (depart) -- il suit son cadre comme un extrait exact
        if (propre.origine === "original" && e.source !== undefined) {
          propre.source = zone(e.source, `Élément ${e.id} : zone d'origine`);
          propre.depart = zone(e.depart, `Élément ${e.id} : cadre d'origine`, { rotation: true });
        }
        if (e.masque) {
          const m = e.masque;
          if (!["x", "y", "l", "h"].every((k) => nombre(m[k], -10000, 20000))) throw new ErreurEditeur("Masque invalide.");
          propre.masque = { x: m.x, y: m.y, l: m.l, h: m.h };
        }
        if (e.type === "texte") {
          // un texte de l'etiquette retape (contenu, police, taille...) : il
          // n'est plus un extrait, il s'ecrit
          if (propre.origine === "original") propre.retape = e.retape === true;
          propre.texte = String(e.texte ?? "").slice(0, 2000);
          propre.taille = nombre(e.taille, 2, 300) ? e.taille : 10;
          propre.police = Object.hasOwn(POLICES, e.police) ? e.police : "Helvetica";
          propre.couleur = COULEUR.test(e.couleur || "") ? e.couleur : "#000000";
          propre.alignement = ["gauche", "centre", "droite"].includes(e.alignement) ? e.alignement : "gauche";
        } else if (e.type === "code") {
          if (!FORMATS.includes(e.format)) throw new ErreurEditeur(`Élément ${e.id} : format inconnu.`);
          // un code de l'etiquette dont la valeur (ou le format, la couleur)
          // a change : il se redessine (verifie a l'export, voir verifieCodes)
          if (propre.origine === "original") propre.reecrit = e.reecrit === true;
          propre.format = e.format;
          propre.valeur = String(e.valeur ?? "").slice(0, 500);
          if (Number.isInteger(e.codeId)) propre.codeId = e.codeId;
          propre.couleur = COULEUR.test(e.couleur || "") ? e.couleur : "#000000";
        } else if (e.type === "image") {
          propre.rotation = G.angle(e.rotation);
          propre.cadrage = G.cadrage(e.cadrage);
          if (e.image != null) {
            const i = e.image;
            if (!i || typeof i !== "object" || !EMPREINTE.test(i.ref || "") || !Number.isInteger(i.l) || !Number.isInteger(i.h) || i.l < 1 || i.h < 1 || i.l > 20000 || i.h > 20000) {
              throw new ErreurEditeur(`Élément ${e.id} : image invalide.`);
            }
            propre.image = { ref: i.ref, l: i.l, h: i.h };
          } else propre.image = null;
          // une image ajoutee a toujours son contenu ; celle de l'etiquette,
          // tant qu'elle n'est pas remplacee, reste un extrait
          if (propre.origine === "ajout" && !propre.image) throw new ErreurEditeur(`Élément ${e.id} : image sans contenu.`);
          if (propre.origine === "original" && !propre.image && !propre.source) throw new ErreurEditeur(`Élément ${e.id} : zone d'origine manquante.`);
        } else {
          propre.fond = COULEUR.test(e.fond || "") ? e.fond : "#ffffff";
        }
        return propre;
      }),
    };
  });
  return { version: 1, pages };
}

/**
 * Les codes de l'etiquette d'origine gardent leur valeur et leur format :
 * verifie contre ce qui a ete lu (l'index), jamais d'apres la page. Les
 * codes ajoutes ne portent ni numero de suivi ni donnees d'expedition.
 */
function verifieCodes(modele, colis, codesLus) {
  const parId = new Map(codesLus.map((c) => [c.id, c]));
  for (const p of modele.pages) {
    for (const e of p.elements) {
      if (e.type !== "code" || e.supprime) continue;
      if (e.origine === "original") {
        const lu = parId.get(e.codeId);
        // un extrait (source) copie les pixels du code : meme illisible, il
        // se deplace tel quel ; regenere (anciens brouillons), il doit avoir ete lu
        if (!lu || (!lu.lisible && !e.source)) throw new ErreurEditeur("Un code d'origine ne correspond à aucun code lu sur l'étiquette.", 422, { protege: true });
        if (e.reecrit) {
          // reecrit : seulement un code qui n'est pas celui du transporteur,
          // et sa nouvelle valeur passe les memes refus qu'un code ajoute
          if (!codeModifiable(lu, colis)) {
            throw new ErreurEditeur("Ce code de l'étiquette porte le numéro de suivi ou des données d'expédition : sa valeur est protégée. Réédite le bordereau chez le transporteur.", 422, { protege: true });
          }
          const refus = valeurRefusee(e.format, e.valeur, colis);
          if (refus) throw new ErreurEditeur(refus.raison, 422, { protege: true, transporteur: refus.transporteur || null });
          continue;
        }
        if (!lu.lisible) continue;
        if (lu.valeur !== e.valeur || lu.format !== e.format) {
          throw new ErreurEditeur("La valeur d'un code de l'étiquette d'origine est protégée : un numéro de suivi ou des données d'expédition ne se changent pas ici. Réédite le bordereau chez le transporteur.", 422, { protege: true });
        }
      } else {
        const refus = valeurRefusee(e.format, e.valeur, colis);
        if (refus) throw new ErreurEditeur(refus.raison, 422, { protege: true, transporteur: refus.transporteur || null });
      }
    }
  }
}

// --- Brouillon (sauvegarde automatique) ----------------------------------------------------

function brouillon(colisId) {
  return base.travail(colisId);
}

function gardeBrouillon(colisId, modele) {
  const propre = valideModele(modele);
  return base.gardeTravail(colisId, propre);
}

// --- Export : un nouveau PDF ------------------------------------------------------------------

function couleur(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Les caracteres que la police standard sait ecrire (WinAnsi : les accents
// francais, €, œ...) ; les autres deviennent « ? » plutot que de tout faire echouer.
function texteEcrivable(police, texte) {
  const permis = new Set(police.getCharacterSet());
  return [...texte].map((c) => (c === "\n" || permis.has(c.codePointAt(0)) ? c : "?")).join("");
}

/**
 * Un element de l'etiquette rendu tel quel (ses pixels, pas une copie
 * redessinee) : un code d'origine, un texte deplace sans etre retape, une
 * image de l'etiquette pas remplacee. Les anciens brouillons (sans zone
 * d'origine) gardent leur rendu d'avant.
 */
function extrait(e) {
  if (e.origine !== "original" || !e.source || !e.depart) return false;
  if (e.type === "code") return !e.reecrit;
  if (e.type === "texte") return !e.retape;
  if (e.type === "image") return !e.image;
  return false;
}

/**
 * Le nouveau PDF : chaque page d'origine, droite, telle quelle, puis les
 * modifications par-dessus. `octets` : le fichier d'origine (jamais modifie).
 */
async function exportePdf(octets, modele, { titre = "Bordereau" } = {}) {
  const sortie = await PDFDocument.create();
  const type = typeDeFichier(octets);
  const sources = []; // [{ dessine(page), largeur, hauteur }]
  if (type === "pdf") {
    const { doc } = await chargeImprimable(octets);
    for (const p of doc.getPages()) {
      const crop = p.getCropBox();
      const r = ((p.getRotation().angle % 360) + 360) % 360;
      const emb = await sortie.embedPage(p, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height });
      const tourne = r === 90 || r === 270;
      const largeur = tourne ? crop.height : crop.width;
      const hauteur = tourne ? crop.width : crop.height;
      // la page d'origine, redressee : ce qu'on voit a l'ecran
      const pose = {
        0: { x: 0, y: 0, rotate: degrees(0) },
        90: { x: 0, y: hauteur, rotate: degrees(-90) },
        180: { x: largeur, y: hauteur, rotate: degrees(180) },
        270: { x: largeur, y: 0, rotate: degrees(90) },
      }[r] || { x: 0, y: 0, rotate: degrees(0) };
      sources.push({ largeur, hauteur, dessine: (page) => page.drawPage(emb, pose) });
    }
  } else if (type === "png" || type === "jpeg") {
    const image = type === "png" ? await sortie.embedPng(octets) : await sortie.embedJpg(octets);
    sources.push({ largeur: image.width, hauteur: image.height, dessine: (page) => page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height }) });
  } else {
    throw new ErreurEditeur("Ce fichier ne peut pas servir de fond à un document de travail.");
  }

  const polices = {};
  const police = async (nom) => (polices[nom] ||= await sortie.embedFont(POLICES[nom] || StandardFonts.Helvetica));
  const images = new Map();
  const imageDe = async (ref) => {
    if (!images.has(ref)) {
      const i = base.imageTravail(ref);
      if (!i) throw new ErreurEditeur("Une image du document de travail est introuvable : redépose-la.", 422);
      images.set(ref, i.type === "png" ? await sortie.embedPng(i.octets) : await sortie.embedJpg(i.octets));
    }
    return images.get(ref);
  };
  const parPage = new Map(modele.pages.map((p) => [p.page, p.elements]));
  let modifications = 0;

  for (let i = 0; i < sources.length; i += 1) {
    const src = sources[i];
    const page = sortie.addPage([src.largeur, src.hauteur]);
    src.dessine(page);
    const H = src.hauteur;
    // le repere de l'editeur (y vers le bas) -> celui du PDF (y vers le haut)
    const RETOURNE = [1, 0, 0, -1, 0, H];
    // une transformation de la page sur elle-meme (un extrait), dans le repere du PDF
    const pageVersPdf = (m) => G.compose(RETOURNE, G.compose(m, RETOURNE));
    // le repere propre d'un cadre (y vers le bas) -> la page du PDF
    const cadreVersPdf = (m) => G.compose(RETOURNE, m);
    const cm = (m) => concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]);
    const elements = parPage.get(i + 1) || [];
    // les masques d'abord : ce qui a ete deplace, modifie ou supprime disparait
    // de sa place d'origine
    for (const e of elements) {
      if (e.origine !== "original" || !(e.modifie || e.supprime)) continue;
      const m = e.masque || e;
      page.drawRectangle({ x: m.x, y: H - m.y - m.h, width: m.l, height: m.h, color: rgb(1, 1, 1) });
      modifications += 1;
    }
    // puis les elements, dans l'ordre des calques (le premier tout au fond)
    for (const e of elements) {
      if (e.supprime || (e.origine === "original" && !e.modifie)) continue;
      if (e.origine === "ajout") modifications += 1;
      if (extrait(e)) {
        // la page d'origine elle-meme, decoupee a la zone copiee et posee
        // dans le cadre : vectorielle, sans rien regenerer
        const m = pageVersPdf(G.compose(G.matriceCadre(e), G.matriceExtrait(e.depart, e)));
        page.pushOperators(pushGraphicsState(), cm(m), rectangle(e.source.x, H - e.source.y - e.source.h, e.source.l, e.source.h), clip(), endPath());
        src.dessine(page);
        page.pushOperators(popGraphicsState());
      } else if (e.type === "image") {
        // l'image dans son cadre (rotation comprise), coupee a ses bords
        const img = await imageDe(e.image.ref);
        const c = G.contenuImage(e.l, e.h, e.image.l, e.image.h, e.cadrage);
        page.pushOperators(pushGraphicsState(), cm(cadreVersPdf(G.matriceCadre(e))), rectangle(0, 0, e.l, e.h), clip(), endPath());
        // repere du cadre : y vers le bas -- l'image se pose tete en haut
        page.drawImage(img, { x: c.x, y: c.y + c.h, width: c.l, height: -c.h });
        page.pushOperators(popGraphicsState());
      } else if (e.type === "rect") {
        page.drawRectangle({ x: e.x, y: H - e.y - e.h, width: e.l, height: e.h, color: couleur(e.fond) });
      } else if (e.type === "texte") {
        const f = await police(e.police);
        const ecrit = texteEcrivable(f, e.texte);
        const interligne = e.taille * 1.18;
        const ascendante = f.heightAtSize(e.taille, { descender: false });
        ecrit.split("\n").forEach((ligne, n) => {
          const l = f.widthOfTextAtSize(ligne, e.taille);
          const dx = e.alignement === "centre" ? (e.l - l) / 2 : e.alignement === "droite" ? e.l - l : 0;
          page.drawText(ligne, { x: e.x + dx, y: H - e.y - ascendante - n * interligne, size: e.taille, font: f, color: couleur(e.couleur) });
        });
      } else if (e.type === "code") {
        const code = await genereCode(e.format, e.valeur, { original: true });
        // un code reecrit de l'etiquette garde son orientation (un code
        // vertical reste vertical) : il se dessine dans son propre repere
        const q = e.orientation || 0;
        const travers = Math.abs(q) === 90;
        const L = travers ? e.h : e.l;
        const Hc = travers ? e.l : e.h;
        const m = G.matriceCadre({ x: e.x + e.l / 2 - L / 2, y: e.y + e.h / 2 - Hc / 2, l: L, h: Hc, rotation: q });
        const mx = L / code.largeur;
        const my = Hc / code.hauteur;
        page.pushOperators(pushGraphicsState(), cm(cadreVersPdf(m)));
        for (const [x, y, l, h] of rectangles(code.matrice)) {
          page.drawRectangle({ x: x * mx, y: y * my, width: l * mx, height: h * my, color: couleur(e.couleur || "#000000") });
        }
        page.pushOperators(popGraphicsState());
      }
    }
  }
  // ce que dit le fichier lui-meme : une version de travail, pas l'original
  sortie.setTitle(`${titre} — version modifiée`);
  sortie.setSubject(`Version de travail créée dans FeurDrop à partir de l'étiquette d'origine (${modifications} modification(s) visuelle(s)). Les données d'expédition et numéros de suivi des codes d'origine n'ont pas été modifiés.`);
  sortie.setProducer("FeurDrop — éditeur de bordereaux");
  sortie.setCreator("FeurDrop");
  sortie.setModificationDate(new Date());
  return { pdf: await sortie.save(), modifications };
}

// --- Les images deposees ---------------------------------------------------------------------

const IMAGE_MAX_OCTETS = 15 * 1024 * 1024;
const IMAGE_MAX_COTE = 12000;
const IMAGE_MAX_PIXELS = 60e6;

// L'orientation EXIF d'un JPEG (1 = droite). Les navigateurs l'appliquent a
// l'affichage, le PDF non : une photo tournee par EXIF s'afficherait d'une
// facon et s'exporterait d'une autre. La page la redresse avant l'envoi.
function orientationJpeg(o) {
  const b = Buffer.from(o.buffer, o.byteOffset, o.byteLength);
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marqueur = b[i + 1];
    const longueur = b.readUInt16BE(i + 2);
    if (marqueur === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
      const t = i + 10;
      const le = b.toString("latin1", t, t + 2) === "II";
      const u16 = (k) => (le ? b.readUInt16LE(k) : b.readUInt16BE(k));
      const u32 = (k) => (le ? b.readUInt32LE(k) : b.readUInt32BE(k));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = u16(ifd);
      for (let k = 0; k < n; k += 1) {
        const entree = ifd + 2 + k * 12;
        if (entree + 12 > b.length) break;
        if (u16(entree) === 0x0112) return u16(entree + 8);
      }
      return 1;
    }
    if (marqueur === 0xda) break;
    i += 2 + longueur;
  }
  return 1;
}

/**
 * Une image deposee dans un document de travail : verifiee (PNG ou JPEG
 * droit, taille raisonnable, qu'un PDF sait l'embarquer), lue (un code-barres
 * qui porterait un numero de suivi ou des donnees d'expedition est refuse,
 * comme un code ajoute), gardee. -> { ref, l, h, type }
 */
async function importeImage(colisId, octets) {
  const colis = getColisById(colisId);
  if (!colis) throw new ErreurEditeur("Étiquette introuvable.", 404);
  if (!octets || !octets.length) throw new ErreurEditeur("Image vide.");
  if (octets.length > IMAGE_MAX_OCTETS) throw new ErreurEditeur("Image trop lourde (15 Mo au plus).", 413);
  const type = typeDeFichier(octets);
  if (type !== "png" && type !== "jpeg") throw new ErreurEditeur("Format d'image non pris en charge (PNG ou JPEG).", 415, { reencoder: true });
  const d = dimensionsImage(octets);
  if (!d || d.largeur < 1 || d.hauteur < 1) throw new ErreurEditeur("Image illisible.", 422, { reencoder: true });
  if (d.largeur > IMAGE_MAX_COTE || d.hauteur > IMAGE_MAX_COTE || d.largeur * d.hauteur > IMAGE_MAX_PIXELS) throw new ErreurEditeur("Image trop grande.", 413, { reencoder: true });
  if (type === "jpeg" && orientationJpeg(octets) !== 1) throw new ErreurEditeur("Photo à redresser avant l'envoi.", 422, { reencoder: true });
  try {
    const essai = await PDFDocument.create();
    if (type === "png") await essai.embedPng(octets);
    else await essai.embedJpg(octets);
  } catch {
    throw new ErreurEditeur("Image illisible pour un PDF.", 422, { reencoder: true });
  }
  // les codes de l'image : rien qui ressemble a un numero de suivi ou a des
  // donnees d'expedition (une reedition officielle se fait chez le transporteur)
  const codes = await lisCodes(octets);
  for (const c of codes) {
    if (!c.texte) continue;
    const refus = valeurRefusee(c.format, c.texte, colis);
    if (refus) throw new ErreurEditeur(`Cette image contient un code refusé : ${refus.raison}`, 422, { protege: true, transporteur: refus.transporteur || null });
  }
  const empreinte = crypto.createHash("sha256").update(octets).digest("hex");
  base.gardeImage({ empreinte, type, largeur: d.largeur, hauteur: d.hauteur, octets, colisId });
  return { ref: empreinte, l: d.largeur, h: d.hauteur, type };
}

/** Le PDF d'un document de travail, verifie (codes proteges compris). */
async function exporte(colisId, modele, { telecharge, codesLus }) {
  const colis = getColisById(colisId);
  if (!colis || !colis.file_id) throw new ErreurEditeur("Étiquette introuvable.", 404);
  const propre = valideModele(modele);
  verifieCodes(propre, colis, codesLus);
  const lus = new Map(codesLus.map((c) => [c.id, c]));
  for (const p of propre.pages) for (const e of p.elements) if (e.type === "code" && e.reecrit) e.orientation = angleDroit(lus.get(e.codeId)?.orientation);
  const fichier = await telecharge(colis.file_id);
  const nom = String(colis.file_name || `etiquette-${colis.id}`).replace(/\.[a-z0-9]{2,5}$/i, "");
  const { pdf, modifications } = await exportePdf(fichier.octets, propre, { titre: nom });
  return { pdf, nom: `${nom}-modifie.pdf`, modifications };
}

module.exports = { FORMATS, POLICES, ErreurEditeur, valeurRefusee, codeModifiable, angleDroit, genereCode, valideModele, verifieCodes, brouillon, gardeBrouillon, exporte, exportePdf, rectangles, importeImage, orientationJpeg, extrait };
