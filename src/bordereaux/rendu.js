const { spawn } = require("child_process");

// Les pages d'une etiquette en images, pour le lecteur de codes. Poppler
// (pdfinfo, pdftoppm : deja installes pour l'impression, voir le Dockerfile)
// lit le PDF par un tuyau : rien n'est ecrit sur le disque, et le PDF
// d'origine n'est jamais modifie.
//
// La page est rendue comme la visionneuse du site l'affiche (pdf.js) : sa
// zone visible (CropBox) et sa rotation (/Rotate). Les positions des codes,
// rapportees a la taille de l'image (0..1), tombent donc au meme endroit sur
// la page affichee, a tous les zooms.

const DELAI_MS = 30000;
const MAX_SORTIE = 120 * 1024 * 1024;

function lance(commande, args, entree) {
  return new Promise((resolve, reject) => {
    const enfant = spawn(commande, args, { timeout: DELAI_MS });
    const morceaux = [];
    let taille = 0;
    let erreur = "";
    enfant.stdout.on("data", (c) => {
      morceaux.push(c);
      taille += c.length;
      if (taille > MAX_SORTIE) enfant.kill();
    });
    enfant.stderr.on("data", (c) => {
      if (erreur.length < 600) erreur += c.toString();
    });
    enfant.on("error", reject);
    enfant.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(morceaux));
      else reject(new Error(erreur.trim().split("\n").find((l) => /error/i.test(l)) || `${commande} : échec (${code})`));
    });
    enfant.stdin.on("error", () => {});
    enfant.stdin.end(Buffer.from(entree));
  });
}

/** "pdf" | "jpeg" | "png" | "gif" | "webp" | null, d'apres les premiers octets. */
function typeDeFichier(o) {
  if (!o || o.length < 12) return null;
  const debut = Buffer.from(o.subarray(0, 1024)).toString("latin1");
  if (debut.includes("%PDF-")) return "pdf";
  if (o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return "jpeg";
  if (o[0] === 0x89 && o[1] === 0x50 && o[2] === 0x4e && o[3] === 0x47) return "png";
  if (debut.startsWith("GIF8")) return "gif";
  if (debut.startsWith("RIFF") && debut.slice(8, 12) === "WEBP") return "webp";
  return null;
}

const TYPES_MIME = { pdf: "application/pdf", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

/** { largeur, hauteur } d'une image PNG, JPEG ou GIF (en pixels), ou null. */
function dimensionsImage(o) {
  const b = Buffer.from(o.buffer, o.byteOffset, o.byteLength);
  const type = typeDeFichier(o);
  if (type === "png" && b.length >= 24) return { largeur: b.readUInt32BE(16), hauteur: b.readUInt32BE(20) };
  if (type === "gif" && b.length >= 10) return { largeur: b.readUInt16LE(6), hauteur: b.readUInt16LE(8) };
  if (type === "jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marqueur = b[i + 1];
      if (marqueur === 0xff) {
        i += 1;
        continue;
      }
      const longueur = b.readUInt16BE(i + 2);
      // SOF0..SOF15, sauf DHT (C4), JPG (C8) et DAC (CC)
      if (marqueur >= 0xc0 && marqueur <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marqueur)) {
        return { largeur: b.readUInt16BE(i + 7), hauteur: b.readUInt16BE(i + 5) };
      }
      i += 2 + longueur;
    }
  }
  return null;
}

/** Le nombre de pages d'un PDF (leve une erreur si poppler ne peut pas l'ouvrir). */
async function nombrePages(pdf) {
  const sortie = (await lance("pdfinfo", ["-"], pdf)).toString("latin1");
  const m = /^Pages:\s+(\d+)/m.exec(sortie);
  if (!m) throw new Error("PDF illisible");
  return Number(m[1]);
}

/**
 * Une page (1, 2...) rendue en niveaux de gris, son plus grand cote a
 * `taille` pixels : { image (PGM), largeur, hauteur }.
 */
async function rendPage(pdf, page, taille) {
  const pgm = await lance("pdftoppm", ["-cropbox", "-scale-to", String(taille), "-gray", "-f", String(page), "-l", String(page), "-"], pdf);
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 40).toString("latin1"));
  if (!m) throw new Error(`page ${page} : rendu impossible`);
  return { image: pgm, largeur: Number(m[1]), hauteur: Number(m[2]) };
}

module.exports = { typeDeFichier, TYPES_MIME, dimensionsImage, nombrePages, rendPage };
