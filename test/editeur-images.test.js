// L'editeur de bordereaux, suite : ce qui se deplace reste EXACTEMENT ce
// qu'il etait (un extrait de la page d'origine, jamais regenere), et une
// image vit dans son cadre (remplie ou ajustee, jamais etiree, decalee,
// zoomee, tournee). Le PDF exporte est compare, point par point, aux memes
// calculs que l'ecran (public/js/bdx/05-geometrie.js).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { PDFDocument, degrees } = require("pdf-lib");
const { Resvg } = require("@resvg/resvg-js");
const { environnementDeTest, demarreApp, videBase } = require("./aide");
const { creeFauxTelegram } = require("./fixtures/faux-telegram");
const { etiquettePdf, codePng } = require("./fixtures/bordereaux");
const G = require("../public/js/bdx/05-geometrie.js");

environnementDeTest();
process.env.BORDEREAUX_INDEXATION = "0";
const faux = creeFauxTelegram();
let db;
let app;
let base;
let editeur;
let analyseFichier;

const PAGE = { taille: [288, 432], codes: [{ texte: "6A99887766554", format: "Code128", x: 20, y: 300, largeur: 230, hauteur: 70 }] };

// une image en quatre couleurs (haut-gauche rouge, haut-droit vert, bas-gauche bleu, bas-droit jaune)
const QUADRANTS = { rouge: [255, 0, 0], vert: [0, 200, 0], bleu: [0, 0, 255], jaune: [255, 220, 0] };
function quadrants(l, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${l}" height="${h}">
    <rect width="${l / 2}" height="${h / 2}" fill="rgb(255,0,0)"/><rect x="${l / 2}" width="${l / 2}" height="${h / 2}" fill="rgb(0,200,0)"/>
    <rect y="${h / 2}" width="${l / 2}" height="${h / 2}" fill="rgb(0,0,255)"/><rect x="${l / 2}" y="${h / 2}" width="${l / 2}" height="${h / 2}" fill="rgb(255,220,0)"/></svg>`;
  return new Resvg(svg).render().asPng();
}

function colisAvecFichier(octets) {
  const fileId = `f-${crypto.randomUUID()}`;
  faux.fichier(fileId, octets);
  return db.addColis("Alice", { fileId, fileKind: "pdf", carrier: "LP", fileName: "6A99887766554.pdf" });
}

async function exporte(id, modele) {
  const r = await fetch(`${app.base}/api/bordereaux/${id}/travail/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.jeton}` },
    body: JSON.stringify({ modele }),
  });
  return { status: r.status, octets: Buffer.from(await r.arrayBuffer()) };
}

async function envoieImage(id, octets, type = "image/png") {
  const r = await fetch(`${app.base}/api/bordereaux/${id}/images`, { method: "POST", headers: { "Content-Type": type, Authorization: `Bearer ${app.jeton}` }, body: octets });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Le rendu d'une page (poppler), en pixels : `k` pixels par point.
function rendu(pdf, k = 2) {
  const ppm = execFileSync("pdftoppm", ["-r", String(72 * k), "-f", "1", "-l", "1", "-singlefile", "-"], { input: pdf, maxBuffer: 64 * 1024 * 1024 });
  // en-tete P6 : largeur hauteur 255
  let i = 0;
  const champs = [];
  while (champs.length < 4) {
    while (/\s/.test(String.fromCharCode(ppm[i]))) i += 1;
    let mot = "";
    while (!/\s/.test(String.fromCharCode(ppm[i]))) mot += String.fromCharCode(ppm[i++]);
    champs.push(mot);
  }
  i += 1;
  const [, largeur, hauteur] = champs.map(Number);
  const pixels = ppm.subarray(i);
  return { largeur, hauteur, k, px: (x, y) => [0, 1, 2].map((c) => pixels[(Math.round(y) * largeur + Math.round(x)) * 3 + c]) };
}

const proche = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

before(async () => {
  process.env.TELEGRAM_API_URL = await faux.demarre();
  process.env.TELEGRAM_ALLOWED_USERS = "111";
  db = require("../src/db");
  require("../src/bot").startBot();
  base = require("../src/bordereaux/base");
  editeur = require("../src/bordereaux/editeur");
  ({ analyseFichier } = require("../src/bordereaux/analyse"));
  app = await demarreApp();
});
after(async () => {
  await app.ferme();
  faux.ferme();
});
beforeEach(() => {
  videBase();
  for (const t of ["codes", "colis_fichiers", "annotations", "fichiers", "travaux", "images_travail"]) base.ouvre().exec(`DELETE FROM ${t}`);
});

test("deplacer un code de l'etiquette : ses pixels exacts a la nouvelle place, l'ancienne masquee, rien de regenere", async () => {
  const pdf = await etiquettePdf([PAGE]);
  const colis = colisAvecFichier(pdf);
  await app.appel(`/api/bordereaux/${colis.id}/analyse`, { methode: "POST", corps: {} });
  const lu = (await app.appel(`/api/bordereaux/${colis.id}`)).json.analyse.pages[0].codes[0];
  const zone = { x: lu.zone.x0 * 288, y: lu.zone.y0 * 432, l: (lu.zone.x1 - lu.zone.x0) * 288, h: (lu.zone.y1 - lu.zone.y0) * 432 };
  const masque = { x: zone.x - 2, y: zone.y - 2, l: zone.l + 4, h: zone.h + 4 };
  const dy = 200;
  const e = { id: "o", type: "code", origine: "original", modifie: true, codeId: lu.id, format: lu.format, valeur: lu.valeur, x: zone.x, y: zone.y + dy, l: zone.l, h: zone.h, masque, source: masque, depart: { ...zone, rotation: 0 } };
  const r = await exporte(colis.id, { pages: [{ page: 1, elements: [e] }] });
  assert.equal(r.status, 200, r.octets.toString());

  // pixel pour pixel : la zone d'origine (rendu de l'original) = la zone deplacee (rendu de l'export)
  const avant = rendu(pdf);
  const apres = rendu(r.octets);
  let ecart = 0;
  let n = 0;
  let noirs = 0;
  for (let y = Math.ceil(zone.y * 2); y < Math.floor((zone.y + zone.h) * 2); y += 1) {
    for (let x = Math.ceil(zone.x * 2); x < Math.floor((zone.x + zone.l) * 2); x += 1) {
      const a = avant.px(x, y);
      const b = apres.px(x, y + dy * 2);
      ecart += Math.abs(a[0] - b[0]);
      n += 1;
      if (a[0] < 128) noirs += 1;
    }
  }
  assert.ok(noirs > n * 0.2, "la zone contient bien le code");
  assert.ok(ecart / n < 2, `memes pixels (ecart moyen ${(ecart / n).toFixed(2)})`);
  // l'ancienne place est blanche
  for (const [x, y] of [[zone.x + 10, zone.y + 10], [zone.x + zone.l / 2, zone.y + zone.h / 2]]) assert.ok(proche(apres.px(x * 2, y * 2), [255, 255, 255], 8), "ancienne place masquee");
  // relu par le lecteur : le meme code, une seule fois, a sa nouvelle place
  const codes = (await analyseFichier(r.octets)).pages[0].codes.filter((c) => c.format === "Code128");
  assert.equal(codes.length, 1);
  assert.equal(codes[0].valeur, "6A99887766554");
  assert.ok(Math.abs(codes[0].y0 - (zone.y + dy) / 432) < 0.02);
});

test("un extrait agrandi garde ses proportions : la matrice de l'ecran est celle de l'export", async () => {
  const pdf = await etiquettePdf([PAGE]);
  const colis = colisAvecFichier(pdf);
  await app.appel(`/api/bordereaux/${colis.id}/analyse`, { methode: "POST", corps: {} });
  const lu = (await app.appel(`/api/bordereaux/${colis.id}`)).json.analyse.pages[0].codes[0];
  const zone = { x: lu.zone.x0 * 288, y: lu.zone.y0 * 432, l: (lu.zone.x1 - lu.zone.x0) * 288, h: (lu.zone.y1 - lu.zone.y0) * 432 };
  // moitie de la taille, pose en haut a gauche
  const e = { id: "o", type: "code", origine: "original", modifie: true, codeId: lu.id, format: lu.format, valeur: lu.valeur, x: 30, y: 150, l: zone.l / 2, h: zone.h / 2, masque: zone, source: zone, depart: { ...zone, rotation: 0 } };
  const r = await exporte(colis.id, { pages: [{ page: 1, elements: [e] }] });
  assert.equal(r.status, 200);
  const codes = (await analyseFichier(r.octets)).pages[0].codes;
  const c = codes.find((x) => x.valeur === "6A99887766554");
  assert.ok(c, "toujours lisible a mi-taille");
  assert.ok(Math.abs(c.x0 * 288 - 30) < 3 && Math.abs(c.y0 * 432 - 150) < 3, `a sa place (${c.x0 * 288}, ${c.y0 * 432})`);
  const ratio = ((c.x1 - c.x0) * 288) / ((c.y1 - c.y0) * 432);
  assert.ok(Math.abs(ratio - zone.l / zone.h) < 0.1, `proportions gardees (${ratio} / ${zone.l / zone.h})`);
});

test("une image dans son cadre : remplie, ajustee, decalee, zoomee, tournee -- le PDF suit les calculs de l'ecran", async () => {
  const colis = colisAvecFichier(await etiquettePdf([{ taille: [288, 432], codes: [{ texte: "REF-1", format: "Code128", x: 20, y: 20, largeur: 120, hauteur: 30 }] }]));
  const png = quadrants(400, 200);
  const envoi = await envoieImage(colis.id, png);
  assert.equal(envoi.status, 201, JSON.stringify(envoi.json));
  assert.deepEqual([envoi.json.l, envoi.json.h], [400, 200]);
  const image = { ref: envoi.json.ref, l: 400, h: 200 };

  const cas = [
    { x: 40, y: 40, l: 120, h: 120, rotation: 0, cadrage: { mode: "remplir" } },
    { x: 40, y: 40, l: 160, h: 120, rotation: 0, cadrage: { mode: "ajuster" } },
    { x: 40, y: 40, l: 120, h: 120, rotation: 0, cadrage: { mode: "remplir", zoom: 2, dx: 0.3, dy: -0.2 } },
    { x: 60, y: 60, l: 140, h: 100, rotation: 90, cadrage: { mode: "remplir", dx: 0.1 } },
    { x: 60, y: 80, l: 150, h: 90, rotation: 30, cadrage: { mode: "remplir", zoom: 1.5 } },
  ];
  for (const c of cas) {
    const e = { id: "img", type: "image", origine: "ajout", image, ...c };
    const r = await exporte(colis.id, { pages: [{ page: 1, elements: [e] }] });
    assert.equal(r.status, 200, r.octets.toString());
    const p = rendu(r.octets);
    const propre = editeur.valideModele({ pages: [{ page: 1, elements: [e] }] }).pages[0].elements[0];
    const contenu = G.contenuImage(propre.l, propre.h, 400, 200, propre.cadrage);
    const m = G.matriceCadre(propre);
    let verifies = 0;
    // des points du cadre (loin des bords des quadrants) : la couleur attendue par le calcul de l'ecran
    for (let u = 0.08; u < 1; u += 0.12) {
      for (let v = 0.08; v < 1; v += 0.12) {
        const lx = u * propre.l;
        const ly = v * propre.h;
        const ix = ((lx - contenu.x) / contenu.l) * 400;
        const iy = ((ly - contenu.y) / contenu.h) * 200;
        const loin = Math.min(Math.abs(ix - 200), Math.abs(iy - 100), ix, 400 - ix, iy, 200 - iy) > 12;
        if (!loin) continue;
        const dedans = ix > 0 && ix < 400 && iy > 0 && iy < 200;
        const attendu = !dedans ? [255, 255, 255] : QUADRANTS[iy < 100 ? (ix < 200 ? "rouge" : "vert") : ix < 200 ? "bleu" : "jaune"];
        const pt = G.applique(m, lx, ly);
        const vu = p.px(pt.x * 2, pt.y * 2);
        assert.ok(proche(vu, attendu), `${JSON.stringify(c)} : (${u.toFixed(2)}, ${v.toFixed(2)}) attendu ${attendu}, vu ${vu}`);
        verifies += 1;
      }
    }
    assert.ok(verifies > 10, `assez de points verifies (${verifies})`);
    // jamais au-dela du cadre : juste dehors, la page reste blanche
    const dehors = G.applique(m, -6, propre.h / 2);
    assert.ok(proche(p.px(dehors.x * 2, dehors.y * 2), [255, 255, 255], 10), `${JSON.stringify(c)} : coupe au bord du cadre`);
  }
});

test("remplacer une image de l'etiquette : le cadre (position, taille, rotation) reste, le contenu change, le masque cache l'ancienne", async () => {
  // une etiquette avec un logo tourne de 90 degres
  const doc = await PDFDocument.create();
  const page = doc.addPage([288, 432]);
  const logo = await doc.embedPng(quadrants(200, 100));
  page.drawImage(logo, { x: 150, y: 250, width: 100, height: 50, rotate: degrees(90) });
  const pdf = await doc.save();
  const colis = colisAvecFichier(pdf);
  // le cadre du logo a l'ecran (y vers le bas) : tourne de -90 (sens inverse des aiguilles)
  // ses coins : (150,250) (150,350) (100,350) (100,250) en PDF -> boite x 100..150, y 82..182
  const cadre = { x: 75, y: 107, l: 100, h: 50, rotation: -90 };
  assert.deepEqual(G.boite(cadre), { x: 100, y: 82, l: 50, h: 100 });
  const nouvelle = quadrants(300, 300);
  const envoi = await envoieImage(colis.id, nouvelle);
  const e = { id: "logo", type: "image", origine: "original", modifie: true, cle: "i3", ...cadre, image: { ref: envoi.json.ref, l: 300, h: 300 }, cadrage: { mode: "remplir" }, masque: { x: 99.5, y: 81.5, l: 51, h: 101 }, source: { x: 99.5, y: 81.5, l: 51, h: 101 }, depart: { ...cadre } };
  const r = await exporte(colis.id, { pages: [{ page: 1, elements: [e] }] });
  assert.equal(r.status, 200, r.octets.toString());
  const p = rendu(r.octets);
  const m = G.matriceCadre(editeur.valideModele({ pages: [{ page: 1, elements: [e] }] }).pages[0].elements[0]);
  // le contenu carre remplit le cadre 100 x 50 : la bande du milieu (rouge/vert en haut, bleu/jaune en bas)
  for (const [u, v, couleur] of [[20, 12, "rouge"], [80, 12, "vert"], [20, 38, "bleu"], [80, 38, "jaune"]]) {
    const pt = G.applique(m, u, v);
    assert.ok(proche(p.px(pt.x * 2, pt.y * 2), QUADRANTS[couleur]), `${couleur} a (${u}, ${v}) du cadre, tourne comme l'ancien logo`);
  }
});

test("les images deposees : PNG/JPEG verifies, gardes a leur empreinte, relus ; les autres formats a redessiner", async () => {
  const colis = colisAvecFichier(await etiquettePdf([PAGE]));
  const png = quadrants(64, 32);
  const r = await envoieImage(colis.id, png);
  assert.equal(r.status, 201);
  assert.equal(r.json.ref, crypto.createHash("sha256").update(png).digest("hex"));
  const relu = await fetch(`${app.base}/api/bordereaux/${colis.id}/images/${r.json.ref}`, { headers: { Authorization: `Bearer ${app.jeton}` } });
  assert.equal(relu.status, 200);
  assert.equal(relu.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await relu.arrayBuffer()), Buffer.from(png));
  // sans session : rien
  assert.equal((await fetch(`${app.base}/api/bordereaux/${colis.id}/images`, { method: "POST", headers: { "Content-Type": "image/png" }, body: png })).status, 401);
  assert.equal((await fetch(`${app.base}/api/bordereaux/${colis.id}/images/${r.json.ref}`)).status, 401);
  // pas une image PNG/JPEG : la page la redessine (reencoder)
  const gif = await envoieImage(colis.id, Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"), "image/png");
  assert.equal(gif.status, 415);
  assert.equal(gif.json.reencoder, true);
  // une empreinte inconnue
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/images/${"0".repeat(64)}`)).status, 404);
  // une photo tournee par EXIF (orientation 6) : redressee par la page avant l'envoi
  const exif = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22]),
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.equal(editeur.orientationJpeg(new Uint8Array(exif)), 6);
  assert.equal(editeur.orientationJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), 1);
});

test("une image deposee qui porte un numero de suivi ou des donnees d'expedition est refusee", async () => {
  const colis = colisAvecFichier(await etiquettePdf([PAGE]));
  const suivi = await envoieImage(colis.id, await codePng("6A11122233344", "QRCode"));
  assert.equal(suivi.status, 422);
  assert.equal(suivi.json.protege, true);
  assert.match(suivi.json.error, /numéro de suivi La Poste/);
  const donnees = await envoieImage(colis.id, await codePng("[)>\u001e01\u001d02TEST", "DataMatrix"));
  assert.equal(donnees.status, 422);
  // un lien (la page de suivi) dans un QR code : permis
  assert.equal((await envoieImage(colis.id, await codePng("https://exemple.test/retour", "QRCode"))).status, 201);
});

test("le document : une image sans contenu, une image de l'etiquette sans zone, une image inconnue -- refuses", async () => {
  const colis = colisAvecFichier(await etiquettePdf([PAGE]));
  const vide = { pages: [{ page: 1, elements: [{ id: "a", type: "image", origine: "ajout", x: 0, y: 0, l: 10, h: 10, image: null }] }] };
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`, { methode: "PUT", corps: { modele: vide } })).status, 400);
  const sansZone = { pages: [{ page: 1, elements: [{ id: "a", type: "image", origine: "original", cle: "i1", x: 0, y: 0, l: 10, h: 10, image: null }] }] };
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`, { methode: "PUT", corps: { modele: sansZone } })).status, 400);
  const mauvaiseRef = { pages: [{ page: 1, elements: [{ id: "a", type: "image", origine: "ajout", x: 0, y: 0, l: 10, h: 10, image: { ref: "../etc", l: 1, h: 1 } }] }] };
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`, { methode: "PUT", corps: { modele: mauvaiseRef } })).status, 400);
  const inconnue = { pages: [{ page: 1, elements: [{ id: "a", type: "image", origine: "ajout", x: 0, y: 0, l: 10, h: 10, image: { ref: "f".repeat(64), l: 1, h: 1 } }] }] };
  const r = await exporte(colis.id, inconnue);
  assert.equal(r.status, 422);
  assert.match(JSON.parse(r.octets.toString()).error, /introuvable/);
  // une image correcte se garde et se relit telle quelle (rotation et cadrage normalises)
  const ok = { pages: [{ page: 1, elements: [{ id: "a", type: "image", origine: "ajout", x: 0, y: 0, l: 10, h: 10, rotation: 450, image: { ref: "f".repeat(64), l: 4, h: 3 }, cadrage: { mode: "ajuster", zoom: 99, dx: 9 } }] }] };
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/travail`, { methode: "PUT", corps: { modele: ok } })).status, 200);
  const e = (await app.appel(`/api/bordereaux/${colis.id}/travail`)).json.travail.modele.pages[0].elements[0];
  assert.equal(e.rotation, 90);
  assert.deepEqual(e.cadrage, { mode: "ajuster", zoom: G.ZOOM_MAX, dx: 5, dy: 0 });
});

test("la geometrie commune : cadrage borne, coins, extrait identique a l'origine", () => {
  // remplir : le contenu couvre le cadre, sans etirement
  const c = G.contenuImage(100, 50, 300, 300, { mode: "remplir" });
  assert.deepEqual(c, { x: 0, y: -25, l: 100, h: 100 });
  // ajuster : l'image entiere, centree
  assert.deepEqual(G.contenuImage(100, 50, 300, 300, { mode: "ajuster" }), { x: 25, y: 0, l: 50, h: 50 });
  // le decalage ne decouvre jamais un bord couvert
  assert.deepEqual(G.bornePosition(100, 50, 300, 300, { mode: "remplir", dx: 1, dy: 1 }), { mode: "remplir", zoom: 1, dx: 0, dy: 0.5 });
  // un extrait a sa place d'origine : la matrice ne change rien
  const z = { x: 10, y: 20, l: 30, h: 40, rotation: 0 };
  const m = G.compose(G.matriceCadre(z), G.matriceExtrait(z, z));
  assert.deepEqual(m.map((v) => Math.round(v * 1e9) / 1e9), [1, 0, 0, 1, 0, 0]);
  // deplace : une translation pure
  const d = G.compose(G.matriceCadre({ ...z, x: 60, y: 5 }), G.matriceExtrait(z, { ...z, x: 60, y: 5 }));
  assert.deepEqual(d.map((v) => Math.round(v * 1e9) / 1e9), [1, 0, 0, 1, 50, -15]);
  assert.equal(G.angle(450), 90);
  assert.equal(G.angle(-270), 90);
});

test("les codes de l'etiquette : le numero de suivi reste verrouille, une reference se reecrit (orientation gardee)", async () => {
  // une etiquette : le numero de suivi La Poste, une reference de commande
  // tournee de 90 degres, et un lien de boutique
  const page = {
    taille: [288, 432],
    codes: [
      { texte: "6A99887766554", format: "Code128", x: 20, y: 330, largeur: 230, hauteur: 70 },
      { texte: "CMD-2026-0042", format: "Code128", x: 20, y: 60, largeur: 180, hauteur: 50 },
      { texte: "https://boutique.test/commande/42", format: "QRCode", x: 200, y: 180, largeur: 70, hauteur: 70 },
    ],
  };
  const pdf = await etiquettePdf([page]);
  const colis = colisAvecFichier(pdf);
  await app.appel(`/api/bordereaux/${colis.id}/analyse`, { methode: "POST", corps: {} });
  const codes = (await app.appel(`/api/bordereaux/${colis.id}`)).json.analyse.pages[0].codes;
  const suivi = codes.find((c) => c.valeur === "6A99887766554");
  const ref = codes.find((c) => c.valeur === "CMD-2026-0042");
  const lien = codes.find((c) => c.format === "QRCode");
  assert.equal(suivi.modifiable, false, "le numero de suivi : verrouille");
  assert.equal(ref.modifiable, true, "une reference de commande : modifiable");
  assert.equal(lien.modifiable, true, "le lien d'une boutique : modifiable");

  const zone = (c) => ({ x: c.zone.x0 * 288, y: c.zone.y0 * 432, l: (c.zone.x1 - c.zone.x0) * 288, h: (c.zone.y1 - c.zone.y0) * 432 });
  const element = (c, valeur, extra = {}) => {
    const z = zone(c);
    const masque = { x: z.x - 2, y: z.y - 2, l: z.l + 4, h: z.h + 4 };
    return { id: `c${c.id}`, type: "code", origine: "original", modifie: true, reecrit: true, codeId: c.id, format: c.format, valeur, ...z, masque, source: masque, depart: { ...z, rotation: 0 }, ...extra };
  };

  // le numero de suivi : ni en apercu, ni a l'export, meme vers une valeur anodine
  const apercu = await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "Code128", valeur: "AUTRE-CHOSE", codeId: suivi.id } });
  assert.equal(apercu.status, 422);
  const r1 = await exporte(colis.id, { pages: [{ page: 1, elements: [element(suivi, "AUTRE-CHOSE")] }] });
  assert.equal(r1.status, 422);
  assert.match(JSON.parse(r1.octets.toString()).error, /protégée/);
  // ... ni « reecrit » vers sa propre valeur pour contourner le controle
  assert.equal((await exporte(colis.id, { pages: [{ page: 1, elements: [element(suivi, suivi.valeur)] }] })).status, 422);

  // une reference : vers un numero de suivi, refuse ; vers une autre reference, permis
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "Code128", valeur: "6A11122233344", codeId: ref.id } })).status, 422);
  assert.equal((await exporte(colis.id, { pages: [{ page: 1, elements: [element(ref, "6A11122233344")] }] })).status, 422);
  assert.equal((await app.appel(`/api/bordereaux/${colis.id}/code`, { methode: "POST", corps: { format: "Code128", valeur: "CMD-2026-0099", codeId: ref.id } })).status, 200);
  const r2 = await exporte(colis.id, { pages: [{ page: 1, elements: [element(ref, "CMD-2026-0099"), element(lien, "https://boutique.test/commande/99")] }] });
  assert.equal(r2.status, 200, r2.octets.toString());
  const relus = (await analyseFichier(r2.octets)).pages[0].codes;
  const valeurs = relus.map((c) => c.valeur);
  assert.ok(valeurs.includes("CMD-2026-0099"), "la nouvelle reference");
  assert.ok(!valeurs.includes("CMD-2026-0042"), "l'ancienne est masquee");
  assert.ok(valeurs.includes("https://boutique.test/commande/99"));
  assert.ok(valeurs.includes("6A99887766554"), "le numero de suivi n'a pas bouge");
  // a la meme place, dans le meme sens
  const nouvelle = relus.find((c) => c.valeur === "CMD-2026-0099");
  assert.ok(Math.abs(nouvelle.x0 - ref.zone.x0) < 0.03 && Math.abs(nouvelle.y0 - ref.zone.y0) < 0.03, "a la place de l'ancienne");
  assert.equal(Math.round(nouvelle.orientation / 90), Math.round(ref.orientation / 90), "meme orientation");
});

test("un code tourne de l'etiquette, reecrit : il reste tourne", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([288, 432]);
  const png = await doc.embedPng(await codePng("LOT-778899", "Code128"));
  p.drawImage(png, { x: 60, y: 60, width: 150, height: 40, rotate: degrees(90) });
  const pdf = await doc.save();
  const colis = colisAvecFichier(pdf);
  await app.appel(`/api/bordereaux/${colis.id}/analyse`, { methode: "POST", corps: {} });
  const lu = (await app.appel(`/api/bordereaux/${colis.id}`)).json.analyse.pages[0].codes[0];
  assert.equal(lu.modifiable, true);
  assert.equal(Math.abs(Math.round(lu.orientation)), 90, "lu vertical");
  const z = { x: lu.zone.x0 * 288, y: lu.zone.y0 * 432, l: (lu.zone.x1 - lu.zone.x0) * 288, h: (lu.zone.y1 - lu.zone.y0) * 432 };
  assert.ok(z.h > z.l * 2, "zone verticale");
  const masque = { x: z.x - 2, y: z.y - 2, l: z.l + 4, h: z.h + 4 };
  const e = { id: "t", type: "code", origine: "original", modifie: true, reecrit: true, codeId: lu.id, format: "Code128", valeur: "LOT-112233", ...z, masque, source: masque, depart: { ...z, rotation: 0 } };
  const r = await exporte(colis.id, { pages: [{ page: 1, elements: [e] }] });
  assert.equal(r.status, 200, r.octets.toString());
  const c = (await analyseFichier(r.octets)).pages[0].codes.find((x) => x.valeur === "LOT-112233");
  assert.ok(c, "lisible");
  assert.equal(Math.abs(Math.round(c.orientation)), 90, "toujours vertical");
  assert.ok((c.y1 - c.y0) * 432 > (c.x1 - c.x0) * 288 * 2, "dans sa zone verticale, pas ecrase");
});

test("les images que plus aucun brouillon ne cite s'effacent apres le delai ; les autres restent", () => {
  const bdx = require("../src/bordereaux/base");
  const b = bdx.ouvre();
  b.exec("DELETE FROM travaux; DELETE FROM images_travail");
  const img = (c, quand) =>
    b.prepare("INSERT INTO images_travail (empreinte, type, largeur, hauteur, octets, colis_id, cree_le) VALUES (?, 'png', 1, 1, ?, 1, ?)").run(c.repeat(64), new Uint8Array([1]), quand);
  img("a", "2026-01-01T00:00:00.000Z"); // vieille, citee par un brouillon
  img("b", "2026-01-01T00:00:00.000Z"); // vieille, citee par plus rien : effacee
  img("c", "2026-11-17T00:00:00.000Z"); // recente, pas encore citee : gardee
  img("d", "2026-01-01T00:00:00.000Z"); // vieille, citee par le brouillon d'un AUTRE colis (meme empreinte)
  bdx.gardeTravail(1, { pages: [{ page: 1, elements: [{ type: "image", image: { ref: "a".repeat(64) } }] }] });
  bdx.gardeTravail(2, { pages: [{ page: 1, elements: [{ type: "image", image: { ref: "d".repeat(64) } }] }] });
  assert.equal(bdx.purgeImages({ avant: "2026-10-19T00:00:00.000Z" }), 1);
  const restent = b.prepare("SELECT substr(empreinte, 1, 1) AS e FROM images_travail ORDER BY e").all().map((r) => r.e);
  assert.deepEqual(restent, ["a", "c", "d"]);
  // « Repartir de l'original » : l'image n'est plus citee, effacee au passage suivant
  bdx.effaceTravail(1);
  assert.equal(bdx.purgeImages({ avant: "2026-10-19T00:00:00.000Z" }), 1);
  assert.equal(bdx.imageTravail("a".repeat(64)), null);
  b.exec("DELETE FROM travaux; DELETE FROM images_travail");
});

test("une image de plus de 16 Mpx est refusee avant d'etre decompressee : la page la redessine plus petite", async () => {
  const colis = colisAvecFichier(await etiquettePdf([PAGE]));
  // l'en-tete d'un PNG de 5000 x 4000 (20 Mpx) : refuse sur ses dimensions,
  // sans rien decoder (un PNG uni de quelques Ko suffirait a remplir la memoire)
  const entete = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(entete, 0);
  entete.writeUInt32BE(13, 8);
  entete.write("IHDR", 12, "latin1");
  entete.writeUInt32BE(5000, 16);
  entete.writeUInt32BE(4000, 20);
  entete[24] = 8;
  entete[25] = 6;
  const r = await envoieImage(colis.id, entete);
  assert.equal(r.status, 413);
  assert.equal(r.json.reencoder, true);
  assert.match(r.json.error, /16 mégapixels/);
  assert.equal(editeur.IMAGE_MAX_PIXELS, 16e6);
});

test("une erreur imprevue de l'editeur : « Erreur interne », le detail reste dans les journaux", async () => {
  const colis = colisAvecFichier(await etiquettePdf([PAGE]));
  const vrai = editeur.exporte;
  const journal = console.error;
  const lignes = [];
  editeur.exporte = async () => {
    throw new Error("SQLITE_IOERR: /data/bordereaux.db");
  };
  console.error = (...a) => lignes.push(a.map(String).join(" "));
  try {
    const r = await fetch(`${app.base}/api/bordereaux/${colis.id}/travail/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.jeton}` },
      body: JSON.stringify({ modele: { pages: [] } }),
    });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "Erreur interne" });
    assert.ok(lignes.some((l) => l.includes("SQLITE_IOERR")), "le detail est journalise");
  } finally {
    editeur.exporte = vrai;
    console.error = journal;
  }
});
