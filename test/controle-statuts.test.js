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

test("statut ancien : un scan d'avant la reception de l'etiquette ne prouve pas ce depot", () => {
  const r = analyse("LP", { colis: colis(10, 12), evenements: [lp(200, "DI1", "Votre colis est livré"), lp(210, "PC1", "Déposé")] });
  assert.equal(r.categorie, "non_confirme");
  assert.equal(r.ancienParcours, true);
});
