// Impression automatique pilotee depuis le telephone : filtres gardes par le
// serveur, taches a identifiant stable, rien d'imprime avant la confirmation
// de l'agent, jamais deux fois, jamais perdu.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase, demarreApp } = require("./aide");

environnementDeTest();
const db = require("../src/db");
let app;
let agent;

before(async () => {
  app = await demarreApp();
  // relu a chaque appel : la remise a zero de la base en change
  agent = (chemin, options = {}) =>
    app.appel(chemin, { anonyme: true, ...options, entetes: { "X-Print-Token": db.getPrintToken(), ...(options.entetes || {}) } });
});
after(() => app.ferme());
beforeEach(() => {
  videBase();
  db.setSetting("auto_print_taches", "[]");
  db.setSetting("auto_print_filtres", "{}");
  db.setSetting("auto_print", "0");
});

const etiquette = (sender, carrier, type = "normal") =>
  db.addColis(sender, { fileId: `F-${Math.random()}`, fileKind: "pdf", carrier, type, fileName: "x.pdf" }).id;

test("depuis le telephone : activer, filtrer, et l'agent ne recoit que la file filtree", async () => {
  // deja la avant l'activation : considere comme imprime (pas de deballage)
  etiquette("Alice", "UPS");
  let r = await app.appel("/api/print/auto", { methode: "POST", corps: { enabled: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, true);
  assert.equal(r.json.pending, 0);

  const ups = etiquette("Alice", "UPS");
  etiquette("Bob", "MR");
  etiquette("Alice", "LP", "special");

  r = await app.appel("/api/print/auto", { methode: "POST", corps: { filtres: { transporteurs: ["UPS"], categories: ["normal", "inconnue"] } } });
  assert.deepEqual(r.json.filtres.transporteurs, ["UPS"]);
  // une categorie inventee est ignoree
  assert.deepEqual(r.json.filtres.categories, ["normal"]);
  assert.equal(r.json.pending, 1);

  // garde par le serveur : relu tel quel
  r = await app.appel("/api/print/auto");
  assert.deepEqual(r.json.filtres.transporteurs, ["UPS"]);
  assert.ok(r.json.options.transporteurs.some((t) => t.code === "UPS"));
  assert.ok(r.json.options.expediteurs.includes("Bob"));

  // ce que voit l'agent
  r = await agent("/api/print/queue", { entetes: { "X-Drop-Imprimante": "Zebra" } });
  assert.deepEqual(r.json, { enabled: true, count: 1 });
  assert.deepEqual(db.fileAuto().map((c) => c.id), [ups]);

  // et le telephone sait que l'agent est la
  r = await app.appel("/api/print/auto");
  assert.equal(r.json.agent.enLigne, true);
  assert.equal(r.json.agent.imprimante, "Zebra");

  // filtres invalides : refuses, rien ne change
  r = await app.appel("/api/print/auto", { methode: "POST", corps: { filtres: "UPS" } });
  assert.equal(r.status, 400);
});

test("une tache : reservee, imprimee seulement apres confirmation, une seule fois", async () => {
  db.setAutoPrintEnabled(true);
  const a = etiquette("Alice", "UPS");
  const b = etiquette("Alice", "MR");

  const t = db.ouvreTache([a, b]);
  // reservees : un second appel ne les ressort pas
  assert.equal(db.compteFileAuto(), 0);
  let etat = (await app.appel("/api/print/auto")).json;
  assert.equal(etat.enCours, 2);
  assert.equal(etat.taches[0].etat, "envoyee");
  // rien n'est marque comme imprime avant la confirmation
  assert.equal(db.countUnprintedLabels(), 2);

  let r = await agent("/api/print/done", { methode: "POST", corps: { job: t.id, ids: [a, b] } });
  assert.equal(r.json.deja, false);
  assert.equal(r.json.marked, 2);
  assert.equal(db.countUnprintedLabels(), 0);

  // la meme confirmation renvoyee apres une coupure : rien de plus
  const fournees = db.getPrintJobs().length;
  r = await agent("/api/print/done", { methode: "POST", corps: { job: t.id, ids: [a, b] } });
  assert.equal(r.json.deja, true);
  assert.equal(db.getPrintJobs().length, fournees);

  etat = (await app.appel("/api/print/auto")).json;
  assert.equal(etat.taches[0].etat, "imprimee");
  assert.equal(etat.enCours, 0);
});

test("un echec de l'imprimante rend les etiquettes a la file ; l'ancien agent (sans identifiant) est compris", async () => {
  db.setAutoPrintEnabled(true);
  const a = etiquette("Alice", "UPS");
  const t = db.ouvreTache([a]);
  let r = await agent("/api/print/echec", { methode: "POST", corps: { job: t.id, erreur: "Imprimante absente" } });
  assert.equal(r.json.etat, "echec");
  assert.equal(db.compteFileAuto(), 1);
  const etat = (await app.appel("/api/print/auto")).json;
  assert.equal(etat.taches[0].erreur, "Imprimante absente");
  assert.equal(db.countUnprintedLabels(), 1);

  // agent d'avant : confirme par les seuls identifiants
  const t2 = db.ouvreTache([a]);
  r = await agent("/api/print/done", { methode: "POST", corps: { ids: [a] } });
  assert.equal(r.json.marked, 1);
  assert.equal((await app.appel("/api/print/auto")).json.taches.find((x) => x.id === t2.id).etat, "imprimee");
});

test("une preparation qui echoue (Telegram absent) ne perd rien et ne marque rien", async () => {
  db.setAutoPrintEnabled(true);
  etiquette("Alice", "UPS");
  const r = await agent("/api/print/next");
  assert.equal(r.status, 500);
  assert.equal(db.compteFileAuto(), 1);
  assert.equal(db.countUnprintedLabels(), 1);
  assert.equal((await app.appel("/api/print/auto")).json.taches[0].etat, "echec");
});

test("le telephone ne touche jamais aux routes de l'agent, et l'inverse", async () => {
  assert.equal((await app.appel("/api/print/queue")).status, 401);
  assert.equal((await agent("/api/print/auto")).status, 401);
});
