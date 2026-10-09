// Le site servi : script et feuille de style assembles depuis leurs morceaux,
// en-tetes de securite, page sans script en ligne.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { environnementDeTest, demarreApp } = require("./aide");

environnementDeTest();
const { PAQUETS } = require("../src/assemblage");
let app;
before(async () => (app = await demarreApp()));
after(() => app.ferme());

test("/app.js et /styles.css : les morceaux bout a bout, dans l'ordre, revalides par ETag", async () => {
  for (const [nom, def] of Object.entries(PAQUETS)) {
    const attendu = def.morceaux.map((m) => fs.readFileSync(path.join(__dirname, "..", "public", m), "utf8")).join("");
    const r = await app.appel(`/${nom}`);
    assert.equal(r.status, 200);
    assert.equal(r.texte, attendu);
    assert.match(r.entetes.get("content-type"), nom.endsWith(".js") ? /javascript/ : /text\/css/);
    const encore = await app.appel(`/${nom}`, { entetes: { "If-None-Match": r.entetes.get("etag") } });
    assert.equal(encore.status, 304);
  }
  // chaque morceau du site est bien inscrit (un fichier oublie ne serait jamais charge)
  for (const dossier of ["js", "css"]) {
    const inscrits = Object.values(PAQUETS).flatMap((p) => p.morceaux).filter((m) => m.startsWith(`${dossier}/`));
    const presents = fs.readdirSync(path.join(__dirname, "..", "public", dossier)).map((f) => `${dossier}/${f}`);
    assert.deepEqual(presents.sort(), inscrits.sort());
  }
});

test("le script assemble se lit d'un bloc (pas d'erreur de syntaxe a la jointure)", async () => {
  const r = await app.appel("/app.js");
  const vm = require("vm");
  assert.doesNotThrow(() => new vm.Script(r.texte, { filename: "app.js" }));
});

test("en-tetes de securite : CSP sur la page, rien en ligne dans le HTML", async () => {
  const page = await app.appel("/");
  const csp = page.entetes.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/script-src[^;]*unsafe/.test(csp), "pas de script en ligne autorise");
  assert.equal(page.entetes.get("x-frame-options"), "DENY");
  assert.equal(page.entetes.get("x-content-type-options"), "nosniff");
  assert.equal(page.entetes.get("referrer-policy"), "same-origin");
  assert.equal(page.entetes.get("x-powered-by"), null);
  assert.ok(!/<script>(?!\s*<\/script>)/.test(page.texte), "aucun script en ligne dans index.html");
  assert.ok(!/\son[a-z]+="/.test(page.texte), "aucun gestionnaire d'evenement en ligne");

  const api = await app.appel("/api/config");
  assert.equal(api.entetes.get("x-content-type-options"), "nosniff");
  assert.equal(api.entetes.get("content-security-policy"), null, "pas de CSP sur le JSON ni les PDF");
});

test("jeton d'impression : l'en-tete, jamais l'adresse", async () => {
  const { getPrintToken } = require("../src/db");
  const jeton = getPrintToken();
  assert.equal((await app.appel(`/api/print/queue?token=${jeton}`)).status, 401);
  assert.equal((await app.appel("/api/print/queue", { entetes: { "X-Print-Token": jeton } })).status, 200);
  assert.equal((await app.appel("/api/print/queue", { entetes: { "X-Print-Token": "faux" } })).status, 401);
});
