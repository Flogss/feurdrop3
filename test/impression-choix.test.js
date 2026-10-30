// « Choisir » a cote de « Tout imprimer » : une seule liasse avec les
// transporteurs coches -- les annotees devant, jamais les LIT (rouleau).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, demarreApp, videBase } = require("./aide");

environnementDeTest();
const db = require("../src/db");
const { rowsFor } = require("../src/routes/print");

let app;
before(async () => {
  app = await demarreApp();
});
after(() => app.ferme());
beforeEach(() => videBase());

const etiquette = (nom, carrier, extra = {}) => db.addColis("Alice", { fileId: `F-${nom}`, fileKind: "pdf", carrier, fileName: `${nom}.pdf`, ...extra });

test("seulement les transporteurs coches, les annotees en tete, sans les LIT", () => {
  const mr = etiquette("mr1", "MR");
  const lp = etiquette("lp1", "LP");
  const ups = etiquette("ups1", "UPS");
  const annotee = etiquette("lp2", "LP");
  db.setColisNote(annotee.id, "fragile");
  const lit = etiquette("lit1", null, { type: "lit" });

  const ids = rowsFor({ categories: ["LP", "MR"], scope: "new" }).map((r) => r.id);
  assert.deepEqual(new Set(ids), new Set([mr.id, lp.id, annotee.id]));
  assert.equal(ids[0], annotee.id, "l'annotee sur le dessus de la liasse");
  assert.ok(!ids.includes(ups.id) && !ids.includes(lit.id));

  // une etiquette deja sortie ne ressort pas avec les nouvelles
  db.markPrinted([mr.id], "test");
  assert.deepEqual(rowsFor({ categories: ["MR"], scope: "new" }), []);
  assert.deepEqual(rowsFor({ categories: ["MR"], scope: "printed" }).map((r) => r.id), [mr.id]);
});

test("la route refuse les LIT dans une selection, et une selection sans etiquette", async () => {
  etiquette("lp1", "LP");
  let r = await app.appel("/api/print/build", { methode: "POST", corps: { categories: ["LP", "LIT"] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /rouleau/);
  r = await app.appel("/api/print/build", { methode: "POST", corps: { categories: ["DHL"] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /aucune etiquette/);
});

test("une quantite par transporteur : les n premieres de sa file (annotees d'abord, puis par arrivee) ; toutes par defaut", () => {
  const lp = [1, 2, 3, 4, 5].map((i) => etiquette(`lp${i}`, "LP"));
  const mr = [1, 2].map((i) => etiquette(`mr${i}`, "MR"));
  db.setColisNote(lp[3].id, "fragile");

  const ids = (q) => rowsFor({ categories: ["LP", "MR"], scope: "new", quantites: q }).map((r) => r.id);
  // 2 La Poste : l'annotee, puis la premiere arrivee ; Mondial Relay entier
  assert.deepEqual(ids({ LP: 2 }), [lp[3].id, lp[0].id, mr[0].id, mr[1].id]);
  assert.deepEqual(ids({ LP: 1, MR: 1 }), [lp[3].id, mr[0].id]);
  // sans quantite, nulle, illisible ou trop grande : toutes
  for (const q of [null, {}, { LP: 0 }, { LP: "abc" }, { LP: 99 }]) assert.equal(ids(q).length, 7, JSON.stringify(q));
});
