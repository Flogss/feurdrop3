// Le controle des depots de bout en bout, contre un faux serveur La Poste :
// la file (cadence, plafond, reprise apres redemarrage), les cas de chaque
// numero (prise en charge, etiquette seule, inconnu, invalide, panne,
// lenteur, blocage), les transporteurs a constater a la main, et la regle :
// la table des colis n'est jamais touchee.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase, demarreApp } = require("./aide");
const { creeFauxLaPoste } = require("./fixtures/faux-laposte");

environnementDeTest();
const faux = creeFauxLaPoste();
const db = require("../src/db");
let depots;

const REGLAGES = { CONTROLE_LAPOSTE_INTERVALLE_MS: "40", CONTROLE_MAX_PAR_PASSAGE: "80", CONTROLE_LAPOSTE_DELAI_MS: "300" };
before(async () => {
  process.env.LAPOSTE_SUIVI_URL = await faux.demarre();
  depots = require("../src/controle/depots");
});
after(() => faux.ferme());
beforeEach(() => {
  videBase();
  faux.vide();
  faux.appels.length = 0;
  Object.assign(process.env, REGLAGES, { OKAPI_KEY: faux.cle });
});

const H = 3600 * 1000;
const isoIlYa = (h) => new Date(Date.now() - h * H).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const ev = (h, code, label = code) => ({ code, label, date: isoIlYa(h) });

// un colis recu il y a (heures + 12) h et drope il y a `heures` h
function drope(numero, { carrier = "LP", heures = 2, expediteur = "Alice" } = {}) {
  const c = db.addColis(expediteur, { fileId: `F-${numero}-${Math.random()}`, fileKind: "pdf", carrier, fileName: `${numero}.pdf` });
  db.dropColis(c.id);
  db.db.prepare("UPDATE colis SET created_at = datetime('now', ?), dropped_at = datetime('now', ?) WHERE id = ?").run(`-${heures + 12} hours`, `-${heures} hours`, c.id);
  return c.id;
}
const ligne = (colisId) => depots.vue().lignes.find((l) => l.colisId === colisId);
const suivi = (numero) => db.db.prepare("SELECT * FROM controle_suivis WHERE numero = ?").get(numero);
const rendDu = () => db.db.prepare("UPDATE controle_suivis SET prochaine_le = datetime('now', '-1 minute'), verifie_le = datetime('now', '-1 hour') WHERE prochaine_le IS NOT NULL").run();
const echec = (p) => p.then(() => assert.fail("aurait du echouer"), (e) => e);

test("les cas d'un numero : prise en charge, etiquette seule, inconnu, invalide", async () => {
  faux.suivi("6A10000000001", [ev(1, "ET1", "Votre colis est en transit"), ev(1.5, "PC1", "Votre colis a été déposé dans un point postal."), ev(30, "DR1")]);
  faux.suivi("6A10000000002", [ev(30, "DR1", "Votre Colissimo va bientôt nous être confié !")]);
  faux.comporte("6A10000000004", "invalide");
  const pris = drope("6A10000000001");
  const etiquette = drope("6A10000000002");
  const inconnu = drope("6A10000000003");
  const invalide = drope("6A10000000004");

  const bilan = await depots.synchronise();
  assert.equal(bilan.verifies, 3);
  assert.equal(bilan.erreurs, 1);

  const p = ligne(pris).controle;
  assert.equal(p.categorie, "confirme");
  assert.equal(p.preuve.code, "PC1");
  assert.equal(p.dernierEvenement.code, "ET1");
  const e = ligne(etiquette).controle;
  assert.equal(e.categorie, "non_confirme");
  assert.equal(e.enRetard, false, "2 h apres le drop, c'est le delai normal");
  assert.equal(ligne(inconnu).controle.categorie, "a_verifier");
  assert.match(ligne(inconnu).controle.raison, /Pas encore connu de La Poste/);
  const i = ligne(invalide);
  assert.equal(i.controle.categorie, "a_verifier");
  assert.match(i.controle.raison, /Numéro refusé/);
  assert.equal(i.erreur.code, "invalide");
  // un numero refuse n'est pas redemande ; les autres ont leur prochaine heure
  assert.equal(suivi("6A10000000004").prochaine_le, null);
  for (const n of ["6A10000000001", "6A10000000002", "6A10000000003"]) assert.ok(suivi(n).prochaine_le, n);
  // chaque ligne dit quand elle a ete verifiee, et donne le suivi officiel
  assert.ok(ligne(pris).verifieLe);
  assert.ok(ligne(pris).lien.includes("6A10000000001"));
});

test("la file : une requete a la fois, espacees, jamais plus que le plafond ; ouvrir la page n'appelle rien", async () => {
  process.env.CONTROLE_MAX_PAR_PASSAGE = "3";
  const numeros = ["6A20000000001", "6A20000000002", "6A20000000003", "6A20000000004", "6A20000000005"];
  for (const n of numeros) {
    faux.suivi(n, [ev(20, "DR1")]);
    drope(n);
  }
  await depots.synchronise();
  assert.equal(faux.appels.length, 3, "le plafond du passage");
  for (let k = 1; k < faux.appels.length; k++) {
    assert.ok(faux.appels[k].at - faux.appels[k - 1].at >= 35, `espacement ${faux.appels[k].at - faux.appels[k - 1].at} ms`);
  }
  await depots.synchronise();
  assert.equal(faux.appels.length, 5, "le passage suivant prend la suite");
  await depots.synchronise();
  assert.equal(faux.appels.length, 5, "rien n'est du : aucun appel");
  depots.vue();
  depots.detail(ligne(depots.vue().lignes[0].colisId).colisId);
  assert.equal(faux.appels.length, 5, "afficher la page ne lit que la base");
  // jamais deux passages en meme temps
  rendDu();
  const [a, b] = [depots.synchronise(), depots.synchronise()];
  assert.equal(a, b);
  await a;
});

test("deux colis au meme numero : une seule requete, la meme lecture", async () => {
  faux.suivi("6A30000000001", [ev(1, "PC1")]);
  const un = drope("6A30000000001");
  const deux = drope("6A30000000001", { expediteur: "Bob" });
  await depots.synchronise();
  assert.equal(faux.appelsPour("6A30000000001").length, 1);
  assert.equal(ligne(un).controle.categorie, "confirme");
  assert.equal(ligne(deux).controle.categorie, "confirme");
});

test("statut deja connu, puis relecture : rien n'est double, et un colis livre n'est plus relu", async () => {
  const n = "6A40000000001";
  faux.suivi(n, [ev(1, "PC1"), ev(30, "DR1")]);
  const id = drope(n);
  await depots.synchronise();
  const evts = () => db.db.prepare("SELECT COUNT(*) AS c FROM controle_evenements WHERE numero = ?").get(n).c;
  assert.equal(evts(), 2);
  // meme reponse : rien de neuf
  rendDu();
  const bilan = await depots.synchronise();
  assert.equal(bilan.nouveauxEvenements, 0);
  assert.equal(evts(), 2);
  // la suite arrive : seuls les nouveaux evenements sont ajoutes
  faux.suivi(n, [ev(0.2, "DI1", "Votre colis est livré."), ev(0.5, "MD2"), ev(1, "PC1"), ev(30, "DR1")], { isFinal: true });
  rendDu();
  assert.equal((await depots.synchronise()).nouveauxEvenements, 2);
  assert.equal(evts(), 4);
  const l = ligne(id);
  assert.equal(l.controle.categorie, "confirme");
  assert.equal(l.controle.livre, true);
  assert.equal(suivi(n).prochaine_le, null, "livre : plus de verification");
});

test("transporteur indisponible ou trop lent : erreur passagere, nouvel essai espace ; ce qu'on savait reste", async () => {
  faux.suivi("6A50000000001", [ev(1, "PC1")]);
  const connu = drope("6A50000000001");
  await depots.synchronise();
  faux.comporte("6A50000000001", "panne");
  faux.comporte("6A50000000002", "lent");
  const lent = drope("6A50000000002");
  rendDu();
  const bilan = await depots.synchronise();
  assert.equal(bilan.erreurs, 2);
  assert.equal(ligne(connu).controle.categorie, "confirme", "une panne n'efface pas une preuve deja lue");
  const l = ligne(lent);
  assert.equal(l.controle.categorie, "a_verifier");
  assert.match(l.controle.raison, /délai dépassé/);
  const prochaine = Date.parse(`${suivi("6A50000000002").prochaine_le.replace(" ", "T")}Z`);
  assert.ok(prochaine - Date.now() > 10 * 60 * 1000, "reessai dans 15 min, pas tout de suite");
});

test("trois pannes de suite : La Poste est mise en pause, le reste du passage attend", async () => {
  for (const n of ["6A60000000001", "6A60000000002", "6A60000000003", "6A60000000004", "6A60000000005"]) {
    faux.comporte(n, "panne");
    drope(n);
  }
  const bilan = await depots.synchronise();
  assert.equal(faux.appels.length, 3);
  assert.equal(bilan.reportes, 2);
  const etat = depots.etat();
  assert.match(etat.methodes.laposte.pause.motif, /plusieurs échecs/);
});

test("blocage ou limite : pause immediate, plus aucun appel, « Vérification bloquée » (jamais « non déposé »), puis reprise", async () => {
  const ids = ["6A70000000001", "6A70000000002", "6A70000000003"].map((n) => {
    faux.suivi(n, [ev(20, "DR1")]);
    return drope(n);
  });
  faux.force(429, {}, { "Retry-After": "60" });
  const bilan = await depots.synchronise();
  assert.equal(faux.appels.length, 1, "on s'arrete au premier refus");
  assert.equal(bilan.pauses.length, 1);
  for (const id of ids) {
    const c = ligne(id).controle;
    assert.equal(c.categorie, "bloque");
    assert.equal(c.libelle, "Vérification bloquée");
    assert.match(c.raison, /pause demandée/);
  }
  // pendant la pause : ni le passage, ni le bouton « Vérifier » n'appellent
  rendDu();
  await depots.synchronise();
  const e = await echec(depots.verifieColis(ids[0]));
  assert.equal(e.status, 429);
  assert.equal(faux.appels.length, 1);
  // une recidive double la pause
  const pause1 = db.db.prepare("SELECT * FROM controle_transporteurs WHERE code = 'laposte'").get();
  db.db.prepare("UPDATE controle_transporteurs SET bloque_jusqua = datetime('now', '-1 minute')").run();
  faux.force(403, {});
  await depots.synchronise();
  const pause2 = db.db.prepare("SELECT * FROM controle_transporteurs WHERE code = 'laposte'").get();
  assert.equal(pause2.echecs, pause1.echecs + 1);
  assert.equal(pause2.type, "bloque");
  assert.match(pause2.motif, /accès refusé/);
  // la pause finie, la file reprend et efface l'alerte
  db.db.prepare("UPDATE controle_transporteurs SET bloque_jusqua = datetime('now', '-1 minute')").run();
  await depots.synchronise();
  assert.equal(faux.appels.length, 5);
  assert.equal(depots.etat().methodes.laposte.pause, null);
  assert.equal(db.db.prepare("SELECT echecs FROM controle_transporteurs WHERE code = 'laposte'").get().echecs, 0);
  assert.equal(ligne(ids[0]).controle.categorie, "non_confirme");
});

test("redemarrage : la file reprend la ou elle en etait", async () => {
  process.env.CONTROLE_MAX_PAR_PASSAGE = "2";
  for (const n of ["6A80000000001", "6A80000000002", "6A80000000003", "6A80000000004"]) {
    faux.suivi(n, [ev(20, "DR1")]);
    drope(n);
  }
  await depots.synchronise();
  assert.equal(faux.appels.length, 2);
  // un nouveau processus : le module repart de zero, la base garde la file
  for (const k of Object.keys(require.cache)) if (k.includes("/src/controle/")) delete require.cache[k];
  const relance = require("../src/controle/depots");
  await relance.synchronise();
  assert.deepEqual(faux.appels.map((a) => a.numero).sort(), ["6A80000000001", "6A80000000002", "6A80000000003", "6A80000000004"]);
  depots = relance;
});

test("Mondial Relay, UPS, DHL : jamais appeles, « Vérification bloquée » avec le lien officiel, constat a la main", async () => {
  const mr = drope("12345678", { carrier: "MR", heures: 30 });
  const ups = drope("1Z999AA10123456784", { carrier: "UPS" });
  const dhl = drope("JJD0146000128653732", { carrier: "DHL" });
  await depots.synchronise();
  assert.equal(faux.appels.length, 0);
  for (const [id, numero, raison] of [
    [mr, "12345678", /Cloudflare/],
    [ups, "1Z999AA10123456784", /Access Denied/],
    [dhl, "JJD0146000128653732", /blocked/],
  ]) {
    const l = ligne(id);
    assert.equal(l.controle.categorie, "bloque");
    assert.equal(l.controle.manuel, true);
    assert.match(l.controle.raison, raison);
    assert.ok(l.lien.includes(numero), l.lien);
    assert.equal(suivi(numero).prochaine_le, null, "jamais dans la file automatique");
  }
  assert.equal(ligne(mr).attention, true, "drope il y a 30 h : a constater");
  assert.equal(ligne(ups).attention, false, "drope il y a 2 h : trop tot");
  assert.equal(depots.vue().compteurs.aConstater, 1);
  assert.equal((await echec(depots.verifieColis(mr))).status, 409);

  assert.equal(depots.constate(mr, "pris").controle.categorie, "confirme");
  assert.match(ligne(mr).controle.raison, /constatée à la main/);
  // le dernier constat fait foi (une erreur de clic se corrige)
  assert.equal(depots.constate(mr, "pas_encore").controle.categorie, "non_confirme");
  depots.constate(mr, "annule");
  assert.equal(ligne(mr).controle.categorie, "bloque");
  assert.equal(depots.constate(mr, "probleme").controle.categorie, "anomalie");
  assert.equal((await echec(Promise.resolve().then(() => depots.constate(ups, "peut-etre")))).status, 400);
  assert.equal(faux.appels.length, 0);
});

test("DPD et Chronopost passent par l'API La Poste", async () => {
  faux.suivi("05212345678901", [ev(1, "PC1", "Colis déposé par l'expéditeur")], { product: "dpd" });
  faux.suivi("XT269045554TS", [ev(1, "PC1", "Pris en charge")], { product: "chronopost" });
  const dpd = drope("05212345678901", { carrier: "DPD" });
  const chrono = drope("XT269045554TS", { carrier: "CHRONO" });
  await depots.synchronise();
  assert.equal(ligne(dpd).transporteur.methode, "laposte");
  assert.equal(ligne(dpd).controle.categorie, "confirme");
  assert.match(ligne(dpd).controle.raison, /déposé par l'expéditeur/);
  assert.equal(ligne(chrono).controle.categorie, "confirme");
});

test("« Vérifier » : lecture immediate, puis 2 minutes de cache", async () => {
  faux.suivi("6A90000000001", [ev(20, "DR1")]);
  const id = drope("6A90000000001");
  const d = await depots.verifieColis(id);
  assert.equal(d.controle.categorie, "non_confirme");
  assert.ok(d.verifieLe);
  assert.ok(d.evenements.length === 1 && d.liens.transporteur.includes("6A90000000001"));
  await depots.verifieColis(id);
  assert.equal(faux.appels.length, 1);
  // une erreur sur ce numero est notee, sans bloquer le transporteur
  db.db.prepare("UPDATE controle_suivis SET verifie_le = datetime('now', '-5 minutes')").run();
  faux.comporte("6A90000000001", "panne");
  const apres = await depots.verifieColis(id);
  assert.equal(apres.erreur.code, "passagere");
  assert.equal(apres.controle.categorie, "non_confirme", "l'etiquette deja lue reste");
  assert.equal(depots.etat().methodes.laposte.pause, null);
});

test("« Relancer » : avance les verifications en attente, sauf celles lues il y a moins de 10 minutes", async () => {
  for (const n of ["6A91000000001", "6A91000000002"]) {
    faux.suivi(n, [ev(20, "DR1")]);
    drope(n);
  }
  await depots.synchronise();
  depots.relance();
  await depots.synchronise(); // le passage en cours (meme promesse)
  assert.equal(faux.appels.length, 2, "lus a l'instant : pas relus");
  db.db.prepare("UPDATE controle_suivis SET verifie_le = datetime('now', '-1 hour') WHERE numero = '6A91000000001'").run();
  depots.relance();
  await depots.synchronise();
  assert.equal(faux.appels.length, 3);
  assert.equal(faux.appels[2].numero, "6A91000000001", "seul celui lu il y a une heure est relu");
});

test("un colis remis en attente sort de la file ; sans OKAPI_KEY rien n'est appele et la page le dit", async () => {
  faux.suivi("6A92000000001", [ev(20, "DR1")]);
  const id = drope("6A92000000001");
  await depots.synchronise();
  db.undropColis(id);
  rendDu();
  await depots.synchronise();
  assert.equal(faux.appels.length, 1);
  assert.equal(suivi("6A92000000001").prochaine_le, null);

  process.env.OKAPI_KEY = "";
  const autre = drope("6A92000000002");
  await depots.synchronise();
  assert.equal(faux.appels.length, 1);
  assert.match(ligne(autre).controle.raison, /OKAPI_KEY/);
  assert.equal(depots.etat().methodes.laposte.configure, false);
  assert.equal((await echec(depots.verifieColis(autre))).status, 503);
});

test("la table des colis n'est jamais modifiee", async () => {
  faux.suivi("6A93000000001", [ev(1, "RE1", "Retourné à l'expéditeur"), ev(10, "PC1")]);
  faux.comporte("6A93000000002", "invalide");
  const a = drope("6A93000000001", { heures: 30 });
  drope("6A93000000002");
  const mr = drope("87654321", { carrier: "MR" });
  const photo = () => JSON.stringify(db.db.prepare("SELECT * FROM colis ORDER BY id").all());
  const avant = photo();
  await depots.synchronise();
  await depots.verifieColis(a);
  depots.constate(mr, "pris");
  depots.relance();
  await depots.synchronise();
  assert.equal(ligne(a).controle.categorie, "anomalie");
  assert.equal(photo(), avant);
});

test("boite jaune : l'ancien parcours ne bloque rien, la verification continue jusqu'au scan apres le drop", async () => {
  const c = db.addColis("Alice", { fileId: "F-BJ", fileKind: "pdf", type: "bj", fileName: "BOITEJAUNE6Y11147788515.pdf" });
  db.dropColis(c.id);
  db.db.prepare("UPDATE colis SET created_at = datetime('now', '-10 hours'), dropped_at = datetime('now', '-8 hours') WHERE id = ?").run(c.id);
  // deja livre en point relais AVANT que FeurDrop recoive l'etiquette
  faux.suivi("6Y11147788515", [ev(20, "DI1", "Votre colis a été livré"), ev(22, "AG1"), ev(30, "ET1"), ev(34, "DR1")], { isFinal: true });
  await depots.synchronise();
  assert.equal(faux.appels.length, 1);
  let l = ligne(c.id);
  assert.equal(l.controle.categorie, "non_confirme");
  assert.match(l.controle.raison, /boîte jaune/);
  assert.ok(suivi("6Y11147788515").prochaine_le, "l'ancien parcours (livre) n'arrete pas les verifications");
  // apres le drop : de nouveau en transit -- c'est la preuve
  faux.suivi("6Y11147788515", [ev(2, "ET1", "Votre colis est en transit"), ev(20, "DI1", "Votre colis a été livré"), ev(22, "AG1"), ev(30, "ET1"), ev(34, "DR1")]);
  rendDu();
  await depots.synchronise();
  l = ligne(c.id);
  assert.equal(l.controle.categorie, "confirme");
  assert.equal(l.controle.preuve.code, "ET1");
});

test("les routes de la page", async () => {
  faux.suivi("6A94000000001", [ev(1, "PC1")]);
  const id = drope("6A94000000001");
  const mr = drope("11223344", { carrier: "MR" });
  const app = await demarreApp();
  try {
    let r = await app.appel("/api/depots");
    assert.equal(r.status, 200);
    assert.equal(r.json.lignes.length, 2);
    assert.equal(r.json.compteurs.bloque, 1);
    assert.equal(faux.appels.length, 0, "ouvrir la page n'appelle aucun transporteur");
    r = await app.appel(`/api/depots/${id}/verifier`, { methode: "POST" });
    assert.equal(r.status, 200);
    assert.equal(r.json.controle.categorie, "confirme");
    r = await app.appel(`/api/depots/${mr}/verifier`, { methode: "POST" });
    assert.equal(r.status, 409);
    r = await app.appel(`/api/depots/${mr}/constat`, { methode: "POST", corps: { resultat: "pris" } });
    assert.equal(r.json.controle.categorie, "confirme");
    r = await app.appel(`/api/depots/${mr}/constat`, { methode: "POST", corps: { resultat: "rien" } });
    assert.equal(r.status, 400);
    r = await app.appel("/api/depots/relancer", { methode: "POST" });
    assert.equal(r.status, 202);
    await depots.synchronise();
    r = await app.appel("/api/depots/resume");
    assert.deepEqual(Object.keys(r.json), ["compteurs"]);
    assert.equal((await app.appel("/api/depots/999999")).status, 404);
  } finally {
    await app.ferme();
  }
});
