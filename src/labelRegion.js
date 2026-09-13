// Trouve la zone utile d'une page d'etiquette : l'encre, debarrassee des fonds
// de page, et surtout debarrassee du bloc "INSTRUCTIONS D'EMBALLAGE /
// PROCEDURE DETAILLEE" que certains transporteurs collent a cote du bordereau.
//
// La regle de decoupe est volontairement prudente : on ne jette un morceau de
// page que s'il est separe du reste par une vraie gouttiere ET qu'il ne
// contient aucun code-barres. Un bordereau porte toujours un code-barres ; un
// bloc d'instructions, jamais. Dans le doute, on garde tout : perdre du papier
// est sans consequence, couper un code-barres fait perdre le colis.

const MM = 72 / 25.4;
const MIN_GUTTER = 6 * MM; // en-deca, c'est une simple marge entre deux blocs
const BACKGROUND_AREA = 0.5; // un dessin couvrant plus de la moitie de la page est un fond
const MARGIN = 1.5 * MM; // air autour de la zone gardee

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function unitBounds(m) {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ]);
  return {
    left: Math.min(...pts.map((p) => p[0])),
    bottom: Math.min(...pts.map((p) => p[1])),
    right: Math.max(...pts.map((p) => p[0])),
    top: Math.max(...pts.map((p) => p[1])),
  };
}

// Une barre de code-barres : un trait tres fin et nettement allonge. Les
// bibliotheques PDF dessinent souvent tout un code-barres en un seul chemin,
// donc il suffit d'en trouver un.
function isBarcodeBar(box) {
  const w = (box.right - box.left) / MM;
  const h = (box.top - box.bottom) / MM;
  return (w < 3 && h > 6) || (h < 3 && w > 6);
}

// Tout ce qui est dessine sur la page : textes (position et taille) et traces.
async function collectInk(page, pdfjs) {
  const viewport = page.getViewport({ scale: 1 });
  const items = [];

  const text = await page.getTextContent();
  for (const item of text.items) {
    if (!item.str || !item.str.trim()) continue;
    const [, , , d, e, f] = item.transform;
    const height = Math.abs(d) || item.height || 8;
    items.push({
      kind: "text",
      left: e,
      bottom: f - height * 0.25,
      right: e + (item.width || 0),
      top: f + height,
    });
  }

  const ops = await page.getOperatorList();
  const { OPS } = pdfjs;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(args, ctm);
    else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintJpegXObject
    ) {
      items.push({ kind: "draw", ...unitBounds(ctm) });
    } else if (fn === OPS.constructPath) {
      const coords = args[1];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k + 1 < coords.length; k += 2) {
        minX = Math.min(minX, coords[k]);
        maxX = Math.max(maxX, coords[k]);
        minY = Math.min(minY, coords[k + 1]);
        maxY = Math.max(maxY, coords[k + 1]);
      }
      if (!Number.isFinite(minX)) continue;
      const project = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      const [x1, y1] = project(minX, minY);
      const [x2, y2] = project(maxX, maxY);
      items.push({
        kind: "draw",
        left: Math.min(x1, x2),
        bottom: Math.min(y1, y2),
        right: Math.max(x1, x2),
        top: Math.max(y1, y2),
      });
    }
  }

  const pageArea = viewport.width * viewport.height;
  return items.filter((b) => {
    if (b.right <= b.left || b.top <= b.bottom) return false;
    // les fonds et grands cadres masqueraient toute separation
    if (b.kind === "draw" && (b.right - b.left) * (b.top - b.bottom) > pageArea * BACKGROUND_AREA) return false;
    return true;
  });
}

function union(items) {
  return items.reduce(
    (acc, b) => ({
      left: Math.min(acc.left, b.left),
      bottom: Math.min(acc.bottom, b.bottom),
      right: Math.max(acc.right, b.right),
      top: Math.max(acc.top, b.top),
    }),
    { left: Infinity, bottom: Infinity, right: -Infinity, top: -Infinity }
  );
}

// Plus grand intervalle vide sur un axe, parmi les elements donnes.
function widestGap(items, axis) {
  const spans = items
    .map((b) => (axis === "x" ? [b.left, b.right] : [b.bottom, b.top]))
    .sort((a, b) => a[0] - b[0]);
  if (spans.length < 2) return null;

  let best = null;
  let end = spans[0][1];
  for (const [start, stop] of spans.slice(1)) {
    if (start > end && (!best || start - end > best[1] - best[0])) best = [end, start];
    end = Math.max(end, stop);
  }
  return best && best[1] - best[0] >= MIN_GUTTER ? best : null;
}

// Coupe la page en deux le long de la gouttiere et ne garde que le morceau qui
// porte un code-barres. Renvoie null si la coupe n'est pas evidente.
function splitOnce(items, axis) {
  const gap = widestGap(items, axis);
  if (!gap) return null;

  const before = items.filter((b) => (axis === "x" ? b.right : b.top) <= gap[0] + 0.5);
  const after = items.filter((b) => (axis === "x" ? b.left : b.bottom) >= gap[1] - 0.5);
  if (before.length === 0 || after.length === 0) return null;

  const barsBefore = before.filter(isBarcodeBar).length;
  const barsAfter = after.filter(isBarcodeBar).length;
  if (barsBefore > 0 && barsAfter === 0) return before;
  if (barsAfter > 0 && barsBefore === 0) return after;
  return null; // code-barres des deux cotes (ou d'aucun) : on ne coupe pas
}

// Zone a imprimer pour une page donnee, en points PDF.
async function labelRegion(bytes, pageIndex = 0) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  try {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    let items = await collectInk(page, pdfjs);
    if (items.length === 0) {
      return { left: 0, bottom: 0, right: viewport.width, top: viewport.height, trimmed: false };
    }

    // au plus une coupe par axe : bordereau + instructions a cote, ou
    // bordereau + conditions generales en dessous
    let trimmed = false;
    for (const axis of ["x", "y"]) {
      const kept = splitOnce(items, axis);
      if (kept) {
        items = kept;
        trimmed = true;
      }
    }

    const ink = union(items);
    return {
      left: Math.max(0, ink.left - MARGIN),
      bottom: Math.max(0, ink.bottom - MARGIN),
      right: Math.min(viewport.width, ink.right + MARGIN),
      top: Math.min(viewport.height, ink.top + MARGIN),
      trimmed,
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

module.exports = { labelRegion };
