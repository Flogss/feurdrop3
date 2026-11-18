// Verifier l'editeur de bordereaux dans l'app Mac, sans rien de reel : une
// base jetable, un faux Telegram qui sert deux etiquettes FACTICES (un PDF
// avec textes, logo, code-barres, code-barres tourne, QR code ; une PNG),
// des images a deposer (/tmp/drop-editeur/images), la vraie app sur le port 3001.
//
//   node scripts/demo-editeur.js
//   open -n <Drop.app de Debug> --args -drop.serveur http://localhost:3001 \
//     -DropJetonTest "$(cat /tmp/drop-editeur/jeton.txt)" \
//     -DropPageSite "/bordereaux/editeur?colis=1" [-DropScenario scenario.json]
//
// -DropScenario (Debug seulement, voir IOS/Drop/App/Mac/ScenarioPage.swift)
// joue des gestes dans la vraie fenetre et la photographie.
const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..");
const { environnementDeTest, MOT_DE_PASSE_TEST } = require(path.join(REPO, "test/aide"));
const { creeFauxTelegram } = require(path.join(REPO, "test/fixtures/faux-telegram"));

const dossier = environnementDeTest();
process.env.BORDEREAUX_DB_PATH = path.join(dossier, "bordereaux.db");
process.env.BORDEREAUX_INDEXATION = "0";

(async () => {
  const { PDFDocument, StandardFonts, rgb, degrees } = require(path.join(REPO, "node_modules/pdf-lib"));
  const { Resvg } = require(path.join(REPO, "node_modules/@resvg/resvg-js"));
  const { codePngDe } = await chargeZxing();
  const png = (svg, largeur) => new Resvg(svg, { fitTo: { mode: "width", value: largeur } }).render().asPng();

  const logo = png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" viewBox="0 0 300 120">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#ff5c8a"/></linearGradient></defs>
      <rect x="4" y="4" width="292" height="112" rx="24" fill="url(#g)"/>
      <circle cx="62" cy="60" r="34" fill="#fff" opacity=".9"/><text x="112" y="76" font-family="Helvetica" font-weight="700" font-size="44" fill="#fff">LOGO</text></svg>`,
    600
  );

  // une etiquette : textes, un logo (image), un code-barres, un code-barres
  // tourne de 90 degres, un QR code -- numeros inventes. Les variantes
  // (decalage, valeur changee, code retire ou ajoute) servent au comparateur.
  const imgLogoOctets = logo;
  async function fabrique({ nom = "Camille Fictive", ville = "3 avenue Imaginaire, 69000 Lyon", ref = "REF-DEMO-12345", lot = "LOT-778899", qrDx = 0, ajout = null } = {}) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([288, 432]);
    const police = await doc.embedFont(StandardFonts.Helvetica);
    const gras = await doc.embedFont(StandardFonts.HelveticaBold);
    page.drawText("EXPEDITEUR : Boutique Test", { x: 18, y: 404, size: 9, font: gras });
    page.drawText("12 rue de l'Exemple, 75000 Paris", { x: 18, y: 392, size: 8, font: police });
    page.drawText("DESTINATAIRE", { x: 18, y: 360, size: 9, font: gras });
    page.drawText(nom, { x: 18, y: 346, size: 12, font: gras });
    page.drawText(ville, { x: 18, y: 332, size: 9, font: police });
    page.drawImage(await doc.embedPng(imgLogoOctets), { x: 168, y: 340, width: 100, height: 40 });
    page.drawImage(await doc.embedPng(await codePngDe(ref, "Code128")), { x: 30, y: 230, width: 228, height: 70 });
    // tourne de 90 degres : il monte le long du bord gauche
    if (lot) page.drawImage(await doc.embedPng(await codePngDe(lot, "Code128")), { x: 58, y: 40, width: 150, height: 40, rotate: degrees(90) });
    page.drawImage(await doc.embedPng(await codePngDe("https://example.com/demo", "QRCode")), { x: 168 + qrDx, y: 60, width: 90, height: 90 });
    if (ajout) page.drawImage(await doc.embedPng(await codePngDe(ajout, "Code128")), { x: 80, y: 170, width: 120, height: 34 });
    page.drawRectangle({ x: 12, y: 12, width: 264, height: 408, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    return doc.save();
  }
  const etiquette = await fabrique();

  // une etiquette en image (PNG), pour le fond image
  const etiquettePng = png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><rect width="400" height="600" fill="#fff"/>
     <rect x="20" y="20" width="360" height="560" fill="none" stroke="#000" stroke-width="2"/>
     <text x="40" y="70" font-family="Helvetica" font-size="22" font-weight="700">ETIQUETTE IMAGE</text>
     <rect x="40" y="120" width="320" height="140" rx="16" fill="#2b6cff"/><text x="70" y="210" font-family="Helvetica" font-size="48" fill="#fff">PHOTO</text></svg>`,
    800
  );

  // des images a deposer depuis le Finder (ratios tres differents)
  const sortie = "/tmp/drop-editeur/images";
  fs.mkdirSync("/tmp/drop-editeur", { recursive: true });
  fs.mkdirSync(sortie, { recursive: true });
  const image = (nom, l, h, couleurs, texte) =>
    fs.writeFileSync(
      path.join(sortie, nom),
      png(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${l}" height="${h}" viewBox="0 0 ${l} ${h}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${couleurs[0]}"/><stop offset="1" stop-color="${couleurs[1]}"/></linearGradient></defs>
        <rect width="${l}" height="${h}" fill="url(#g)"/>
        <circle cx="${l / 2}" cy="${h / 2}" r="${Math.min(l, h) * 0.32}" fill="none" stroke="#fff" stroke-width="${Math.max(4, Math.min(l, h) * 0.04)}"/>
        <line x1="0" y1="0" x2="${l}" y2="${h}" stroke="#fff" stroke-width="3" opacity=".6"/><line x1="${l}" y1="0" x2="0" y2="${h}" stroke="#fff" stroke-width="3" opacity=".6"/>
        <text x="${l / 2}" y="${h / 2 + Math.min(l, h) * 0.06}" text-anchor="middle" font-family="Helvetica" font-weight="700" font-size="${Math.min(l, h) * 0.16}" fill="#fff">${texte}</text></svg>`,
        l
      )
    );
  image("grande-paysage-1600x900.png", 1600, 900, ["#1fb6ff", "#7c5cff"], "PAYSAGE");
  image("petite-portrait-200x400.png", 200, 400, ["#ff8a00", "#ff2d55"], "PORTRAIT");
  image("bandeau-2000x200.png", 2000, 200, ["#00c48c", "#0a84ff"], "BANDEAU TRES LARGE");
  image("carre-800x800.png", 800, 800, ["#ffd60a", "#ff375f"], "CARRE");

  const telegram = creeFauxTelegram();
  process.env.TELEGRAM_API_URL = await telegram.demarre();
  telegram.fichier("DEMO_PDF", etiquette);
  telegram.fichier("DEMO_PNG", etiquettePng);
  fs.writeFileSync("/tmp/drop-editeur/etiquette-demo.pdf", etiquette);

  const { ouvreBase, addColis } = require(path.join(REPO, "src/db"));
  ouvreBase();
  addColis("Boutique Test", { chatId: -1, messageId: 1, fileName: "demo-etiquette.pdf", fileId: "DEMO_PDF", fileKind: "document" });
  addColis("Boutique Test", { chatId: -1, messageId: 2, fileName: "demo-etiquette.png", fileId: "DEMO_PNG", fileKind: "photo" });
  // de quoi remplir la liste et comparer : des variantes, d'autres expediteurs et transporteurs
  const variantes = [
    ["Atelier Nord", "LP", { qrDx: 18, ref: "REF-DEMO-12399", lot: null, ajout: "NEW-0001" }],
    ["Atelier Nord", "LP", { nom: "Lou Exemple", qrDx: -10 }],
    ["Maison Sud", "UPS", { nom: "Sam Modele", ville: "8 rue Fictive, 13000 Marseille" }],
    ["Maison Sud", "UPS", { ref: "REF-MS-4410" }],
    ["Boutique Test", "DHL", { nom: "Alex Essai", lot: "LOT-000111" }],
    ["Studio Ouest", "MR", { ref: "REF-SO-77" }],
    ["Studio Ouest", "MR", { nom: "Dominique Test", qrDx: 6 }],
    ["Boutique Test", "LP", { ajout: "RETOUR-12" }],
    ["Maison Sud", "CHRONO", { nom: "Charlie Demo" }],
    ["Atelier Nord", "LP", { ville: "1 place du Test, 33000 Bordeaux" }],
    ["Boutique Test", "UPS", { ref: "REF-DEMO-20000" }],
    ["Studio Ouest", "DHL", { lot: null }],
  ];
  for (const [i, [expediteur, carrier, options]] of variantes.entries()) {
    telegram.fichier(`DEMO_V${i}`, await fabrique(options));
    addColis(expediteur, { chatId: -1, messageId: 10 + i, carrier, fileName: `demo-${i + 3}.pdf`, fileId: `DEMO_V${i}`, fileKind: "document" });
  }
  const base = require(path.join(REPO, "src/bordereaux/base"));
  const retours = base.creeCategorie("Retours", base.COULEURS[0]);
  const verifier = base.creeCategorie("À vérifier", base.COULEURS[3] || base.COULEURS[1]);
  for (const id of [3, 5, 9]) base.classe(id, (retours.categorie || retours).id);
  for (const id of [4, 11]) base.classe(id, (verifier.categorie || verifier).id);
  require(path.join(REPO, "src/bot")).startBot();
  const { creeApp } = require(path.join(REPO, "src/app"));
  const app = creeApp();
  await new Promise((r) => app.listen(3001, "127.0.0.1", r));
  const r = await fetch("http://127.0.0.1:3001/api/auth/connexion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motDePasse: MOT_DE_PASSE_TEST, mode: "app", appareil: "demo editeur" }),
  }).then((x) => x.json());
  fs.writeFileSync("/tmp/drop-editeur/jeton.txt", r.jeton);
  console.log(`PRET http://localhost:3001 (base ${dossier})`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function chargeZxing() {
  const req = require("module").createRequire(path.join(REPO, "package.json"));
  const z = await import(req.resolve("zxing-wasm/writer"));
  z.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(req.resolve("zxing-wasm/writer/zxing_writer.wasm")) }, fireImmediately: true });
  return {
    codePngDe: async (texte, format) => {
      const r = await z.writeBarcode(texte, { format, scale: 4, addQuietZones: false });
      if (r.error) throw new Error(r.error);
      return new Uint8Array(await r.image.arrayBuffer());
    },
  };
}
