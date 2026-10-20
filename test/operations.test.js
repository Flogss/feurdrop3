// Les operations groupees sur les colis et leurs effets reels : ce qui part,
// ce qui reste, le stock (normal et BJ a part), la tournee, l'argent.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase, demarreApp } = require("./aide");

environnementDeTest();
const db = require("../src/db");
let app;

before(async () => (app = await demarreApp()));
after(() => app.ferme());
beforeEach(() => videBase());

// un colis en attente ; `imprime` : deja sorti de l'imprimante (pret a partir)
function colis(sender, carrier, { type = "normal", imprime = true } = {}) {
  const c = db.addColis(sender, { fileId: `f-${Math.random()}`, fileKind: "pdf", carrier, type });
  if (imprime) db.markPrinted([c.id], "test");
  return c.id;
}
const statut = (id) => db.getColisById(id).status;
const stocks = () => db.getStocks();
const poste = (chemin, corps) => app.appel(chemin, { methode: "POST", corps: corps ?? {} });

test("drop par transporteur : seulement ce transporteur, seulement l'imprime, le stock suit", async () => {
  db.adjustStock(10, "normal");
  const mr = [colis("Alice", "MR"), colis("Bob", "MR"), colis("Alice", "MR")];
  const mrPasImprime = colis("Alice", "MR", { imprime: false });
  const lp = colis("Alice", "LP");
  const r = await poste("/api/colis/drop-carrier/MR");
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 3);
  assert.equal(r.json.restants, 1, "le MR pas encore imprime reste");
  assert.deepEqual(mr.map(statut), ["dropped", "dropped", "dropped"]);
  assert.equal(statut(mrPasImprime), "pending");
  assert.equal(statut(lp), "pending");
  assert.equal(stocks().normal, 7);
});

test("drop des boites jaunes : le stock BJ baisse, pas le normal", async () => {
  db.adjustStock(5, "normal");
  db.adjustStock(5, "bj");
  colis("Alice", null, { type: "bj" });
  colis("Bob", null, { type: "bj" });
  const r = await poste("/api/colis/drop-carrier/BJ");
  assert.equal(r.json.count, 2);
  assert.deepEqual([stocks().normal, stocks().bj], [5, 3]);
});

test("drop par expediteur et « tout sauf les LIT »", async () => {
  const a = colis("Alice", "MR");
  const b = colis("Bob", "MR");
  const lit = colis("Carla", "DHL", { type: "lit" });
  const c = colis("Carla", "UPS");
  let r = await poste(`/api/colis/drop-sender/${encodeURIComponent("Alice")}`);
  assert.equal(r.json.count, 1);
  assert.deepEqual([statut(a), statut(b)], ["dropped", "pending"]);
  r = await poste("/api/colis/drop-all-except-lit");
  assert.equal(r.json.count, 2);
  assert.deepEqual([statut(b), statut(c), statut(lit)], ["dropped", "dropped", "pending"]);
});

test("en tournee, un drop groupe ne prend que le sac (rien de ce qui arrive pendant)", async () => {
  const avant = colis("Alice", "MR");
  await poste("/api/tour/start");
  // arrive pendant la tournee, imprime automatiquement : pas dans le sac
  db.db.prepare("UPDATE colis SET created_at = datetime('now', '-1 minute') WHERE id = ?").run(avant);
  const pendant = colis("Alice", "MR");
  db.db.prepare("UPDATE colis SET created_at = datetime('now', '+1 minute') WHERE id = ?").run(pendant);
  const r = await poste("/api/colis/drop-carrier/MR");
  assert.equal(r.json.count, 1);
  assert.deepEqual([statut(avant), statut(pendant)], ["dropped", "pending"]);
});

test("stock : un nombre entier de pochettes, rien d'autre", async () => {
  assert.equal((await poste("/api/stock/adjust", { delta: 1.5, kind: "normal" })).status, 400);
  assert.equal((await poste("/api/stock/adjust", { delta: "abc", kind: "normal" })).status, 400);
  assert.equal((await poste("/api/stock/adjust", { delta: 3, kind: "bj" })).status, 200);
  assert.deepEqual([stocks().normal, stocks().bj], [0, 3]);
});

test("« Payé » : seulement le montant confirme ; s'il a change, rien n'est marque", async () => {
  const a = colis("Alice", "MR");
  db.dropColis(a);
  // l'ecran montre 4 € ; entre-temps un autre colis d'Alice est drope
  const b = colis("Alice", "LP");
  db.dropColis(b);
  let r = await poste(`/api/debts/Alice/pay`, { owed: 4 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /montant a changé/);
  assert.equal(db.getColisById(a).paid, 0, "rien de marque");
  // l'ecran relu montre 8 € : confirme, tout est marque
  r = await poste(`/api/debts/Alice/pay`, { owed: 8 });
  assert.equal(r.json.count, 2);
  assert.equal(db.getDebtsBySender().length, 0);
  // renvoye (reseau) : plus rien a marquer, pas d'erreur
  r = await poste(`/api/debts/Alice/pay`, { owed: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 0);
});

test("modifier un colis (prix, note, transporteur) et le retirer", async () => {
  const id = colis("Alice", "MR");
  let r = await app.appel(`/api/print/colis/${id}`, { methode: "PATCH", corps: { price: "6,5", note: "fragile", carrier: "LP" } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.price, r.json.note, r.json.carrier], [6.5, "fragile", "LP"]);
  assert.equal(db.getColisById(id).price_locked, 1, "prix fixe a la main : verrouille");
  assert.equal((await app.appel(`/api/print/colis/${id}`, { methode: "PATCH", corps: { price: "" } })).status, 400);
  assert.equal((await app.appel(`/api/print/colis/${id}`, { methode: "PATCH", corps: { carrier: "XYZ" } })).status, 400);
  r = await app.appel(`/api/print/colis/${id}`, { methode: "DELETE" });
  assert.equal(r.status, 200);
  assert.equal(db.getColisById(id), undefined);
  assert.equal((await app.appel(`/api/print/colis/${id}`, { methode: "DELETE" })).status, 404);
});

test("confirmation d'impression renvoyee apres un redemarrage : une seule fournee", async () => {
  const ids = [colis("Alice", "MR", { imprime: false }), colis("Bob", "MR", { imprime: false })];
  const avant = db.getPrintJobs().length;
  let r = await poste("/api/print/job/inconnu/imprime", { ids });
  assert.equal(r.json.marked, 2);
  r = await poste("/api/print/job/inconnu/imprime", { ids });
  assert.equal(r.json.marked, 0);
  assert.equal(r.json.deja, true);
  assert.equal(db.getPrintJobs().length, avant + 1, "pas de seconde fournee dans le menu de reimpression");
});
