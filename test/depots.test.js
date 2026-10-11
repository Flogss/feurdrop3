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

const REGLAGES = { CONTROLE_LAPOSTE_INTERVALLE_MS: "40", CONTROLE_MAX_PAR_PASSAGE: "80", CONTROLE_LAPOSTE_DELAI_MS: "1500" };
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
  // un numero refuse n'est pas redemande ; un depot prouve non plus (la
  // question est reglee) ; les autres ont leur prochaine heure
  assert.equal(suivi("6A10000000004").prochaine_le, null);
  assert.equal(suivi("6A10000000001").prochaine_le, null, "depot prouve : plus relu");
  for (const n of ["6A10000000002", "6A10000000003"]) assert.ok(suivi(n).prochaine_le, n);
  // la memoire de la lecture : methode, statut brut, statut normalise
  assert.equal(suivi("6A10000000001").methode_lecture, "laposte");
  assert.equal(suivi("6A10000000001").statut, "confirme");
  assert.equal(suivi("6A10000000002").statut, "non_confirme");
  assert.match(suivi("6A10000000002").statut_brut, /bientôt nous être confié/);
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

test("statut deja connu, puis relecture : rien n'est double, et un depot prouve n'est plus relu", async () => {
  const n = "6A40000000001";
  faux.suivi(n, [ev(30, "DR1")]);
  const id = drope(n);
  await depots.synchronise();
  const evts = () => db.db.prepare("SELECT COUNT(*) AS c FROM controle_evenements WHERE numero = ?").get(n).c;
  assert.equal(evts(), 1);
  // meme reponse : rien de neuf
  rendDu();
  const bilan = await depots.synchronise();
  assert.equal(bilan.nouveauxEvenements, 0);
  assert.equal(evts(), 1);
  // la prise en charge arrive : seuls les nouveaux evenements sont ajoutes
  faux.suivi(n, [ev(0.5, "ET1"), ev(1, "PC1"), ev(30, "DR1")]);
  rendDu();
  assert.equal((await depots.synchronise()).nouveauxEvenements, 2);
  assert.equal(evts(), 3);
  const l = ligne(id);
  assert.equal(l.controle.categorie, "confirme");
  assert.equal(suivi(n).prochaine_le, null, "depot prouve : plus de verification");
  const appels = faux.appels.length;
  rendDu();
  await depots.synchronise();
  assert.equal(faux.appels.length, appels, "plus jamais relu par la file");
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
  assert.equal(bilan.erreurs, 1);
  // « Vérifier » sur un depot prouve, transporteur en panne : la preuve reste
  db.db.prepare("UPDATE controle_suivis SET verifie_le = datetime('now', '-1 hour') WHERE numero = '6A50000000001'").run();
  const apres = await depots.verifieColis(connu);
  assert.equal(apres.erreur.code, "passagere");
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

test("UPS : jamais lu automatiquement (conditions d'utilisation), « Vérification bloquée », constat a la main", async () => {
  const ups = drope("1Z999AA10123456784", { carrier: "UPS", heures: 30 });
  const ups2 = drope("1Z999AA10123456786", { carrier: "UPS" });
  await depots.synchronise();
  assert.equal(faux.appels.length, 0);
  const l = ligne(ups);
  assert.equal(l.controle.categorie, "bloque");
  assert.equal(l.controle.manuel, true);
  assert.match(l.controle.raison, /interdisent toute consultation automatisée/);
  assert.ok(l.lien.includes("1Z999AA10123456784"), l.lien);
  assert.equal(suivi("1Z999AA10123456784").prochaine_le, null, "jamais dans la file automatique");
  assert.equal(ligne(ups).attention, true, "drope il y a 30 h : a constater");
  assert.equal(ligne(ups2).attention, false, "drope il y a 2 h : trop tot");
  assert.equal(depots.vue().compteurs.aConstater, 1);
  assert.equal((await echec(depots.verifieColis(ups))).status, 409);
  // « Tout vérifier » ne donne jamais UPS au Mac : il reste « à constater »
  depots.lanceCampagne({ force: true });
  assert.deepEqual(depots.travail().items, []);
  assert.equal(depots.campagne().compteurs.aConstater, 2);

  assert.equal(depots.constate(ups, "pris").controle.categorie, "confirme");
  assert.match(ligne(ups).controle.raison, /constatée à la main/);
  assert.equal(suivi("1Z999AA10123456784").methode_lecture, "manuel");
  // le dernier constat fait foi (une erreur de clic se corrige)
  assert.equal(depots.constate(ups, "pas_encore").controle.categorie, "non_confirme");
  depots.constate(ups, "annule");
  assert.equal(ligne(ups).controle.categorie, "bloque");
  assert.equal(depots.constate(ups, "probleme").controle.categorie, "a_verifier");
  assert.equal((await echec(Promise.resolve().then(() => depots.constate(ups, "peut-etre")))).status, 400);
  assert.equal(faux.appels.length, 0);
});

// ce que le Mac envoie : le texte visible de la page officielle
const pageMR = (lignes) => `Mondial Relay\nSuivi de colis\nSTATUT\n${lignes.find((l) => !/^[\d/:]+$/.test(l)) || ""}\nSUIVI GLOBAL DE MON COLIS\nColis en préparation chez l'expéditeur\nColis remis à Mondial Relay\nColis livré au destinataire\nSUIVI DÉTAILLÉ DE MON COLIS\n${lignes.join("\n")}\nJe m'informe`;
const jour = (h) => {
  const d = new Date(Date.now() - h * H);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
};

test("« Tout vérifier » : Mondial Relay lu par le Mac -- pris en charge, etiquette seule, inconnu, page bloquee, erreur reseau, reprise", async () => {
  const pris = drope("4278870015", { carrier: "MR", heures: 30 });
  const etiquette = drope("4278870016", { carrier: "MR", heures: 5 });
  const inconnu = drope("4278870017", { carrier: "MR", heures: 5 });
  const reseau = drope("4278870018", { carrier: "MR", heures: 5 });
  faux.suivi("6A95000000001", [ev(1, "PC1")]);
  const lp = drope("6A95000000001");
  // avant : Mondial Relay attend le Mac, il n'est jamais appele par le serveur
  await depots.synchronise();
  assert.equal(faux.appelsPour("4278870015").length, 0);
  assert.equal(ligne(pris).transporteur.methode, "navigateur");
  assert.equal(ligne(pris).controle.categorie, "a_verifier");
  assert.match(ligne(pris).controle.raison, /Tout vérifier/);

  // « Tout vérifier » : La Poste est deja prouve (rien a relire), MR attend le Mac
  const c = depots.nouvelleCampagne({ par: "site" });
  await depots.synchronise();
  assert.equal(c.compteurs.total, 4, "le depot La Poste deja prouve n'est pas relu");
  assert.equal(c.attendMac, true);

  // le Mac prend un lot : un seul transporteur, des adresses officielles, un bail
  const lot = depots.travail({ agent: "Mac de test", lot: 3 });
  assert.equal(lot.items.length, 3);
  assert.ok(lot.items.every((it) => it.transporteur === "MR" && it.url.startsWith("https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=")));
  assert.equal(depots.campagne().agent.actif, true);
  // les numeros pris ne sont pas redonnes tant que le bail court
  const lot2 = depots.travail({ agent: "Mac de test", lot: 3 });
  assert.deepEqual(lot2.items.map((it) => it.numero), ["4278870018"]);

  const r = depots.recoitResultats(
    [
      { numero: "4278870015", transporteur: "MR", url: lot.items[0].url, titre: "Suivi de colis - Mondial Relay", texte: pageMR([jour(28), "Colis pris en charge en Point Relais", "20:31", "Colis en préparation chez l'expéditeur", "12:42"]) },
      { numero: "4278870016", transporteur: "MR", titre: "Suivi de colis - Mondial Relay", texte: pageMR([jour(4), "Colis en préparation chez l'expéditeur", "12:42"]) },
      { numero: "4278870017", transporteur: "MR", titre: "Suivi de colis - Mondial Relay", texte: "Nous n’avons identifié aucun colis portant ce numéro de suivi 😞" },
      { numero: "4278870018", transporteur: "MR", erreur: "délai dépassé" },
      // un resultat pour un numero qui n'est pas un colis drope : ignore
      { numero: "9999999999", transporteur: "MR", texte: pageMR(["Colis livré au destinataire"]) },
    ],
    { agent: "Mac de test" }
  );
  assert.deepEqual(r.resultats.map((x) => x.etat), ["trouve", "trouve", "introuvable", "erreur", "ignore"]);
  assert.equal(ligne(pris).controle.categorie, "confirme");
  assert.match(ligne(pris).controle.raison, /page officielle lue sur le Mac/);
  assert.equal(ligne(etiquette).controle.categorie, "non_confirme");
  assert.equal(ligne(inconnu).controle.categorie, "a_verifier");
  assert.equal(ligne(reseau).controle.categorie, "a_verifier", "une erreur reseau ne dit rien du colis");
  // la memoire : methode, statut brut, adresse lue, qui l'a lue
  const m = suivi("4278870015");
  assert.equal(m.methode_lecture, "navigateur");
  assert.equal(m.statut, "confirme");
  assert.equal(m.statut_brut, "Colis pris en charge en Point Relais");
  assert.ok(m.page_url.includes("4278870015"));
  assert.equal(m.lu_par, "Mac de test");

  // reprise : l'erreur reseau repart une fois (pas de boucle) ; un Mac
  // endormi rend son bail ; la deuxieme erreur est definitive
  let etat = depots.campagne();
  assert.equal(etat.compteurs.restants, 1);
  db.db.prepare("UPDATE controle_campagne_items SET bail_jusqua = datetime('now', '-1 minute') WHERE etat = 'en_cours'").run();
  const reprise = depots.travail({ agent: "Mac de test" });
  assert.deepEqual(reprise.items.map((it) => it.numero), ["4278870018"]);
  depots.recoitResultats([{ numero: "4278870018", transporteur: "MR", erreur: "délai dépassé" }]);
  etat = depots.campagne();
  assert.equal(etat.compteurs.erreurs, 1);
  assert.equal(etat.compteurs.restants, 0);
  assert.equal(etat.campagne.statut, "terminee", "plus rien a lire : la campagne se termine d'elle-meme");
  assert.equal(etat.compteurs.verifies, 3);
  assert.equal(etat.compteurs.confirmes, 1);
  assert.equal(etat.compteurs.nonConfirmes, 1);

  // une page bloquee : arret pour Mondial Relay, ses autres numeros aussi, pause
  const autre = drope("4278870019", { carrier: "MR", heures: 5 });
  depots.lanceCampagne({ force: true });
  const lot3 = depots.travail({ agent: "Mac de test", lot: 1 });
  depots.recoitResultats([{ numero: lot3.items[0].numero, transporteur: "MR", titre: "Just a moment...", texte: "Vérifiez que vous êtes humain" }]);
  etat = depots.campagne();
  assert.ok(etat.compteurs.bloques >= 2, "le numero lu et les autres de Mondial Relay");
  assert.deepEqual(depots.travail({ agent: "Mac de test" }).items, [], "plus rien n'est donne au Mac pour Mondial Relay");
  assert.equal(ligne(autre).controle.categorie, "bloque");
  assert.match(ligne(autre).controle.raison, /Mondial Relay/);
  // ce qui etait prouve le reste
  assert.equal(ligne(pris).controle.categorie, "confirme");
  assert.equal(depots.etat().lecture.find((l) => l.code === "MR").pause.type, "bloque");

  // une demande explicite redonne une chance (le defi a pu etre resolu) ;
  // le depot deja prouve n'est jamais redemande
  depots.lanceCampagne({ force: true });
  const lot4 = depots.travail({ agent: "Mac de test", lot: 12 });
  assert.ok(lot4.items.length > 0);
  assert.ok(!lot4.items.some((it) => it.numero === "4278870015"));
  // ni La Poste ni la table des colis n'ont ete touchees par tout ca
  assert.equal(faux.appelsPour("4278870015").length, 0);
  assert.equal(ligne(lp).controle.categorie, "confirme");
});

test("lecture coupee pour un transporteur : la page se verifie a la main, le Mac ne la recoit pas", async () => {
  const dhl = drope("JJD0146000128653732", { carrier: "DHL", heures: 30 });
  assert.equal(ligne(dhl).transporteur.methode, "navigateur");
  depots.coupeLecture("DHL", true);
  assert.equal(ligne(dhl).transporteur.methode, "manuel");
  assert.equal(ligne(dhl).controle.categorie, "bloque");
  depots.lanceCampagne({ force: true });
  assert.deepEqual(depots.travail().items, []);
  assert.equal(depots.etat().lecture.find((l) => l.code === "DHL").active, false);
  depots.coupeLecture("DHL", false);
  depots.lanceCampagne({ force: true });
  assert.equal(depots.travail().items[0].numero, "JJD0146000128653732");
  assert.throws(() => depots.coupeLecture("UPS", false), /ne se lit pas/);
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
  // « Tout vérifier » sans cle : ces numeros finissent en erreur, la campagne se termine
  depots.lanceCampagne({ force: true });
  const etat = depots.campagne();
  assert.equal(etat.compteurs.erreurs, 1);
  assert.equal(etat.campagne.statut, "terminee");
});

test("la table des colis n'est jamais modifiee", async () => {
  faux.suivi("6A93000000001", [ev(1, "RE1", "Retourné à l'expéditeur"), ev(10, "PC1")]);
  faux.comporte("6A93000000002", "invalide");
  const a = drope("6A93000000001", { heures: 30 });
  drope("6A93000000002");
  const ups = drope("1Z999AA10123456785", { carrier: "UPS" });
  const photo = () => JSON.stringify(db.db.prepare("SELECT * FROM colis ORDER BY id").all());
  const avant = photo();
  await depots.synchronise();
  await depots.verifieColis(a);
  depots.constate(ups, "pris");
  depots.relance();
  await depots.synchronise();
  const mr = drope("4278870020", { carrier: "MR" });
  const avant2 = photo();
  depots.nouvelleCampagne({});
  // « Tout vérifier » lance l'API La Poste en fond : on attend ce passage
  await depots.synchronise();
  depots.travail({});
  depots.recoitResultats([{ numero: "4278870020", transporteur: "MR", texte: pageMR([jour(1), "Colis pris en charge en Point Relais"]) }]);
  depots.annuleCampagne();
  // un retour apres la prise en charge : posté confirmé, la suite dans le detail
  assert.equal(ligne(a).controle.categorie, "confirme");
  assert.equal(ligne(a).controle.suite.retour, true);
  assert.equal(ligne(mr).controle.categorie, "confirme");
  assert.equal(photo(), avant2);
  assert.ok(avant2.startsWith(avant.slice(0, -1)));
});

test("boite jaune deja en point relais avant la reception de l'etiquette : depot confirme, et c'est dit", async () => {
  const c = db.addColis("Alice", { fileId: "F-BJ", fileKind: "pdf", type: "bj", fileName: "BOITEJAUNE6Y11147788515.pdf" });
  db.dropColis(c.id);
  db.db.prepare("UPDATE colis SET created_at = datetime('now', '-10 hours'), dropped_at = datetime('now', '-8 hours') WHERE id = ?").run(c.id);
  faux.suivi("6Y11147788515", [ev(1, "ET1", "Votre colis est en transit"), ev(22, "AG1", "Votre Colissimo vous attend dans votre point de retrait."), ev(34, "DR1")]);
  await depots.synchronise();
  assert.equal(faux.appels.length, 1);
  const l = ligne(c.id);
  assert.equal(l.controle.categorie, "confirme");
  assert.equal(l.controle.preuve.code, "AG1");
  assert.match(l.controle.raison, /En point de retrait le .* antérieur à la réception de l'étiquette/);
});

test("les routes de la page", async () => {
  faux.suivi("6A94000000001", [ev(1, "PC1")]);
  const id = drope("6A94000000001");
  const dhl = drope("JJD0146000128653733", { carrier: "DHL" });
  const app = await demarreApp();
  try {
    let r = await app.appel("/api/depots");
    assert.equal(r.status, 200);
    assert.equal(r.json.lignes.length, 2);
    assert.equal(r.json.compteurs.a_verifier, 2);
    assert.equal(r.json.compteurs.anomalie, 0, "garde pour les anciennes versions de l'app");
    assert.equal(faux.appels.length, 0, "ouvrir la page n'appelle aucun transporteur");
    r = await app.appel(`/api/depots/${id}/verifier`, { methode: "POST" });
    assert.equal(r.status, 200);
    assert.equal(r.json.controle.categorie, "confirme");
    // DHL : « Vérifier » confie la page au Mac
    r = await app.appel(`/api/depots/${dhl}/verifier`, { methode: "POST" });
    assert.equal(r.status, 200);
    assert.equal(r.json.enAttenteDuMac, true);
    // « Tout vérifier » et ce que fait le Mac
    r = await app.appel("/api/depots/campagne", { methode: "POST", corps: {} });
    assert.equal(r.status, 202);
    r = await app.appel("/api/depots/campagne/travail?agent=Mac&lot=4");
    assert.equal(r.json.items[0].numero, "JJD0146000128653733");
    r = await app.appel("/api/depots/campagne/resultats", { methode: "POST", corps: { agent: "Mac", resultats: [{ numero: "JJD0146000128653733", transporteur: "DHL", texte: "Désolé, votre tentative de suivi a échoué." }] } });
    assert.equal(r.json.resultats[0].etat, "introuvable");
    assert.equal((await app.appel("/api/depots/campagne/resultats", { methode: "POST", corps: {} })).status, 400);
    r = await app.appel("/api/depots/campagne");
    assert.equal(r.json.campagne.statut, "terminee");
    r = await app.appel("/api/depots/lecture/DHL", { methode: "POST", corps: { active: false } });
    assert.equal(r.json.lecture.find((l) => l.code === "DHL").active, false);
    r = await app.appel("/api/depots/campagne/annuler", { methode: "POST" });
    assert.equal(r.status, 200);
    r = await app.appel(`/api/depots/${dhl}/constat`, { methode: "POST", corps: { resultat: "pris" } });
    assert.equal(r.json.controle.categorie, "confirme");
    r = await app.appel(`/api/depots/${dhl}/constat`, { methode: "POST", corps: { resultat: "rien" } });
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
