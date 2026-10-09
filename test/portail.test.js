// L'espace prive d'un expediteur ne montre que ses colis, sans prix ni rien
// du dashboard, et un faux lien n'ouvre rien.
const { test, beforeEach, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, demarreApp, videBase } = require("./aide");

environnementDeTest();
const db = require("../src/db");
const { creePortail, retirePortail, portailPour } = require("../src/portail");
let app;
before(async () => (app = await demarreApp()));
after(() => app.ferme());
beforeEach(() => videBase());

function espace(nom) {
  const r = creePortail(db.getOrCreateSender(nom).id);
  return r.sender.portail_jeton;
}

test("chaque jeton ne voit que les colis de son expediteur", async () => {
  const a1 = db.addColis("Alice", { fileId: "a1", fileKind: "pdf", carrier: "MR", fileName: "6A07648914126.pdf" });
  db.addColis("Alice", { fileId: "a2", fileKind: "pdf", carrier: "UPS" });
  db.addColis("Bob", { fileId: "b1", fileKind: "pdf", carrier: "MR", fileName: "BOB-SECRET.pdf" });
  db.markPrinted([a1.id], "test");
  const jetonAlice = espace("Alice");
  const jetonBob = espace("Bob");

  const alice = await app.appel(`/api/portail/${jetonAlice}`);
  assert.equal(alice.status, 200);
  assert.equal(alice.json.expediteur, "Alice");
  assert.equal(alice.json.colis.length, 2);
  assert.ok(!alice.texte.includes("BOB-SECRET") && !alice.texte.includes("Bob"));

  const bob = await app.appel(`/api/portail/${jetonBob}`);
  assert.equal(bob.json.colis.length, 1);
  assert.equal(bob.json.expediteur, "Bob");
});

test("rien du dashboard : ni prix, ni identifiant interne, ni fichier", async () => {
  const c = db.addColis("Alice", { fileId: "secret-file-id", fileKind: "pdf", carrier: "MR", caption: "legende privee" });
  db.setColisNote(c.id, "note interne");
  const r = await app.appel(`/api/portail/${espace("Alice")}`);
  const colis = r.json.colis[0];
  assert.deepEqual(Object.keys(colis).sort(), ["boiteJaune", "dropeLe", "etape", "imprimeLe", "recuLe", "ref", "suivi", "transporteur"]);
  for (const interdit of ["secret-file-id", "legende privee", "note interne", '"price"', `"id":${c.id}`]) {
    assert.ok(!r.texte.includes(interdit), `fuite : ${interdit}`);
  }
  assert.equal(r.entetes.get("cache-control"), "no-store");
  assert.equal(r.entetes.get("referrer-policy"), "no-referrer");
});

test("lien faux, regenere ou desactive : 404 ; « Autre » n'a pas d'espace", async () => {
  db.addColis("Alice", { fileId: "a", fileKind: "pdf" });
  const ancien = espace("Alice");
  const nouveau = espace("Alice"); // regenere : l'ancien cesse de marcher
  assert.equal((await app.appel(`/api/portail/${ancien}`)).status, 404);
  assert.equal((await app.appel(`/api/portail/${nouveau}`)).status, 200);
  retirePortail(db.getOrCreateSender("Alice").id);
  assert.equal((await app.appel(`/api/portail/${nouveau}`)).status, 404);
  assert.equal((await app.appel("/api/portail/abc")).status, 404);
  assert.equal((await app.appel("/api/portail/' OR 1=1 --xxxxxxxxxxxxxxxxxx")).status, 404);

  const autre = creePortail(db.getOrCreateSender("Autre").id);
  assert.equal(autre.status, 400);
  assert.equal(portailPour("x".repeat(24)), null);
});

test("trop d'essais avec de faux liens : 429", async () => {
  let dernier = null;
  for (let i = 0; i < 32; i++) {
    dernier = await app.appel(`/api/portail/${"z".repeat(23)}${String(i).padStart(2, "0")}`, {
      entetes: { "X-Forwarded-For": "203.0.113.7" },
    });
  }
  assert.equal(dernier.status, 429);
  // une autre adresse n'est pas penalisee
  const autre = await app.appel(`/api/portail/${"z".repeat(25)}`, { entetes: { "X-Forwarded-For": "203.0.113.8" } });
  assert.equal(autre.status, 404);
});

test("l'etape d'un colis suit le dashboard (a imprimer, imprime, en drop, drope)", async () => {
  const aImprimer = db.addColis("Alice", { fileId: "1", fileKind: "pdf", carrier: "MR" });
  const imprime = db.addColis("Alice", { fileId: "2", fileKind: "pdf", carrier: "MR" });
  const drope = db.addColis("Alice", { fileId: "3", fileKind: "pdf", carrier: "MR" });
  db.markPrinted([imprime.id, drope.id], "test");
  db.dropColis(drope.id);
  const jeton = espace("Alice");
  const avant = (await app.appel(`/api/portail/${jeton}`)).json;
  assert.deepEqual(avant.compte, { a_imprimer: 1, imprime: 1, en_drop: 0, drope: 1 });

  db.startTour(null);
  const pendant = (await app.appel(`/api/portail/${jeton}`)).json;
  assert.deepEqual(pendant.compte, { a_imprimer: 1, imprime: 0, en_drop: 1, drope: 1 });
  assert.ok(aImprimer.id);
});
