// L'interpretation des statuts, cas par cas (octobre 2026) : le statut, son
// libelle, la chronologie et les evenements precedents -- jamais un mot
// isole. Une preuve de prise en charge deja etablie ne s'efface jamais ;
// une absence de resultat n'est jamais une confirmation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyseDepot } = require("../src/controle/analyse");
const laposte = require("../src/controle/laposte");
const dhl = require("../src/controle/dhl");
const { lisPage, litLibelle } = require("../src/controle/pages");
const { transporteur } = require("../src/controle/transporteurs");

const H = 3600 * 1000;
const MAINTENANT = Date.parse("2026-10-13T10:00:00Z"); // un mardi
const sqlIlYa = (h) => new Date(MAINTENANT - h * H).toISOString().slice(0, 19).replace("T", " ");
const isoIlYa = (h) => new Date(MAINTENANT - h * H).toISOString().replace(".000Z", "+00:00");
const colis = (dropH, recuH = dropH + 24) => ({ status: "dropped", created_at: sqlIlYa(recuH), dropped_at: sqlIlYa(dropH) });
const lp = (h, code, label) => laposte.versEvenement({ code, label, date: isoIlYa(h) });
const analyse = (code, args) => analyseDepot({ maintenant: MAINTENANT, delaiHeures: 48, transporteur: transporteur(code), suivi: { trouve: 1 }, ...args });

// une page Mondial Relay telle que le Mac la lit (structure relevee en octobre)
const pageMR = (jours) =>
  [
    "NUMÉRO DE COLIS",
    "78870015",
    "SUIVI DÉTAILLÉ DE MON COLIS",
    ...jours.flatMap(([date, evenements]) => [date, evenements[0][1], ...evenements.flatMap(([heure, libelle]) => [heure, libelle])]),
    "Je m'informe",
  ].join("\n");
const evenementsMR = (jours) => {
  const r = lisPage("MR", { titre: "Suivi de colis - Mondial Relay", texte: pageMR(jours) }, "4278870015");
  assert.equal(r.etat, "trouve");
  return r.evenements;
};

// --- Mondial Relay -----------------------------------------------------------------------

test("Mondial Relay : « Colis livré » confirme la prise en charge (evenement reel, date)", () => {
  const evenements = evenementsMR([
    ["12/10/2026", [["14:02", "Colis livré"], ["09:15", "Colis disponible en Point Relais"]]],
    ["11/10/2026", [["10:00", "Colis en préparation chez l'expéditeur"]]],
  ]);
  const r = analyse("MR", { colis: colis(30, 60), evenements });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.livre, true);
});

test("Mondial Relay : « Colis expédié depuis site logistique » et « Colis pris en charge au PR » confirment", () => {
  for (const libelle of ["Colis expédié depuis site logistique", "Colis pris en charge au PR", "Colis pris en charge en Point Relais"]) {
    assert.deepEqual([litLibelle(libelle, "MR").etape, litLibelle(libelle, "MR").physique], ["in_transit", true], libelle);
    const evenements = evenementsMR([["12/10/2026", [["18:40", libelle], ["08:00", "Colis en préparation chez l'expéditeur"]]]]);
    assert.equal(analyse("MR", { colis: colis(20, 40), evenements }).categorie, "confirme", libelle);
  }
});

test("Mondial Relay : « Une enquête est en cours » n'annule pas une preuve anterieure, et n'en est pas une", () => {
  const apres = evenementsMR([
    ["13/10/2026", [["08:30", "Une enquête est en cours"]]],
    ["12/10/2026", [["18:40", "Colis pris en charge en Point Relais"]]],
  ]);
  const r = analyse("MR", { colis: colis(20, 40), evenements: apres });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.preuve.statut, "Colis pris en charge en Point Relais");
  assert.equal(r.dernierEvenement.statut, "Une enquête est en cours");
  assert.match(r.suite.libelle, /enquête/);
  // seule : aucune preuve, a regarder -- jamais « confirme »
  const seule = analyse("MR", { colis: colis(20, 40), evenements: evenementsMR([["13/10/2026", [["08:30", "Une enquête est en cours"]]]]) });
  assert.notEqual(seule.categorie, "confirme");
});

test("Mondial Relay : une autre mise en page (date, heure et libelle sur une ligne) est encore lue", () => {
  const texte = "Suivi de colis\nNuméro de colis : 78870015\nSuivi détaillé de mon colis\n12/10/2026 18:40 Colis pris en charge en Point Relais\n11/10/2026 08:00 Colis en préparation chez l'expéditeur\nJe m'informe";
  const r = lisPage("MR", { texte }, "4278870015");
  assert.equal(r.etat, "trouve");
  const p = r.evenements.find((e) => e.physique);
  assert.equal(p.survenuLe, "2026-10-12T18:40:00+02:00");
  // le numero affiche est celui d'un autre colis : jamais attribue
  assert.equal(lisPage("MR", { texte }, "4278870099").etat, "autre_numero");
});

// --- DPD, Colissimo, La Poste (API officielle) --------------------------------------------

test("DPD : « Tri effectué en agence » = entre dans le reseau, meme sous un code que la liste ne connait pas", () => {
  const e = lp(10, "ZZ2", "Tri effectué en agence");
  assert.deepEqual([e.etape, e.physique], ["in_transit", true]);
  const r = analyse("DPD", { colis: colis(20), evenements: [e, lp(30, "DR1", "Votre colis va bientôt nous être confié")] });
  assert.equal(r.categorie, "confirme");
});

test("Colissimo : « Votre colis vous attend en point relais » confirme", () => {
  for (const code of ["AG1", "ZZ9"]) {
    const r = analyse("LP", { colis: colis(20), evenements: [lp(5, code, "Votre colis vous attend en point relais")] });
    assert.equal(r.categorie, "confirme", code);
  }
});

test("La Poste : « Vous avez fait une demande d'affranchissement » ne confirme JAMAIS (quel que soit le code)", () => {
  for (const code of ["DR1", "PC1", "ET1", "ZZ9"]) {
    const e = lp(5, code, "Vous avez fait une demande d'affranchissement");
    assert.equal(e.physique, false, code);
    const r = analyse("LP", { colis: colis(20), evenements: [e] });
    assert.equal(r.categorie, "non_confirme", code);
  }
});

test("une enquete sous un code d'incident La Poste n'est pas une preuve ; apres une preuve, elle ne l'efface pas", () => {
  const enquete = lp(2, "PB1", "Une enquête est en cours");
  assert.equal(enquete.physique, false);
  assert.notEqual(analyse("LP", { colis: colis(20), evenements: [enquete] }).categorie, "confirme");
  assert.equal(analyse("LP", { colis: colis(20), evenements: [enquete, lp(10, "PC1", "Votre colis a été déposé")] }).categorie, "confirme");
});

// --- DHL ------------------------------------------------------------------------------------

test("DHL : « delivered » confirme ; « en cours de dédouanement » = deja dans le reseau", () => {
  const livre = dhl.versEvenement({ statusCode: "delivered", description: "Delivered", timestamp: isoIlYa(2) }, 0);
  assert.deepEqual([livre.etape, livre.physique], ["delivered", true]);
  const douane = dhl.versEvenement({ statusCode: "transit", description: "Envoi en cours de dédouanement", timestamp: isoIlYa(5) }, 1);
  assert.deepEqual([douane.etape, douane.physique], ["in_transit", true]);
  const dhlNav = { ...transporteur("DHL") };
  assert.equal(analyseDepot({ maintenant: MAINTENANT, transporteur: dhlNav, suivi: { trouve: 1 }, colis: colis(20), evenements: [douane] }).categorie, "confirme");
  // la page officielle (lue sur le Mac) : « Livré », « en cours de dédouanement »
  assert.deepEqual([litLibelle("Livré", "DHL").etape, litLibelle("Livré", "DHL").physique], ["delivered", true]);
  assert.equal(litLibelle("Envoi en cours de dédouanement", "DHL").physique, true);
  assert.equal(litLibelle("Livraison prévue demain", "DHL").physique, false);
});

// --- La preuve reste -----------------------------------------------------------------------

test("la preuve reste : dernier evenement secondaire, livre, ou lecture en erreur ensuite", () => {
  const preuve = lp(18, "PC1", "Votre colis a été déposé dans un point postal");
  const cas = [
    { suivi: { trouve: 1 }, evenements: [lp(2, "ZZ9", "Information sans importance"), preuve] },
    { suivi: { trouve: 1 }, evenements: [lp(2, "DI1", "Votre colis est livré"), preuve] },
    { suivi: { trouve: 1, code_erreur: "passagere", erreur: "La Poste injoignable", essais: 5 }, evenements: [preuve] },
    { suivi: { trouve: 1, code_erreur: "bloque", erreur: "anti-robot" }, evenements: [preuve] },
    { suivi: { trouve: 0 }, evenements: [preuve] },
  ];
  for (const c of cas) assert.equal(analyse("LP", { colis: colis(20), ...c }).categorie, "confirme", JSON.stringify(c.suivi));
});

// --- Numero incorrect, ou simplement pas de reponse ------------------------------------------

test("numero incorrect seulement si le transporteur le dit ; un delai, une panne ou une protection ne le sont jamais", () => {
  const LP = "LP";
  assert.equal(analyse(LP, { colis: colis(10), suivi: { trouve: null, code_erreur: "invalide", erreur: "Numéro invalide" } }).categorie, "incorrect");
  // inconnu : dans le delai, pas encore pris en charge ; au-dela, une lecture : a verifier ; deux : incorrect
  assert.equal(analyse(LP, { colis: colis(10), suivi: { trouve: 0, inconnu_lectures: 3 } }).categorie, "non_confirme");
  assert.equal(analyse(LP, { colis: colis(80), suivi: { trouve: 0, inconnu_lectures: 1 } }).categorie, "a_verifier");
  assert.equal(analyse(LP, { colis: colis(80), suivi: { trouve: 0, inconnu_lectures: 2 } }).categorie, "incorrect");
  // jamais incorrect : delai depasse, erreur reseau, page incomplete, anti-robot, pause
  const jamais = [
    { suivi: { trouve: null, code_erreur: "passagere", erreur: "délai dépassé", essais: 1 } },
    { suivi: { trouve: null, code_erreur: "passagere", erreur: "La Poste injoignable", essais: 6 } },
    { suivi: { trouve: null, code_erreur: "incomplet", erreur: "page incomplète", essais: 1 } },
    { suivi: { trouve: null, code_erreur: "bloque", erreur: "anti-robot" } },
    { suivi: null, pause: { jusqua: sqlIlYa(-2), motif: "accès refusé" } },
  ];
  for (const c of jamais) {
    const r = analyse(LP, { colis: colis(80), ...c });
    assert.notEqual(r.categorie, "incorrect", JSON.stringify(c));
    assert.notEqual(r.categorie, "confirme", JSON.stringify(c));
  }
});

test("une absence de resultat n'est jamais une confirmation ; un evenement ambigu non plus", () => {
  for (const c of [{ suivi: null }, { suivi: { trouve: null } }, { suivi: { trouve: 1 } }, { suivi: { trouve: 0 } }]) {
    assert.notEqual(analyse("LP", { colis: colis(30), evenements: [], ...c }).categorie, "confirme");
  }
  const ambigu = analyse("MR", { colis: colis(30), evenements: evenementsMR([["12/10/2026", [["10:00", "Statut 7Z"]]]]).concat([]) });
  assert.equal(ambigu.categorie, "a_verifier");
});

test("statut ancien : un parcours termine puis une nouvelle etiquette, ou un parcours de plus de 30 jours, ne prouve pas ce depot", () => {
  // livre il y a 8 jours, puis une nouvelle etiquette : numero reutilise
  const reutilise = analyse("LP", { colis: colis(10, 12), evenements: [lp(20, "DR1", "Votre Colissimo va bientôt nous être confié"), lp(200, "DI1", "Votre colis est livré"), lp(210, "PC1", "Déposé")] });
  assert.equal(reutilise.categorie, "non_confirme");
  assert.equal(reutilise.ancienParcours, true);
  // un parcours de plus de 30 jours avant l'enregistrement
  const vieux = analyse("LP", { colis: colis(10, 12), evenements: [lp(1000, "DI1", "Votre colis est livré"), lp(1010, "PC1", "Déposé")] });
  assert.equal(vieux.categorie, "non_confirme");
  // livre 2 jours AVANT l'enregistrement, sans rien apres (cas reels) : le colis a bien circule
  const tard = analyse("LP", { colis: colis(10, 12), evenements: [lp(60, "DI1", "Votre colis est livré"), lp(80, "PC1", "Déposé")] });
  assert.equal(tard.categorie, "confirme");
  assert.equal(tard.livre, true);
});

test("cas reels @boxingmaestro : pris en charge ou livre avant l'enregistrement dans FeurDrop -> Posté confirmé", () => {
  // MR 4278185095 : pris en charge le 01/10 14:39, enregistre et dropé le 02/10
  const pris = analyseDepot({
    colis: { status: "dropped", created_at: "2026-10-02 17:00:00", dropped_at: "2026-10-02 17:51:00" },
    suivi: { trouve: 1 },
    evenements: [{ survenuLe: "2026-10-01T14:39:00+02:00", etape: "in_transit", physique: true, libelle: "Colis pris en charge en Point Relais", source: "navigateur" }],
    transporteur: transporteur("MR"),
    maintenant: MAINTENANT,
  });
  assert.equal(pris.categorie, "confirme");
  // MR 3473600217 : livré le 13/10, dropé le 15/10
  const livre = analyseDepot({
    colis: { status: "dropped", created_at: "2026-10-15 18:00:00", dropped_at: "2026-10-15 18:34:00" },
    suivi: { trouve: 1 },
    evenements: [{ survenuLe: "2026-10-13T14:46:00+02:00", etape: "delivered", physique: true, libelle: "Colis livré au destinataire", source: "navigateur" }],
    transporteur: transporteur("MR"),
    maintenant: Date.parse("2026-10-20T19:00:00Z"),
  });
  assert.equal(livre.categorie, "confirme");
  // une livraison datee dans le futur (page mal lue) ne compte jamais
  const futur = analyseDepot({
    colis: { status: "dropped", created_at: "2026-10-08 14:00:00", dropped_at: "2026-10-08 14:39:00" },
    suivi: { trouve: 1 },
    evenements: [{ survenuLe: "2026-10-22T13:07:00+02:00", etape: "delivered", physique: true, libelle: "Delivered", source: "navigateur" }],
    transporteur: transporteur("DHL"),
    maintenant: Date.parse("2026-10-20T19:00:00Z"),
  });
  assert.notEqual(futur.categorie, "confirme");
  assert.equal(futur.livre, false);
});

test("La Poste : une etiquette annulee et remboursee est dite (jamais « pas encore scanné » sans fin)", () => {
  const r = analyse("LP", { colis: colis(100), evenements: [lp(20, "ZZ1", "Vous avez fait une demande d'annulation de votre affranchissement auprès de notre service clients. Nous procédons au remboursement de votre envoi."), lp(120, "DR1")] });
  assert.equal(r.categorie, "a_verifier");
  assert.equal(r.annulee, true);
  assert.match(r.raison, /annulée et remboursée/);
});

test("DHL : la page d'un numero inconnu (pied de page « Delivered ») n'est jamais une livraison", () => {
  const texte = "Service de suivi\nSaisissez votre/vos numéro(s) de suivi\nSuivre\nJJD014600012864921699\nDésolé, votre tentative de suivi a échoué. Veuillez vérifier votre numéro de suivi et réessayer.\nQuestions fréquemment posées\nPied de page\nInformations sur la société\nÀ propos de DHL\nDelivered\nCarrières";
  assert.equal(lisPage("DHL", { texte }, "JJD014600012864921699").etat, "introuvable");
  // la meme page sans le message d'echec (chargement partiel) : pas de livraison non plus
  const partielle = "Saisissez votre/vos numéro(s) de suivi\nSuivre\nJJD014600012864921699\n22.10.2026\nPied de page\nInformations sur la société\nDelivered";
  const r = lisPage("DHL", { texte: partielle }, "JJD014600012864921699");
  assert.ok(!r.evenements.some((e) => e.etape === "delivered"));
});

// --- Releves sur 60 vrais colis Mondial Relay (20/10/2026, numeros factices ici) -------

test("Mondial Relay reel : les formules relevees sur de vrais colis", () => {
  const cas = [
    ["Prise en charge de votre colis sur notre site logistique de Wissous.", "in_transit", true],
    ["Prise en charge de votre colis sur notre site logistique de .", "in_transit", true],
    ["Colis en cours de traitement sur le site COMBS LA VILLE", "in_transit", true],
    ["Colis expédié depuis le site HUB HARNES", "in_transit", true],
    ["Colis en route vers le point de livraison", "in_transit", true],
    ["5 jours restants pour retirer le colis en Locker", "available_for_pickup", true],
    ["Colis livré au destinataire", "delivered", true],
    // la demande (une reclamation), pas le colis : jamais une preuve
    ["Nous avons bien pris en charge de votre demande, une réponse vous sera apportée prochainement sur votre suivi/ici.", "exception", false],
    ["Une recherche est en cours concernant votre colis, nous reviendrons vers vous dès que possible.", "exception", false],
    ["Une enquête est actuellement en cours.", "exception", false],
  ];
  for (const [libelle, etape, physique] of cas) {
    const r = litLibelle(libelle, "MR");
    assert.deepEqual([r.etape, r.physique], [etape, physique], libelle);
  }
});

test("Mondial Relay reel : le numero affiche sur 7 chiffres (« 9185908 ») est bien celui du colis", () => {
  const texte = "NUMÉRO DE COLIS\n9185908\nSTATUT\nVotre colis a été livré à l'enseigne.\nSUIVI DÉTAILLÉ DE MON COLIS\n13/10/2026\nColis livré au destinataire\n13:46\nColis livré au destinataire\nJe m'informe";
  assert.equal(lisPage("MR", { texte }, "2109185908").etat, "trouve");
  assert.equal(lisPage("MR", { texte }, "2109185999").etat, "autre_numero");
});

test("Mondial Relay reel : enquete en cours, jours passes sans heure -- la prise en charge du jour du drop reste la preuve", () => {
  // etiquette recue le 09/10 a 17:09 UTC (19:09 a Paris), dropee a 18:35 UTC ;
  // la page ne donne plus l'heure des jours passes (« 09/10 · Colis pris en charge »)
  const texte = `NUMÉRO DE COLIS
71615948
SUIVI DÉTAILLÉ DE MON COLIS
19/10/2026
Une enquête est actuellement en cours.
15:42
Une enquête est actuellement en cours.
17/10/2026
Une recherche est en cours concernant votre colis, nous reviendrons vers vous dès que possible avec des informations complémentaires. Une réponse définitive vous sera apportée dans un délai maximum de 30 jours.
14/10/2026
Nous avons bien pris en charge de votre demande, une réponse vous sera apportée prochainement sur votre suivi/ici.
09/10/2026
Colis pris en charge en Point Relais
03/10/2026
Colis en préparation chez l'expéditeur
Je m'informe`;
  const lu = lisPage("MR", { texte }, "8571615948");
  assert.equal(lu.etat, "trouve");
  // ce que le serveur garde : la page ne donnait que le jour
  const evenements = lu.evenements.map((e) => ({ ...e, jourSeul: !e.brut.heure }));
  const r = analyseDepot({
    colis: { status: "dropped", created_at: "2026-10-09 17:09:37", dropped_at: "2026-10-09 18:35:37" },
    suivi: { trouve: 1 },
    evenements,
    transporteur: transporteur("MR"),
    maintenant: Date.parse("2026-10-20T19:00:00Z"),
  });
  assert.equal(r.categorie, "confirme");
  assert.equal(r.preuve.statut, "Colis pris en charge en Point Relais");
  assert.match(r.raison, /le 09\/10 :/, "la date seule, sans heure inventee");
  assert.match(r.suite.libelle, /enquête/);
});

test("Mondial Relay reel : numero reutilise -- l'ancien parcours ne compte pas, la nouvelle prise en charge si", () => {
  const texte = `NUMÉRO DE COLIS
82493071
SUIVI DÉTAILLÉ DE MON COLIS
10/10/2026
Prise en charge de votre colis sur notre site logistique de Wissous.
17:45
Prise en charge de votre colis sur notre site logistique de Wissous.
04/10/2026
Colis livré au destinataire
30/09/2026
5 jours restants pour retirer le colis en Locker
29/09/2026
Colis expédié depuis le site HUB HARNES
Je m'informe`;
  const lu = lisPage("MR", { texte }, "5982493071");
  const evenements = lu.evenements.map((e) => ({ ...e, jourSeul: !e.brut.heure }));
  const colis = { status: "dropped", created_at: "2026-10-08 23:42:03", dropped_at: "2026-10-09 13:42:49" };
  const r = analyseDepot({ colis, suivi: { trouve: 1 }, evenements, transporteur: transporteur("MR"), maintenant: Date.parse("2026-10-20T19:00:00Z") });
  assert.equal(r.categorie, "confirme");
  assert.match(r.preuve.statut, /site logistique de Wissous/, "la preuve est celle du nouveau parcours");
});

test("une formule inconnue apres la reception de l'etiquette : a verifier (jamais « pas encore scanné »)", () => {
  const evenements = [
    { survenuLe: "2026-10-10T17:45:00+02:00", etape: "unknown", physique: false, libelle: "Nouvelle formule du transporteur", source: "navigateur" },
    { survenuLe: "2026-10-09T12:00:00+02:00", etape: "info_received", physique: false, libelle: "Colis en préparation chez l'expéditeur", source: "navigateur" },
  ];
  const r = analyseDepot({ colis: { status: "dropped", created_at: "2026-10-08 23:42:03", dropped_at: "2026-10-09 13:42:49" }, suivi: { trouve: 1 }, evenements, transporteur: transporteur("MR"), maintenant: Date.parse("2026-10-20T19:00:00Z") });
  assert.equal(r.categorie, "a_verifier");
  assert.equal(r.nonReconnu, true);
});
