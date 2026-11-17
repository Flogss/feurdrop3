// Le lecteur de codes (zxing-cpp compile en WebAssembly), dans son propre
// thread : la memoire d'un module WebAssembly ne redescend jamais, alors on
// arrete ce thread des qu'il ne sert plus (voir decodeur.js) et tout est rendu
// au systeme. Le binaire .wasm est lu sur le disque (node_modules) : jamais
// telecharge depuis un CDN, ni en production ni dans les tests.
import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { prepareZXingModule, readBarcodes, formatToLabel, MATRIX_BARCODE_FORMATS } from "zxing-wasm/reader";

const require = createRequire(import.meta.url);
const wasmBinary = await readFile(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });

const OPTIONS = {
  formats: [], // tous : 1D (Code 128, 39, 93, EAN, UPC, ITF, Codabar, DataBar) et 2D (QR, DataMatrix, Aztec, PDF417, MaxiCode)
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 40,
  // un symbole trouve mais pas decodable revient quand meme (isValid false) :
  // on le signale « illisible », sans valeur
  returnErrors: true,
  // la valeur brute (les separateurs GS/RS des codes 2D compris)
  textMode: "Plain",
};

function nomDuFormat(format) {
  try {
    return formatToLabel(format) || format;
  } catch {
    return format;
  }
}

parentPort.on("message", async ({ id, octets }) => {
  try {
    const resultats = await readBarcodes(octets, OPTIONS);
    parentPort.postMessage({
      id,
      resultats: resultats.map((r) => ({
        format: r.format,
        nomFormat: nomDuFormat(r.format),
        famille: MATRIX_BARCODE_FORMATS.includes(r.format) ? "2D" : "1D",
        valide: r.isValid,
        texte: r.isValid ? r.text : null,
        erreur: r.isValid ? null : r.error || "illisible",
        position: r.position,
        orientation: r.orientation,
        typeContenu: r.contentType,
      })),
    });
  } catch (err) {
    parentPort.postMessage({ id, erreur: err?.message || String(err) });
  }
});

parentPort.postMessage({ pret: true });
