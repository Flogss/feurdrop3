// Taille des requetes : chaque route a sa limite, et un depassement repond
// proprement (413 en JSON), sans rien casser.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, demarreApp } = require("./aide");

environnementDeTest();
let app;
before(async () => (app = await demarreApp()));
after(() => app.ferme());

test("une liste de suivi d'environ 140 Ko passe la limite", async () => {
  const numeros = Array.from({ length: 10000 }, (_, i) => `6A${String(10000000000 + i).padStart(11, "0")}`);
  const corps = JSON.stringify({ text: numeros.join("\n"), name: "gros-fichier.txt" });
  assert.ok(corps.length > 140 * 1024, `corps de ${corps.length} octets`);
  const r = await app.appel("/api/suivi/verifier", { methode: "POST", corps });
  // sans cle Okapi la verification ne peut pas partir : l'important est que
  // la liste ait ete LUE (pas de 413) et que l'erreur soit lisible
  assert.notEqual(r.status, 413, r.texte);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /OKAPI_KEY/);
});

test("au-dela de 8 Mo, la liste de suivi est refusee proprement", async () => {
  const corps = JSON.stringify({ text: "6A07648914126\n".repeat(650000) });
  assert.ok(corps.length > 8 * 1024 * 1024);
  const r = await app.appel("/api/suivi/verifier", { methode: "POST", corps });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /trop volumineuse.*8 Mo/);
});

test("les autres routes gardent la limite de 100 Ko", async () => {
  const corps = JSON.stringify({ name: "x".repeat(200 * 1024), price: 4 });
  const r = await app.appel("/api/senders", { methode: "POST", corps });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /100 Ko/);

  // la relance de suivi n'a pas besoin des 8 Mo non plus
  const relance = await app.appel("/api/suivi/recheck", { methode: "POST", corps: JSON.stringify({ milestones: ["x".repeat(200 * 1024)] }) });
  assert.equal(relance.status, 413);
});

test("un JSON illisible repond 400 en JSON, sans arreter le serveur", async () => {
  const r = await app.appel("/api/senders", { methode: "POST", corps: "{pas du json" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /illisible/);
  const vivant = await app.appel("/api/config");
  assert.equal(vivant.status, 200);
});
