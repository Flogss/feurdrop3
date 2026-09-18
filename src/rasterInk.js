const { spawn, spawnSync } = require("child_process");

// Zone encree d'une page, mesuree sur le RENDU et non sur le flux de contenu.
//
// Pourquoi : analyser le contenu d'un PDF pour deviner ce qui s'imprime est un
// puits sans fond. Un trace peut etre rogne par un cadre, peint en blanc, mis
// en opacite nulle, enferme dans un masque, ou servir uniquement de gabarit.
// Chaque correction en decouvre une autre. Le rendu, lui, ne ment pas : ce qui
// est noir a l'ecran est ce qui sortira de l'imprimante.
//
// pdftoppm (paquet poppler-utils) sait ecrire un PGM sur la sortie standard :
// un en-tete de trois lignes puis un octet par pixel. Aucune dependance npm,
// aucun decodeur d'image a ecrire.

// 100 ppp : assez fin pour un trait de 0,25 mm, assez grossier pour rester
// rapide. Mesure : environ 250 ms par etiquette, rendu compris.
const DPI = 100;
const WHITE = 245; // au-dessus, c'est du papier
const STEP = 2; // un pixel sur deux suffit a trouver les bords
const TIMEOUT_MS = 20000;

let available = null;

// poppler est-il installe ? La reponse ne change pas en cours d'execution.
function isAvailable() {
  if (available === null) {
    try {
      available = spawnSync("pdftoppm", ["-v"], { timeout: 5000 }).error === undefined;
    } catch (err) {
      available = false;
    }
    if (!available) {
      console.log("[print] pdftoppm absent : recadrage des etiquettes sur le contenu du PDF");
    }
  }
  return available;
}

function renderGray(bytes, pageIndex) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pdftoppm",
      ["-gray", "-r", String(DPI), "-f", String(pageIndex + 1), "-l", String(pageIndex + 1)],
      { timeout: TIMEOUT_MS }
    );

    const chunks = [];
    let size = 0;
    child.stdout.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      // garde-fou : une page absurde ne doit pas remplir la memoire
      if (size > 80 * 1024 * 1024) child.kill();
    });
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(chunks)));
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(bytes));
  });
}

// En-tete PGM : "P5\n<largeur> <hauteur>\n255\n" puis les pixels.
function parsePgm(buffer) {
  if (buffer.length < 10 || buffer[0] !== 0x50 || buffer[1] !== 0x35) return null;
  let pos = 2;
  const nombres = [];
  while (nombres.length < 3 && pos < buffer.length) {
    while (pos < buffer.length && /\s/.test(String.fromCharCode(buffer[pos]))) pos += 1;
    if (buffer[pos] === 0x23) {
      while (pos < buffer.length && buffer[pos] !== 0x0a) pos += 1;
      continue;
    }
    let n = 0;
    let vu = false;
    while (pos < buffer.length && buffer[pos] >= 0x30 && buffer[pos] <= 0x39) {
      n = n * 10 + (buffer[pos] - 0x30);
      pos += 1;
      vu = true;
    }
    if (!vu) return null;
    nombres.push(n);
  }
  pos += 1; // l'unique blanc qui suit l'en-tete
  const [width, height] = nombres;
  if (!width || !height) return null;
  return { width, height, data: buffer.subarray(pos, pos + width * height) };
}

// Rectangle encre, en points PDF, origine en bas a gauche. Renvoie null si on
// ne sait pas mesurer : l'appelant garde alors son analyse du contenu.
async function rasterInkBox(bytes, pageIndex, { rotation = 0 } = {}) {
  // une page pivotee se rend dans un autre repere que celui de son MediaBox :
  // plutot que de risquer un cadrage a l'envers, on laisse la main
  if (!isAvailable() || rotation % 360 !== 0) return null;

  let image;
  try {
    image = parsePgm(await renderGray(bytes, pageIndex));
  } catch (err) {
    return null;
  }
  if (!image || image.data.length < image.width * image.height) return null;

  const { width, height, data } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += STEP) {
    const row = y * width;
    for (let x = 0; x < width; x += STEP) {
      if (data[row + x] > WHITE) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null; // page blanche : rien a en tirer

  const toPt = 72 / DPI;
  const pageHeight = height * toPt;
  return {
    left: Math.max(0, minX - STEP) * toPt,
    right: Math.min(width, maxX + STEP + 1) * toPt,
    // l'image a son origine en haut, le PDF en bas
    bottom: pageHeight - Math.min(height, maxY + STEP + 1) * toPt,
    top: pageHeight - Math.max(0, minY - STEP) * toPt,
  };
}

module.exports = { rasterInkBox, isAvailable };
