const { spawn, spawnSync } = require("child_process");
const { PDFDocument } = require("pdf-lib");
const { rasterInkBox, isAvailable: rasterDisponible } = require("./rasterInk");

// Une etiquette que pdf-lib ne sait pas recopier telle quelle :
//   - un PDF protege par un mot de passe proprietaire (« chiffre ») : il
//     s'ouvre sans mot de passe, mais ses flux restent chiffres. pdf-lib le
//     chargeait (ignoreEncryption), puis echouait en enregistrant la liasse
//     -- « Unknown compression method in flate stream: 252, 35 » -- et c'est
//     TOUTE l'impression qui tombait, etiquettes saines comprises ;
//   - un flux compresse d'une facon que pdf-lib ne relit pas.
// Poppler (pdftocairo, installe avec pdftoppm, voir le Dockerfile) relit ces
// PDF et les reecrit en PDF clair, vectoriel : l'etiquette s'imprime comme
// les autres. S'il n'y arrive pas non plus, seule cette etiquette echoue --
// elle reste « a imprimer », la liasse sort sans elle.

const DELAI_MS = 20000;
const MAX_OCTETS = 60 * 1024 * 1024;

let poppler = null;
function popplerDisponible() {
  if (poppler === null) {
    try {
      poppler = spawnSync("pdftocairo", ["-v"], { timeout: 5000 }).error === undefined;
    } catch {
      poppler = false;
    }
  }
  return poppler;
}

// Le PDF relu et reecrit par poppler (entree et sortie par les tuyaux).
function reecrit(bytes) {
  return new Promise((resolve, reject) => {
    const enfant = spawn("pdftocairo", ["-pdf", "-", "-"], { timeout: DELAI_MS });
    const morceaux = [];
    let taille = 0;
    let erreur = "";
    enfant.stdout.on("data", (c) => {
      morceaux.push(c);
      taille += c.length;
      if (taille > MAX_OCTETS) enfant.kill();
    });
    enfant.stderr.on("data", (c) => {
      erreur += c.toString().slice(0, 300);
    });
    enfant.on("error", reject);
    enfant.on("close", (code) => {
      const pdf = Buffer.concat(morceaux);
      if (code === 0 && pdf.length > 100) resolve(new Uint8Array(pdf));
      else reject(new Error(`relecture impossible${erreur ? ` (${erreur.trim().split("\n")[0]})` : ""}`));
    });
    enfant.stdin.on("error", () => {});
    enfant.stdin.end(Buffer.from(bytes));
  });
}

// Chaque page se recopie-t-elle vraiment ? (c'est a l'enregistrement que
// pdf-lib decode les flux : on le fait ici, dans un document jetable)
async function verifieRecopiable(doc) {
  const essai = await PDFDocument.create();
  for (const page of doc.getPages()) {
    const recopie = await essai.embedPage(page);
    await recopie.embed();
  }
}

/**
 * Le PDF d'une etiquette, pret a etre recopie dans une liasse :
 * { doc, bytes, reecrit }. `bytes` : ceux du PDF reellement utilise (le PDF
 * reecrit le cas echeant). Leve une erreur si l'etiquette est illisible.
 */
async function chargeImprimable(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let raison = doc.isEncrypted ? "PDF protégé par mot de passe" : null;
  if (!raison) {
    try {
      await verifieRecopiable(doc);
      return { doc, bytes, reecrit: false };
    } catch (err) {
      raison = `PDF illisible (${err.message})`;
    }
  }
  if (!popplerDisponible()) throw new Error(`${raison} : il faut poppler pour le relire`);

  let clair;
  try {
    clair = await reecrit(bytes);
  } catch (err) {
    throw new Error(`${raison} : ${err.message}`);
  }
  const relu = await PDFDocument.load(clair);
  await verifieRecopiable(relu);
  // un flux que poppler n'a pas su lire donne une page blanche : on ne
  // l'imprime pas comme si de rien n'etait
  if (rasterDisponible()) {
    for (let i = 0; i < relu.getPageCount(); i += 1) {
      if (!(await rasterInkBox(clair, i).catch(() => null))) throw new Error(`${raison} : page vide une fois relue`);
    }
  }
  return { doc: relu, bytes: clair, reecrit: true };
}

module.exports = { chargeImprimable, popplerDisponible };
