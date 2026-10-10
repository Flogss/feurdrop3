// L'adaptateur de l'API officielle La Poste : chaque reponse possible devient
// une lecture claire ou une erreur typee (que la file sait traiter).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { creeFauxLaPoste } = require("./fixtures/faux-laposte");

const faux = creeFauxLaPoste();
let laposte;
before(async () => {
  process.env.LAPOSTE_SUIVI_URL = await faux.demarre();
  process.env.OKAPI_KEY = faux.cle;
  process.env.CONTROLE_LAPOSTE_DELAI_MS = "1000";
  laposte = require("../src/controle/laposte");
});
after(() => faux.ferme());
beforeEach(() => faux.vide());

const echec = (p) => p.then(() => assert.fail("aurait du echouer"), (e) => e);

test("cle refusee au premier appel : erreur de configuration (pas une pause)", async () => {
  process.env.OKAPI_KEY = "mauvaise";
  const e = await echec(laposte.verifie("6A12345678901"));
  assert.equal(e.type, "config");
  assert.match(e.message, /OKAPI_KEY/);
  process.env.OKAPI_KEY = faux.cle;
});

test("un suivi lu : evenements traduits, l'etiquette n'est pas une preuve", async () => {
  faux.suivi("6A12345678901", [
    { code: "PC1", label: "Votre colis a été déposé dans un point postal.", date: "2026-10-09T18:45:00+02:00" },
    { code: "DR1", label: "Votre Colissimo va bientôt nous être confié !", date: "2026-10-08T10:00:00+02:00" },
  ]);
  const r = await laposte.verifie("6A12345678901");
  assert.equal(r.trouve, true);
  assert.deepEqual(r.evenements.map((e) => [e.code, e.etape, e.physique]), [["PC1", "in_transit", true], ["DR1", "info_received", false]]);
  assert.equal(r.evenements[0].source, "laposte");
  assert.ok(r.evenements[0].cle.startsWith("PC1|"));
});

test("numero inconnu (404) : trouve = false, sans erreur", async () => {
  const r = await laposte.verifie("6A99999999999");
  assert.deepEqual({ trouve: r.trouve, n: r.evenements.length }, { trouve: false, n: 0 });
});

test("numero mal forme (400) : invalide", async () => {
  faux.comporte("XX1", "invalide");
  const e = await echec(laposte.verifie("XX1"));
  assert.equal(e.type, "invalide");
  assert.match(e.message, /pas valide/);
});

test("limites : 401 apres un succes = cle au piquet ; 429 avec Retry-After ; 403 = acces refuse", async () => {
  faux.force(401, { code: "UNAUTHORIZED" });
  const piquet = await echec(laposte.verifie("6A12345678901"));
  assert.equal(piquet.type, "limite");
  assert.ok(piquet.pauseMs >= 60000);

  faux.force(429, {}, { "Retry-After": "42" });
  const quota = await echec(laposte.verifie("6A12345678901"));
  assert.equal(quota.type, "limite");
  assert.equal(quota.pauseMs, 42000);

  faux.force(403, {});
  const interdit = await echec(laposte.verifie("6A12345678901"));
  assert.equal(interdit.type, "bloque");
  assert.match(interdit.message, /403/);
});

test("panne et lenteur : erreur passagere", async () => {
  faux.comporte("6A11111111111", "panne");
  assert.equal((await echec(laposte.verifie("6A11111111111"))).type, "passagere");
  faux.comporte("6A22222222222", "lent");
  const lent = await echec(laposte.verifie("6A22222222222"));
  assert.equal(lent.type, "passagere");
  assert.match(lent.message, /délai dépassé/);
});
