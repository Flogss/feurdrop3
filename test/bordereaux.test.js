// Etude des bordereaux : tous les codes de chaque page (1D, QR, DataMatrix),
// a la bonne place (zoom ou rotation n'y changent rien : positions en 0..1
// de la page affichee), indexes une fois, retrouves par la recherche ; un
// code abime reste « illisible », sans valeur inventee ; le fichier
// d'origine n'est jamais modifie. Avec le vrai bot face a un faux Telegram.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { environnementDeTest, demarreApp, videBase } = require("./aide");
const { creeFauxTelegram } = require("./fixtures/faux-telegram");
const { etiquettePdf, codePng, zoneAttendue } = require("./fixtures/bordereaux");

environnementDeTest();
process.env.BORDEREAUX_INDEXATION = "0";
process.env.BORDEREAUX_PAUSE_MS = "10";
const faux = creeFauxTelegram();

let db;
let app;
let base;
let bordereaux;

// une etiquette : un numero (Code 128), un QR (adresse web), un DataMatrix
const PAGE_COMPLETE = {
  taille: [288, 432],
  codes: [
    { texte: "6A99887766554", format: "Code128", x: 20, y: 300, largeur: 230, hauteur: 70 },
    { texte: "https://suivi.exemple.test/colis?id=QX41", format: "QRCode", x: 24, y: 120, largeur: 110, hauteur: 110 },
    { texte: "ZZ00112233FR-TRI", format: "DataMatrix", x: 170, y: 130, largeur: 80, hauteur: 80 },
  ],
};

function colisAvecFichier(expediteur, fichier, octets, options = {}) {
  const fileId = `f-${crypto.randomUUID()}`;
  faux.fichier(fileId, octets);
  return db.addColis(expediteur, { fileId, fileKind: "pdf", carrier: "LP", fileName: fichier, ...options });
}

const telechargements = () => faux.appelsDe("getFile").length;

function procheDe(zone, attendue, marge = 0.02) {
  for (const k of ["x0", "y0", "x1", "y1"]) {
    assert.ok(Math.abs(zone[k] - attendue[k]) <= marge, `${k} : ${zone[k]} au lieu de ${attendue[k].toFixed(4)}`);
  }
}

before(async () => {
  process.env.TELEGRAM_API_URL = await faux.demarre();
  process.env.TELEGRAM_ALLOWED_USERS = "111";
  process.env.FILE_REPRISES_MS = "";
  db = require("../src/db");
  require("../src/bot").startBot();
  base = require("../src/bordereaux/base");
  bordereaux = require("../src/bordereaux");
  app = await demarreApp();
});
after(async () => {
  await app.ferme();
  // le bot interroge encore le faux Telegram : on ne l'attend pas
  faux.ferme();
});
beforeEach(() => {
  videBase();
  for (const t of ["codes", "colis_fichiers", "annotations", "fichiers"]) base.ouvre().exec(`DELETE FROM ${t}`);
});

test("tous les codes d'une page, a leur place, chacun avec son role", async () => {
  const pdf = await etiquettePdf([PAGE_COMPLETE]);
  const c = colisAvecFichier("Alice", "6A99887766554.pdf", pdf);

  const avant = await app.appel(`/api/bordereaux/${c.id}`);
  assert.equal(avant.status, 200);
  assert.equal(avant.json.analyse.etat, "attente");

  const r = await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: {} });
  assert.equal(r.status, 200, r.texte);
  const a = r.json.analyse;
  assert.equal(a.etat, "analyse");
  assert.equal(a.nombrePages, 1);
  const codes = a.pages[0].codes;
  assert.equal(codes.length, 3, JSON.stringify(codes.map((x) => x.valeur)));
  const par = Object.fromEntries(codes.map((x) => [x.format, x]));

  assert.equal(par.Code128.valeur, "6A99887766554");
  assert.equal(par.Code128.famille, "1D");
  assert.equal(par.Code128.role, "suivi");
  assert.equal(par.Code128.suivi.lien, "https://www.laposte.fr/outils/suivre-vos-envois?code=6A99887766554");
  assert.equal(par.QRCode.valeur, "https://suivi.exemple.test/colis?id=QX41");
  assert.equal(par.QRCode.role, "lien");
  assert.equal(par.QRCode.famille, "2D");
  assert.equal(par.DataMatrix.valeur, "ZZ00112233FR-TRI");
  assert.equal(par.DataMatrix.role, "autre", "un code qui n'est pas le numero n'est pas pris pour lui");

  // chaque zone tombe sur le code dessine (en 0..1 de la page affichee)
  for (const dessine of PAGE_COMPLETE.codes) {
    const lu = par[dessine.format];
    // le 1D : la largeur exacte ; la hauteur lue peut etre celle des barres
    procheDe(lu.zone, zoneAttendue(PAGE_COMPLETE, dessine), dessine.format === "Code128" ? 0.03 : 0.02);
  }
  // du haut vers le bas, dans l'ordre de lecture
  assert.deepEqual(codes.map((x) => x.format), ["Code128", "QRCode", "DataMatrix"]);
});

test("plusieurs pages, page tournee : chaque code sur sa page, a sa place affichee", async () => {
  const pages = [
    { taille: [288, 432], codes: [{ texte: "6A11111111111", format: "Code128", x: 30, y: 320, largeur: 220, hauteur: 60 }] },
    { taille: [288, 432], codes: [] },
    {
      taille: [288, 432],
      rotation: 90,
      codes: [
        { texte: "PAGE3-QR", format: "QRCode", x: 30, y: 40, largeur: 90, hauteur: 90 },
        { texte: "6A33333333333", format: "Code128", x: 20, y: 250, largeur: 240, hauteur: 60 },
      ],
    },
  ];
  const c = colisAvecFichier("Alice", "lot.pdf", await etiquettePdf(pages));
  const { json } = await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: {} });
  const a = json.analyse;
  assert.equal(a.nombrePages, 3);
  assert.deepEqual(a.pages.map((p) => p.codes.length), [1, 0, 2]);
  assert.equal(a.pages[0].codes[0].valeur, "6A11111111111");
  // la page tournee est plus large que haute, comme a l'ecran
  assert.ok(a.pages[2].largeur > a.pages[2].hauteur);
  const qr = a.pages[2].codes.find((x) => x.format === "QRCode");
  procheDe(qr.zone, zoneAttendue(pages[2], pages[2].codes[0]));
  const barre = a.pages[2].codes.find((x) => x.format === "Code128");
  assert.equal(barre.valeur, "6A33333333333");
  // sans numero dans le nom du fichier : la forme La Poste est reconnue,
  // mais seulement « probable »
  assert.equal(barre.role, "suivi-probable");
  assert.equal(barre.suivi.transporteur, "LP");
});

test("un code abime est « illisible », sans valeur ; un fichier qui n'est pas une etiquette est signale", async () => {
  const pdf = await etiquettePdf([
    {
      codes: [{ texte: "https://exemple.test/colis/ABC123456", format: "QRCode", options: { ecLevel: "L", scale: 6 }, x: 30, y: 250, largeur: 120, hauteur: 120 }],
      abime: [{ x: 30, y: 300, largeur: 120, hauteur: 22 }],
    },
  ]);
  const c = colisAvecFichier("Alice", "abime.pdf", pdf);
  const { json } = await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: {} });
  const codes = json.analyse.pages[0].codes;
  // le symbole est repere (sa zone se voit) mais pas dechiffre
  assert.equal(codes.length, 1);
  for (const code of codes) {
    assert.equal(code.lisible, false);
    assert.equal(code.valeur, null);
    assert.equal(code.role, "illisible");
    assert.match(code.erreur, /abîmé|illisible|indéchiffrable/);
  }
  assert.equal(json.analyse.illisibles, codes.length);

  const texte = colisAvecFichier("Alice", "pas-un-pdf.pdf", Buffer.from("bonjour, ceci n'est pas une etiquette"));
  const r = await app.appel(`/api/bordereaux/${texte.id}/analyse`, { methode: "POST", corps: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.analyse.etat, "erreur");
  assert.match(r.json.analyse.erreur, /ni un PDF ni une image/);
  assert.equal(r.json.analyse.pages.length, 0);
});

test("une photo d'etiquette (PNG) se lit aussi ; une etiquette protegee par mot de passe s'ouvre sans etre modifiee", async () => {
  const png = await codePng("6A44444444444", "Code128", { scale: 3 });
  const fileId = "photo-1";
  faux.fichier(fileId, png);
  const c = db.addColis("Alice", { fileId, fileKind: "image", carrier: "LP", fileName: "photo.png" });
  const { json } = await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: {} });
  assert.equal(json.analyse.type, "png");
  assert.equal(json.analyse.pages[0].codes[0].valeur, "6A44444444444");

  const protegee = fs.readFileSync(path.join(__dirname, "fixtures", "etiquette-protegee.pdf"));
  const p = colisAvecFichier("Alice", "protegee.pdf", protegee);
  const r = await app.appel(`/api/bordereaux/${p.id}/analyse`, { methode: "POST", corps: {} });
  assert.equal(r.json.analyse.etat, "analyse");
  const fichier = await fetch(`${app.base}/api/bordereaux/${p.id}/fichier`, { headers: { Authorization: `Bearer ${app.jeton}` } });
  assert.deepEqual(Buffer.from(await fichier.arrayBuffer()), protegee);
});

test("lu une seule fois : ni retelechargement, ni relecture ; un redrop partage l'analyse", async () => {
  const pdf = await etiquettePdf([PAGE_COMPLETE]);
  const c = colisAvecFichier("Alice", "6A99887766554.pdf", pdf);
  await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: {} });
  const apres = telechargements();
  const empreinte = base.lien(c.id).empreinte;
  const analyseLe = base.fichier(empreinte).analyse_le;

  await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: {} });
  // meme fichier, autre colis (un redrop reprend l'etiquette d'origine)
  const copie = db.addColis("Alice", { fileId: db.getColisById(c.id).file_id, fileKind: "pdf", carrier: "LP", fileName: "6A99887766554.pdf" });
  const r = await app.appel(`/api/bordereaux/${copie.id}/analyse`, { methode: "POST", corps: {} });
  assert.equal(r.json.analyse.pages[0].codes.length, 3);
  assert.equal(telechargements(), apres, "aucun nouveau telechargement");
  assert.equal(base.fichier(empreinte).analyse_le, analyseLe, "aucune relecture");
  assert.equal(base.lien(copie.id).empreinte, empreinte);

  // « Relire » force une nouvelle lecture
  const force = await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: { force: true } });
  assert.equal(force.status, 200);
  assert.equal(force.json.analyse.pages[0].codes.length, 3);
});

test("recherche : numero entier, debut, fin, faute de frappe ; le code, sa page et son etiquette", async () => {
  const pdf = await etiquettePdf([
    { codes: [] },
    { codes: [{ texte: "6A55512345678", format: "Code128", x: 30, y: 300, largeur: 220, hauteur: 60 }] },
  ]);
  const c = colisAvecFichier("Alice", "colis-alice.pdf", pdf, { carrier: "LP" });
  // une etiquette pas encore lue : son numero (nom du fichier) suffit
  const pasLue = colisAvecFichier("Bob", "6A55599999999.pdf", Buffer.from("%PDF-1.4 pas lu"));
  await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: {} });

  const exact = (await app.appel("/api/bordereaux/recherche?q=6A55512345678")).json;
  assert.equal(exact.resultats[0].id, c.id);
  const m = exact.resultats[0].correspondances[0];
  assert.equal(m.source, "code");
  assert.equal(m.page, 2, "la page du code");
  assert.equal(m.score, 100);
  assert.ok(Number.isInteger(m.codeId));

  const debut = (await app.appel("/api/bordereaux/recherche?q=6a555")).json;
  assert.deepEqual(debut.resultats.map((r) => r.id).sort(), [c.id, pasLue.id].sort(), "les deux commencent par 6A555");
  assert.equal(debut.resultats.find((r) => r.id === pasLue.id).correspondances[0].source, "suivi");

  const fin = (await app.appel("/api/bordereaux/recherche?q=45678")).json;
  assert.equal(fin.resultats[0].id, c.id);

  // un chiffre change
  const faute = (await app.appel("/api/bordereaux/recherche?q=6A55512345679")).json;
  assert.equal(faute.resultats[0].id, c.id);
  assert.equal(faute.resultats[0].correspondances[0].type, "proche");

  const rien = (await app.appel("/api/bordereaux/recherche?q=ZZZZZZZZZZ")).json;
  assert.equal(rien.resultats.length, 0);
  assert.equal((await app.appel("/api/bordereaux/recherche?q=6A")).json.resultats.length, 0, "trop court");
});

test("le fichier d'origine sort tel quel (ETag, telechargement) ; la note d'etude reste a part", async () => {
  const pdf = Buffer.from(await etiquettePdf([PAGE_COMPLETE]));
  const c = colisAvecFichier("Alice", "6A99887766554.pdf", pdf);
  const avecJeton = { Authorization: `Bearer ${app.jeton}` };

  const r = await fetch(`${app.base}/api/bordereaux/${c.id}/fichier`, { headers: avecJeton });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), /^inline; filename="6A99887766554\.pdf"/);
  const octets = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(octets, pdf);
  const etag = r.headers.get("etag");
  assert.equal(etag, `"${crypto.createHash("sha256").update(pdf).digest("hex")}"`);

  await app.appel(`/api/bordereaux/${c.id}/analyse`, { methode: "POST", corps: {} });
  const encore = await fetch(`${app.base}/api/bordereaux/${c.id}/fichier`, { headers: { ...avecJeton, "If-None-Match": etag } });
  assert.equal(encore.status, 304);
  const dl = await fetch(`${app.base}/api/bordereaux/${c.id}/fichier?telecharger=1`, { headers: avecJeton });
  assert.match(dl.headers.get("content-disposition"), /^attachment;/);

  const note = await app.appel(`/api/bordereaux/${c.id}/annotation`, { methode: "PUT", corps: { texte: "  coin abîmé, code relu à la main  " } });
  assert.equal(note.status, 200);
  assert.equal(note.json.annotation.texte, "coin abîmé, code relu à la main");
  const d = (await app.appel(`/api/bordereaux/${c.id}`)).json;
  assert.equal(d.annotation.texte, "coin abîmé, code relu à la main");
  // ni le colis (sa note du dashboard) ni le fichier ne bougent
  assert.equal(db.getColisById(c.id).note, null);
  const relu = Buffer.from(await (await fetch(`${app.base}/api/bordereaux/${c.id}/fichier`, { headers: avecJeton })).arrayBuffer());
  assert.deepEqual(relu, pdf);
  const vide = await app.appel(`/api/bordereaux/${c.id}/annotation`, { methode: "PUT", corps: { texte: "" } });
  assert.equal(vide.json.annotation, null);
});

test("liste, filtres, etat de l'index ; sans session : rien", async () => {
  const pdf = await etiquettePdf([PAGE_COMPLETE]);
  const a = colisAvecFichier("Alice", "6A99887766554.pdf", pdf);
  const b = colisAvecFichier("Bob", "autre.pdf", pdf);
  db.markPrinted([b.id], "test");
  db.addColis("Carla", { carrier: "LP" }); // sans fichier : pas d'etiquette
  await app.appel(`/api/bordereaux/${a.id}/analyse`, { methode: "POST", corps: {} });

  const tous = (await app.appel("/api/bordereaux")).json;
  assert.deepEqual(tous.bordereaux.map((x) => x.id), [b.id, a.id]);
  const lue = tous.bordereaux.find((x) => x.id === a.id);
  assert.deepEqual(lue.index, { etat: "analyse", pages: 1, lisibles: 3, illisibles: 0 });
  assert.equal(lue.suivi.numero, "6A99887766554");
  // b partage le meme fichier mais n'a pas encore ete rattache
  assert.equal(tous.bordereaux.find((x) => x.id === b.id).index.etat, "attente");

  assert.deepEqual((await app.appel("/api/bordereaux?filtre=imprimes")).json.bordereaux.map((x) => x.id), [b.id]);
  assert.deepEqual((await app.appel("/api/bordereaux?filtre=a_imprimer")).json.bordereaux.map((x) => x.id), [a.id]);
  assert.deepEqual((await app.appel("/api/bordereaux?q=bob")).json.bordereaux.map((x) => x.id), [b.id]);

  const etat = (await app.appel("/api/bordereaux/etat")).json;
  assert.equal(etat.etiquettes, 2);
  assert.equal(etat.analysees, 1);
  assert.equal(etat.codes, 3);

  for (const chemin of ["/api/bordereaux", `/api/bordereaux/${a.id}`, `/api/bordereaux/${a.id}/fichier`, "/api/bordereaux/recherche?q=6A99"]) {
    assert.equal((await app.appel(chemin, { anonyme: true })).status, 401, chemin);
  }
  assert.equal((await app.appel(`/api/bordereaux/${a.id}/analyse`, { methode: "POST", corps: {}, anonyme: true })).status, 401);
  assert.equal((await app.appel("/api/bordereaux/999999")).status, 404);
});

test("l'indexation en fond lit les etiquettes recentes, puis s'arrete", async () => {
  const pdf = await etiquettePdf([PAGE_COMPLETE]);
  const ids = [colisAvecFichier("Alice", "a.pdf", pdf).id, colisAvecFichier("Bob", "b.pdf", Buffer.from("rien")).id];
  process.env.BORDEREAUX_INDEXATION = "1";
  bordereaux.demarreIndexation({ delaiMs: 0 });
  try {
    const debut = Date.now();
    while (Date.now() - debut < 20000) {
      if (ids.every((id) => base.lien(id)?.empreinte)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    bordereaux.arreteIndexation();
    process.env.BORDEREAUX_INDEXATION = "0";
  }
  const etat = (await app.appel("/api/bordereaux/etat")).json;
  assert.equal(etat.analysees, 2);
  assert.equal(etat.codes, 3);
});

test("une page a part : /bordereaux (sa page, son script), derriere la session", async () => {
  const sans = await app.appel("/bordereaux", { anonyme: true });
  assert.equal(sans.status, 302);
  assert.match(sans.entetes.get("location"), /\/connexion/);
  const page = await app.appel("/bordereaux");
  assert.equal(page.status, 200);
  assert.match(page.texte, /<h1>Bordereaux<\/h1>/);
  assert.match(page.texte, /src="bordereaux\.js"/);
  assert.match(page.entetes.get("content-security-policy"), /script-src 'self'/);
  // le dashboard ne l'embarque plus : il l'ouvre a part
  const dashboard = await app.appel("/");
  assert.ok(!dashboard.texte.includes('id="view-bordereaux"'));
  assert.match(dashboard.texte, /href="\/bordereaux" target="_blank"/);
  const script = await app.appel("/bordereaux.js");
  assert.equal(script.status, 200);
  assert.match(script.texte, /function bdxOuvre/);
  assert.ok(!(await app.appel("/app.js")).texte.includes("function bdxOuvre"));
  // un fichier sans session : refuse (seules les pages renvoient a la connexion)
  assert.equal((await app.appel("/bordereaux.js", { anonyme: true })).status, 401);
});
