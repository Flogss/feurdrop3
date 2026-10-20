// Le poids se paie : poids en kg × le prix du kilo de l'expediteur (1 € par
// defaut), en plus du tarif du type. Lu dans la description (« 📦 mondial
// relay 5kg »), la liste du jour, ou pose avec /poids.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase, demarreApp } = require("./aide");

environnementDeTest();
const db = require("../src/db");
const { lisPoids } = require("../src/poids");
let app;

before(async () => (app = await demarreApp()));
after(() => app.ferme());
beforeEach(() => videBase());

test("lecture d'un poids ecrit a la main", () => {
  assert.equal(lisPoids("📦 mondial relay\n5kg"), 5000);
  assert.equal(lisPoids("📦 mondial relay 5 kg"), 5000);
  assert.equal(lisPoids("colis 1,5kg fragile"), 1500);
  assert.equal(lisPoids("1.5 KG"), 1500);
  assert.equal(lisPoids("750 g"), 750);
  assert.equal(lisPoids("2 kilos"), 2000);
  // pas de poids : un numero de suivi, un prix, rien
  assert.equal(lisPoids("📦 mondial relay"), null);
  assert.equal(lisPoids("8R50345899012"), null);
  assert.equal(lisPoids("AB5KG123"), null);
  assert.equal(lisPoids("7.5 EUR"), null);
  assert.equal(lisPoids(null), null);
  // /poids 5 : un nombre seul est en kg ; une faute de frappe enorme est refusee
  assert.equal(lisPoids("5", { nombreSeulEnKg: true }), 5000);
  assert.equal(lisPoids("5"), null);
  assert.equal(lisPoids("5000kg"), null);
});

test("le prix d'un colis : tarif du type + poids au prix du kilo de l'expediteur", () => {
  const sans = db.addColis("Alice", { fileId: "a", fileKind: "pdf", carrier: "MR" });
  const avec = db.addColis("Alice", { fileId: "b", fileKind: "pdf", carrier: "MR", poidsG: 5000 });
  const lit = db.addColis("Alice", { fileId: "c", fileKind: "pdf", type: "lit", poidsG: 2000 });
  const g = (c) => db.getColisById(c.id);
  assert.equal(g(sans).price, 4);
  assert.equal(g(avec).price, 9, "4 € + 5 kg × 1 €");
  assert.equal(g(avec).poids_g, 5000);
  assert.equal(g(lit).price, 7.5, "5,50 € + 2 kg × 1 €");

  // le prix du kilo de l'expediteur change : ses colis en attente suivent
  const alice = db.db.prepare("SELECT * FROM senders WHERE name = 'Alice'").get();
  assert.equal(alice.kg_price, 1);
  db.updateSenderPrices(alice.id, { kgPrice: 2 });
  assert.equal(g(avec).price, 14, "4 € + 5 kg × 2 €");
  assert.equal(g(sans).price, 4);
  assert.equal(g(lit).price, 9.5);

  // le poids change (ou s'efface) : le prix suit
  assert.equal(db.setColisPoids(avec.id, 1500).price, 7);
  assert.equal(db.setColisPoids(avec.id, null).price, 4);

  // changer de type garde le poids
  db.setColisPoids(sans.id, 1000);
  assert.equal(db.setColisType(sans.id, "lit").price, 7.5, "5,50 € + 1 kg × 2 €");

  // un prix fixe a la main (/prix) n'est jamais ecrase par le poids
  db.setColisPrice(avec.id, 6);
  assert.equal(db.setColisPoids(avec.id, 3000).price, 6);
  assert.equal(g(avec).poids_g, 3000);
});

test("le prix du kilo se regle par expediteur depuis le dashboard (et l'app)", async () => {
  db.addColis("Bob", { fileId: "x", fileKind: "pdf", poidsG: 2500 });
  let r = await app.appel("/api/senders");
  const bob = r.json.find((s) => s.name === "Bob");
  assert.equal(bob.kg_price, 1);

  r = await app.appel(`/api/senders/${bob.id}`, { methode: "PUT", corps: { kgPrice: 1.2 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.kg_price, 1.2);
  assert.equal(db.db.prepare("SELECT price FROM colis WHERE sender_name = 'Bob'").get().price, 7, "4 € + 2,5 kg × 1,20 €");

  assert.equal((await app.appel(`/api/senders/${bob.id}`, { methode: "PUT", corps: { kgPrice: -1 } })).status, 400);

  r = await app.appel("/api/senders", { methode: "POST", corps: { name: "Carla", price: 3, kgPrice: 0.5 } });
  assert.equal(r.json.kg_price, 0.5);
  r = await app.appel("/api/senders", { methode: "POST", corps: { name: "Dan", price: 3 } });
  assert.equal(r.json.kg_price, 1, "1 € le kilo par defaut");
});

test("B08 : un special en attente suit le tarif normal de son expediteur quand il change", () => {
  const sp = db.addColis("Eve", { fileId: "s", fileKind: "pdf", type: "special", poidsG: 1000 });
  assert.equal(db.getColisById(sp.id).price, 5, "4 € + 1 kg");
  const eve = db.db.prepare("SELECT * FROM senders WHERE name = 'Eve'").get();
  db.updateSenderPrices(eve.id, { price: 6 });
  assert.equal(db.getColisById(sp.id).price, 7, "6 € + 1 kg");
});
