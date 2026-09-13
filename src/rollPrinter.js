const { PDFDocument, degrees, rgb } = require("pdf-lib");
const { labelRegion } = require("./labelRegion");

// Impression des LIT sur rouleau continu (papier fax Exacompta, 210 mm de
// large). Les colis LIT sont trop gros pour l'imprimante thermique 4x6, on les
// sort donc sur rouleau. Deux objectifs : ne gaspiller ni papier ni temps.
//
//   - chaque bordereau est recadre sur son encre utile (voir labelRegion) ;
//   - deux bordereaux sont poses cote a cote des qu'ils tiennent dans la
//     largeur, avec un trait de coupe entre les deux ;
//   - la hauteur de chaque page suit le contenu : sur un rouleau, une page
//     est juste une longueur de papier.

const MM = 72 / 25.4;
const ROLL_WIDTH = Number(process.env.ROLL_WIDTH_MM || 210) * MM;
const MARGIN = 3 * MM;
const COLUMN_GAP = 4 * MM;

const USABLE_WIDTH = ROLL_WIDTH - MARGIN * 2;
const COLUMN_WIDTH = (USABLE_WIDTH - COLUMN_GAP) / 2;
const PAIR_MIN_SCALE = 0.8; // on ne reduit pas un bordereau de plus de 20 % pour l'apparier

// Oriente et met a l'echelle un bordereau pour un emplacement donne. On
// n'agrandit jamais : un code-barres agrandi ne se lit pas mieux, et le papier
// coute plus cher que les millimetres gagnes.
function fitInto(width, height, slotWidth) {
  const options = [
    { rotation: 0, w: width, h: height },
    { rotation: 90, w: height, h: width },
  ].map((option) => {
    const scale = Math.min(1, slotWidth / option.w);
    return { ...option, scale, drawnW: option.w * scale, drawnH: option.h * scale };
  });

  // a egalite d'echelle, on garde l'orientation d'origine
  return options.reduce((a, b) => (b.scale > a.scale + 1e-6 ? b : a));
}

// Trait de coupe discret entre deux bordereaux.
function drawCutLine(page, x, top, bottom) {
  page.drawLine({
    start: { x, y: bottom },
    end: { x, y: top },
    thickness: 0.4,
    color: rgb(0.75, 0.75, 0.75),
    dashArray: [3, 3],
  });
}

// Prepare un bordereau : page source, zone utile, taille une fois placee.
async function prepareLabel(out, item) {
  const source = await PDFDocument.load(item.bytes, { ignoreEncryption: true });
  const prepared = [];

  for (let i = 0; i < source.getPageCount(); i += 1) {
    const region = await labelRegion(item.bytes, i).catch(() => null);
    const page = source.getPage(i);
    const media = page.getMediaBox();
    const box = region || {
      left: media.x,
      bottom: media.y,
      right: media.x + media.width,
      top: media.y + media.height,
      trimmed: false,
    };

    const width = box.right - box.left;
    const height = box.top - box.bottom;
    if (width < 10 || height < 10) continue;

    const embedded = await out.embedPage(page, {
      left: box.left,
      bottom: box.bottom,
      right: box.right,
      top: box.top,
    });

    // Tient-il dans une demi-laize ? On accepte de le reduire un peu pour
    // pouvoir en poser deux par rangee : une rangee economisee, c'est une
    // quinzaine de centimetres de rouleau. En dessous de PAIR_MIN_SCALE en
    // revanche, le code-barres devient trop petit et on prefere la pleine
    // largeur.
    const half = fitInto(width, height, COLUMN_WIDTH);
    const full = fitInto(width, height, USABLE_WIDTH);
    const fitsHalf = half.scale >= PAIR_MIN_SCALE || half.scale >= full.scale - 1e-6;

    prepared.push({
      embedded,
      width,
      height,
      trimmed: box.trimmed,
      // deux placements possibles : reduit pour tenir a deux par rangee, ou a
      // sa taille naturelle s'il finit seul sur la sienne
      placement: fitsHalf ? half : full,
      alone: full,
      full: !fitsHalf,
    });
  }
  return prepared;
}

// Pose un bordereau deja oriente ; la rotation se fait autour de (x, y), donc
// l'ancre change de coin.
function placeOn(page, label, left, bottom) {
  const { rotation, scale } = label.placement;
  const scaledW = label.width * scale;
  const scaledH = label.height * scale;
  const anchor = rotation === 90 ? { x: left + scaledH, y: bottom } : { x: left, y: bottom };

  page.drawPage(label.embedded, {
    x: anchor.x,
    y: anchor.y,
    width: scaledW,
    height: scaledH,
    rotate: degrees(rotation),
  });
}

// Assemble les bordereaux sur le rouleau. `labels` : [{ bytes, label }].
async function buildRoll(labels) {
  const out = await PDFDocument.create();
  const failed = [];
  const prepared = [];

  for (const item of labels) {
    try {
      prepared.push(...(await prepareLabel(out, item)));
    } catch (err) {
      failed.push({ label: item.label, reason: err.message });
    }
  }

  if (prepared.length === 0) return { pdf: null, pages: 0, rows: 0, trimmed: 0, failed };

  // rangees : deux bordereaux cote a cote des qu'ils tiennent tous les deux
  const rows = [];
  let pending = null;
  for (const label of prepared) {
    if (label.full) {
      if (pending) {
        rows.push([pending]);
        pending = null;
      }
      rows.push([label]);
    } else if (pending) {
      rows.push([pending, label]);
      pending = null;
    } else {
      pending = label;
    }
  }
  if (pending) rows.push([pending]);

  for (const row of rows) {
    if (row.length === 1) row[0].placement = row[0].alone;
    const rowHeight = Math.max(...row.map((l) => l.placement.drawnH));
    const page = out.addPage([ROLL_WIDTH, rowHeight + MARGIN * 2]);

    if (row.length === 2) {
      placeOn(page, row[0], MARGIN, MARGIN);
      placeOn(page, row[1], MARGIN + COLUMN_WIDTH + COLUMN_GAP, MARGIN);
      drawCutLine(page, MARGIN + COLUMN_WIDTH + COLUMN_GAP / 2, rowHeight + MARGIN, MARGIN);
    } else {
      // seul sur sa rangee : inutile de l'avoir reduit, on le remet a sa
      // taille naturelle et on le centre
      placeOn(page, row[0], (ROLL_WIDTH - row[0].placement.drawnW) / 2, MARGIN);
    }
  }

  return {
    pdf: Buffer.from(await out.save()),
    pages: out.getPageCount(),
    rows: rows.length,
    trimmed: prepared.filter((l) => l.trimmed).length,
    labels: prepared.length,
    failed,
  };
}

module.exports = { buildRoll, ROLL_WIDTH };
