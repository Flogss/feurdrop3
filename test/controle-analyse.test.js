// La regle de preuve du depot, scenario par scenario (sans reseau) : jamais
// "confirme" sans evenement physique credible ; un site bloque n'est jamais
// "non depose".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyseDepot } = require("../src/controle/analyse");
const { lisCode, versEvenement } = require("../src/controle/laposte");
const { transporteur } = require("../src/controle/transporteurs");

const H = 3600 * 1000;
const MAINTENANT = Date.parse("2026-10-13T10:00:00Z"); // un mardi
const sqlIlYa = (h) => new Date(MAINTENANT - h * H).toISOString().slice(0, 19).replace("T", " ");
const isoIlYa = (h) => new Date(MAINTENANT - h * H).toISOString().replace(".000Z", "+00:00");
const colis = (dropH, recuH = dropH + 24) => ({ status: "dropped", created_at: sqlIlYa(recuH), dropped_at: sqlIlYa(dropH) });
// un evenement La Poste tel que l'adaptateur le traduit
const lp = (h, code, label = code) => versEvenement({ code, label, date: isoIlYa(h) });
const LP = transporteur("LP");
const analyse = (args) => analyseDepot({ maintenant: MAINTENANT, delaiHeures: 48, transporteur: LP, suivi: { trouve: 1 }, ...args });

test("codes La Poste : l'etiquette n'est jamais une preuve, un code inconnu non plus", () => {
  assert.deepEqual(lisCode("DR1"), { etape: "info_received", physique: false });
  assert.equal(lisCode("PC1").physique, true);
  assert.equal(lisCode("PC2").physique, true);
  assert.equal(lisCode("ET1").etape, "in_transit");
  assert.equal(lisCode("EP1").physique, true);
  assert.equal(lisCode("MD1").etape, "out_for_delivery");
  assert.equal(lisCode("AG1").etape, "available_for_pickup");
  assert.equal(lisCode("DI1").etape, "delivered");
  assert.equal(lisCode("RE1").incident, "Retourné à l'expéditeur");
  assert.equal(lisCode("DI2").incident, "Distribué à l'expéditeur (retour)");
  assert.equal(lisCode("ND1").incident, "Non distribuable");
  assert.deepEqual(lisCode("ZZ9"), { etape: "unknown", physique: false });
  assert.deepEqual(lisCode(null), { etape: "unknown", physique: false });
});

test("prise en charge confirmee : PC1 « déposé dans un point postal »", () => {
  const r = analyse({ colis: colis(20), evenements: [lp(5, "ET1", "Votre colis est en transit"), lp(18, "PC1", "Votre colis a été déposé dans un point postal."), lp(40, "DR1")] });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.preuve.code, "PC1");
  assert.match(r.raison, /déposé dans un point postal/);
  assert.equal(r.dernierEvenement.code, "ET1");
});

test("etiquette creee sans prise en charge : non confirme, dans le delai puis hors delai", () => {
  const recent = analyse({ colis: colis(6), evenements: [lp(30, "DR1", "Votre Colissimo va bientôt nous être confié !")] });
  assert.equal(recent.categorie, "non_confirme");
  assert.equal(recent.enRetard, false);
  assert.match(recent.raison, /délai normal/);
  const vieux = analyse({ colis: colis(96), evenements: [lp(100, "DR1")] });
  assert.equal(vieux.categorie, "non_confirme");
  assert.equal(vieux.enRetard, true);
});

test("numero inconnu du transporteur : verification necessaire, sans affoler dans le delai", () => {
  const recent = analyse({ colis: colis(3), suivi: { trouve: 0 }, evenements: [] });
  assert.equal(recent.categorie, "a_verifier");
  assert.equal(recent.enRetard, false);
  const vieux = analyse({ colis: colis(80), suivi: { trouve: 0 }, evenements: [] });
  assert.equal(vieux.enRetard, true);
  assert.match(vieux.raison, /Toujours inconnu/);
});

test("pas encore verifie : en file d'attente", () => {
  const r = analyse({ colis: colis(1), suivi: null, evenements: [] });
  assert.equal(r.categorie, "a_verifier");
  assert.match(r.raison, /file d'attente/);
});

test("livre : depot prouve, la preuve reste la prise en charge", () => {
  const r = analyse({ colis: colis(72), evenements: [lp(2, "DI1", "Votre colis est livré."), lp(60, "PC1")] });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.preuve.code, "PC1");
  assert.equal(r.livre, true);
  const seul = analyse({ colis: colis(72), evenements: [lp(2, "DI1")] });
  assert.match(seul.raison, /aucun scan de prise en charge/);
});

test("numero invalide ; erreur ; ce qu'on savait reste", () => {
  const invalide = analyse({ colis: colis(10), suivi: { trouve: null, code_erreur: "invalide", erreur: "Le numéro n'est pas valide" }, evenements: [] });
  assert.equal(invalide.categorie, "a_verifier");
  assert.match(invalide.raison, /Numéro refusé/);
  assert.equal(invalide.enRetard, true);
  const garde = analyse({ colis: colis(30), suivi: { trouve: 1, code_erreur: "passagere", erreur: "La Poste injoignable" }, evenements: [lp(20, "PC1")] });
  assert.equal(garde.categorie, "confirme");
});

test("scans anterieurs a la reception de l'etiquette : ils prouvent le depot, et c'est dit", () => {
  const r = analyse({ colis: colis(24, 48), evenements: [lp(2000, "DI1"), lp(2100, "PC1")] });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.preuve.code, "PC1");
  assert.match(r.raison, /antérieur à la réception de l'étiquette/);
  // un incident d'un ancien parcours n'est pas une anomalie de ce depot
  const ancienRetour = analyse({ colis: colis(24, 48), evenements: [lp(2000, "RE1", "Retourné à l'expéditeur"), lp(2100, "PC1")] });
  assert.equal(ancienRetour.categorie, "confirme");
  // une etiquette creee avant la reception du fichier est normale
  const etiquette = analyse({ colis: colis(5, 30), evenements: [lp(200, "DR1")] });
  assert.equal(etiquette.categorie, "non_confirme");
});

test("cas reel : en point de retrait avant la reception de l'etiquette -> depot confirme, avec les deux dates", () => {
  // 6B00017912600 : etiquette recue par FeurDrop le 09/10 a 17:20 UTC ; La
  // Poste l'avait en transit la veille et en point de retrait le matin
  const r = analyseDepot({
    colis: { status: "dropped", created_at: "2026-10-09 17:20:59", dropped_at: "2026-10-09 18:44:15" },
    suivi: { trouve: 1 },
    evenements: [
      versEvenement({ code: "AG1", label: "Votre colis est disponible dans votre point de retrait", date: "2026-10-09T10:51:00+02:00" }),
      versEvenement({ code: "MD1", label: "Votre colis est sur son site de distribution.", date: "2026-10-09T07:43:29+02:00" }),
      versEvenement({ code: "EP1", label: "Votre Colissimo est en cours de traitement sur le site de tri local.", date: "2026-10-09T03:02:20+02:00" }),
      versEvenement({ code: "ET1", label: "Votre colis est en transit sur nos plateformes logistiques.", date: "2026-10-08T13:34:47+02:00" }),
      versEvenement({ code: "DR1", label: "Votre Colissimo va bientôt nous être confié !", date: "2026-10-08T03:08:00+02:00" }),
    ],
    transporteur: LP,
    maintenant: Date.parse("2026-10-10T08:00:00Z"),
  });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.preuve.code, "ET1");
  assert.match(r.raison, /08\/10 13:34 \(scan antérieur à la réception de l'étiquette, le 09\/10 19:20\)/);
});

test("boite jaune : en point relais puis de nouveau en transit, depot confirme sans anomalie", () => {
  const r = analyseDepot({
    colis: { type: "bj", status: "dropped", created_at: "2026-10-09 12:50:15", dropped_at: "2026-10-09 14:47:15" },
    suivi: { trouve: 1 },
    evenements: [
      { code: "ET1", label: "Votre colis est en transit sur nos plateformes logistiques.", date: "2026-10-09T19:30:00+02:00" },
      { code: "AG1", label: "Votre colis est disponible dans votre point de retrait", date: "2026-10-09T10:57:00+02:00" },
      { code: "MD1", label: "Votre colis est sur son site de distribution.", date: "2026-10-09T08:35:31+02:00" },
      { code: "DR1", label: "Votre Colissimo va bientôt nous être confié !", date: "2026-10-08T20:11:00+02:00" },
    ].map(versEvenement),
    transporteur: LP,
    maintenant: Date.parse("2026-10-09T20:00:00Z"),
  });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.preuve.code, "MD1");
});

test("apres la prise en charge, un retour ou un souci ne defait jamais le depot (pas d'anomalie)", () => {
  const retour = analyse({ colis: colis(100), evenements: [lp(5, "RE1", "Retourné à l'expéditeur"), lp(90, "PC1")] });
  assert.equal(retour.categorie, "confirme");
  assert.equal(retour.libelle, "Posté confirmé");
  assert.equal(retour.preuve.code, "PC1");
  // la suite reste consultable dans le detail, sans alerte
  assert.equal(retour.suite.libelle, "Retourné à l'expéditeur");
  assert.equal(retour.suite.retour, true);
  const probleme = analyse({ colis: colis(50), evenements: [lp(5, "PB1", "Problème en cours"), lp(40, "PC1")] });
  assert.equal(probleme.categorie, "confirme");
  const nonDistribuable = analyse({ colis: colis(50), evenements: [lp(5, "ND1", "Non distribuable"), lp(40, "PC1")] });
  assert.equal(nonDistribuable.categorie, "confirme");
  // un retour sans autre scan : on ne retourne que ce qu'on a eu
  const seul = analyse({ colis: colis(100), evenements: [lp(5, "RE1", "Retourné à l'expéditeur")] });
  assert.equal(seul.categorie, "confirme");
});

test("« Votre colis est mis à disposition du vendeur » apres une prise en charge : posté confirmé, sans alerte", () => {
  const { lisPage } = require("../src/controle/pages");
  const page = lisPage("MR", {
    titre: "Suivi de colis - Mondial Relay",
    texte: "STATUT\nVotre colis est mis à disposition du vendeur\nSUIVI GLOBAL DE MON COLIS\nColis livré au destinataire\nSUIVI DÉTAILLÉ DE MON COLIS\n12/10/2026\nVotre colis est mis à disposition du vendeur\n09:12\n09/10/2026\nColis pris en charge en Point Relais\n20:31\nColis en préparation chez l'expéditeur\n12:42\nJe m'informe",
  });
  assert.equal(page.etat, "trouve");
  const r = analyse({ colis: colis(100, 120), transporteur: transporteur("MR"), evenements: page.evenements });
  assert.equal(r.categorie, "confirme");
  assert.match(r.raison, /Pris en charge le 09\/10 20:31/);
  assert.match(r.suite.libelle, /mis à disposition du vendeur/);
  // le « suivi global » (liste des etapes possibles) n'est pas une livraison
  assert.equal(r.livre, false);
});

test("statut transporteur non reconnu : verification necessaire, pas une preuve", () => {
  const r = analyse({ colis: colis(30), evenements: [lp(10, "XX9", "Statut inédit")] });
  assert.equal(r.categorie, "a_verifier");
  assert.match(r.raison, /non reconnu/);
});

test("UPS (consultation automatisee interdite) : bloque, a la main, jamais « non depose »", () => {
  const ups = transporteur("UPS");
  assert.equal(ups.methode, "manuel");
  const r = analyse({ colis: colis(30), transporteur: ups, suivi: null, evenements: [] });
  assert.equal(r.categorie, "bloque");
  assert.equal(r.libelle, "Vérification bloquée");
  assert.match(r.raison, /interdisent toute consultation automatisée/);
  assert.equal(r.manuel, true);
  assert.ok(ups.lien("1Z999AA10123456784").includes("1Z999AA10123456784"), "lien officiel avec le numero");
});

test("pages lues sur le Mac (Mondial Relay, DHL, FedEx, GLS) : en attente, bloquee, lecture coupee", () => {
  for (const code of ["MR", "DHL", "FEDEX", "GLS"]) assert.equal(transporteur(code).methode, "navigateur", code);
  const mr = transporteur("MR");
  const attente = analyse({ colis: colis(5), transporteur: mr, suivi: null, evenements: [] });
  assert.equal(attente.categorie, "a_verifier");
  assert.match(attente.raison, /Tout vérifier/);
  // un defi anti-robot a la derniere lecture : bloque, rien de conclu sur le colis
  const defi = analyse({ colis: colis(30), transporteur: mr, suivi: { trouve: null, code_erreur: "bloque", erreur: "le site affiche une vérification anti-robot" }, evenements: [] });
  assert.equal(defi.categorie, "bloque");
  const pause = analyse({ colis: colis(30), transporteur: mr, suivi: null, evenements: [], pause: { jusqua: sqlIlYa(-2), motif: "accès refusé" } });
  assert.equal(pause.categorie, "bloque");
  assert.match(pause.raison, /ouvrir à la main/);
  // l'interrupteur coupe : la page se verifie a la main
  const coupe = transporteur("MR", { lectureCoupee: ["MR"] });
  assert.equal(coupe.methode, "manuel");
  assert.equal(analyse({ colis: colis(30), transporteur: coupe, suivi: null, evenements: [] }).categorie, "bloque");
  // une erreur reseau du Mac ne dit rien du colis, et n'efface pas une preuve
  const reseau = analyse({ colis: colis(30), transporteur: mr, suivi: { trouve: 1, code_erreur: "passagere", erreur: "page non lue sur le Mac : délai dépassé" }, evenements: [] });
  assert.equal(reseau.categorie, "a_verifier");
  assert.match(reseau.raison, /Rien n'est conclu/);
});

test("transporteur en pause : bloque, et on dit jusqu'a quand", () => {
  const r = analyse({ colis: colis(10), suivi: null, evenements: [], pause: { jusqua: sqlIlYa(-1), motif: "trop de vérifications" } });
  assert.equal(r.categorie, "bloque");
  assert.match(r.raison, /trop de vérifications/);
  // mais ce qu'on a deja lu reste valable pendant la pause
  const deja = analyse({ colis: colis(30), evenements: [lp(20, "PC1")], pause: { jusqua: sqlIlYa(-1), motif: "pause" } });
  assert.equal(deja.categorie, "confirme");
});

test("API La Poste non configuree : le dire", () => {
  const r = analyse({ colis: colis(10), suivi: null, evenements: [], configure: false });
  assert.equal(r.categorie, "a_verifier");
  assert.match(r.raison, /OKAPI_KEY/);
});

test("constats faits a la main sur la page officielle", () => {
  const ups = transporteur("UPS");
  const constat = (h, code, extra = {}) => ({ survenuLe: isoIlYa(h), code, source: "manuel", ...extra });
  const pris = analyse({ colis: colis(30), transporteur: ups, evenements: [constat(1, "MANUEL_PRIS", { physique: true, etape: "in_transit" })] });
  assert.equal(pris.categorie, "confirme");
  assert.match(pris.raison, /constatée à la main/);
  const pasEncore = analyse({ colis: colis(30), transporteur: ups, evenements: [constat(1, "MANUEL_PAS_ENCORE", { etape: "info_received" })] });
  assert.equal(pasEncore.categorie, "non_confirme");
  const perime = analyse({ colis: colis(80), transporteur: ups, evenements: [constat(30, "MANUEL_PAS_ENCORE", { etape: "info_received" })] });
  assert.match(perime.raison, /à revérifier/);
  assert.equal(perime.enRetard, true);
  const probleme = analyse({ colis: colis(30), transporteur: ups, evenements: [constat(1, "MANUEL_PROBLEME", { incident: "Problème signalé", etape: "exception" })] });
  assert.equal(probleme.categorie, "a_verifier");
  assert.match(probleme.raison, /Problème signalé à la main/);
  // le dernier constat fait foi
  const corrige = analyse({
    colis: colis(30),
    transporteur: ups,
    evenements: [constat(1, "MANUEL_PRIS", { physique: true, etape: "in_transit" }), constat(5, "MANUEL_PAS_ENCORE", { etape: "info_received" })],
  });
  assert.equal(corrige.categorie, "confirme");
});

test("le delai normal ne compte pas les dimanches", () => {
  const lundi = Date.parse("2026-10-12T11:00:00Z");
  const r = analyseDepot({
    colis: { status: "dropped", created_at: "2026-10-09 08:00:00", dropped_at: "2026-10-10 08:00:00" },
    suivi: { trouve: 1 },
    evenements: [versEvenement({ code: "DR1", label: "Étiquette", date: "2026-10-09T18:00:00+02:00" })],
    transporteur: LP,
    maintenant: lundi,
    delaiHeures: 48,
  });
  assert.equal(r.enRetard, false);
});
