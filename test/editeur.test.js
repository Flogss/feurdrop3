// L'editeur de bordereaux : un document de travail a part, un NOUVEAU PDF a
// l'export -- l'etiquette d'origine ne bouge jamais. Les codes de l'etiquette
// gardent leur valeur ; un nouveau code ne porte ni numero de suivi ni
// donnees d'expedition (verifie par le serveur, jamais par la page).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { PDFDocument } = require("pdf-lib");
const { environnementDeTest, demarreApp, videBase } = require("./aide");
const { creeFauxTelegram } = require("./fixtures/faux-telegram");
const { etiquettePdf } = require("./fixtures/bordereaux");

environnementDeTest();
process.env.BORDEREAUX_INDEXATION = "0";
const faux = creeFauxTelegram();
let db;
let app;
let base;
let analyseFichier;

const PAGE = {
  taille: [288, 432],
  codes: [{ texte: "6A99887766554", format: "Code128", x: 20, y: 300, largeur: 230, hauteur: 70 }],
};

function colisAvecFichier(octets, options = {}) {
  const fileId = `f-${crypto.randomUUID()}`;
  faux.fichier(fileId, octets);
  return { colis: db.addColis("Alice", { fileId, fileKind: "pdf", carrier: "LP", fileName: "6A99887766554.pdf", ...options }), octets: Buffer.from(octets) };
}

async function exporte(id, modele) {
  const r = await fetch(`${app.base}/api/bordereaux/${id}/travail/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.jeton}` },
    body: JSON.stringify({ modele }),
  });
  return { status: r.status, entetes: r.headers, octets: Buffer.from(await r.arrayBuffer()) };
}

before(async () => {
  process.env.TELEGRAM_API_URL = await faux.demarre();
  process.env.TELEGRAM_ALLOWED_USERS = "111";
  db = require("../src/db");
  require("../src/bot").startBot();
  base = require("../src/bordereaux/base");
  ({ analyseFichier } = require("../src/bordereaux/analyse"));
  app = await demarreApp();
});
after(async () => {
  await app.ferme();
  faux.ferme();
});
beforeEach(() => {
  videBase();
  for (const t of ["codes", "colis_fichiers", "annotations", "fichiers", "travaux"]) base.ouvre().exec(`DELETE FROM ${t}`);
});

test("un code regenere : apercu vectoriel ; numero de suivi et donnees d'expedition refuses", async () => {
  const { colis } = colisAvecFichier(await etiquettePdf([PAGE]));
  const qr = await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "QRCode", valeur: "https://exemple.test/retour?id=42" } });
  assert.equal(qr.status, 200, qr.texte);
  assert.equal(qr.json.largeur, qr.json.hauteur);
  assert.match(qr.json.chemin, /^M\d+ \d+h\d+v\d+h-\d+z/);

  // la forme d'un numero de suivi La Poste, dans un code-barres : refuse
  const suivi = await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "Code128", valeur: "6A11122233344" } });
  assert.equal(suivi.status, 422);
  assert.equal(suivi.json.protege, true);
  assert.match(suivi.json.error, /numéro de suivi La Poste/);
  assert.equal(suivi.json.transporteur.code, "LP");
  // des donnees d'expedition (norme [)>) : refusees, meme en QR
  const donnees = await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "DataMatrix", valeur: "[)>\u001e01\u001d02" } });
  assert.equal(donnees.status, 422);
  // un numero de suivi nu dans un QR code : refuse aussi (depot en point relais par QR)
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "QRCode", valeur: "6A11122233344" } })).status, 422);
  // un lien de suivi dans un QR code : permis (la page de suivi du transporteur)
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "QRCode", valeur: "https://www.laposte.fr/outils/suivre-vos-envois?code=6A11122233344" } })).status, 200);
  // une reference interne : permise
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "Code128", valeur: "REF-INTERNE-7" } })).status, 200);
  // impossible dans ce format : dit clairement
  const ean = await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "EAN13", valeur: "abc" } });
  assert.equal(ean.status, 400);
  assert.match(ean.json.error, /impossible dans ce format/);
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "Inconnu", valeur: "x" } })).status, 400);
});

test("brouillon : garde, relu, efface ; un document invalide est refuse", async () => {
  const { colis } = colisAvecFichier(await etiquettePdf([PAGE]));
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`)).json.travail, null);
  const modele = { pages: [{ page: 1, elements: [{ id: "t1", type: "texte", x: 10, y: 10, l: 120, h: 20, texte: "FRAGILE", taille: 14, police: "Helvetica-Bold", couleur: "#d01010" }] }] };
  const garde = await app.appel(`/api/bordereaux/${colis.id}/travail`, { methode: "PUT", corps: { modele } });
  assert.equal(garde.status, 200);
  const relu = (await app.appel(`/api/bordereaux/${colis.id}/travail`)).json.travail;
  assert.equal(relu.modele.pages[0].elements[0].texte, "FRAGILE");
  assert.equal(relu.modele.pages[0].elements[0].police, "Helvetica-Bold");
  assert.ok(relu.modifieLe);

  for (const mauvais of [null, { pages: "x" }, { pages: [{ page: 1, elements: [{ id: "a", type: "script", x: 0, y: 0, l: 1, h: 1 }] }] }, { pages: [{ page: 1, elements: [{ id: "a", type: "rect", x: "0", y: 0, l: 1, h: 1 }] }] }]) {
    assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`, { methode: "PUT", corps: { modele: mauvais } })).status, 400);
  }
  const trop = { pages: [{ page: 1, elements: Array.from({ length: 401 }, (_, i) => ({ id: `r${i}`, type: "rect", x: 0, y: 0, l: 1, h: 1 })) }] };
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`, { methode: "PUT", corps: { modele: trop } })).status, 400);

  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`, { methode: "DELETE" })).json.efface, true);
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`)).json.travail, null);
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`, { anonyme: true })).status, 401);
});

test("export : un nouveau PDF (texte, QR, masque, code d'origine deplace), l'original intact", async () => {
  const { colis, octets } = colisAvecFichier(await etiquettePdf([PAGE]));
  await app.appel(`/api/bordereaux/${colis.id}/analyse`, { methode: "POST", corps: {} });
  const lu = (await app.appel(`/api/bordereaux/${colis.id}`)).json.analyse.pages[0].codes[0];
  assert.equal(lu.valeur, "6A99887766554");

  const modele = {
    pages: [
      {
        page: 1,
        elements: [
          { id: "fond", type: "rect", x: 150, y: 20, l: 120, h: 40, fond: "#ffeeee" },
          { id: "t1", type: "texte", x: 20, y: 20, l: 120, h: 24, texte: "RETOUR À L'ENVOYEUR", taille: 11, police: "Helvetica-Bold", couleur: "#000000" },
          { id: "qr", type: "code", format: "QRCode", valeur: "REF-INTERNE-42", x: 180, y: 180, l: 80, h: 80 },
          // le code d'origine, deplace (meme valeur) : masque a sa place, redessine plus bas
          { id: "orig", type: "code", origine: "original", modifie: true, codeId: lu.id, format: "Code128", valeur: lu.valeur, x: 20, y: 330, l: 230, h: 70, masque: { x: 18, y: 58, l: 236, h: 76 } },
        ],
      },
    ],
  };
  const r = await exporte(colis.id, modele);
  assert.equal(r.status, 200);
  assert.equal(r.entetes.get("content-type"), "application/pdf");
  assert.match(r.entetes.get("content-disposition"), /6A99887766554-modifie\.pdf/);

  const doc = await PDFDocument.load(r.octets);
  assert.equal(doc.getPageCount(), 1);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 288, height: 432 });
  assert.match(doc.getTitle(), /version modifiée/);
  assert.match(doc.getSubject(), /n'ont pas été modifiés/);
  const texte = execFileSync("pdftotext", ["-", "-"], { input: r.octets }).toString();
  assert.match(texte, /RETOUR À L'ENVOYEUR/);

  // relu par le meme lecteur : le QR ajoute, et le code d'origine a sa nouvelle place (une seule fois)
  const a = await analyseFichier(r.octets);
  const codes = a.pages[0].codes;
  const qr = codes.find((c) => c.format === "QRCode");
  assert.equal(qr.valeur, "REF-INTERNE-42");
  assert.ok(Math.abs(qr.x0 - 180 / 288) < 0.02 && Math.abs(qr.y0 - 180 / 432) < 0.02, `QR a sa place (${qr.x0}, ${qr.y0})`);
  const barres = codes.filter((c) => c.format === "Code128");
  assert.equal(barres.length, 1, "l'ancien emplacement est masque");
  assert.equal(barres[0].valeur, "6A99887766554");
  assert.ok(Math.abs(barres[0].y0 - 330 / 432) < 0.03, `code deplace (${barres[0].y0})`);

  // l'original, sur « Telegram », n'a pas bouge
  const original = Buffer.from(await (await fetch(`${app.base}/api/bordereaux/${colis.id}/fichier`, { headers: { Authorization: `Bearer ${app.jeton}` } })).arrayBuffer());
  assert.deepEqual(original, octets);
});

test("export : la valeur d'un code d'origine est protegee, un code ajoute au format d'un numero de suivi aussi", async () => {
  const { colis } = colisAvecFichier(await etiquettePdf([PAGE]));
  await app.appel(`/api/bordereaux/${colis.id}/analyse`, { methode: "POST", corps: {} });
  const lu = (await app.appel(`/api/bordereaux/${colis.id}`)).json.analyse.pages[0].codes[0];
  const change = { pages: [{ page: 1, elements: [{ id: "o", type: "code", origine: "original", modifie: true, codeId: lu.id, format: "Code128", valeur: "6A00000000000", x: 20, y: 60, l: 230, h: 70 }] }] };
  const r1 = await exporte(colis.id, change);
  assert.equal(r1.status, 422);
  assert.match(JSON.parse(r1.octets.toString()).error, /protégée/);
  const invente = { pages: [{ page: 1, elements: [{ id: "a", type: "code", format: "Code128", valeur: "6A55566677788", x: 20, y: 20, l: 200, h: 50 }] }] };
  assert.equal((await exporte(colis.id, invente)).status, 422);
  const faux = { pages: [{ page: 1, elements: [{ id: "o", type: "code", origine: "original", modifie: true, codeId: 999999, format: "Code128", valeur: "X", x: 0, y: 0, l: 10, h: 10 }] }] };
  assert.equal((await exporte(colis.id, faux)).status, 422);
});

test("export d'une page tournee : les ajouts tombent la ou on les a poses a l'ecran", async () => {
  const page = { taille: [288, 432], rotation: 90, codes: [{ texte: "PAGE-TOURNEE", format: "QRCode", x: 30, y: 40, largeur: 90, hauteur: 90 }] };
  const { colis } = colisAvecFichier(await etiquettePdf([page]));
  // page affichee : 432 x 288 (paysage) ; un QR ajoute en haut a droite
  const modele = { pages: [{ page: 1, elements: [{ id: "q", type: "code", format: "QRCode", valeur: "AJOUT-PAYSAGE", x: 320, y: 20, l: 80, h: 80 }] }] };
  const r = await exporte(colis.id, modele);
  assert.equal(r.status, 200);
  const doc = await PDFDocument.load(r.octets);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 432, height: 288 }, "la page sort droite, comme a l'ecran");
  const codes = (await analyseFichier(r.octets)).pages[0].codes;
  const ajout = codes.find((c) => c.valeur === "AJOUT-PAYSAGE");
  assert.ok(Math.abs(ajout.x0 - 320 / 432) < 0.02 && Math.abs(ajout.y0 - 20 / 288) < 0.02, `a sa place (${ajout.x0}, ${ajout.y0})`);
  assert.ok(codes.find((c) => c.valeur === "PAGE-TOURNEE"), "le contenu d'origine est la, tourne comme a l'ecran");
});

test("apercu du code de l'etiquette elle-meme (deplace) : permis s'il correspond a ce qui a ete lu", async () => {
  const { colis } = colisAvecFichier(await etiquettePdf([PAGE]));
  await app.appel(`/api/bordereaux/${colis.id}/analyse`, { methode: "POST", corps: {} });
  const lu = (await app.appel(`/api/bordereaux/${colis.id}`)).json.analyse.pages[0].codes[0];
  const ok = await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "Code128", valeur: lu.valeur, codeId: lu.id } });
  assert.equal(ok.status, 200);
  // le meme identifiant avec une autre valeur : refuse
  const autre = await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "Code128", valeur: "6A12312312312", codeId: lu.id } });
  assert.equal(autre.status, 422);
});

test("les pages de l'editeur et du comparateur : a part, derriere la session", async () => {
  for (const [chemin, script] of [["/bordereaux/editeur?colis=1", "editeur.js"], ["/bordereaux/comparer?a=1&b=2", "comparateur.js"]]) {
    const sans = await app.appel(chemin, { anonyme: true });
    assert.equal(sans.status, 302, chemin);
    const page = await app.appel(chemin);
    assert.equal(page.status, 200);
    assert.match(page.texte, new RegExp(`src="/${script.replace(".", "\\.")}"`));
    assert.match(page.entetes.get("content-security-policy"), /script-src 'self'/);
    const js = await app.appel(`/${script}`);
    assert.equal(js.status, 200);
    assert.equal((await app.appel(`/${script}`, { anonyme: true })).status, 401);
  }
});
