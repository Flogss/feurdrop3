// Trouve la zone utile d'une page d'etiquette : l'encre reellement visible,
// debarrassee du bloc "INSTRUCTIONS D'EMBALLAGE / PROCEDURE DETAILLEE" que
// certains transporteurs collent a cote du bordereau.
//
// Deux pieges que cette analyse evite, parce qu'ils gonflent la zone gardee et
// font imprimer des metres de blanc :
//
//   - un trace n'est pas forcement dessine. La plupart des PDF d'etiquettes
//     commencent par un rectangle de la taille de la page qui sert uniquement
//     de zone de decoupe (clip). Il faut regarder l'operation qui SUIT le
//     trace pour savoir s'il est peint ;
//   - une image ne contient pas de l'encre partout. Chronopost livre la feuille
//     entiere en un seul JPEG dont la moitie gauche est blanche : sans regarder
//     les pixels, on recadre sur du papier.
//
// La regle de decoupe reste prudente : on ne jette un morceau de page que s'il
// est separe du reste par une vraie gouttiere ET qu'il ne contient aucun
// code-barres. Un bordereau porte toujours un code-barres ; un bloc
// d'instructions, jamais. Dans le doute on garde tout : perdre du papier est
// sans consequence, couper un code-barres fait perdre le colis.

const { rasterInkBox } = require("./rasterInk");

const MM = 72 / 25.4;
const MIN_GUTTER = 6 * MM; // en-deca, c'est une simple marge entre deux blocs
const BACKGROUND_AREA = 0.5; // un aplat couvrant plus de la moitie de la page est un fond
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

function boundsOf(points) {
  return {
    left: Math.min(...points.map((p) => p[0])),
    bottom: Math.min(...points.map((p) => p[1])),
    right: Math.max(...points.map((p) => p[0])),
    top: Math.max(...points.map((p) => p[1])),
  };
}

// Emprise d'un rectangle du repere unite (une image) une fois transforme.
function rectBounds(ctm, r) {
  return boundsOf(
    [[r.u0, r.v0], [r.u1, r.v0], [r.u0, r.v1], [r.u1, r.v1]].map(([x, y]) => [
      ctm[0] * x + ctm[2] * y + ctm[4],
      ctm[1] * x + ctm[3] * y + ctm[5],
    ])
  );
}

function intersect(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.max(a.left, b.left),
    bottom: Math.max(a.bottom, b.bottom),
    right: Math.min(a.right, b.right),
    top: Math.min(a.top, b.top),
  };
}

function isEmpty(box) {
  return !box || box.right <= box.left || box.top <= box.bottom;
}

// --- Encre reelle d'une image ------------------------------------------------
// pdfjs decode deja ces images pour le rendu, on se sert de ses donnees.
const WHITE = 245; // au-dessus, on considere que c'est du papier
const ALPHA = 40; // en-dessous, le pixel est trop transparent pour se voir
const SCAN_STEP = 2; // un pixel sur deux suffit pour trouver les bords

// Rectangle d'encre dans le carre unite de l'image (origine en bas a gauche,
// comme en PDF). Renvoie null si l'image est illisible (on gardera alors son
// emprise complete) et { blank: true } si elle est entierement blanche.
function imageInkRect(image) {
  const { width, height, data } = image;
  if (!data || !width || !height) return null;

  // On deduit le nombre d'octets par pixel de la taille reelle du tampon
  // plutot que de se fier au champ `kind` : pdfjs livre aussi du gris sur un
  // octet, et une image qu'on renonce a lire finit par imposer son emprise
  // entiere -- c'est-a-dire, pour une feuille livree en un seul bitmap,
  // aucun recadrage du tout.
  const channels = Math.floor(data.length / (width * height));
  if (![1, 3, 4].includes(channels)) return null;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += SCAN_STEP) {
    const row = y * width * channels;
    for (let x = 0; x < width; x += SCAN_STEP) {
      const i = row + x * channels;
      if (channels === 4 && data[i + 3] < ALPHA) continue;
      if (channels === 1) {
        if (data[i] > WHITE) continue;
      } else if (data[i] > WHITE && data[i + 1] > WHITE && data[i + 2] > WHITE) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { blank: true };

  // la ligne 0 d'une image est en HAUT, alors que le carre unite a son origine
  // en bas : l'axe vertical s'inverse
  return {
    u0: Math.max(0, minX - SCAN_STEP) / width,
    u1: Math.min(width, maxX + SCAN_STEP + 1) / width,
    v0: 1 - Math.min(height, maxY + SCAN_STEP + 1) / height,
    v1: 1 - Math.max(0, minY - SCAN_STEP) / height,
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

// Un aplat blanc sans contour ne se voit pas sur du papier blanc.
function isInvisible(color) {
  if (!color) return false;
  const [r, g, b] = color;
  const max = Math.max(r, g, b) > 1 ? 255 : 1;
  return r / max > 0.97 && g / max > 0.97 && b / max > 0.97;
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
  const PAINTS = new Set(
    [
      OPS.fill,
      OPS.eoFill,
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
    ].filter((op) => op !== undefined)
  );
  const FILL_ONLY = new Set([OPS.fill, OPS.eoFill].filter((op) => op !== undefined));

  let ctm = [1, 0, 0, 1, 0, 0];
  let clip = null; // zone de decoupe courante, en points page
  let fillColor = null;
  // opacites de l'etat graphique : un trace a CA = 0 est parfaitement
  // invisible, et pourtant certaines etiquettes en sont pleines
  let fillAlpha = 1;
  let strokeAlpha = 1;
  let pending = null; // dernier trace construit, pas encore peint ni utilise en clip
  const stack = [];

  const add = (box) => {
    const visible = intersect(box, clip);
    if (!isEmpty(visible)) items.push(visible);
  };

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) {
      stack.push({ ctm, clip, fillAlpha, strokeAlpha });
    } else if (fn === OPS.paintFormXObjectBegin) {
      // Un form XObject a sa propre matrice ET son propre cadre : tout ce qu'il
      // dessine en dehors de ce cadre est rogne a l'affichage. Les ignorer
      // faisait compter comme encre des traces parfaitement invisibles -- et
      // suffisait a garder une demi-page blanche dans le recadrage.
      stack.push({ ctm, clip, fillAlpha, strokeAlpha });
      const [matrix, bbox] = args;
      if (Array.isArray(matrix) && matrix.length === 6) ctm = multiply(matrix, ctm);
      if (Array.isArray(bbox) && bbox.length === 4) {
        const [x0, y0, x1, y1] = bbox;
        clip = intersect(
          clip,
          boundsOf(
            [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [
              ctm[0] * x + ctm[2] * y + ctm[4],
              ctm[1] * x + ctm[3] * y + ctm[5],
            ])
          )
        );
      }
    } else if (fn === OPS.paintFormXObjectEnd || fn === OPS.restore) {
      const saved = stack.pop();
      if (saved) {
        ctm = saved.ctm;
        clip = saved.clip;
        fillAlpha = saved.fillAlpha;
        strokeAlpha = saved.strokeAlpha;
      }
    } else if (fn === OPS.transform) {
      ctm = multiply(args, ctm);
    } else if (fn === OPS.setGState) {
      for (const [key, value] of args[0] || []) {
        if (key === "ca" && typeof value === "number") fillAlpha = value;
        if (key === "CA" && typeof value === "number") strokeAlpha = value;
      }
    } else if (fn === OPS.setFillRGBColor) {
      fillColor = args;
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintJpegXObject
    ) {
      // on recadre l'image sur son encre : une feuille entiere livree en bitmap
      // ne doit pas compter comme de l'encre d'un bord a l'autre
      let box = rectBounds(ctm, { u0: 0, v0: 0, u1: 1, v1: 1 });
      let measured = false;
      const id = args[0];
      try {
        if (typeof id === "string" && page.objs.has(id)) {
          const ink = imageInkRect(page.objs.get(id));
          if (ink && ink.blank) continue; // image entierement blanche
          if (ink) {
            box = rectBounds(ctm, ink);
            measured = true;
          }
        }
      } catch (err) {
        // image non decodee : on garde son emprise, mais sans certitude
      }
      // `measured: false` = on n'a pas pu regarder ses pixels. Son emprise
      // reste connue, mais elle ne servira qu'a defaut d'autre encre.
      add({ kind: "image", measured, ...box });
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
      pending = null;
      if (!Number.isFinite(minX)) continue;
      const project = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      pending = boundsOf([project(minX, minY), project(maxX, maxY)]);
    } else if (fn === OPS.clip || fn === OPS.eoClip) {
      // le trace ne sera pas dessine : il restreint ce qui suit
      if (pending) clip = intersect(clip, pending);
    } else if (PAINTS.has(fn)) {
      const remplit = FILL_ONLY.has(fn);
      const opacite = remplit ? fillAlpha : Math.max(fillAlpha, strokeAlpha);
      const visible = opacite > 0.02 && !(remplit && isInvisible(fillColor));
      if (pending && visible) add({ kind: "path", ...pending });
      pending = null;
    }
  }

  const pageArea = viewport.width * viewport.height;
  return items.filter((b) => {
    if (isEmpty(b)) return false;
    // un aplat qui couvre la page est un fond : il masquerait toute separation
    if (b.kind === "path" && (b.right - b.left) * (b.top - b.bottom) > pageArea * BACKGROUND_AREA) {
      return false;
    }
    return true;
  });
}


// Marge de rattachement : un libelle colle a un cadre est a quelques
// millimetres de lui, jamais a dix centimetres.
const TEXT_REACH = 12 * MM;


// Un trait de guide : un cheveu qui traverse la feuille. Les bordereaux en
// portent souvent -- reperes de pliage, bords de planche, amorces de decoupe --
// et ils s'impriment bel et bien, mais ils ne font pas partie de l'etiquette.
// Les compter comme encre revenait a garder la feuille entiere.
//
// La longueur les distingue d'une barre de code-barres : une barre depasse
// rarement 50 mm, un trait de guide court sur toute la page.
const HAIRLINE_THIN = 1.2 * MM;
const HAIRLINE_LONG = 100 * MM;

function isGuideLine(box) {
  if (box.kind === "text") return false;
  const w = box.right - box.left;
  const h = box.top - box.bottom;
  return (w < HAIRLINE_THIN && h > HAIRLINE_LONG) || (h < HAIRLINE_THIN && w > HAIRLINE_LONG);
}

function dropGuideLines(items) {
  const sans = items.filter((b) => !isGuideLine(b));
  if (sans.length === 0) return items;
  const aire = (b) => (b.right - b.left) * (b.top - b.bottom);
  // on ne les ecarte que si ca resserre vraiment le cadrage
  return aire(union(sans)) < aire(union(items)) * 0.8 ? sans : items;
}

function keepTextNearInk(items) {
  const structure = items.filter((b) => b.kind !== "text");
  if (structure.length === 0) return items;

  const zone = union(structure);
  const proche = (b) =>
    b.left < zone.right + TEXT_REACH &&
    b.right > zone.left - TEXT_REACH &&
    b.bottom < zone.top + TEXT_REACH &&
    b.top > zone.bottom - TEXT_REACH;

  const gardes = items.filter((b) => b.kind !== "text" || proche(b));
  return gardes.length > 0 ? gardes : items;
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
// Ce qu'on jette doit etre un vrai bloc. Cette coupe existe pour retirer un
// pave "INSTRUCTIONS D'EMBALLAGE" colle a cote du bordereau ; elle n'a jamais
// eu pour but de raboter un logo de quelques millimetres au bord.
const MIN_DROPPED = 35 * MM;

function splitOnce(items, axis) {
  const gap = widestGap(items, axis);
  if (!gap) return null;

  const before = items.filter((b) => (axis === "x" ? b.right : b.top) <= gap[0] + 0.5);
  const after = items.filter((b) => (axis === "x" ? b.left : b.bottom) >= gap[1] - 0.5);
  if (before.length === 0 || after.length === 0) return null;

  const taille = (liste) => {
    const b = union(liste);
    return axis === "x" ? b.right - b.left : b.top - b.bottom;
  };

  const barsBefore = before.filter(isBarcodeBar).length;
  const barsAfter = after.filter(isBarcodeBar).length;
  if (barsBefore > 0 && barsAfter === 0 && taille(after) >= MIN_DROPPED) return before;
  if (barsAfter > 0 && barsBefore === 0 && taille(before) >= MIN_DROPPED) return after;
  return null; // code-barres des deux cotes, d'aucun, ou morceau trop petit
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
      // rien de lisible dans le contenu : le rendu reste une chance de cadrer
      const rendu = await rasterInkBox(bytes, pageIndex, { rotation: page.rotate || 0 });
      const box = rendu || { left: 0, bottom: 0, right: viewport.width, top: viewport.height };
      return {
        left: Math.max(0, box.left - MARGIN),
        bottom: Math.max(0, box.bottom - MARGIN),
        right: Math.min(viewport.width, box.right + MARGIN),
        top: Math.min(viewport.height, box.top + MARGIN),
        trimmed: false,
      };
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

    // Le texte est rapporte par pdfjs pour la page entiere, sans tenir compte
    // des cadres qui le rognent : une etiquette repliee dans un form XObject
    // laisse traîner du texte dans la moitie blanche de la feuille. Or ce
    // texte-la ne s'imprime pas.
    //
    // On garde donc le texte qui TOUCHE la structure dessinee -- cadres,
    // codes-barres, images -- et on ecarte celui qui flotte seul dans le vide.
    // Un bordereau sans aucun trace (rare) garde tout son texte.
    items = dropGuideLines(items);
    items = keepTextNearInk(items);

    // Une image qu'on n'a pas su mesurer couvre souvent toute la feuille : la
    // laisser decider du cadrage revient a ne rien recadrer. Des qu'il existe
    // de l'encre mesuree, c'est elle qui fait foi.
    const mesures = items.filter((b) => b.kind !== "image" || b.measured);
    if (mesures.length > 0 && mesures.length < items.length) {
      const total = union(items);
      const sur = union(mesures);
      const aire = (b) => (b.right - b.left) * (b.top - b.bottom);
      // on ne retient l'encre mesuree que si elle fait vraiment gagner de la
      // place : sinon autant garder la vue large, moins risquee
      if (aire(sur) < aire(total) * 0.8) items = mesures;
    }

    let ink = union(items);

    // Le rendu fait foi. L'analyse du contenu enchaine les suppositions -- ce
    // trace est-il peint, rogne, transparent, decoratif ? -- et chacune peut
    // se tromper en moins : c'est ainsi qu'un logo Mondial Relay s'est
    // retrouve coupe de six millimetres.
    //
    // On ne lui garde donc qu'un seul pouvoir, celui que le rendu n'a pas :
    // reconnaitre un bloc d'instructions a l'absence de code-barres. Quand
    // cette coupe s'est declenchee, on croise les deux ; sinon le rendu
    // decide seul.
    const rendu = await rasterInkBox(bytes, pageIndex, { rotation: page.rotate || 0 });
    if (rendu) {
      const retenu = trimmed ? intersect(ink, rendu) : rendu;
      if (!isEmpty(retenu)) ink = retenu;
    }

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
