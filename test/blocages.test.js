// Aucune operation ne doit laisser l'app sur un chargement sans fin : le
// serveur repond toujours, vite, et une operation renvoyee apres une coupure
// (la reponse perdue en route, devant un locker sans reseau) n'est jamais
// appliquee deux fois.
//
// Le bug d'origine (mode locker, iPhone) : apres « Déposé », le code suivant
// tournait indefiniment -- son image n'arrivait pas (Telegram en erreur ou
// muet) et l'app avalait l'erreur sans rien proposer ; a la reouverture,
// meme paire, meme echec, meme roue.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase, demarreApp } = require("./aide");

environnementDeTest();
const db = require("../src/db");
const sp = require("../src/specials");
let app;

before(async () => (app = await demarreApp()));
after(() => app.ferme());
beforeEach(() => videBase());

function paireSpeciale(n) {
  const c = db.addColis("Alice", { fileId: `F-sp-${n}`, fileKind: "pdf", type: "special", carrier: "LP", fileName: `6A1234567890${n}.pdf` });
  sp.apparieColis(c.id, "Alice");
  sp.apparieCode(`CODE-${n}`, "Alice", "image");
  return c.id;
}

test("locker : le code d'une paire repond tout de suite meme sans Telegram (erreur claire, jamais une attente)", async () => {
  paireSpeciale(1);
  const { paires } = (await app.appel("/api/special/paires")).json;
  const debut = Date.now();
  const r = await app.appel(`/api/special/code/${paires[0].id}`);
  assert.equal(r.status, 503);
  assert.match(r.json.error, /bot/);
  assert.ok(Date.now() - debut < 2000, "une erreur, tout de suite");
  // un code inconnu : 404, tout de suite aussi
  assert.equal((await app.appel("/api/special/code/999999")).status, 404);
});

test("drop renvoye apres une coupure : applique une seule fois (meme cle, ou cle neuve)", async () => {
  db.setSetting("stock", 10);
  const id = paireSpeciale(1);
  const cle = { "Idempotency-Key": "drop-essai-1" };
  const premier = await app.appel(`/api/print/colis/${id}/drop`, { methode: "POST", corps: {}, entetes: cle });
  assert.equal(premier.status, 200);
  assert.equal(db.getStock("normal"), 9);
  // la meme operation renvoyee (reponse perdue) : la reponse d'origine est rejouee
  const rejoue = await app.appel(`/api/print/colis/${id}/drop`, { methode: "POST", corps: {}, entetes: cle });
  assert.equal(rejoue.status, 200);
  assert.equal(rejoue.entetes.get("idempotent-replay"), "true");
  // un nouvel appui (nouvelle cle) sur un colis deja drope : « deja fait », rien de refait
  const encore = await app.appel(`/api/print/colis/${id}/drop`, { methode: "POST", corps: {} });
  assert.equal(encore.status, 200);
  assert.equal(encore.json.deja, true);
  assert.equal(db.getStock("normal"), 9, "une seule pochette consommee");
  const drops = db.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'drop'").get().n;
  assert.equal(drops, 1, "un seul drop au journal");
  // la paire a quitte la liste du locker
  assert.deepEqual((await app.appel("/api/special/paires")).json.paires, []);
  // un colis qui n'existe pas : toujours une vraie erreur
  assert.equal((await app.appel("/api/print/colis/999999/drop", { methode: "POST", corps: {} })).status, 404);
});

test("« Fait » sur un code seul renvoye apres une coupure : rejoue, pas d'erreur", async () => {
  const { paire } = sp.apparieCode("CODE-SEUL", "Alice", "image");
  sp.rendSeul({ paireId: paire.id, role: "code" });
  const cle = { "Idempotency-Key": "fini-essai-1" };
  const premier = await app.appel(`/api/special/paires/${paire.id}/fini`, { methode: "POST", corps: {}, entetes: cle });
  assert.equal(premier.status, 200);
  const rejoue = await app.appel(`/api/special/paires/${paire.id}/fini`, { methode: "POST", corps: {}, entetes: cle });
  assert.equal(rejoue.status, 200);
  assert.equal(rejoue.entetes.get("idempotent-replay"), "true");
});

test("B09 : un ajout de colis renvoye APRES un redemarrage du serveur n'est pas applique deux fois", async () => {
  db.addColis("Alice", { fileId: "f-b09", fileKind: "pdf" });
  const avant = db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n;
  const cle = { "Idempotency-Key": "ajout-b09" };
  const r = await app.appel("/api/colis/quick-add/Alice", { methode: "POST", corps: { n: 2 }, entetes: cle });
  assert.equal(r.status, 200);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, avant + 2);

  // le serveur redemarre (deploiement) : ses modules repartent de zero, seule
  // la base reste
  for (const m of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](app|idempotence|routes[\\/][^\\/]+)\.js$/.test(m)) delete require.cache[m];
  }
  const relance = await demarreApp();
  try {
    // l'app n'a jamais recu la reponse : elle renvoie la meme operation
    const encore = await relance.appel("/api/colis/quick-add/Alice", { methode: "POST", corps: { n: 2 }, entetes: cle });
    assert.equal(encore.status, 200);
    assert.equal(encore.entetes.get("idempotent-replay"), "true", "la reponse d'origine est rejouee");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, avant + 2, "toujours deux colis de plus, pas quatre");
  } finally {
    await relance.ferme();
  }
});
