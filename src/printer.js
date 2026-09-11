const { PDFDocument, degrees } = require("pdf-lib");
const { contentBoxes } = require("./pdfContent");

// Imprimante MUNBYN thermique 4x6 pouces = 101,6 x 152,4 mm.
// En points PDF (1 pt = 1/72 pouce) : 288 x 432. En generant des pages
// exactement a cette taille, l'impression "taille reelle" tombe juste, sans
// marge ni recadrage par le pilote.
const LABEL_WIDTH = Number(process.env.LABEL_WIDTH_PT || 288);
const LABEL_HEIGHT = Number(process.env.LABEL_HEIGHT_PT || 432);

function toBox(box) {
  return {
    left: box.x,
    bottom: box.y,
    right: box.x + box.width,
    top: box.y + box.height,
    width: box.width,
    height: box.height,
  };
}

// Recadrage automatique quand le PDF ne dit pas ou est l'etiquette.
// Sur une feuille A4, l'etiquette est soit une image collee dans un coin, soit
// une zone vectorielle systematiquement clippee par le meme rectangle. On
// retient le candidat dont les proportions ressemblent le plus a une etiquette,
// ce qui elimine les bandeaux, les logos et les blocs de mentions.
const MIN_SIDE_RATIO = 0.3; // au moins 30 % de la page dans les deux sens
const MIN_AREA_RATIO = 0.08; // et au moins 8 % de sa surface
const MAX_AREA_RATIO = 0.9; // au-dela, c'est la page elle-meme
const MAX_RATIO_GAP = 0.35; // au-dela, ce n'est pas une etiquette

// Ecart entre les proportions d'un candidat et celles de l'etiquette, dans un
// sens comme dans l'autre (une etiquette couchee reste une etiquette).
function ratioGap(width, height) {
  const target = LABEL_WIDTH / LABEL_HEIGHT;
  const ratio = width / height;
  return Math.min(Math.abs(ratio - target), Math.abs(ratio - 1 / target));
}

function autoCropBox(page, media) {
  let boxes;
  try {
    boxes = contentBoxes(page);
  } catch (err) {
    return null;
  }
  if (!boxes || boxes.length === 0) return null;

  const candidates = boxes
    .map((b) => ({
      kind: b.kind,
      left: Math.max(b.left, media.left),
      bottom: Math.max(b.bottom, media.bottom),
      right: Math.min(b.right, media.right),
      top: Math.min(b.top, media.top),
    }))
    .map((b) => ({ ...b, width: b.right - b.left, height: b.top - b.bottom }))
    .filter(
      (b) =>
        b.width >= media.width * MIN_SIDE_RATIO &&
        b.height >= media.height * MIN_SIDE_RATIO &&
        b.width * b.height >= media.width * media.height * MIN_AREA_RATIO &&
        b.width * b.height <= media.width * media.height * MAX_AREA_RATIO
    )
    .map((b) => ({ ...b, gap: ratioGap(b.width, b.height) }))
    .filter((b) => b.gap <= MAX_RATIO_GAP);

  if (candidates.length === 0) return null;

  // Proportions les plus proches d'abord. A proportions comparables, une zone
  // qui contient une image l'emporte : sur les feuilles qui portent deux
  // emplacements (etiquette + duplicata), c'est celui qui est rempli. En
  // dernier recours, le plus grand.
  candidates.sort((a, b) => {
    if (Math.abs(a.gap - b.gap) > 0.05) return a.gap - b.gap;
    if (a.kind !== b.kind) return a.kind === "image" ? -1 : 1;
    return b.width * b.height - a.width * a.height;
  });
  return candidates[0];
}

// Beaucoup d'etiquettes sont livrees sur une page A4 avec un grand vide
// autour. Trois sources, de la plus fiable a la plus deduite : la TrimBox /
// ArtBox declaree par le PDF, sinon l'image de l'etiquette reperee dans le
// contenu, sinon la page entiere.
function usableBox(page) {
  const media = toBox(page.getMediaBox());

  for (const getter of ["getTrimBox", "getArtBox", "getBleedBox", "getCropBox"]) {
    try {
      const box = page[getter]();
      if (!box || box.width <= 20 || box.height <= 20) continue;
      if (box.width * box.height < media.width * media.height * 0.95) return toBox(box);
    } catch (err) {
      // boite absente : pdf-lib retombe sur la MediaBox, rien a faire
    }
  }

  return autoCropBox(page, media) || media;
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
