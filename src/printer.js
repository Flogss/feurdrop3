const { PDFDocument, degrees } = require("pdf-lib");

// Imprimante MUNBYN thermique 4x6 pouces = 101,6 x 152,4 mm.
// En points PDF (1 pt = 1/72 pouce) : 288 x 432. En generant des pages
// exactement a cette taille, l'impression "taille reelle" tombe juste, sans
// marge ni recadrage par le pilote.
const LABEL_WIDTH = Number(process.env.LABEL_WIDTH_PT || 288);
const LABEL_HEIGHT = Number(process.env.LABEL_HEIGHT_PT || 432);

// Beaucoup d'etiquettes sont livrees sur une page A4 avec un grand vide
// autour. Quand le PDF declare une TrimBox / ArtBox plus petite que la page,
// c'est le contour exact de l'etiquette : on s'en sert pour recadrer.
function usableBox(page) {
  const media = page.getMediaBox();
  const candidates = [];
  for (const getter of ["getTrimBox", "getArtBox", "getBleedBox", "getCropBox"]) {
    try {
      const box = page[getter]();
      if (box && box.width > 20 && box.height > 20) candidates.push(box);
    } catch (err) {
      // boite absente : pdf-lib retombe sur la MediaBox, rien a faire
    }
  }

  // la plus petite boite credible, si elle rogne vraiment quelque chose
  let best = media;
  for (const box of candidates) {
    if (box.width * box.height < best.width * best.height * 0.95) best = box;
  }
  return {
    left: best.x,
    bottom: best.y,
    right: best.x + best.width,
    top: best.y + best.height,
    width: best.width,
    height: best.height,
  };
}

// Rotation propre de la page source. Attention : /Rotate tourne dans le sens
// HORAIRE alors que le `rotate` de pdf-lib tourne dans le sens ANTIHORAIRE.
// On renvoie donc l'angle antihoraire equivalent, sinon les pages pivotees
// ressortent a l'envers.
function pageRotation(page) {
  try {
    const clockwise = ((Math.round((page.getRotation().angle || 0) / 90) * 90) % 360 + 360) % 360;
    return (360 - clockwise) % 360;
  } catch (err) {
    return 0;
  }
}

// Choisit entre "tel quel" et "pivote d'un quart de tour" celui qui remplit le
// mieux l'etiquette, puis centre le resultat. C'est ce qui evite a la fois le
// trop-zoome et le timbre-poste au milieu de la page.
function fitScale(contentWidth, contentHeight, rotation) {
  const rotated = rotation % 180 !== 0;
  const visibleW = rotated ? contentHeight : contentWidth;
  const visibleH = rotated ? contentWidth : contentHeight;
  const scale = Math.min(LABEL_WIDTH / visibleW, LABEL_HEIGHT / visibleH);
  return { scale, footprintW: visibleW * scale, footprintH: visibleH * scale };
}

// Point d'ancrage de drawPage/drawImage selon la rotation : le contenu pivote
// autour de (x, y), donc l'origine change de coin.
function anchorFor(rotation, left, bottom, scaledW, scaledH) {
  switch (rotation) {
    case 90:
      return { x: left + scaledH, y: bottom };
    case 180:
      return { x: left + scaledW, y: bottom + scaledH };
    case 270:
      return { x: left, y: bottom + scaledW };
    default:
      return { x: left, y: bottom };
  }
}

// Tout le calcul geometrique en un seul endroit, sans dependre de pdf-lib :
// quelle rotation, quel agrandissement, et ou poser le contenu sur la page
// 4x6. `baseRotation` est la rotation propre de la page source (/Rotate).
function planPlacement(contentWidth, contentHeight, baseRotation = 0) {
  // Les quatre orientations possibles, par ordre de preference a agrandissement
  // egal : l'orientation d'origine d'abord, puis un quart de tour d'un cote ou
  // de l'autre, et en dernier le demi-tour (une etiquette a l'envers n'est
  // jamais preferable a une etiquette de cote).
  const candidates = [0, 90, 270, 180].map((delta) => {
    const rotation = ((baseRotation + delta) % 360 + 360) % 360;
    return { rotation, ...fitScale(contentWidth, contentHeight, rotation) };
  });
  const best = candidates.reduce((a, b) => (b.scale > a.scale + 1e-9 ? b : a));

  const { rotation, scale, footprintW, footprintH } = best;

  const left = (LABEL_WIDTH - footprintW) / 2;
  const bottom = (LABEL_HEIGHT - footprintH) / 2;
  const scaledW = contentWidth * scale;
  const scaledH = contentHeight * scale;

  return {
    rotation,
    scale,
    footprintW,
    footprintH,
    scaledW,
    scaledH,
    // taux de remplissage de l'etiquette, pour signaler les sources mal cadrees
    coverage: (footprintW * footprintH) / (LABEL_WIDTH * LABEL_HEIGHT),
    ...anchorFor(rotation, left, bottom, scaledW, scaledH),
  };
}

async function addPdfPages(out, bytes) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = src.getPageCount();

  for (let i = 0; i < pageCount; i += 1) {
    const srcPage = src.getPage(i);
    const box = usableBox(srcPage);
    const plan = planPlacement(box.width, box.height, pageRotation(srcPage));

    const embedded = await out.embedPage(srcPage, {
      left: box.left,
      bottom: box.bottom,
      right: box.right,
      top: box.top,
    });

    const page = out.addPage([LABEL_WIDTH, LABEL_HEIGHT]);
    page.drawPage(embedded, {
      x: plan.x,
      y: plan.y,
      width: plan.scaledW,
      height: plan.scaledH,
      rotate: degrees(plan.rotation),
    });
  }
  return pageCount;
}

async function addImagePage(out, bytes) {
  const header = Buffer.from(bytes.slice(0, 4));
  const isPng = header[0] === 0x89 && header[1] === 0x50;
  const image = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);

  const plan = planPlacement(image.width, image.height, 0);
  const page = out.addPage([LABEL_WIDTH, LABEL_HEIGHT]);
  page.drawImage(image, {
    x: plan.x,
    y: plan.y,
    width: plan.scaledW,
    height: plan.scaledH,
    rotate: degrees(plan.rotation),
  });
  return 1;
}

// Assemble les etiquettes bout a bout, une par page au format de l'imprimante.
// `labels` : [{ bytes, kind: "pdf" | "image", label }]. Renvoie le PDF final et
// la liste des etiquettes qui n'ont pas pu etre lues.
async function mergeLabels(labels) {
  const out = await PDFDocument.create();
  const failed = [];
  let pages = 0;

  for (const item of labels) {
    try {
      pages += item.kind === "image" ? await addImagePage(out, item.bytes) : await addPdfPages(out, item.bytes);
    } catch (err) {
      failed.push({ label: item.label, reason: err.message });
    }
  }

  if (pages === 0) return { pdf: null, pages: 0, failed };
  return { pdf: Buffer.from(await out.save()), pages, failed };
}

module.exports = { mergeLabels, planPlacement, LABEL_WIDTH, LABEL_HEIGHT };
