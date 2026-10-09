// Les regles qui touchent aux colis et a l'argent : le sac d'une tournee, les
// drops groupes, les montants, les transactions, les ajouts et retraits a la
// main, les fusions d'expediteurs et les jours de Paris.
const { test, beforeEach, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, demarreApp, videBase } = require("./aide");

environnementDeTest();
const db = require("../src/db");
let app;
before(async () => (app = await demarreApp()));
after(() => app.ferme());
beforeEach(() => videBase());

// un colis avec une date de creation choisie (UTC, comme en base)
function colis(expediteur, { cree = null, imprime = false, ...options } = {}) {
  const c = db.addColis(expediteur, { fileId: options.sansFichier ? null : `f-${Math.random()}`, fileKind: "pdf", ...options });
  if (cree) db.db.prepare("UPDATE colis SET created_at = ? WHERE id = ?").run(cree, c.id);
  if (imprime) db.markPrinted([c.id], "test");
  return c.id;
}
const statut = (id) => db.getColisById(id)?.status;
const depart = (quand, selection = null) => {
  db.startTour(selection);
  db.db.prepare("UPDATE settings SET value = ? WHERE key = 'tour_started_at'").run(quand);
};

// --- tourScope ---------------------------------------------------------------

test("tourScope : sans tournee, aucune restriction", () => {
  assert.deepEqual(db.tourScope(), { clause: "", params: [] });
});

test("tourScope : le sac = arrives avant le depart, et dans la selection", () => {
  const avantMR = colis("A", { cree: "2026-10-09 08:00:00", carrier: "MR" });
  const avantUPS = colis("A", { cree: "2026-10-09 08:00:00", carrier: "UPS" });
  const avantLit = colis("A", { cree: "2026-10-09 08:00:00", carrier: "MR", type: "lit" });
  const apres = colis("A", { cree: "2026-10-09 10:00:00", carrier: "MR" });
  depart("2026-10-09 09:00:00", ["normal:MR", "lit:MR"]);

  const { clause, params } = db.tourScope();
  const sac = db.db.prepare(`SELECT id FROM colis WHERE status = 'pending'${clause} ORDER BY id`).all(...params).map((r) => r.id);
  assert.deepEqual(sac, [avantMR, avantLit]);
  assert.ok(!sac.includes(avantUPS) && !sac.includes(apres));
  assert.equal(db.getHorsTournee().count, 2);
  assert.equal(db.getArrivedDuringTour().count, 1);
});

// --- dropWhere -----------------------------------------------------------------

test("drop groupe : seulement le pret (imprime ou sans fichier), le reste est compte", () => {
  db.adjustStock(10, "normal");
  db.adjustStock(5, "bj");
  const imprime = colis("A", { imprime: true, carrier: "MR" });
  const pasImprime = colis("A", { carrier: "MR" });
  const aLaMain = colis("B", { sansFichier: true });
  const bj = colis("C", { imprime: true, type: "bj" });

  const r = db.dropAll();
  assert.equal(r.count, 3);
  assert.equal(r.bj, 1);
  assert.equal(r.restants, 1);
  assert.equal(statut(imprime), "dropped");
  assert.equal(statut(aLaMain), "dropped");
  assert.equal(statut(bj), "dropped");
  assert.equal(statut(pasImprime), "pending");
  assert.deepEqual(db.consumeStock(r), { normal: 8, bj: 4 });
});

test("drop groupe pendant une tournee : rien hors du sac", () => {
  const dansLeSac = colis("A", { cree: "2026-10-09 08:00:00", imprime: true, carrier: "MR" });
  const arriveApres = colis("A", { cree: "2026-10-09 10:00:00", imprime: true, carrier: "MR" });
  const autreTransporteur = colis("A", { cree: "2026-10-09 08:00:00", imprime: true, carrier: "UPS" });
  depart("2026-10-09 09:00:00", ["normal:MR"]);

  const r = db.dropByCarrier("MR");
  assert.equal(r.count, 1);
  assert.equal(statut(dansLeSac), "dropped");
  assert.equal(statut(arriveApres), "pending");
  assert.equal(statut(autreTransporteur), "pending");
});

test("fin de tournee par l'API : le sac seulement, stock une fois, resume enregistre", async () => {
  db.adjustStock(10, "normal");
  const sac = colis("A", { cree: "2026-10-09 08:00:00", imprime: true, carrier: "MR" });
  const pasPret = colis("A", { cree: "2026-10-09 08:00:00", carrier: "MR" });
  const apres = colis("B", { cree: "2099-01-01 00:00:00", imprime: true, carrier: "MR" });
  depart("2026-10-09 09:00:00");

  const fin = await app.appel("/api/tour/finish", { methode: "POST", corps: { startedAt: "2026-10-09 09:00:00" } });
  assert.equal(fin.status, 200);
  assert.equal(fin.json.count, 1);
  assert.equal(fin.json.restants, 1);
  assert.equal(statut(sac), "dropped");
  assert.equal(statut(pasPret), "pending");
  assert.equal(statut(apres), "pending");
  assert.equal(db.getStock("normal"), 9);
  assert.equal(db.getTourStart(), null);
  assert.equal(db.getLastTour().count, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM tours").get().n, 1);
});

// --- Montants ---------------------------------------------------------------------

test("montants : arrondis au centime a l'ecriture et dans les totaux", async () => {
  assert.equal(db.arrondiCentimes(0.1 + 0.2), 0.3);
  assert.equal(db.arrondiCentimes(1.005), 1.01);
  assert.equal(db.arrondiCentimes("4,5".replace(",", ".")), 4.5);
  assert.equal(db.arrondiCentimes("abc"), 0);

  const s = db.getOrCreateSender("Alice");
  db.updateSenderPrices(s.id, { price: 4.333333 });
  assert.equal(db.getOrCreateSender("Alice").price, 4.33);

  // trois colis a 0,10 € : la somme flottante vaut 0,30000000000000004
  for (let i = 0; i < 3; i++) {
    const id = colis("Alice", { carrier: "MR" });
    db.setColisPrice(id, 0.1);
  }
  const stats = await app.appel("/api/stats");
  assert.equal(stats.json.pendingValue, 0.3);
  assert.equal(stats.json.bySender[0].pending_value, 0.3);

  // un prix force reste force quand le tarif change
  const force = colis("Alice", { carrier: "MR" });
  db.setColisPrice(force, 7.5);
  db.updateSenderPrices(s.id, { price: 5 });
  assert.equal(db.getColisById(force).price, 7.5);
});

test("montants : prix invalides refuses par l'API", async () => {
  const r = await app.appel("/api/senders", { methode: "POST", corps: { name: "Bob", price: -1 } });
  assert.equal(r.status, 400);
  const ok = await app.appel("/api/senders", { methode: "POST", corps: { name: "Bob", price: 4.555, litPrice: 6, bjPrice: 4 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.price, 4.56);
});

// --- Transactions ---------------------------------------------------------------

test("transaction : une erreur annule tout ce qui avait ete ecrit", () => {
  assert.throws(() =>
    db.transaction(() => {
      db.addColis("Alice", { journal: false });
      throw new Error("panne au milieu");
    })
  );
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, 0);
});

test("transaction imbriquee : l'interieur s'annule seul, l'exterieur continue", () => {
  db.transaction(() => {
    db.addColis("Alice", { journal: false });
    assert.throws(() =>
      db.transaction(() => {
        db.addColis("Bob", { journal: false });
        throw new Error("interieur");
      })
    );
  });
  const noms = db.db.prepare("SELECT sender_name FROM colis").all().map((r) => r.sender_name);
  assert.deepEqual(noms, ["Alice"]);
});

test("transaction : une fonction async est refusee (rien n'est ecrit)", () => {
  assert.throws(() => db.transaction(async () => db.addColis("Alice", { journal: false })), /synchrone/);
});

test("fusion d'expediteurs : tout ou rien", () => {
  const source = db.getOrCreateSender("Ancien");
  const cible = db.getOrCreateSender("Nouveau");
  const c = colis("Ancien", { carrier: "MR" });
  db.db.exec("CREATE TRIGGER panne BEFORE DELETE ON senders BEGIN SELECT RAISE(ABORT, 'panne simulee'); END");
  assert.throws(() => db.mergeSenderInto(source.id, cible.id), /panne simulee/);
  db.db.exec("DROP TRIGGER panne");
  assert.equal(db.getColisById(c).sender_name, "Ancien", "le colis n'a pas bouge");
  assert.ok(db.db.prepare("SELECT 1 FROM senders WHERE id = ?").get(source.id));

  const r = db.mergeSenderInto(source.id, cible.id);
  assert.equal(r.moved, 1);
  assert.equal(db.getColisById(c).sender_name, "Nouveau");
});

test("fusion d'expediteurs : les paires du topic special suivent", () => {
  const source = db.getOrCreateSender("Ancien");
  const cible = db.getOrCreateSender("Nouveau");
  db.db.prepare("INSERT INTO paires_special (numero, sender_name, code_file_id) VALUES (1, 'Ancien', 'code')").run();
  db.mergeSenderInto(source.id, cible.id);
  assert.equal(db.db.prepare("SELECT sender_name FROM paires_special").get().sender_name, "Nouveau");

  const autre = db.getOrCreateSender("Petit");
  db.db.prepare("INSERT INTO paires_special (numero, sender_name) VALUES (2, 'Petit')").run();
  db.mergeSendersIntoOther([autre.id]);
  assert.equal(db.db.prepare("SELECT sender_name FROM paires_special WHERE numero = 2").get().sender_name, "Autre");
});

test("fusion dans « Autre » : tout ou rien", () => {
  const a = db.getOrCreateSender("A");
  const b = db.getOrCreateSender("B");
  colis("A", { sansFichier: true });
  colis("B", { sansFichier: true });
  db.db.exec(
    "CREATE TRIGGER panne BEFORE DELETE ON senders WHEN old.name = 'B' BEGIN SELECT RAISE(ABORT, 'panne simulee'); END"
  );
  assert.throws(() => db.mergeSendersIntoOther([a.id, b.id]), /panne simulee/);
  db.db.exec("DROP TRIGGER panne");
  // A avait deja ete deplace avant la panne : il revient
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis WHERE sender_name = 'Autre'").get().n, 0);
  assert.ok(db.db.prepare("SELECT 1 FROM senders WHERE name = 'A'").get());
});

// --- Ajouts et retraits a la main -------------------------------------------

test("+n colis : tout ou rien", () => {
  db.db.exec(
    "CREATE TRIGGER panne BEFORE INSERT ON colis WHEN (SELECT COUNT(*) FROM colis) >= 2 BEGIN SELECT RAISE(ABORT, 'panne simulee'); END"
  );
  assert.throws(() => db.quickAddColis("Alice", 5), /panne simulee/);
  db.db.exec("DROP TRIGGER panne");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, 0);

  db.quickAddColis("Alice", 5);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, 5);
});

test("+n colis par l'API : une cle d'idempotence rejouee n'ajoute rien de plus", async () => {
  const entetes = { "Idempotency-Key": "cle-unique-1" };
  const r1 = await app.appel("/api/colis/quick-add/Alice", { methode: "POST", corps: { n: 3 }, entetes });
  const r2 = await app.appel("/api/colis/quick-add/Alice", { methode: "POST", corps: { n: 3 }, entetes });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.entetes.get("idempotent-replay"), "true");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, 3);
});

test("+n colis par l'API : une panne libere la cle, le nouvel essai ajoute bien les n", async () => {
  db.db.exec("CREATE TRIGGER panne BEFORE INSERT ON colis WHEN (SELECT COUNT(*) FROM colis) >= 1 BEGIN SELECT RAISE(ABORT, 'panne simulee'); END");
  const entetes = { "Idempotency-Key": "cle-unique-2" };
  const r1 = await app.appel("/api/colis/quick-add/Alice", { methode: "POST", corps: { n: 3 }, entetes });
  assert.equal(r1.status, 500);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, 0, "rien n'est reste de l'essai rate");
  db.db.exec("DROP TRIGGER panne");
  const r2 = await app.appel("/api/colis/quick-add/Alice", { methode: "POST", corps: { n: 3 }, entetes });
  assert.equal(r2.status, 200);
  assert.notEqual(r2.entetes.get("idempotent-replay"), "true");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, 3);
});

test("« − » : retire les colis comptes a la main, jamais une vraie etiquette", async () => {
  const etiquette = colis("Alice", { carrier: "MR" });
  const etiquetteImprimee = colis("Alice", { carrier: "MR", imprime: true });
  db.quickAddColis("Alice", 2);

  // on en demande 5 : seuls les 2 comptes a la main partent
  const r = await app.appel("/api/colis/quick-remove/Alice", { methode: "POST", corps: { n: 5 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, 2);
  assert.equal(statut(etiquette), "pending");
  assert.equal(statut(etiquetteImprimee), "pending");

  // plus rien a la main : refus explicite, les etiquettes restent
  const encore = await app.appel("/api/colis/quick-remove/Alice", { methode: "POST", corps: { n: 1 } });
  assert.equal(encore.status, 404);
  assert.match(encore.json.error, /compté à la main/);
  const file = await app.appel("/api/print/resume");
  assert.equal(file.json.total, 1, "l'etiquette jamais imprimee est toujours dans la file d'impression");
});

test("« − » : les plus recents d'abord", () => {
  db.quickAddColis("Alice", 1);
  const ancien = db.db.prepare("SELECT MAX(id) AS id FROM colis").get().id;
  db.quickAddColis("Alice", 1);
  assert.equal(db.quickRemoveColis("Alice", 1), 1);
  assert.equal(statut(ancien), "pending");
});

// --- Jours de Paris --------------------------------------------------------------

test("jours de Paris : changements d'heure et minuit", () => {
  const { jourParis, lundiDe, ajouteJours } = require("../src/dates");
  // hiver (UTC+1) : 23 h 30 UTC = 00 h 30 le lendemain a Paris
  assert.equal(jourParis("2026-01-14 23:30:00"), "2026-01-15");
  assert.equal(jourParis("2026-01-14 22:30:00"), "2026-01-14");
  // ete (UTC+2) : 22 h 30 UTC = 00 h 30 le lendemain
  assert.equal(jourParis("2026-07-14 22:30:00"), "2026-07-15");
  assert.equal(jourParis("2026-07-14 21:59:59"), "2026-07-14");
  // passage a l'heure d'ete (29 mars 2026, 01 h 00 UTC) et retour (25 octobre)
  assert.equal(jourParis("2026-03-28 23:30:00"), "2026-03-29");
  assert.equal(jourParis("2026-03-29 22:30:00"), "2026-03-30");
  assert.equal(jourParis("2026-10-24 22:30:00"), "2026-10-25");
  assert.equal(jourParis("2026-10-25 22:30:00"), "2026-10-25");
  assert.equal(jourParis("2026-10-25 23:30:00"), "2026-10-26");
  assert.equal(jourParis(null), null);
  assert.equal(lundiDe("2026-10-11"), "2026-10-05"); // un dimanche
  assert.equal(lundiDe("2026-10-05"), "2026-10-05");
  assert.equal(ajouteJours("2026-03-28", 2), "2026-03-30");
});

test("jour comptable : un drop de samedi soir tard compte samedi, un dimanche passe au lundi", () => {
  const samediSoir = colis("A", { sansFichier: true });
  const dimanche = colis("A", { sansFichier: true });
  db.dropAll();
  // samedi 10 octobre 2026, 23 h 30 a Paris = 21 h 30 UTC
  db.db.prepare("UPDATE colis SET dropped_at = '2026-10-10 21:30:00' WHERE id = ?").run(samediSoir);
  // dimanche 11 octobre, 10 h a Paris
  db.db.prepare("UPDATE colis SET dropped_at = '2026-10-11 08:00:00' WHERE id = ?").run(dimanche);
  const jours = db.db
    .prepare("SELECT date(jour_paris(dropped_at), CASE strftime('%w', jour_paris(dropped_at)) WHEN '0' THEN '+1 day' ELSE '+0 day' END) AS j FROM colis ORDER BY id")
    .all()
    .map((r) => r.j);
  assert.deepEqual(jours, ["2026-10-10", "2026-10-12"]);
  const meilleur = db.getBestDay();
  assert.ok(["2026-10-10", "2026-10-12"].includes(meilleur.date));
});

test("« aujourd'hui » du dashboard : le jour de Paris", async () => {
  const { aujourdhuiParis } = require("../src/dates");
  const id = colis("A", { sansFichier: true });
  db.dropAll();
  const r1 = await app.appel("/api/stats");
  assert.equal(r1.json.todayCount, 1);
  // un drop d'hier soir (Paris) ne compte pas aujourd'hui
  const hier = new Date(`${aujourdhuiParis()}T00:00:00+02:00`).getTime() - 30 * 60 * 1000;
  db.db
    .prepare("UPDATE colis SET dropped_at = ? WHERE id = ?")
    .run(new Date(hier - 2 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "), id);
  const r2 = await app.appel("/api/stats");
  assert.equal(r2.json.todayCount, 0);
});
