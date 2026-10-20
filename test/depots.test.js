// Le controle des depots de bout en bout, contre de faux serveurs (La Poste,
// UPS, DHL : SIMULES, aux formats de leur documentation) et les textes de
// pages officielles tels que le Mac les envoie (mise en page reelle de
// Mondial Relay, relevee sur de vrais colis) :
//   - la file (cadence, plafond, reprise apres redemarrage, pas de doublon) ;
//   - la sortie de la file active : un depot prouve s'en va (et n'y revient
//     jamais), un numero vraiment inconnu en est retire, une erreur reseau ne
//     retire jamais rien ;
//   - les faux positifs : etiquette seule, ancien parcours d'un numero reutilise ;
//   - le Mac : en ligne / hors ligne, file persistante, defi anti-robot ;
//   - et la regle : la table des colis n'est jamais touchee.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase, demarreApp } = require("./aide");
const { creeFauxLaPoste } = require("./fixtures/faux-laposte");
const { creeFauxUPS, creeFauxDHL } = require("./fixtures/faux-transporteurs");

environnementDeTest();
const faux = creeFauxLaPoste();
const fauxUPS = creeFauxUPS();
const fauxDHL = creeFauxDHL();
const db = require("../src/db");
let depots;
let urlUPS;
let urlDHL;

const REGLAGES = { CONTROLE_LAPOSTE_INTERVALLE_MS: "40", CONTROLE_MAX_PAR_PASSAGE: "80", CONTROLE_LAPOSTE_DELAI_MS: "1500" };
before(async () => {
  process.env.LAPOSTE_SUIVI_URL = await faux.demarre();
  urlUPS = await fauxUPS.demarre();
  urlDHL = await fauxDHL.demarre();
  depots = require("../src/controle/depots");
});
after(async () => {
  await faux.ferme();
  await fauxUPS.ferme();
  await fauxDHL.ferme();
});
beforeEach(() => {
  videBase();
  faux.vide();
  faux.appels.length = 0;
  fauxUPS.vide();
  fauxDHL.vide();
  for (const v of ["UPS_CLIENT_ID", "UPS_CLIENT_SECRET", "UPS_API_URL", "DHL_API_KEY", "DHL_API_URL"]) delete process.env[v];
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
// le detail d'un colis (qu'il soit dans la file active ou non)
const ligne = (colisId) => depots.detail(colisId);
// dans la file active ?
const actif = (colisId) => depots.vue().lignes.some((l) => l.colisId === colisId);
const suivi = (numero) => db.db.prepare("SELECT * FROM controle_suivis WHERE numero = ?").get(numero);
const nbEvenements = (numero) => db.db.prepare("SELECT COUNT(*) AS c FROM controle_evenements WHERE numero = ?").get(numero).c;
const rendDu = () => db.db.prepare("UPDATE controle_suivis SET prochaine_le = datetime('now', '-1 minute'), verifie_le = datetime('now', '-1 hour') WHERE prochaine_le IS NOT NULL").run();
const levePauses = () => db.db.prepare("UPDATE controle_transporteurs SET bloque_jusqua = datetime('now', '-1 minute')").run();
const echec = (p) => p.then(() => assert.fail("aurait du echouer"), (e) => e);
const photoColis = () => JSON.stringify(db.db.prepare("SELECT * FROM colis ORDER BY id").all());

// --- La page de suivi Mondial Relay, telle que le Mac l'envoie ----------------------
// (la mise en page relevee sur de vrais colis : le numero affiche -- ses 8
// derniers chiffres --, le « suivi global » des etapes possibles, puis le
// suivi detaille : une date, le titre du jour, des paires heure / evenement)
const paris = (h) => {
  const parties = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(Date.now() - h * H))
      .map((p) => [p.type, p.value])
  );
  return { date: `${parties.day}/${parties.month}/${parties.year}`, heure: `${parties.hour}:${parties.minute}` };
};
// evenements : [[il y a h heures, libelle], ...] du plus recent au plus ancien
function pageMR(numero, evenements) {
  const jours = [];
  for (const [h, libelle] of evenements) {
    const { date, heure } = paris(h);
    let j = jours.find((x) => x.date === date);
    if (!j) jours.push((j = { date, lignes: [libelle] }));
    j.lignes.push(heure, libelle);
  }
  return [
    "Mondial Relay",
    "Suivi de colis",
    "NUMÉRO DE COLIS",
    String(numero).slice(-8),
    "STATUT",
    "SUIVI GLOBAL DE MON COLIS",
    "Colis en préparation chez l'expéditeur",
    "Colis remis à Mondial Relay",
    "Colis livré au destinataire",
    "SUIVI DÉTAILLÉ DE MON COLIS",
    ...jours.flatMap((j) => [j.date, ...j.lignes]),
    "Je m'informe",
  ].join("\n");
}
const resultatMR = (numero, evenements, extra = {}) => ({
  numero,
  transporteur: "MR",
  url: `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${numero}`,
  titre: "Suivi de colis - Mondial Relay",
  texte: pageMR(numero, evenements),
  ...extra,
});
const INCONNU_MR = "Nous n’avons identifié aucun colis portant ce numéro de suivi 😞";

// =====================================================================================
// Les cas obligatoires
// =====================================================================================

test("etiquette seule : non confirmé, reste dans la file active", async () => {
  faux.suivi("6A10000000002", [ev(30, "DR1", "Votre Colissimo va bientôt nous être confié ! Il est en cours de préparation chez votre expéditeur.")]);
  const id = drope("6A10000000002");
  await depots.synchronise();
  const l = ligne(id);
  assert.equal(l.controle.categorie, "non_confirme");
  assert.equal(l.controle.enRetard, false, "2 h apres le drop, c'est le delai normal");
  assert.equal(actif(id), true);
  assert.equal(suivi("6A10000000002").statut, "non_confirme");
  assert.equal(suivi("6A10000000002").confirme_le, null);
  assert.match(suivi("6A10000000002").statut_brut, /bientôt nous être confié/);
  assert.ok(suivi("6A10000000002").prochaine_le, "relu plus tard");
});

test("premier scan : posté confirmé, sort de la file active, date de confirmation et preuve gardees", async () => {
  const n = "6A10000000001";
  faux.suivi(n, [ev(30, "DR1", "Votre Colissimo va bientôt nous être confié !")]);
  const id = drope(n);
  await depots.synchronise();
  assert.equal(actif(id), true);
  // le premier scan arrive
  faux.suivi(n, [ev(0.5, "PC1", "Votre colis a été déposé dans un point postal."), ev(30, "DR1", "Votre Colissimo va bientôt nous être confié !")]);
  rendDu();
  await depots.synchronise();
  const l = ligne(id);
  assert.equal(l.controle.categorie, "confirme");
  assert.equal(l.controle.preuve.code, "PC1");
  assert.ok(l.confirmeLe);
  const v = depots.vue();
  assert.equal(v.lignes.some((x) => x.colisId === id), false, "plus dans la file active");
  const h = v.historique.confirmes.find((x) => x.colisId === id);
  assert.ok(h, "dans l'historique des confirmés");
  assert.ok(h.confirmeLe);
  assert.equal(h.preuve.statut, "Votre colis a été déposé dans un point postal.");
  assert.equal(v.compteurs.confirme, 1);
  assert.equal(v.compteurs.actifs, 0);
  const s = suivi(n);
  assert.equal(s.statut, "confirme");
  assert.ok(s.confirme_le);
  assert.match(s.preuve_libelle, /déposé dans un point postal/);
  // plus controle ; mais un colis La Poste reste suivi (calmement) jusqu'a
  // sa livraison, pour les actualites de l'espace expediteur
  const dans = (Date.parse(`${s.prochaine_le.replace(" ", "T")}Z`) - Date.now()) / H;
  assert.ok(dans > 3.5 && dans <= 4, `prochaine lecture dans ${dans} h`);
  // le colis et son etiquette sont intacts
  assert.equal(db.db.prepare("SELECT status FROM colis WHERE id = ?").get(id).status, "dropped");
});

test("en transit : posté confirmé", async () => {
  faux.suivi("6A10000000005", [ev(1, "ET1", "Votre colis est en transit sur nos plateformes logistiques."), ev(30, "DR1")]);
  const id = drope("6A10000000005");
  await depots.synchronise();
  assert.equal(ligne(id).controle.categorie, "confirme");
  assert.equal(ligne(id).controle.preuve.etape, "in_transit");
  assert.equal(actif(id), false);
});

test("livré : posté confirmé, et ne revient jamais dans la file (ni « Tout vérifier », ni « Relancer », ni une panne)", async () => {
  const n = "6A10000000006";
  faux.suivi(n, [ev(1, "DI1", "Votre colis est livré."), ev(10, "ET1"), ev(20, "PC1"), ev(40, "DR1")]);
  const id = drope(n, { heures: 30 });
  await depots.synchronise();
  assert.equal(ligne(id).controle.categorie, "confirme");
  assert.equal(ligne(id).controle.livre, true);
  assert.equal(actif(id), false);
  assert.equal(suivi(n).final, 1, "livre : son suivi est fini");
  assert.equal(suivi(n).prochaine_le, null);
  const appels = faux.appels.length;
  // ni la file, ni « Relancer », ni « Tout vérifier » ne le relisent
  rendDu();
  await depots.synchronise();
  depots.relance();
  await depots.synchronise();
  const c = depots.nouvelleCampagne({ par: "test" });
  await depots.synchronise();
  assert.equal(c.compteurs.total, 0);
  assert.equal(faux.appels.length, appels);
  // « Vérifier » sur ce colis : une panne ne le remet pas dans la file
  faux.comporte(n, "panne");
  db.db.prepare("UPDATE controle_suivis SET verifie_le = datetime('now', '-1 hour') WHERE numero = ?").run(n);
  await depots.verifieColis(id);
  assert.equal(ligne(id).controle.categorie, "confirme");
  assert.equal(actif(id), false);
  assert.equal(suivi(n).prochaine_le, null);
});

test("« mis à disposition du vendeur » apres la prise en charge (Mondial Relay) : confirmé, aucune anomalie", async () => {
  const n = "4278870015";
  const id = drope(n, { carrier: "MR", heures: 70 });
  depots.lanceCampagne({ force: true });
  const lot = depots.travail({ agent: "Mac de test" });
  assert.deepEqual(lot.items.map((it) => it.numero), [n]);
  const r = depots.recoitResultats([resultatMR(n, [[2, "Votre colis est mis à disposition du vendeur"], [60, "Colis pris en charge en Point Relais"], [64, "Colis en préparation chez l'expéditeur"]])], { agent: "Mac de test" });
  assert.equal(r.resultats[0].etat, "trouve");
  const l = ligne(id);
  assert.equal(l.controle.categorie, "confirme");
  assert.match(l.controle.raison, /Pris en charge/);
  assert.match(l.controle.suite.libelle, /mis à disposition du vendeur/);
  assert.equal(l.controle.suite.retour, true, "la suite est notee, sans alerte");
  assert.equal(l.attention, false);
  assert.equal(actif(id), false);
  // le meme cas chez La Poste : retour a l'expediteur apres le depot
  faux.suivi("6A93000000001", [ev(1, "RE1", "Retourné à l'expéditeur"), ev(10, "PC1")]);
  const lp = drope("6A93000000001", { heures: 30 });
  await depots.synchronise();
  assert.equal(ligne(lp).controle.categorie, "confirme");
  assert.equal(ligne(lp).controle.suite.retour, true);
  assert.equal(depots.vue().compteurs.attention, 0);
});

test("numero vraiment inconnu : retiré de la file active (lectures repetees, espacees), le colis reste", async () => {
  const n = "6A11000000001";
  const id = drope(n, { heures: 80 });
  const avant = photoColis();
  await depots.synchronise();
  // une premiere lecture « inconnu » : a regarder, pas encore retire
  let l = ligne(id);
  assert.equal(l.controle.categorie, "a_verifier");
  assert.equal(l.controle.inconnu, true);
  assert.equal(actif(id), true);
  assert.equal(suivi(n).inconnu_lectures, 1);
  // deuxieme lecture trop tot (moins de 12 h) : rien ne change
  rendDu();
  await depots.synchronise();
  assert.equal(suivi(n).inconnu_lectures, 2);
  assert.equal(suivi(n).archive_le, null, "deux lectures rapprochees ne suffisent pas");
  // 13 h plus tard, toujours inconnu : retire de la file
  db.db.prepare("UPDATE controle_suivis SET inconnu_premier_le = datetime('now', '-13 hours') WHERE numero = ?").run(n);
  rendDu();
  await depots.synchronise();
  const s = suivi(n);
  assert.ok(s.archive_le, "retire");
  assert.match(s.archive_motif, /inconnu de La Poste : 3 lectures/);
  assert.equal(JSON.parse(s.archive_detail).regle, "inconnu");
  assert.equal(s.prochaine_le, null);
  const v = depots.vue();
  assert.equal(v.lignes.some((x) => x.colisId === id), false);
  const retire = v.historique.retires.find((x) => x.colisId === id);
  assert.match(retire.retire.motif, /inconnu/);
  assert.equal(v.compteurs.retires, 1);
  // plus jamais relu, et le colis n'a pas bouge
  const appels = faux.appels.length;
  rendDu();
  await depots.synchronise();
  assert.equal(faux.appels.length, appels);
  assert.equal(photoColis(), avant);
  // « Vérifier » sur ce colis le remet dans la file
  await depots.verifieColis(id);
  assert.equal(suivi(n).archive_le, null);
  assert.equal(actif(id), true);
});

test("numero inconnu mais drope recemment : jamais retire (le premier scan peut tarder)", async () => {
  const n = "6A11000000002";
  const id = drope(n, { heures: 5 });
  await depots.synchronise();
  assert.equal(ligne(id).controle.categorie, "non_confirme", "pas encore connu : pas de prise en charge");
  db.db.prepare("UPDATE controle_suivis SET inconnu_premier_le = datetime('now', '-20 hours') WHERE numero = ?").run(n);
  rendDu();
  await depots.synchronise();
  assert.equal(suivi(n).archive_le, null);
  assert.equal(actif(id), true);
});

test("numero refusé comme invalide par l'API : retiré tout de suite, avec la raison", async () => {
  faux.comporte("6A10000000004", "invalide");
  const id = drope("6A10000000004");
  const bilan = await depots.synchronise();
  assert.equal(bilan.retires, 1);
  assert.match(suivi("6A10000000004").archive_motif, /refusé par La Poste/);
  assert.equal(actif(id), false);
  assert.ok(depots.vue().historique.retires.some((x) => x.colisId === id));
});

test("erreur reseau, delai depasse : le vrai colis n'est jamais retiré, sa preuve n'est jamais effacee", async () => {
  // un colis drope il y a longtemps, que La Poste n'arrive jamais a lire
  const n = "6A12000000001";
  const id = drope(n, { heures: 200 });
  faux.comporte(n, "panne");
  // un autre deja vu une fois « inconnu », puis le transporteur tombe en panne
  const n2 = "6A12000000002";
  const id2 = drope(n2, { heures: 200 });
  await depots.synchronise();
  assert.equal(suivi(n2).inconnu_lectures, 1);
  faux.comporte(n2, "lent");
  for (let k = 0; k < 6; k++) {
    db.db.prepare("UPDATE controle_suivis SET inconnu_premier_le = datetime('now', '-30 hours') WHERE inconnu_premier_le IS NOT NULL").run();
    rendDu();
    levePauses();
    await depots.synchronise();
  }
  for (const [num, colisId] of [[n, id], [n2, id2]]) {
    assert.equal(suivi(num).archive_le, null, `${num} jamais retire sur une erreur`);
    assert.equal(actif(colisId), true);
  }
  assert.equal(suivi(n2).inconnu_lectures, 1, "une erreur n'est pas une lecture « inconnu »");
  assert.ok(suivi(n).essais >= 4);
  assert.equal(ligne(id).controle.categorie, "a_verifier", "au 4e echec de suite : a regarder");
  // les premiers echecs : « en attente », jamais un verdict
  const n3 = "6A12000000003";
  faux.comporte(n3, "panne");
  const id3 = drope(n3, { heures: 5 });
  levePauses();
  await depots.synchronise();
  assert.equal(ligne(id3).controle.categorie, "en_attente");
  assert.match(ligne(id3).controle.raison, /rien n'est conclu/);
  // une preuve deja lue reste, quelle que soit la panne
  const n4 = "6A12000000004";
  faux.suivi(n4, [ev(1, "PC1")]);
  const id4 = drope(n4);
  levePauses();
  await depots.synchronise();
  faux.comporte(n4, "panne");
  db.db.prepare("UPDATE controle_suivis SET verifie_le = datetime('now', '-1 hour') WHERE numero = ?").run(n4);
  const apres = await depots.verifieColis(id4);
  assert.equal(apres.erreur.code, "passagere");
  assert.equal(apres.controle.categorie, "confirme");
});

test("CAPTCHA : bloqué, aucun faux statut, plus rien demande a ce transporteur", async () => {
  const a = drope("4278870031", { carrier: "MR", heures: 30 });
  const b = drope("4278870032", { carrier: "MR", heures: 30 });
  const gls = drope("12345678901", { carrier: "GLS", heures: 30 });
  depots.lanceCampagne({ force: true });
  const lot = depots.travail({ agent: "Mac de test", lot: 1 });
  assert.equal(lot.items[0].transporteur, "GLS", "un lot = un seul transporteur");
  const lotMR = depots.travail({ agent: "Mac de test", lot: 1 });
  assert.equal(lotMR.items[0].numero, "4278870031");
  const r = depots.recoitResultats([{ numero: "4278870031", transporteur: "MR", titre: "Just a moment...", texte: "Vérifiez que vous êtes humain" }]);
  assert.equal(r.resultats[0].etat, "bloque");
  for (const id of [a, b]) {
    const c = ligne(id).controle;
    assert.equal(c.categorie, "bloque");
    assert.equal(c.libelle, "Vérification bloquée");
  }
  // aucun statut invente : ni lu, ni « inconnu », aucun evenement
  const s = suivi("4278870031");
  assert.equal(s.trouve, null);
  assert.equal(s.inconnu_lectures, 0);
  assert.equal(nbEvenements("4278870031"), 0);
  assert.equal(s.archive_le, null);
  // l'autre numero Mondial Relay est marque bloque dans la campagne ; plus rien pour MR
  assert.ok(depots.campagne().compteurs.bloques >= 2);
  assert.deepEqual(depots.travail({ agent: "Mac de test" }).items, []);
  assert.equal(depots.etat().lecture.find((l) => l.code === "MR").pause.type, "bloque");
  // un autre transporteur n'est pas concerne
  assert.equal(ligne(gls).controle.categorie, "en_attente");
  // une banniere de cookies n'est pas un defi : la page est lue normalement
  levePauses();
  depots.lanceCampagne({ force: true, numeros: ["4278870032"] });
  depots.travail({ agent: "Mac de test" });
  const cookies = resultatMR("4278870032", [[20, "Colis pris en charge en Point Relais"]]);
  cookies.texte = `Nous utilisons des cookies pour améliorer votre expérience.\nAccepter & Fermer\nContinuer sans accepter\n${cookies.texte}`;
  assert.equal(depots.recoitResultats([cookies]).resultats[0].etat, "trouve");
  assert.equal(ligne(b).controle.categorie, "confirme");
});

test("deux lectures du meme colis : aucun doublon (API et page)", async () => {
  const n = "6A40000000001";
  // (le meme objet d'une lecture a l'autre : une vraie date La Poste ne bouge pas)
  const dr1 = ev(30, "DR1");
  faux.suivi(n, [dr1]);
  drope(n);
  await depots.synchronise();
  assert.equal(nbEvenements(n), 1);
  rendDu();
  assert.equal((await depots.synchronise()).nouveauxEvenements, 0);
  assert.equal(nbEvenements(n), 1);
  // la prise en charge arrive : seuls les nouveaux evenements sont ajoutes
  faux.suivi(n, [ev(0.5, "ET1"), ev(1, "PC1"), dr1]);
  rendDu();
  assert.equal((await depots.synchronise()).nouveauxEvenements, 2);
  assert.equal(nbEvenements(n), 3);
  // la meme page Mondial Relay envoyee deux fois (deux Mac, ou un renvoi)
  const mr = "4278870040";
  const id = drope(mr, { carrier: "MR", heures: 30 });
  const page = resultatMR(mr, [[20, "Colis pris en charge en Point Relais"], [26, "Colis en préparation chez l'expéditeur"]]);
  depots.recoitResultats([page]);
  depots.recoitResultats([page, page]);
  assert.equal(nbEvenements(mr), 2);
  assert.equal(ligne(id).evenements.length, 2);
  // deux colis au meme numero : une seule requete, la meme lecture
  faux.suivi("6A30000000001", [ev(1, "PC1")]);
  const un = drope("6A30000000001");
  const deux = drope("6A30000000001", { expediteur: "Bob" });
  await depots.synchronise();
  assert.equal(faux.appelsPour("6A30000000001").length, 1);
  assert.equal(ligne(un).controle.categorie, "confirme");
  assert.equal(ligne(deux).controle.categorie, "confirme");
});

test("colis simultanes : chaque resultat sur le bon numero, une page d'un autre numero n'est jamais attribuee", async () => {
  const numeros = ["4278870051", "4278870052", "4278870053", "4278870054"];
  const ids = Object.fromEntries(numeros.map((n) => [n, drope(n, { carrier: "MR", heures: 30 })]));
  depots.lanceCampagne({ force: true });
  const lot = depots.travail({ agent: "Mac de test", lot: 12 });
  assert.deepEqual(lot.items.map((it) => it.numero).sort(), numeros);
  // les resultats reviennent dans le desordre ; le dernier montre la page d'un AUTRE colis
  depots.recoitResultats([
    resultatMR("4278870053", [[26, "Colis en préparation chez l'expéditeur"]]),
    resultatMR("4278870051", [[20, "Colis pris en charge en Point Relais"]]),
    { numero: "4278870052", transporteur: "MR", titre: "Suivi de colis - Mondial Relay", texte: INCONNU_MR },
    { ...resultatMR("4278870051", [[3, "Colis livré au destinataire"]]), numero: "4278870054" },
  ]);
  assert.equal(ligne(ids["4278870051"]).controle.categorie, "confirme");
  assert.equal(ligne(ids["4278870053"]).controle.categorie, "non_confirme");
  assert.equal(suivi("4278870052").trouve, 0);
  // la page du 51 renvoyee pour le 54 : refusee, rien n'est ecrit sous le 54
  assert.equal(nbEvenements("4278870054"), 0);
  assert.equal(suivi("4278870054").code_erreur, "autre_numero");
  assert.equal(ligne(ids["4278870054"]).controle.categorie, "en_attente");
  assert.equal(nbEvenements("4278870051"), 1, "et rien d'autre n'est ajoute au 51");
  // un resultat pour un numero qui n'est pas un colis drope : ignore
  assert.equal(depots.recoitResultats([resultatMR("9999999999", [[1, "Colis livré au destinataire"]])]).resultats[0].etat, "ignore");
  // un resultat annonce pour un autre transporteur : ignore
  assert.equal(depots.recoitResultats([{ ...resultatMR("4278870053", [[1, "Colis pris en charge en Point Relais"]]), transporteur: "GLS" }]).resultats[0].etat, "ignore");
  assert.equal(ligne(ids["4278870053"]).controle.categorie, "non_confirme");
});

// =====================================================================================
// Les faux positifs corriges
// =====================================================================================

test("faux positif corrigé : un numero reutilise ne montre qu'un ancien parcours -> non confirmé, reste actif", async () => {
  // l'ancien colis de ce numero, livre il y a 8 jours ; l'etiquette du nouveau est arrivee il y a 14 h
  faux.suivi("6A13000000001", [ev(190, "DI1", "Votre colis est livré."), ev(200, "ET1"), ev(210, "PC1")]);
  const id = drope("6A13000000001");
  await depots.synchronise();
  const c = ligne(id).controle;
  assert.equal(c.categorie, "non_confirme");
  assert.equal(c.ancienParcours, true);
  assert.equal(c.livre, false, "la livraison de l'ancien colis ne dit rien de celui-ci");
  assert.match(c.raison, /ancien parcours/);
  assert.equal(actif(id), true);
  // meme chose sur une page Mondial Relay
  const mr = drope("4278870060", { carrier: "MR", heures: 3 });
  depots.recoitResultats([resultatMR("4278870060", [[150, "Colis livré au destinataire"], [170, "Colis pris en charge en Point Relais"]])]);
  assert.equal(ligne(mr).controle.categorie, "non_confirme");
  assert.equal(actif(mr), true);
});

test("apres la mise a jour : un ancien « confirmé » de l'ancienne regle est revu, et relu s'il ne l'est plus", async () => {
  // l'etat laisse par l'ancienne version : statut « confirme », plus de
  // prochaine lecture, pas de date de confirmation (colonne nouvelle)
  faux.suivi("6A14000000001", [ev(30, "DR1", "Votre Colissimo va bientôt nous être confié !")]);
  faux.suivi("6A14000000002", [ev(1, "PC1"), ev(30, "DR1")]);
  const faux1 = drope("6A14000000001");
  const vrai = drope("6A14000000002");
  await depots.synchronise();
  db.db.prepare("UPDATE controle_suivis SET statut = 'confirme', confirme_le = NULL, prochaine_le = NULL").run();
  faux.appels.length = 0;
  faux.suivi("6A14000000001", [ev(0.5, "PC1", "Votre colis a été déposé dans un point postal."), ev(30, "DR1")]);
  await depots.synchronise();
  // le faux positif est revenu dans la file, et relu tout de suite ; le vrai
  // depot, pas encore livre, reprend son suivi (actualites de l'expediteur)
  assert.deepEqual(faux.appels.map((a) => a.numero).sort(), ["6A14000000001", "6A14000000002"]);
  assert.equal(ligne(faux1).controle.categorie, "confirme", "relu : cette fois le depot est prouve");
  assert.ok(suivi("6A14000000002").confirme_le);
  assert.equal(actif(vrai), false, "il reste hors de la liste active");
});

test("faux positif corrigé : boite jaune -- un passage en point relais avant l'etiquette n'est pas la preuve, le scan d'apres l'est", async () => {
  const c = db.addColis("Alice", { fileId: "F-BJ", fileKind: "pdf", type: "bj", fileName: "BOITEJAUNE6Y11147788515.pdf" });
  db.dropColis(c.id);
  db.db.prepare("UPDATE colis SET created_at = datetime('now', '-10 hours'), dropped_at = datetime('now', '-8 hours') WHERE id = ?").run(c.id);
  faux.suivi("6Y11147788515", [ev(22, "AG1", "Votre Colissimo vous attend dans votre point de retrait."), ev(34, "DR1")]);
  await depots.synchronise();
  assert.equal(ligne(c.id).controle.categorie, "non_confirme");
  faux.suivi("6Y11147788515", [ev(1, "ET1", "Votre colis est en transit"), ev(22, "AG1", "Votre Colissimo vous attend dans votre point de retrait."), ev(34, "DR1")]);
  rendDu();
  await depots.synchronise();
  const l = ligne(c.id);
  assert.equal(l.controle.categorie, "confirme");
  assert.equal(l.controle.preuve.code, "ET1");
});

// =====================================================================================
// UPS et DHL : les API officielles (simulees ici), ou a la main
// =====================================================================================

test("UPS sans identifiants d'API : jamais lu automatiquement (conditions d'UPS), constat a la main", async () => {
  const ups = drope("1Z999AA10123456784", { carrier: "UPS", heures: 30 });
  const ups2 = drope("1Z999AA10123456786", { carrier: "UPS" });
  await depots.synchronise();
  assert.equal(faux.appels.length + fauxUPS.appels.length, 0);
  const l = ligne(ups);
  assert.equal(l.transporteur.methode, "manuel");
  assert.equal(l.controle.categorie, "bloque");
  assert.equal(l.controle.manuel, true);
  assert.match(l.controle.raison, /interdisent la lecture automatisée/);
  assert.match(l.raisonManuel, /UPS_CLIENT_ID/);
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
  // le Mac recoit les numeros a ouvrir un par un dans le navigateur
  assert.ok(depots.campagne().numerosAConstater.includes("1Z999AA10123456784"));
  // B02 : le « dont N à constater » de la carte « bloquée » ne compte que
  // les bloques (aConstater compte aussi des non confirmes : le « dont »
  // depassait le total)
  const c = depots.vue();
  assert.equal(c.compteurs.aConstaterBloques, c.lignes.filter((x) => x.aConstater && x.controle.categorie === "bloque").length);
  assert.ok(c.compteurs.aConstaterBloques <= c.compteurs.bloque);
  assert.equal(depots.etat().methodes.ups.configure, false);

  assert.equal(depots.constate(ups, "pris").controle.categorie, "confirme");
  assert.match(ligne(ups).controle.raison, /constatée à la main/);
  assert.equal(actif(ups), false);
  assert.equal(suivi("1Z999AA10123456784").methode_lecture, "manuel");
  // le dernier constat fait foi (une erreur de clic se corrige)
  assert.equal(depots.constate(ups, "pas_encore").controle.categorie, "non_confirme");
  assert.equal(actif(ups), true);
  assert.equal(suivi("1Z999AA10123456784").confirme_le, null);
  depots.constate(ups, "annule");
  assert.equal(ligne(ups).controle.categorie, "bloque");
  assert.equal(depots.constate(ups, "probleme").controle.categorie, "a_verifier");
  // les etats lus sur la page officielle : seule une prise en charge vue
  // confirme, jamais une etiquette, un statut inconnu ou une page bloquee
  for (const [constat, categorie] of [
    ["etiquette", "non_confirme"],
    ["pas_encore", "non_confirme"],
    ["inconnu", "a_verifier"],
    ["bloque", "bloque"],
    ["transit", "confirme"],
    ["livre", "confirme"],
    ["pris", "confirme"],
  ]) {
    depots.constate(ups, "annule");
    assert.equal(depots.constate(ups, constat).controle.categorie, categorie, constat);
  }
  depots.constate(ups, "annule");
  assert.match(depots.constate(ups, "livre").controle.raison, /Livré après prise en charge/);
  assert.equal((await echec(Promise.resolve().then(() => depots.constate(ups, "peut-etre")))).status, 400);
  assert.equal(fauxUPS.appels.length, 0);
});

test("UPS avec l'API officielle (SIMULEE) : etiquette seule, enlevement, inconnu, relecture sans doublon", async () => {
  Object.assign(process.env, { UPS_CLIENT_ID: fauxUPS.id, UPS_CLIENT_SECRET: fauxUPS.secret, UPS_API_URL: urlUPS });
  require("../src/controle/ups")._remiseAZero();
  fauxUPS.suivi("1Z999AA10123456701", [{ type: "M", description: "Shipper created a label, UPS has not received the package yet.", h: 1 }]);
  fauxUPS.suivi("1Z999AA10123456702", [
    { type: "I", description: "Departed from Facility", h: 1 },
    { type: "P", description: "Pickup Scan", h: 2 },
    { type: "M", description: "Shipper created a label, UPS has not received the package yet.", h: 10 },
  ]);
  const etiquette = drope("1Z999AA10123456701", { carrier: "UPS" });
  const pris = drope("1Z999AA10123456702", { carrier: "UPS" });
  const inconnu = drope("1Z999AA10123456703", { carrier: "UPS" });
  await depots.synchronise();
  assert.equal(ligne(pris).transporteur.methode, "ups");
  assert.equal(ligne(etiquette).controle.categorie, "non_confirme");
  assert.equal(ligne(pris).controle.categorie, "confirme");
  assert.equal(ligne(pris).controle.preuve.code, "P");
  assert.match(ligne(pris).controle.raison, /API UPS/);
  assert.equal(actif(pris), false);
  assert.equal(ligne(inconnu).controle.categorie, "non_confirme");
  assert.equal(suivi("1Z999AA10123456703").trouve, 0);
  assert.ok(fauxUPS.appels.every((a) => a.src === "FeurDrop" && a.transId));
  assert.equal(depots.etat().methodes.ups.configure, true);
  assert.equal(faux.appels.length, 0, "La Poste n'est pas appelee pour UPS");
  // la livraison arrive ; « Vérifier » relit : un seul evenement de plus
  fauxUPS.suivi("1Z999AA10123456702", [
    { type: "D", description: "Delivered", h: 0.2 },
    { type: "I", description: "Departed from Facility", h: 1 },
    { type: "P", description: "Pickup Scan", h: 2 },
    { type: "M", description: "Shipper created a label, UPS has not received the package yet.", h: 10 },
  ]);
  db.db.prepare("UPDATE controle_suivis SET verifie_le = datetime('now', '-1 hour') WHERE numero = '1Z999AA10123456702'").run();
  const d = await depots.verifieColis(pris);
  assert.equal(nbEvenements("1Z999AA10123456702"), 4);
  assert.equal(d.controle.livre, true);
  assert.equal(actif(pris), false);
});

test("DHL avec l'API officielle (SIMULEE) : donnees electroniques, depose, inconnu, quota", async () => {
  Object.assign(process.env, { DHL_API_KEY: fauxDHL.cle, DHL_API_URL: urlDHL });
  fauxDHL.suivi("JJD0146000128653701", [{ statusCode: "pre-transit", description: "Les données électroniques de l'envoi ont été transmises à DHL.", h: 1 }]);
  fauxDHL.suivi("JJD0146000128653702", [
    { statusCode: "transit", description: "L'envoi a été déposé par l'expéditeur dans un point de vente DHL.", h: 1 },
    { statusCode: "pre-transit", description: "Les données électroniques de l'envoi ont été transmises à DHL.", h: 5 },
  ]);
  const annonce = drope("JJD0146000128653701", { carrier: "DHL" });
  const depose = drope("JJD0146000128653702", { carrier: "DHL" });
  const inconnu = drope("JJD0146000128653703", { carrier: "DHL" });
  await depots.synchronise();
  assert.equal(ligne(depose).transporteur.methode, "dhl");
  assert.equal(ligne(annonce).controle.categorie, "non_confirme");
  assert.equal(ligne(depose).controle.categorie, "confirme");
  assert.equal(suivi("JJD0146000128653703").trouve, 0);
  assert.equal(ligne(inconnu).controle.categorie, "non_confirme");
  assert.ok(fauxDHL.appels.every((a) => a.langue === "fr"));
  // avec la cle, DHL n'est plus confie au Mac
  depots.lanceCampagne({ force: true });
  assert.deepEqual(depots.travail({ agent: "Mac de test" }).items, []);
  // quota atteint : pause, « bloqué », plus aucun appel
  fauxDHL.comporte("JJD0146000128653701", "limite");
  rendDu();
  await depots.synchronise();
  assert.equal(depots.etat().methodes.dhl.pause.type, "limite");
  const appels = fauxDHL.appels.length;
  rendDu();
  await depots.synchronise();
  assert.equal(fauxDHL.appels.length, appels);
  assert.equal(ligne(annonce).controle.categorie, "non_confirme", "ce qui etait lu reste");
  // sans la cle : DHL repasse par la page officielle, lue sur le Mac
  delete process.env.DHL_API_KEY;
  assert.equal(ligne(inconnu).transporteur.methode, "navigateur");
});

// =====================================================================================
// Le Mac : en ligne, file persistante, reprise
// =====================================================================================

test("le Mac : hors ligne -> les pages attendent (et la page le dit) ; en ligne -> il prend la file tout seul, sans campagne", async () => {
  const a = drope("4278870071", { carrier: "MR", heures: 30 });
  const b = drope("4278870072", { carrier: "MR", heures: 30 });
  await depots.synchronise(); // les numeros entrent dans la file persistante
  let e = depots.etat();
  assert.equal(e.mac.actif, false);
  assert.equal(e.mac.pagesDues, 2, "deux pages attendent le Mac");
  assert.match(ligne(a).controle.raison, /app Drop du Mac/);
  // le Mac se signale
  const signal = depots.agent({ nom: "Mac de test" });
  assert.equal(signal.aLire, 2);
  e = depots.etat();
  assert.equal(e.mac.actif, true);
  assert.equal(e.mac.nom, "Mac de test");
  // il prend la file, sans « Tout vérifier »
  const lot = depots.travail({ agent: "Mac de test" });
  assert.equal(lot.campagne, null);
  assert.deepEqual(lot.items.map((it) => it.numero).sort(), ["4278870071", "4278870072"]);
  assert.ok(lot.pauseMs >= 3000, "le rythme de Mondial Relay");
  // pendant le bail : rien n'est redonne
  assert.deepEqual(depots.travail({ agent: "Mac de test" }).items, []);
  depots.recoitResultats([resultatMR("4278870071", [[20, "Colis pris en charge en Point Relais"]]), resultatMR("4278870072", [[26, "Colis en préparation chez l'expéditeur"]])]);
  assert.equal(ligne(a).controle.categorie, "confirme");
  assert.equal(ligne(b).controle.categorie, "non_confirme");
  assert.equal(depots.etat().mac.pagesDues, 0);
  // le Mac ne s'est plus signale depuis 2 minutes : hors ligne, avec l'heure
  db.setSetting("controle_agent_vu", JSON.stringify({ le: new Date(Date.now() - 120e3).toISOString(), nom: "Mac de test" }));
  e = depots.etat();
  assert.equal(e.mac.actif, false);
  assert.ok(e.mac.le);
});

test("redemarrage : la file du serveur et celle du Mac reprennent la ou elles en etaient", async () => {
  process.env.CONTROLE_MAX_PAR_PASSAGE = "2";
  for (const n of ["6A80000000001", "6A80000000002", "6A80000000003", "6A80000000004"]) {
    faux.suivi(n, [ev(20, "DR1")]);
    drope(n);
  }
  drope("4278870081", { carrier: "MR", heures: 30 });
  await depots.synchronise();
  assert.equal(faux.appels.length, 2);
  const lot = depots.travail({ agent: "Mac de test" });
  assert.equal(lot.items.length, 1);
  // un nouveau processus : le module repart de zero, la base garde les files
  for (const k of Object.keys(require.cache)) if (k.includes("/src/controle/")) delete require.cache[k];
  const relance = require("../src/controle/depots");
  await relance.synchronise();
  assert.deepEqual(faux.appels.map((a) => a.numero).sort(), ["6A80000000001", "6A80000000002", "6A80000000003", "6A80000000004"]);
  // le Mac s'etait endormi : son bail expire, le numero lui revient
  assert.deepEqual(relance.travail({ agent: "Mac de test" }).items, []);
  db.db.prepare("UPDATE controle_suivis SET prochaine_le = datetime('now', '-1 minute') WHERE numero = '4278870081'").run();
  assert.equal(relance.travail({ agent: "Mac de test" }).items[0].numero, "4278870081");
  depots = relance;
});

// =====================================================================================
// La file du serveur
// =====================================================================================

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
  depots.detail(depots.vue().lignes[0].colisId);
  depots.etat();
  depots.campagne();
  assert.equal(faux.appels.length, 5, "afficher la page ne lit que la base");
  // jamais deux passages en meme temps
  rendDu();
  const [a, b] = [depots.synchronise(), depots.synchronise()];
  assert.equal(a, b);
  await a;
});

test("trois pannes de suite : La Poste est mise en pause, le reste du passage attend", async () => {
  for (const n of ["6A60000000001", "6A60000000002", "6A60000000003", "6A60000000004", "6A60000000005"]) {
    faux.comporte(n, "panne");
    drope(n);
  }
  const bilan = await depots.synchronise();
  assert.equal(faux.appels.length, 3);
  assert.equal(bilan.reportes, 2);
  assert.match(depots.etat().methodes.laposte.pause.motif, /plusieurs échecs/);
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
  levePauses();
  faux.force(403, {});
  await depots.synchronise();
  const pause2 = db.db.prepare("SELECT * FROM controle_transporteurs WHERE code = 'laposte'").get();
  assert.equal(pause2.echecs, pause1.echecs + 1);
  assert.equal(pause2.type, "bloque");
  assert.match(pause2.motif, /accès refusé/);
  // la pause finie, la file reprend et efface l'alerte
  levePauses();
  await depots.synchronise();
  assert.equal(faux.appels.length, 5);
  assert.equal(depots.etat().methodes.laposte.pause, null);
  assert.equal(db.db.prepare("SELECT echecs FROM controle_transporteurs WHERE code = 'laposte'").get().echecs, 0);
  assert.equal(ligne(ids[0]).controle.categorie, "non_confirme");
});

test("« Tout vérifier » : les API sur le serveur, les pages sur le Mac, progression, erreur reprise une fois, fin d'elle-meme", async () => {
  faux.suivi("6A95000000001", [ev(1, "PC1")]);
  faux.suivi("6A95000000002", [ev(20, "DR1")]);
  const lp = drope("6A95000000001");
  drope("6A95000000002");
  const mr = drope("4278870091", { carrier: "MR", heures: 30 });
  drope("4278870092", { carrier: "MR", heures: 30 });
  await depots.synchronise();
  assert.equal(ligne(lp).controle.categorie, "confirme");
  // le depot prouve n'est pas relu, ni ce qui a ete lu il y a moins de 30 min ; le reste l'est
  const c = depots.nouvelleCampagne({ par: "site" });
  assert.equal(c.compteurs.total, 2);
  assert.equal(c.attendMac, true);
  await depots.synchronise();
  const lot = depots.travail({ agent: "Mac de test", lot: 1 });
  assert.equal(lot.campagne, c.campagne.id);
  assert.ok(lot.items[0].url.startsWith("https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition="));
  depots.recoitResultats([resultatMR("4278870091", [[20, "Colis pris en charge en Point Relais"]])]);
  // erreur reseau sur l'autre : reprise une fois, puis definitive
  let n = depots.travail({ agent: "Mac de test" }).items[0].numero;
  assert.equal(n, "4278870092");
  depots.recoitResultats([{ numero: n, transporteur: "MR", erreur: "délai dépassé" }]);
  n = depots.travail({ agent: "Mac de test" }).items[0].numero;
  assert.equal(n, "4278870092", "un deuxieme essai");
  depots.recoitResultats([{ numero: n, transporteur: "MR", erreur: "délai dépassé" }]);
  const etat = depots.campagne();
  assert.equal(etat.campagne.statut, "terminee");
  assert.equal(etat.compteurs.verifies, 1);
  assert.equal(etat.compteurs.confirmes, 1);
  assert.equal(etat.compteurs.erreurs, 1);
  assert.equal(etat.compteurs.restants, 0);
  assert.equal(ligne(mr).controle.categorie, "confirme");
  assert.match(ligne(mr).controle.raison, /page officielle lue sur le Mac/);
  const m = suivi("4278870091");
  assert.equal(m.methode_lecture, "navigateur");
  assert.equal(m.statut_brut, "Colis pris en charge en Point Relais");
  assert.ok(m.page_url.includes("4278870091"));
  assert.equal(m.lu_par, "Mac");
  // une page incomplete (suivi pas encore affiche) : une erreur, jamais un statut
  depots.lanceCampagne({ force: true, numeros: ["4278870092"] });
  depots.travail({ agent: "Mac de test" });
  const r = depots.recoitResultats([{ numero: "4278870092", transporteur: "MR", titre: "Suivi de colis - Mondial Relay", texte: "Mondial Relay\nSuivi de colis\nChargement..." }]);
  assert.equal(r.resultats[0].etat, "incomplet");
  assert.equal(suivi("4278870092").trouve, null);
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

test("Mondial Relay coupe puis rallume : le Mac reprend ses pages tout de suite, sans « Tout vérifier » ni passage", async () => {
  drope("4278870101", { carrier: "MR", heures: 30 });
  drope("4278870102", { carrier: "MR", heures: 30 });
  await depots.synchronise();
  depots.coupeLecture("MR", true);
  assert.deepEqual(depots.travail({ agent: "Mac de test" }).items, [], "coupee : rien pour le Mac");
  assert.equal(depots.agent({ nom: "Mac de test" }).aLire, 0);
  depots.coupeLecture("MR", false);
  assert.equal(depots.agent({ nom: "Mac de test" }).aLire, 2, "rallumee : les pages sont dues aussitot");
  assert.deepEqual(depots.travail({ agent: "Mac de test" }).items.map((it) => it.numero).sort(), ["4278870101", "4278870102"]);
  assert.equal(depots.etat().lecture.find((l) => l.code === "MR").active, true);
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
  const inconnu = drope("6A93000000003", { heures: 100 });
  const ups = drope("1Z999AA10123456785", { carrier: "UPS" });
  const avant = photoColis();
  await depots.synchronise();
  await depots.verifieColis(a);
  depots.constate(ups, "pris");
  depots.relance();
  await depots.synchronise();
  // un numero retire : seule la ligne du controle bouge
  db.db.prepare("UPDATE controle_suivis SET inconnu_premier_le = datetime('now', '-20 hours') WHERE numero = '6A93000000003'").run();
  rendDu();
  await depots.synchronise();
  assert.ok(suivi("6A93000000003").archive_le);
  assert.ok(suivi("6A93000000002").archive_le);
  const mr = drope("4278870020", { carrier: "MR" });
  const avant2 = photoColis();
  depots.nouvelleCampagne({});
  // « Tout vérifier » lance les API en fond : on attend ce passage
  await depots.synchronise();
  depots.travail({});
  depots.recoitResultats([resultatMR("4278870020", [[1, "Colis pris en charge en Point Relais"]])]);
  depots.annuleCampagne();
  assert.equal(ligne(a).controle.categorie, "confirme");
  assert.equal(ligne(mr).controle.categorie, "confirme");
  assert.equal(ligne(inconnu).retire.motif.includes("inconnu"), true);
  assert.equal(photoColis(), avant2);
  assert.ok(avant2.startsWith(avant.slice(0, -1)));
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
    assert.equal(r.json.compteurs.en_attente, 2);
    assert.equal(r.json.compteurs.anomalie, 0, "garde pour les anciennes versions de l'app");
    assert.deepEqual(Object.keys(r.json.historique).sort(), ["confirmes", "retires"]);
    assert.equal(r.json.etat.mac.actif, false);
    assert.equal(faux.appels.length, 0, "ouvrir la page n'appelle aucun transporteur");
    r = await app.appel(`/api/depots/${id}/verifier`, { methode: "POST" });
    assert.equal(r.status, 200);
    assert.equal(r.json.controle.categorie, "confirme");
    r = await app.appel("/api/depots");
    assert.equal(r.json.lignes.length, 1, "le depot prouve a quitte la file active");
    assert.equal(r.json.historique.confirmes[0].colisId, id);
    // DHL : « Vérifier » confie la page au Mac
    r = await app.appel(`/api/depots/${dhl}/verifier`, { methode: "POST" });
    assert.equal(r.status, 200);
    assert.equal(r.json.enAttenteDuMac, true);
    // le Mac se signale
    r = await app.appel("/api/depots/agent?nom=Mac");
    assert.equal(r.status, 200);
    assert.equal(r.json.aLire, 1);
    assert.equal((await app.appel("/api/depots")).json.etat.mac.actif, true);
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
