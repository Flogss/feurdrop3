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

test("numero inconnu du transporteur : pas encore pris en charge dans le delai, a regarder au-dela", () => {
  const recent = analyse({ colis: colis(3), suivi: { trouve: 0 }, evenements: [] });
  assert.equal(recent.categorie, "non_confirme");
  assert.equal(recent.enRetard, false);
  const vieux = analyse({ colis: colis(80), suivi: { trouve: 0 }, evenements: [] });
  assert.equal(vieux.categorie, "a_verifier");
  assert.equal(vieux.enRetard, true);
  assert.equal(vieux.inconnu, true);
  assert.match(vieux.raison, /Toujours inconnu/);
});

test("pas encore lu : « En attente de lecture », pas un verdict", () => {
  const r = analyse({ colis: colis(1), suivi: null, evenements: [] });
  assert.equal(r.categorie, "en_attente");
  assert.equal(r.libelle, "En attente de lecture");
  assert.match(r.raison, /file de vérification/);
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
  assert.equal(invalide.categorie, "incorrect");
  assert.equal(invalide.libelle, "Numéro incorrect");
  assert.match(invalide.raison, /Numéro refusé/);
  assert.equal(invalide.enRetard, true);
  const garde = analyse({ colis: colis(30), suivi: { trouve: 1, code_erreur: "passagere", erreur: "La Poste injoignable" }, evenements: [lp(20, "PC1")] });
  assert.equal(garde.categorie, "confirme");
});

test("FAUX POSITIF corrige : des scans ANTERIEURS a la reception de l'etiquette ne prouvent pas ce depot", () => {
  // un ancien parcours du numero (etiquette reutilisee) : non confirme, et c'est dit
  const r = analyse({ colis: colis(24, 48), evenements: [lp(2000, "DI1"), lp(2100, "PC1"), lp(60, "DR1")] });
  assert.equal(r.categorie, "non_confirme");
  assert.equal(r.ancienParcours, true);
  assert.match(r.raison, /ancien parcours/);
  assert.equal(r.livre, false, "la livraison d'un ancien parcours ne dit rien de ce colis");
  // un incident d'un ancien parcours non plus
  const ancienRetour = analyse({ colis: colis(24, 48), evenements: [lp(2000, "RE1", "Retourné à l'expéditeur"), lp(2100, "PC1")] });
  assert.equal(ancienRetour.categorie, "non_confirme");
  // une etiquette creee avant la reception du fichier est normale
  const etiquette = analyse({ colis: colis(5, 30), evenements: [lp(200, "DR1")] });
  assert.equal(etiquette.categorie, "non_confirme");
  // un nouveau scan apres la reception : c'est lui la preuve
  const nouveau = analyse({ colis: colis(24, 48), evenements: [lp(10, "ET1", "En transit"), lp(2000, "DI1"), lp(2100, "PC1")] });
  assert.equal(nouveau.categorie, "confirme");
  assert.equal(nouveau.preuve.code, "ET1");
});

test("FAUX POSITIF corrige, cas reel : 6B00017912600 en point de retrait la veille de la reception de son etiquette -> non confirme", () => {
  // etiquette recue par FeurDrop le 09/10 a 17:20 UTC ; La Poste l'avait en
  // transit le 08/10 et en point de retrait le 09/10 au matin : ce n'est pas
  // un depot de FeurDrop (il etait « Posté confirmé » avant la correction)
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
  assert.equal(r.categorie, "non_confirme");
  assert.match(r.raison, /ancien parcours/);
});

test("boite jaune : ancien passage en point relais, puis un vrai scan apres la reception -> confirme par le nouveau scan", () => {
  const r = analyseDepot({
    colis: { type: "bj", status: "dropped", created_at: "2026-10-09 12:50:15", dropped_at: "2026-10-09 14:47:15" },
    suivi: { trouve: 1 },
    evenements: [
      { code: "ET1", label: "Votre colis est en transit sur nos plateformes logistiques.", date: "2026-10-09T19:30:00+02:00" },
      { code: "AG1", label: "Votre colis est disponible dans votre point de retrait", date: "2026-10-09T00:57:00+02:00" },
      { code: "MD1", label: "Votre colis est sur son site de distribution.", date: "2026-10-08T22:35:31+02:00" },
      { code: "DR1", label: "Votre Colissimo va bientôt nous être confié !", date: "2026-10-08T20:11:00+02:00" },
    ].map(versEvenement),
    transporteur: LP,
    maintenant: Date.parse("2026-10-09T20:00:00Z"),
  });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.preuve.code, "ET1");
});

test("un code physique dont le libelle dit le contraire n'est pas une preuve", () => {
  for (const label of ["Votre Colissimo va bientôt nous être confié !", "L'expéditeur ne nous a pas encore remis votre colis", "Votre colis est en attente de dépôt"]) {
    const e = versEvenement({ code: "PC1", label, date: isoIlYa(2) });
    assert.equal(e.physique, false, label);
  }
  const r = analyse({ colis: colis(10), evenements: [versEvenement({ code: "ET1", label: "Votre colis est en attente de prise en charge", date: isoIlYa(2) })] });
  assert.notEqual(r.categorie, "confirme");
});

test("un evenement date dans le futur ou sans date n'est jamais une preuve", () => {
  const futur = analyse({ colis: colis(10), evenements: [lp(-30, "PC1", "Votre colis a été déposé")] });
  assert.notEqual(futur.categorie, "confirme");
  const sansDate = analyse({ colis: colis(10), evenements: [versEvenement({ code: "PC1", label: "Déposé", date: null })] });
  assert.notEqual(sansDate.categorie, "confirme");
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
  // la mise en page reelle de Mondial Relay : date, titre du jour, puis heure / evenement
  const page = lisPage("MR", {
    titre: "Suivi de colis - Mondial Relay",
    texte: "NUMÉRO DE COLIS\n78870015\nSTATUT\nSUIVI GLOBAL DE MON COLIS\nColis en préparation chez l'expéditeur\nColis remis à Mondial Relay\nColis livré au destinataire\nSUIVI DÉTAILLÉ DE MON COLIS\n12/10/2026\nVotre colis est mis à disposition du vendeur\n09:12\nVotre colis est mis à disposition du vendeur\n09/10/2026\nColis pris en charge en Point Relais\n20:31\nColis pris en charge en Point Relais\n12:42\nColis en préparation chez l'expéditeur\nJe m'informe",
  }, "4278870015");
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

test("UPS sans identifiants d'API (lecture du site interdite) : a la main, jamais « non depose »", () => {
  const ups = transporteur("UPS");
  assert.equal(ups.methode, "manuel");
  const r = analyse({ colis: colis(30), transporteur: ups, suivi: null, evenements: [] });
  assert.equal(r.categorie, "bloque");
  assert.equal(r.libelle, "Vérification bloquée");
  assert.match(r.raison, /interdisent la lecture automatisée/);
  assert.equal(r.manuel, true);
  assert.ok(ups.lien("1Z999AA10123456784").includes("1Z999AA10123456784"), "lien officiel avec le numero");
});

test("pages lues sur le Mac (Mondial Relay, GLS, DHL sans cle) : en attente, bloquee, lecture coupee", () => {
  for (const code of ["MR", "DHL", "GLS"]) assert.equal(transporteur(code).methode, "navigateur", code);
  const mr = transporteur("MR");
  const attente = analyse({ colis: colis(5), transporteur: mr, suivi: null, evenements: [] });
  assert.equal(attente.categorie, "en_attente");
  assert.match(attente.raison, /app Drop du Mac/);
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
  assert.match(reseau.raison, /rien n'est conclu/);
  // jamais lu, une panne : toujours « en attente » (une erreur technique n'est pas un verdict)
  const panne = analyse({ colis: colis(30), transporteur: mr, suivi: { trouve: null, essais: 1, code_erreur: "passagere", erreur: "délai dépassé" }, evenements: [] });
  assert.equal(panne.categorie, "en_attente");
  assert.equal(panne.erreurTechnique, true);
  assert.match(panne.raison, /délai dépassé.*rien n'est conclu/);
  // au 4e echec de suite : a regarder
  const tenace = analyse({ colis: colis(30), transporteur: mr, suivi: { trouve: null, essais: 4, code_erreur: "passagere", erreur: "délai dépassé" }, evenements: [] });
  assert.equal(tenace.categorie, "a_verifier");
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
