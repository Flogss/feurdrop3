// La fabrication des PDF d'impression : la liasse thermique 4x6 et le
// rouleau des LIT (dont le code mort a ete retire).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { mergeLabels } = require("../src/printer");
const { buildRoll } = require("../src/rollPrinter");

async function etiquette(texte, [largeur, hauteur] = [288, 432]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([largeur, hauteur]);
  const police = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 15, y: 15, width: largeur - 30, height: hauteur - 30, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  page.drawText(texte, { x: 40, y: hauteur / 2, size: 22, font: police });
  return doc.save();
}

const lot = async (n, format) =>
  Promise.all(
    Array.from({ length: n }, async (_, i) => ({ bytes: await etiquette(`COLIS ${i + 1}`, format), kind: "pdf", label: `c${i}.pdf`, colisId: i + 1 }))
  );

test("liasse thermique : une page 4x6 par etiquette", async () => {
  const { pdf, pages, failed } = await mergeLabels(await lot(3));
  assert.ok(pdf);
  assert.equal(failed.length, 0);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 3);
  assert.equal(pages, 3);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(Math.round(width), 288);
  assert.equal(Math.round(height), 432);
});

test("rouleau des LIT : un PDF a la largeur du rouleau, de longueur mesuree", async () => {
  const r = await buildRoll(await lot(4, [595, 842]));
  assert.ok(r.pdf);
  assert.equal(r.failed.length, 0);
  assert.ok(r.lengthMm > 0);
  const doc = await PDFDocument.load(r.pdf);
  const largeurMm = (doc.getPage(0).getSize().width * 25.4) / 72;
  assert.ok(Math.abs(largeurMm - 210) < 1, `largeur ${largeurMm} mm`);
});

test("un fichier illisible est signale, pas avale", async () => {
  const items = [...(await lot(1)), { bytes: new Uint8Array([1, 2, 3]), kind: "pdf", label: "casse.pdf", colisId: 99 }];
  const { pdf, failed } = await mergeLabels(items);
  assert.ok(pdf);
  assert.deepEqual(failed.map((f) => f.colisId), [99]);
});

// Un PDF protege par un mot de passe proprietaire (des transporteurs livrent
// leurs bordereaux ainsi) : il s'ouvre, mais ses flux restent chiffres.
// pdf-lib echouait en enregistrant la liasse -- « Unknown compression method
// in flate stream » -- et TOUTE l'impression tombait avec lui.
const { popplerDisponible } = require("../src/pdfLisible");
const PROTEGEE = require("fs").readFileSync(require("path").join(__dirname, "fixtures", "etiquette-protegee.pdf"));

test("une etiquette protegee par mot de passe s'imprime avec les autres", { skip: !popplerDisponible() && "poppler absent" }, async () => {
  const items = [...(await lot(2)), { bytes: PROTEGEE, kind: "pdf", label: "protegee.pdf", colisId: 50 }];
  assert.equal((await PDFDocument.load(PROTEGEE, { ignoreEncryption: true })).isEncrypted, true, "le fichier de test est bien chiffre");
  const { pdf, pages, failed } = await mergeLabels(items);
  assert.ok(pdf);
  assert.deepEqual(failed, []);
  assert.equal(pages, 3);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 3);

  // sur le rouleau des LIT aussi
  const r = await buildRoll([{ bytes: PROTEGEE, kind: "pdf", label: "protegee.pdf", colisId: 50 }]);
  assert.ok(r.pdf);
  assert.deepEqual(r.failed, []);
});

test("un flux impossible a decompresser : cette etiquette seule echoue, la liasse sort", async () => {
  const { PDFName } = require("pdf-lib");
  const casse = await PDFDocument.create();
  const page = casse.addPage([288, 432]);
  // un en-tete zlib invalide, comme dans le message vu en production
  page.node.set(PDFName.of("Contents"), casse.context.register(casse.context.stream(new Uint8Array([252, 35, 1, 2, 3, 4, 5, 6]), { Filter: "FlateDecode" })));
  const items = [...(await lot(2)), { bytes: await casse.save(), kind: "pdf", label: "casse.pdf", colisId: 77 }];
  const { pdf, pages, failed } = await mergeLabels(items);
  assert.ok(pdf, "les autres etiquettes sortent");
  assert.equal(pages, 2);
  assert.deepEqual(failed.map((f) => f.colisId), [77]);
  assert.match(failed[0].reason, /illisible/);
});
