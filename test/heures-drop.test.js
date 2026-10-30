// Les heures de drop : poser, modifier, retirer ; soldees quand les colis
// sont postes ; l'expediteur ne voit que celles de ses colis en attente.
const { test, beforeEach, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, demarreApp, videBase } = require("./aide");

environnementDeTest();
const db = require("../src/db");
const { creePortail } = require("../src/portail");
const { lisHeure, instantParis } = require("../src/db/heuresDrop");
let app;
before(async () => (app = await demarreApp()));
after(() => app.ferme());
beforeEach(() => videBase());

const pret = (expediteur, carrier, options = {}) => {
  const c = db.addColis(expediteur, { fileId: `f-${Math.random()}`, fileKind: "pdf", carrier, ...options });
  db.markPrinted([c.id], "test");
  return c.id;
};
const ajoute = (heure, transporteurs) => app.appel("/api/heures-drop", { methode: "POST", corps: { heure, transporteurs } });
const heures = async () => (await app.appel("/api/stats")).json.heuresDrop.heures;

test("lecture de l'heure et heure de Paris (hiver comme ete)", () => {
  assert.equal(lisHeure("16:00"), "16:00");
  assert.equal(lisHeure("9h30"), "09:30");
  assert.equal(lisHeure("19h"), "19:00");
  assert.equal(lisHeure("7"), "07:00");
  assert.equal(lisHeure("24:00"), null);
  assert.equal(lisHeure("16:75"), null);
  assert.equal(lisHeure("bonjour"), null);
  assert.equal(new Date(instantParis("2026-10-30", "16:00")).toISOString(), "2026-10-30T15:00:00.000Z");
  assert.equal(new Date(instantParis("2026-07-14", "16:00")).toISOString(), "2026-07-14T14:00:00.000Z");
});

test("poser plusieurs heures, chacune ses transporteurs ; les modifier, les retirer", async () => {
  let r = await ajoute("16:00", ["LP"]);
  assert.equal(r.status, 200);
  r = await ajoute("19h30", ["MR", "BJ"]);
  assert.equal(r.status, 200);
  const liste = r.json.heures;
  assert.equal(liste.length, 2);
  const lp = liste.find((h) => h.heure === "16:00");
  const mr = liste.find((h) => h.heure === "19:30");
  assert.deepEqual(lp.transporteurs, [{ code: "LP", label: "La Poste" }]);
  assert.deepEqual(mr.transporteurs.map((t) => t.label), ["Mondial Relay", "Boîte jaune"]);
  assert.ok(r.json.transporteurs.some((t) => t.code === "BJ"), "la boite jaune se prevoit aussi");

  // les heures sont dans /api/stats (le dashboard et l'app les voient sans appel de plus)
  assert.equal((await heures()).length, 2);

  r = await app.appel(`/api/heures-drop/${mr.id}`, { methode: "PATCH", corps: { heure: "20:15", transporteurs: ["MR"] } });
  assert.equal(r.status, 200);
  const modifiee = r.json.heures.find((h) => h.id === mr.id);
  assert.equal(modifiee.heure, "20:15");
  assert.deepEqual(modifiee.transporteurs.map((t) => t.code), ["MR"]);

  r = await app.appel(`/api/heures-drop/${lp.id}`, { methode: "DELETE" });
  assert.deepEqual(r.json.heures.map((h) => h.id), [mr.id]);

  // refus clairs
  assert.equal((await ajoute("25:00", ["LP"])).status, 400);
  assert.equal((await ajoute("16:00", [])).status, 400);
  assert.equal((await ajoute("16:00", ["PAS-UN-TRANSPORTEUR"])).status, 400);
  assert.equal((await app.appel("/api/heures-drop/inconnue", { methode: "PATCH", corps: { heure: "10:00" } })).status, 404);
});

test("les colis postes soldent leur heure : un drop groupe emporte le transporteur", async () => {
  pret("Alice", "LP");
  pret("Alice", "LP");
  pret("Alice", "MR");
  await ajoute("16:00", ["LP"]);
  await ajoute("19:30", ["MR"]);

  db.dropByCarrier("LP");
  assert.deepEqual((await heures()).map((h) => h.heure), ["19:30"], "La Poste postee : son heure part");

  db.dropAll();
  assert.deepEqual(await heures(), [], "tout poste : plus d'heure");
});

test("un colis droppe a l'unite ne solde l'heure que s'il etait le dernier pret", async () => {
  const a = pret("Alice", "LP");
  const b = pret("Alice", "LP");
  await ajoute("16:00", ["LP", "MR"]);

  db.dropColis(a);
  assert.equal((await heures()).length, 1, "il reste un La Poste pret : l'heure tient");
  db.dropColis(b);
  const reste = await heures();
  assert.deepEqual(reste.map((h) => h.transporteurs.map((t) => t.code)), [["MR"]], "La Poste soldee, Mondial Relay attend encore");
});

test("l'expediteur voit l'heure de ses colis en attente, et seulement des siens", async () => {
  const lp = pret("Alice", "LP");
  pret("Alice", "LP");
  pret("Alice", "LP", { type: "bj" });
  pret("Bob", "MR");
  await ajoute("16:00", ["LP"]);
  await ajoute("19:30", ["MR"]);
  await ajoute("18:00", ["BJ"]);
  const jeton = creePortail(db.getOrCreateSender("Alice").id).sender.portail_jeton;

  const r = await app.appel(`/api/portail/${jeton}`);
  assert.equal(r.status, 200);
  assert.deepEqual(
    // (rangees par instant : selon l'heure du test, 16:00 peut etre demain)
    r.json.heuresDrop.map((h) => [h.heure, h.transporteurs.map((t) => [t.nom, t.colis])]).sort(),
    [
      ["16:00", [["La Poste", 2]]],
      ["18:00", [["Boîte jaune", 1]]],
    ],
    "pas l'heure de Mondial Relay : Alice n'a aucun colis Mondial Relay"
  );
  const enAttente = r.json.colis.filter((c) => c.etape !== "drope");
  assert.ok(enAttente.every((c) => c.depotPrevu), "chaque colis en attente dit quand il part");
  assert.equal(enAttente.filter((c) => c.depotPrevu.heure === "16:00").length, 2);

  // postes : plus d'heure, et le colis drope n'en porte pas
  db.dropColis(lp);
  db.dropByCarrier("LP");
  const apres = await app.appel(`/api/portail/${jeton}`);
  assert.deepEqual(apres.json.heuresDrop.map((h) => h.heure), ["18:00"]);
  assert.ok(apres.json.colis.filter((c) => c.etape === "drope").every((c) => !c.depotPrevu));
});
