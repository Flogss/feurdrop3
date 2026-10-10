// /save : l'export JSON des donnees -- complet, coherent, sans secret, relu
// et controle, et sans rien modifier.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase } = require("./aide");

environnementDeTest();
const db = require("../src/db");
const { creeSauvegarde, verifieSauvegarde, CATEGORIES } = require("../src/sauvegarde");
const { creePortail } = require("../src/portail");

beforeEach(() => videBase());

// une base qui touche a tout : expediteurs, colis dans tous les etats, stock,
// tournee, paires, regles, journal, arrivees, appareils, et des secrets
function remplis() {
  const a = db.addColis("Alice", { fileId: "FILE-A", fileKind: "pdf", carrier: "MR", fileName: "6A07648914126.pdf", caption: "fragile" });
  const b = db.addColis("Bob", { fileId: "FILE-B", fileKind: "pdf", type: "lit" });
  db.quickAddColis("Carla", 2);
  db.markPrinted([a.id], "Flo");
  db.dropColis(a.id);
  db.markSenderPaid("Alice");
  db.setColisNote(b.id, "client rappelle");
  db.adjustStock(25, "normal");
  db.adjustStock(4, "bj");
  db.startTour(["normal:MR"]);
  db.recordTour({ startedAt: "2026-10-08 08:00:00", endedAt: "2026-10-08 09:00:00", seconds: 3600, count: 3, value: 12 });
  db.saveCarrierRule("keyword", "DHL SCAN", "DHL");
  db.db.prepare("INSERT INTO paires_special (numero, sender_name, colis_id, code_file_id) VALUES (1, 'Bob', ?, 'CODE-1')").run(b.id);
  db.inscritArrivee(111, 1, { message_id: 1, document: { file_id: "X" } });
  const fait = db.inscritArrivee(111, 2, { message_id: 2 });
  db.arriveeFaite(fait);
  db.saveSubscription({ endpoint: "https://push.example/SECRET-ENDPOINT", keys: { p256dh: "SECRET-P256DH", auth: "SECRET-AUTH" }, label: "iPhone" });
  const jeton = creePortail(db.getOrCreateSender("Alice").id).sender.portail_jeton;
  db.getPrintToken();
  db.setSetting("vapid_private_key", "SECRET-VAPID-PRIVEE");
  db.setSetting("vapid_public_key", "SECRET-VAPID-PUBLIQUE");
  db.setSetting("portail_secret", "SECRET-PORTAIL");
  return { jeton };
}

const contenuDe = (s) => JSON.parse(s.contenu.toString("utf8"));
const dumpBase = () =>
  JSON.stringify(
    db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => db.db.prepare(`SELECT * FROM "${name}"`).all())
  );

test("toutes les categories, avec leurs comptes exacts", () => {
  remplis();
  const s = creeSauvegarde();
  const json = contenuDe(s);
  assert.equal(json.format, "feurdrop-sauvegarde");
  assert.equal(json.versionFormat, 1);
  assert.equal(json.versionSchema, require("../src/db/migrations").VERSION_SCHEMA);
  assert.match(s.fichier, /^feurdrop-backup-\d{4}-\d{2}-\d{2}-\d{2}h\d{2}\.json$/);

  const n = (sql) => db.db.prepare(sql).get().n;
  assert.equal(json.donnees.expediteurs.length, n("SELECT COUNT(*) AS n FROM senders"));
  assert.equal(json.donnees.colis.length, n("SELECT COUNT(*) AS n FROM colis"));
  assert.equal(json.donnees.lots.length, n("SELECT COUNT(*) AS n FROM batches"));
  assert.equal(json.donnees.tournees.length, 1);
  assert.equal(json.donnees.pairesSpeciales.length, 1);
  assert.equal(json.donnees.reglesTransporteurs.length, 1);
  assert.equal(json.donnees.journal.length, n("SELECT COUNT(*) AS n FROM journal"));
  assert.equal(json.donnees.arriveesEnAttente.length, 1, "seule l'arrivee non traitee");
  assert.equal(json.donnees.appareilsNotifies.length, 1);
  for (const c of CATEGORIES) assert.ok(Array.isArray(json.donnees[c.nom]), c.nom);

  // le metier est la : statuts, prix, impression, paiement, note, file_id
  const alice = json.donnees.colis.find((c) => c.sender_name === "Alice");
  assert.equal(alice.status, "dropped");
  assert.equal(alice.paid, 1);
  assert.equal(alice.printed_by, "Flo");
  assert.equal(alice.file_id, "FILE-A");
  assert.equal(json.donnees.colis.find((c) => c.sender_name === "Bob").note, "client rappelle");
  const reglages = Object.fromEntries(json.donnees.reglages.map((r) => [r.key, r.value]));
  assert.equal(reglages.stock, "25");
  assert.equal(reglages.stock_bj, "4");
  assert.ok(reglages.tour_started_at);
  assert.deepEqual(json.resume.stock, { normal: 25, bj: 4 });
  assert.equal(json.resume.colisEnAttente.nombre, 3);
  assert.equal(json.controle.total, s.total);
});

test("aucun secret exploitable dans le fichier", () => {
  const { jeton } = remplis();
  const texte = creeSauvegarde().contenu.toString("utf8");
  const secrets = [
    jeton,
    db.getPrintToken(),
    db.getSetting("vapid_private_key"),
    db.getSetting("vapid_public_key"),
    "SECRET-PORTAIL",
    "SECRET-ENDPOINT",
    "SECRET-P256DH",
    "SECRET-AUTH",
    process.env.TELEGRAM_BOT_TOKEN,
  ];
  for (const secret of secrets) assert.ok(secret && !texte.includes(secret), `secret present : ${String(secret).slice(0, 8)}…`);
  const json = JSON.parse(texte);
  const alice = json.donnees.expediteurs.find((e) => e.name === "Alice");
  assert.equal(alice.portail_actif, true);
  assert.ok(!("portail_jeton" in alice));
  assert.ok(json.configuration.variablesDefinies.includes("TELEGRAM_BOT_TOKEN"), "le nom, pas la valeur");
});

test("le fichier est relu et controle ; une alteration est detectee", () => {
  remplis();
  const s = creeSauvegarde();
  const texte = s.contenu.toString("utf8");
  assert.equal(verifieSauvegarde(texte).total, s.total);

  const altere = JSON.parse(texte);
  altere.donnees.colis[0].price = 999;
  assert.throws(() => verifieSauvegarde(JSON.stringify(altere)), /empreinte/);

  const tronque = JSON.parse(texte);
  tronque.donnees.colis.pop();
  assert.throws(() => verifieSauvegarde(JSON.stringify(tronque)), /colis/);

  const sansCategorie = JSON.parse(texte);
  delete sansCategorie.donnees.tournees;
  assert.throws(() => verifieSauvegarde(JSON.stringify(sansCategorie)), /tournees/);

  assert.throws(() => verifieSauvegarde(texte.slice(0, texte.length / 2)), /JSON valide/);
  assert.throws(() => verifieSauvegarde(JSON.stringify({ format: "autre" })), /pas une sauvegarde/);
});

test("la sauvegarde ne modifie rien dans la base", () => {
  remplis();
  const avant = dumpBase();
  creeSauvegarde();
  creeSauvegarde();
  assert.equal(dumpBase(), avant);
});

test("une base vide se sauvegarde aussi", () => {
  const s = creeSauvegarde();
  const json = contenuDe(s);
  assert.equal(json.donnees.colis.length, 0);
  assert.equal(verifieSauvegarde(s.contenu.toString("utf8")).total, s.total);
});

test("une table inconnue (ajoutee plus tard) est sauvegardee plutot qu'oubliee", () => {
  db.db.exec("CREATE TABLE IF NOT EXISTS essai_futur (id INTEGER PRIMARY KEY, valeur TEXT)");
  db.db.prepare("INSERT INTO essai_futur (valeur) VALUES ('x')").run();
  const json = contenuDe(creeSauvegarde());
  assert.deepEqual(json.donnees.autresTables.essai_futur, [{ id: 1, valeur: "x" }]);
  db.db.exec("DROP TABLE essai_futur");
});
