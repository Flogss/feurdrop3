// Des etiquettes de test fabriquees a la volee : de vrais codes-barres et QR
// codes (generes par zxing, le meme moteur que le lecteur), poses dans des
// PDF par pdf-lib. Numeros et adresses inventes -- jamais une vraie etiquette.
const fs = require("fs");
const { PDFDocument, degrees, rgb } = require("pdf-lib");

let ecrivain = null;
async function zxing() {
  if (!ecrivain) {
    ecrivain = import("zxing-wasm/writer").then((z) => {
      // le binaire local, jamais le CDN (les tests n'ont pas de reseau)
      z.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(require.resolve("zxing-wasm/writer/zxing_writer.wasm")) }, fireImmediately: true });
      return z;
    });
  }
  return ecrivain;
}

/** Les octets PNG d'un code. */
async function codePng(texte, format, options = {}) {
  const { writeBarcode } = await zxing();
  // sans marge blanche autour : le code occupe exactement la zone dessinee (la
  // page blanche fait la marge)
  const r = await writeBarcode(texte, { format, scale: 4, addQuietZones: false, ...options });
  if (r.error) throw new Error(r.error);
  return new Uint8Array(await r.image.arrayBuffer());
}

/**
 * Un PDF. `pages` : [{ taille: [l, h], rotation, codes: [{ texte, format,
 * x, y, largeur, hauteur }], abime: [{ x, y, largeur, hauteur }] }] --
 * coordonnees PDF (points, origine en bas a gauche).
 */
async function etiquettePdf(pages) {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage(p.taille || [288, 432]);
    if (p.rotation) page.setRotation(degrees(p.rotation));
    for (const c of p.codes || []) {
      const image = await doc.embedPng(await codePng(c.texte, c.format, c.options));
      page.drawImage(image, { x: c.x, y: c.y, width: c.largeur, height: c.hauteur });
    }
    for (const a of p.abime || []) page.drawRectangle({ x: a.x, y: a.y, width: a.largeur, height: a.hauteur, color: rgb(1, 1, 1) });
  }
  return doc.save();
}

/**
 * La zone attendue d'un code (0..1, origine en haut a gauche) une fois la
 * page affichee -- rotation comprise, comme pdf.js et poppler la montrent.
 */
function zoneAttendue(page, c) {
  const [l, h] = page.taille || [288, 432];
  const u0 = c.x / l;
  const u1 = (c.x + c.largeur) / l;
  const v0 = 1 - (c.y + c.hauteur) / h;
  const v1 = 1 - c.y / h;
  switch (((page.rotation || 0) % 360 + 360) % 360) {
    case 90:
      return { x0: 1 - v1, x1: 1 - v0, y0: u0, y1: u1 };
    case 180:
      return { x0: 1 - u1, x1: 1 - u0, y0: 1 - v1, y1: 1 - v0 };
    case 270:
      return { x0: v0, x1: v1, y0: 1 - u1, y1: 1 - u0 };
    default:
      return { x0: u0, x1: u1, y0: v0, y1: v1 };
  }
}

module.exports = { codePng, etiquettePdf, zoneAttendue };
