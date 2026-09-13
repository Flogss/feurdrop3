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

// --- Encre reelle d'une image ------------------------------------------------
// Certains transporteurs livrent toute la page en bitmap : l'image couvre alors
// la feuille entiere alors que le bordereau n'en occupe qu'un coin. Sans
// regarder les pixels, on recadrerait sur du blanc. pdfjs decode deja ces
// images pour le rendu, on se sert de ses donnees.
const WHITE = 245; // au-dessus, on considere que c'est du papier
const SCAN_STEP = 2; // un pixel sur deux suffit pour trouver les bords

// Rectangle d'encre dans le carre unite de l'image (origine en bas a gauche,
// comme en PDF), ou null si l'image est inexploitable ou entierement blanche.
function imageInkRect(image) {
  const { width, height, kind, data } = image;
  if (!data || !width || !height) return null;
  // 2 = RGB, 3 = RGBA ; les autres formats sont rares, on garde l'image entiere
  const channels = kind === 2 ? 3 : kind === 3 ? 4 : 0;
  if (!channels) return null;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += SCAN_STEP) {
    const row = y * width * channels;
    for (let x = 0; x < width; x += SCAN_STEP) {
      const i = row + x * channels;
      if (channels === 4 && data[i + 3] < 16) continue; // transparent
      if (data[i] > WHITE && data[i + 1] > WHITE && data[i + 2] > WHITE) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  // la ligne 0 d'une image est en HAUT, alors que le carre unite a son origine
  // en bas : l'axe vertical s'inverse
  return {
    u0: Math.max(0, minX - SCAN_STEP) / width,
    u1: Math.min(width, maxX + SCAN_STEP + 1) / width,
    v0: 1 - Math.min(height, maxY + SCAN_STEP + 1) / height,
    v1: 1 - Math.max(0, minY - SCAN_STEP) / height,
  };
}

function subRectBounds(ctm, r) {
  const pts = [[r.u0, r.v0], [r.u1, r.v0], [r.u0, r.v1], [r.u1, r.v1]].map(([x, y]) => [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
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
  if (box.kind === "text") return false;
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
      // on recadre l'image sur son encre : une page entiere livree en bitmap
      // ne doit pas compter comme de l'encre du bord au bord
      let box = unitBounds(ctm);
      const id = args[0];
      try {
        if (typeof id === "string" && page.objs.has(id)) {
          const rect = imageInkRect(page.objs.get(id));
          if (rect) box = subRectBounds(ctm, rect);
        }
      } catch (err) {
        // image non decodee : on garde son emprise complete
      }
      items.push({ kind: "image", ...box });
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
        kind: "path",
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
    // Un grand TRACE qui couvre la page est un fond ou un cadre : il
    // masquerait toute separation. Une grande IMAGE, au contraire, EST
    // l'etiquette : certains transporteurs livrent toute la page en bitmap.
    if (b.kind === "path" && (b.right - b.left) * (b.top - b.bottom) > pageArea * BACKGROUND_AREA) {
      return false;
    }
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
