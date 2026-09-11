const zlib = require("zlib");
const { PDFName, PDFArray, PDFDict, PDFNumber } = require("pdf-lib");

// Lecture minimale d'un flux de contenu PDF, pour retrouver ou se trouve
// l'etiquette sur une feuille A4. Deux indices suffisent en pratique :
//   - l'emprise des images (etiquette scannee collee dans un coin) ;
//   - les rectangles de decoupe "re W n" (etiquette vectorielle : le
//     producteur clippe systematiquement sur la zone de l'etiquette).
// Sans ca, on reduit toute la feuille et l'etiquette finit minuscule.

function inflate(bytes) {
  try {
    return zlib.inflateSync(Buffer.from(bytes));
  } catch (err) {
    try {
      return zlib.inflateRawSync(Buffer.from(bytes));
    } catch (err2) {
      return null;
    }
  }
}

// Renvoie le flux decode, ou null si le filtre n'est pas gere (on renonce
// alors au recadrage automatique plutot que de deviner).
function decodeStream(context, stream) {
  if (!stream || !stream.dict) return null;
  const raw = stream.contents;
  if (!raw) return null;

  const filter = stream.dict.get(PDFName.of("Filter"));
  const names = [];
  if (filter instanceof PDFArray) {
    for (let i = 0; i < filter.size(); i += 1) names.push(String(context.lookup(filter.get(i))));
  } else if (filter) {
    names.push(String(filter));
  }

  if (names.length === 0) return Buffer.from(raw);
  if (names.length === 1 && (names[0] === "/FlateDecode" || names[0] === "/Fl")) return inflate(raw);
  return null;
}

const DELIMITERS = new Set([..."()<>[]{}/%", " ", "\n", "\r", "\t", "\f", "\0"]);

// Decoupe un flux en jetons exploitables (nombres, noms, operateurs). Les
// chaines et les images en ligne sont sautees : leur contenu binaire pourrait
// sinon passer pour des operateurs.
function tokenize(buffer) {
  const text = buffer.toString("latin1");
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0") {
      i += 1;
    } else if (ch === "%") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i += 1;
    } else if (ch === "(") {
      let depth = 1;
      i += 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "\\") i += 2;
        else {
          if (text[i] === "(") depth += 1;
          else if (text[i] === ")") depth -= 1;
          i += 1;
        }
      }
      tokens.push({ type: "other" });
    } else if (ch === "<" && text[i + 1] === "<") {
      tokens.push({ type: "other" });
      i += 2;
    } else if (ch === ">" && text[i + 1] === ">") {
      tokens.push({ type: "other" });
      i += 2;
    } else if (ch === "<") {
      while (i < text.length && text[i] !== ">") i += 1;
      i += 1;
      tokens.push({ type: "other" });
    } else if (ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      tokens.push({ type: "other" });
      i += 1;
    } else if (ch === "/") {
      let j = i + 1;
      while (j < text.length && !DELIMITERS.has(text[j])) j += 1;
      tokens.push({ type: "name", value: text.slice(i + 1, j) });
      i = j;
    } else {
      let j = i;
      while (j < text.length && !DELIMITERS.has(text[j])) j += 1;
      const word = text.slice(i, j);
      i = j === i ? i + 1 : j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ type: "number", value: Number(word) });
      else if (word) tokens.push({ type: "op", value: word });
    }
  }
  return tokens;
}

// [a b c d e f] : m appliquee AVANT n (convention PDF : CTM' = m x CTM).
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

// Emprise d'un rectangle une fois la matrice appliquee.
function transformRect(ctm, x, y, w, h) {
  const [a, b, c, d, e, f] = ctm;
  const point = (px, py) => [a * px + c * py + e, b * px + d * py + f];
  const corners = [point(x, y), point(x + w, y), point(x, y + h), point(x + w, y + h)];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return {
    left: Math.min(...xs),
    bottom: Math.min(...ys),
    right: Math.max(...xs),
    top: Math.max(...ys),
  };
}

// Une image est dessinee dans le carre unite : sa place est celle de la CTM.
function unitSquareBounds(ctm) {
  return transformRect(ctm, 0, 0, 1, 1);
}

function numbersBefore(tokens, index, count) {
  const values = [];
  for (let i = index - 1; i >= 0 && values.length < count; i -= 1) {
    if (tokens[i].type !== "number") break;
    values.unshift(tokens[i].value);
  }
  return values.length === count ? values : null;
}

function lookupXObject(context, resources, name) {
  if (!(resources instanceof PDFDict)) return null;
  const xobjects = context.lookup(resources.get(PDFName.of("XObject")));
  if (!(xobjects instanceof PDFDict)) return null;
  return context.lookup(xobjects.get(PDFName.of(name)));
}

// Parcourt le flux en suivant la pile graphique (q/Q/cm) et note l'emprise de
// chaque image. Descend dans les XObject de type Form, ou l'etiquette est
// parfois encapsulee.
const PAINT_OPS = new Set(["n", "f", "F", "f*", "S", "s", "B", "B*", "b", "b*"]);

function collectBoxes(context, streamBytes, resources, ctm, depth, out) {
  if (depth > 3) return;
  const tokens = tokenize(streamBytes);
  const stack = [];
  let current = ctm;
  let pendingRects = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "op") continue;

    if (token.value === "re") {
      const r = numbersBefore(tokens, i, 4);
      if (r) pendingRects.push(transformRect(current, r[0], r[1], r[2], r[3]));
    } else if (token.value === "W" || token.value === "W*") {
      // le chemin en cours devient la zone de decoupe
      for (const rect of pendingRects) out.push({ kind: "clip", ...rect });
    } else if (PAINT_OPS.has(token.value)) {
      pendingRects = [];
    }

    if (token.value === "q") {
      stack.push(current);
    } else if (token.value === "Q") {
      current = stack.pop() || ctm;
    } else if (token.value === "cm") {
      const m = numbersBefore(tokens, i, 6);
      if (m) current = multiply(m, current);
    } else if (token.value === "BI") {
      // image en ligne : on saute jusqu'a EI, le binaire n'est pas analysable
      while (i < tokens.length && !(tokens[i].type === "op" && tokens[i].value === "EI")) i += 1;
    } else if (token.value === "Do") {
      const nameToken = tokens[i - 1];
      if (!nameToken || nameToken.type !== "name") continue;
      const xobject = lookupXObject(context, resources, nameToken.value);
      if (!xobject || !xobject.dict) continue;

      const subtype = String(xobject.dict.get(PDFName.of("Subtype")) || "");
      if (subtype === "/Image") {
        out.push({ kind: "image", ...unitSquareBounds(current) });
      } else if (subtype === "/Form") {
        const inner = decodeStream(context, xobject);
        if (!inner) continue;
        const matrixArr = context.lookup(xobject.dict.get(PDFName.of("Matrix")));
        let formCtm = current;
        if (matrixArr instanceof PDFArray && matrixArr.size() === 6) {
          const m = [];
          for (let k = 0; k < 6; k += 1) {
            const v = context.lookup(matrixArr.get(k));
            m.push(v instanceof PDFNumber ? v.asNumber() : Number(String(v)));
          }
          formCtm = multiply(m, current);
        }
        const innerRes = context.lookup(xobject.dict.get(PDFName.of("Resources"))) || resources;
        collectBoxes(context, inner, innerRes, formCtm, depth + 1, out);
      }
    }
  }
}

// Emprises des images et des zones de decoupe de la page, dedoublonnees
// (un meme rectangle de decoupe peut revenir des dizaines de fois).
function contentBoxes(page) {
  const context = page.doc.context;
  const contents = context.lookup(page.node.get(PDFName.of("Contents")));
  const streams = [];

  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) streams.push(context.lookup(contents.get(i)));
  } else if (contents) {
    streams.push(contents);
  }

  const decoded = streams.map((s) => decodeStream(context, s)).filter(Boolean);
  if (decoded.length === 0) return [];

  const resources = context.lookup(page.node.get(PDFName.of("Resources")));
  const out = [];
  collectBoxes(context, Buffer.concat(decoded), resources, [1, 0, 0, 1, 0, 0], 0, out);

  const seen = new Set();
  return out.filter((box) => {
    const key = `${box.kind}:${box.left.toFixed(1)}:${box.bottom.toFixed(1)}:${box.right.toFixed(1)}:${box.top.toFixed(1)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { contentBoxes };
