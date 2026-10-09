// Les deux bugs critiques du rapport d'audit, reproduits puis gardes sous
// surveillance : une requete de suivi invalide faisait tomber tout le serveur,
// et une fin de tournee sans tournee droppait des colis hors du sac.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { environnementDeTest, demarreApp, videBase } = require("./aide");

environnementDeTest();

function lanceServeurEnfant() {
  return new Promise((resolve, reject) => {
    const enfant = spawn(process.execPath, [path.join(__dirname, "fixtures", "serveur-enfant.js")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sortie = "";
    let erreurs = "";
    enfant.stderr.on("data", (d) => (erreurs += d));
    enfant.stdout.on("data", (d) => {
      sortie += d;
      const m = /PRET (\S+)/.exec(sortie);
      if (m) resolve({ enfant, base: m[1], erreurs: () => erreurs });
    });
    enfant.on("exit", (code) => reject(new Error(`serveur arrete avant d'etre pret (code ${code}) : ${erreurs}`)));
  });
}

test("suivi : une liste sans numero valide ne fait pas tomber le serveur", async (t) => {
  const { enfant, base, erreurs } = await lanceServeurEnfant();
  let sortiCode = null;
  enfant.on("exit", (code) => (sortiCode = code));
  t.after(() => enfant.kill());

  for (const corps of [{ text: "" }, { text: "pas un numero\nni celui-ci" }, {}]) {
    const r = await fetch(`${base}/api/suivi/verifier`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    }).catch((err) => ({ status: `erreur reseau : ${err.cause?.code || err.message}` }));
    assert.equal(r.status, 400, `reponse attendue 400, recu ${r.status}\n${erreurs()}`);
    const json = await r.json();
    assert.match(json.error, /aucun numero valide/);
  }

  // relance d'une categorie vide : meme chemin d'erreur
  const relance = await fetch(`${base}/api/suivi/recheck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ milestones: ["in_transit"] }),
  }).catch((err) => ({ status: `erreur reseau : ${err.cause?.code || err.message}` }));
  assert.ok([400, 503].includes(relance.status), `relance : recu ${relance.status}\n${erreurs()}`);

  // le serveur repond toujours
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sortiCode, null, `le serveur s'est arrete (code ${sortiCode})\n${erreurs()}`);
  const vivant = await fetch(`${base}/api/config`);
  assert.equal(vivant.status, 200);
});

test("tournee : terminer sans tournee en cours ne drope rien", async (t) => {
  videBase();
  const db = require("../src/db");
  const { appel, ferme } = await demarreApp();
  t.after(ferme);

  db.adjustStock(10, "normal");
  // A : dans le sac (arrive avant le depart, imprime)
  const a = db.addColis("Alice", { fileId: "fa", fileKind: "pdf", carrier: "MR" });
  db.markPrinted([a.id], "test");

  const depart = await appel("/api/tour/start", { methode: "POST", corps: {} });
  assert.equal(depart.status, 200);

  // B : arrive PENDANT la tournee, et deja imprime (impression auto)
  const b = db.addColis("Bob", { fileId: "fb", fileKind: "pdf", carrier: "MR" });
  db.db.prepare("UPDATE colis SET created_at = datetime(created_at, '+5 seconds') WHERE id = ?").run(b.id);
  db.markPrinted([b.id], "Impression auto");

  // A est drope a l'unite devant le guichet : le sac est vide, la tournee se
  // referme toute seule
  const unite = await appel(`/api/print/colis/${a.id}/drop`, { methode: "POST", corps: {} });
  assert.equal(unite.status, 200);
  assert.equal(db.getTourStart(), null);

  // un autre appareil, encore sur l'ancien ecran, appuie sur "Terminer"
  const fin = await appel("/api/tour/finish", { methode: "POST", corps: {} });
  assert.equal(fin.status, 409, `fin sans tournee : ${fin.status} ${fin.texte}`);
  assert.equal(db.getColisById(b.id).status, "pending", "B, arrive pendant la tournee, ne doit pas etre drope");
  assert.equal(db.getStock("normal"), 9, "seul A a consomme une pochette");
});

test("tournee : une seconde fin ne refait rien, un ecran perime ne termine pas la suivante", async (t) => {
  videBase();
  const db = require("../src/db");
  const { appel, ferme } = await demarreApp();
  t.after(ferme);

  db.adjustStock(10, "normal");
  const a = db.addColis("Alice", { fileId: "fa", fileKind: "pdf", carrier: "MR" });
  db.markPrinted([a.id], "test");
  db.db.prepare("UPDATE colis SET created_at = datetime(created_at, '-20 seconds') WHERE id = ?").run(a.id);

  await appel("/api/tour/start", { methode: "POST", corps: {} });
  // la premiere tournee est partie dix secondes plus tot (deux departs dans la
  // meme seconde n'arrivent pas en vrai)
  db.db.prepare("UPDATE settings SET value = datetime(value, '-10 seconds') WHERE key = 'tour_started_at'").run();
  const depart = { json: { startedAt: db.getTourStart() } };
  const premiere = await appel("/api/tour/finish", { methode: "POST", corps: { startedAt: depart.json.startedAt } });
  assert.equal(premiere.status, 200);
  assert.equal(premiere.json.count, 1);
  assert.equal(db.getStock("normal"), 9);

  // double appui
  const seconde = await appel("/api/tour/finish", { methode: "POST", corps: { startedAt: depart.json.startedAt } });
  assert.equal(seconde.status, 409);
  assert.equal(db.getStock("normal"), 9, "le stock n'est decremente qu'une fois");

  // une nouvelle tournee commence ; un appareil qui affiche encore la
  // precedente ne peut pas la terminer a sa place
  const c = db.addColis("Carla", { fileId: "fc", fileKind: "pdf", carrier: "UPS" });
  db.markPrinted([c.id], "test");
  const nouvelle = await appel("/api/tour/start", { methode: "POST", corps: {} });
  assert.equal(nouvelle.status, 200);
  const perime = await appel("/api/tour/finish", { methode: "POST", corps: { startedAt: depart.json.startedAt } });
  assert.equal(perime.status, 409, `ecran perime : ${perime.status} ${perime.texte}`);
  assert.equal(db.getColisById(c.id).status, "pending");
  assert.ok(db.getTourStart(), "la nouvelle tournee continue");

  // l'annulation depuis l'ecran perime est refusee de meme
  const annulePerime = await appel("/api/tour/end", { methode: "POST", corps: { startedAt: depart.json.startedAt } });
  assert.equal(annulePerime.status, 409);
  assert.ok(db.getTourStart());

  // l'ecran a jour termine la bonne tournee
  const bonne = await appel("/api/tour/finish", { methode: "POST", corps: { startedAt: nouvelle.json.startedAt } });
  assert.equal(bonne.status, 200);
  assert.equal(bonne.json.count, 1);
  assert.equal(db.getStock("normal"), 8);

  // annuler quand tout est deja ferme : rien a faire, pas d'erreur
  const annuleRien = await appel("/api/tour/end", { methode: "POST", corps: {} });
  assert.equal(annuleRien.status, 200);
});
