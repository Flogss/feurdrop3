// L'espace expediteur montre ou en est chaque colis drope chez le
// transporteur -- pris en charge, livre, pas encore scanne -- sans rien
// d'interne. A la visite, les colis La Poste pas encore prouves sont relus
// (une fois par 10 minutes au plus) ; les autres montrent ce qui est deja su
// (pages lues sur le Mac, constats faits a la main). Faux serveur La Poste.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase, demarreApp } = require("./aide");
const { creeFauxLaPoste } = require("./fixtures/faux-laposte");

environnementDeTest();
const faux = creeFauxLaPoste();
const db = require("../src/db");
const { creePortail } = require("../src/portail");
let app;
let depots;

before(async () => {
  process.env.LAPOSTE_SUIVI_URL = await faux.demarre();
  depots = require("../src/controle/depots");
  app = await demarreApp();
});
after(async () => {
  await app.ferme();
  await faux.ferme();
});
beforeEach(() => {
  videBase();
  faux.vide();
  faux.appels.length = 0;
  Object.assign(process.env, { OKAPI_KEY: faux.cle, CONTROLE_LAPOSTE_INTERVALLE_MS: "10", CONTROLE_PORTAIL_MINUTES: "10" });
});

const H = 3600 * 1000;
const isoIlYa = (h) => new Date(Date.now() - h * H).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const ev = (h, code, label = code) => ({ code, label, date: isoIlYa(h) });
let n = 0;
function drope(expediteur, numero, { carrier = "LP", heures = 5 } = {}) {
  const c = db.addColis(expediteur, { fileId: `F-${numero}-${++n}`, fileKind: "pdf", carrier, fileName: `${numero}.pdf` });
  db.dropColis(c.id);
  db.db.prepare("UPDATE colis SET created_at = datetime('now', ?), dropped_at = datetime('now', ?) WHERE id = ?").run(`-${heures + 12} hours`, `-${heures} hours`, c.id);
  return c.id;
}
const jetonDe = (nom) => creePortail(db.getOrCreateSender(nom).id).sender.portail_jeton;
const attendsLaFile = async () => {
  for (let i = 0; i < 50 && depots.etat().enCours === false && faux.appels.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await depots.synchronise(); // le passage lance par la visite (meme promesse)
};
const parNumero = (r) => Object.fromEntries(r.json.colis.map((c) => [c.suivi?.numero, c.depot]));

test("a la visite : les colis La Poste sont relus, l'expediteur voit pris en charge / pas encore scanne", async () => {
  faux.suivi("6A50000000001", [ev(1, "PC1", "Votre colis a été déposé dans un point postal."), ev(20, "DR1")]);
  faux.suivi("6A50000000002", [ev(20, "DR1", "Votre Colissimo va bientôt nous être confié !")]);
  drope("Alice", "6A50000000001");
  drope("Alice", "6A50000000002");
  drope("Bob", "6A50000000003");
  const jeton = jetonDe("Alice");

  // premiere visite : rien n'est encore lu, la lecture part
  let r = await app.appel(`/api/portail/${jeton}`, { anonyme: true });
  assert.equal(r.status, 200);
  assert.deepEqual(parNumero(r), { "6A50000000001": { etat: "verification", le: null, constate: false }, "6A50000000002": { etat: "verification", le: null, constate: false } });
  await attendsLaFile();
  // (la file lit aussi ce qui etait du par ailleurs : le nouveau colis de Bob)
  const lus = faux.appels.map((a) => a.numero);
  assert.ok(lus.includes("6A50000000001") && lus.includes("6A50000000002"), lus.join());

  r = await app.appel(`/api/portail/${jeton}`, { anonyme: true });
  const d = parNumero(r);
  assert.equal(d["6A50000000001"].etat, "pris");
  assert.ok(d["6A50000000001"].le);
  assert.equal(d["6A50000000002"].etat, "pas_encore");
  // rien d'interne : ni raison, ni methode, ni erreur
  for (const interdit of ["raison", "methode", "bientôt nous être confié", "PC1", "erreur"]) assert.ok(!r.texte.includes(interdit), `fuite : ${interdit}`);

  // une deuxieme visite tout de suite : pas de nouvelle lecture (10 min)
  faux.appels.length = 0;
  await app.appel(`/api/portail/${jeton}`, { anonyme: true });
  await depots.synchronise();
  assert.equal(faux.appels.length, 0);
});

test("les autres transporteurs : ce qui est deja su (constat a la main, page lue sur le Mac), jamais de lecture a la visite", async () => {
  const mr = drope("Alice", "4278870015", { carrier: "MR", heures: 30 });
  const ups = drope("Alice", "1Z999AA10123456784", { carrier: "UPS", heures: 30 });
  const mr2 = drope("Alice", "4278870016", { carrier: "MR", heures: 30 });
  depots.constate(ups, "pris");
  depots.constate(mr, "pris");
  const jeton = jetonDe("Alice");
  const r = await app.appel(`/api/portail/${jeton}`, { anonyme: true });
  const d = parNumero(r);
  assert.equal(d["1Z999AA10123456784"].etat, "pris");
  assert.equal(d["1Z999AA10123456784"].constate, true);
  assert.equal(d["4278870015"].etat, "pris");
  assert.equal(d["4278870016"], null, "rien de su : seulement « Drop »");
  await depots.synchronise();
  assert.equal(faux.appels.length, 0);
  // un retour apres la prise en charge (« mis a disposition du vendeur ») ne change rien pour l'expediteur
  assert.ok(mr2);
});

test("un colis livre, un numero retire, un colis pas encore drope", async () => {
  faux.suivi("6A50000000010", [ev(1, "DI1", "Votre colis est livré."), ev(5, "PC1")]);
  drope("Alice", "6A50000000010", { heures: 30 });
  const retire = drope("Alice", "6A50000000011", { heures: 100 });
  db.addColis("Alice", { fileId: "F-attente", fileKind: "pdf", carrier: "LP", fileName: "6A50000000012.pdf" });
  await depots.synchronise();
  db.db.prepare("UPDATE controle_suivis SET archive_le = datetime('now'), archive_motif = 'inconnu de La Poste' WHERE numero = '6A50000000011'").run();
  const r = await app.appel(`/api/portail/${jetonDe("Alice")}`, { anonyme: true });
  const d = parNumero(r);
  assert.equal(d["6A50000000010"].etat, "livre");
  assert.equal(d["6A50000000011"], null, "retire de la file : rien de plus que « Drop »");
  assert.equal(d["6A50000000012"], null, "pas encore drope");
  assert.ok(!r.texte.includes("inconnu de La Poste"));
  assert.ok(retire);
});
