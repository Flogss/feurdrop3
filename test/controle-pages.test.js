// Le lecteur des pages officielles (controle/pages.js), avec les vrais
// textes relevés dans WebKit sur le Mac de FeurDrop (octobre 2026, numeros
// factices) : jamais de preuve sans une formule qui la dit, jamais de
// conclusion sur une page de protection.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lisPage, litLibelle, litDate, estBloque } = require("../src/controle/pages");

// --- textes reels (extraits) -----------------------------------------------------------

const MR_INTROUVABLE = `Mondial Relay e-livraison de vos colis
Suivi de colis
 AccueilSuivi de colis
Suivre un colis
Numéro de colis
Votre numéro de colis est composé de 8 chiffres.
Code postal du destinataire
Rechercher
Nous n’avons identifié aucun colis portant ce numéro de suivi 😞
L'une de ces 2 raisons peut l'expliquer :
Le numéro saisi est incorrect. Veuillez noter qu'il doit comporter 8, 10 ou 12 chiffres. Vous venez de passer commande et quelques minutes peuvent être nécessaires avant que votre suivi de colis ne s'affiche.
Je m'informe`;

// la page d'un colis (structure vue le 09/10/2026 sur un vrai numero)
const MR_PRIS = `Accueil
Suivi de colis
Suivre un colis
Rechercher un autre colis
Mis à jour le 09/10/2026 à 20:31
NUMÉRO DE COLIS
78870015
STATUT
Colis pris en charge en Point Relais
SUIVI GLOBAL DE MON COLIS
Colis en préparation chez l'expéditeur
Colis remis à Mondial Relay
Colis livré au destinataire
SUIVI DÉTAILLÉ DE MON COLIS
09/10/2026
Colis pris en charge en Point Relais
20:31
Colis en préparation chez l'expéditeur
12:42
Je m'informe
APP'SOLUMENT INDISPENSABLE !`;

const DHL_ECHEC = `Navigation et contenu
Suivi
Service de suivi
Saisissez votre/vos numéro(s) de suivi
Suivre
JJD0146000128653732
Désolé, votre tentative de suivi a échoué. Veuillez vérifier votre numéro de suivi et réessayer.
Questions fréquemment posées
Pourquoi mon envoi n'a-t-il pas été livré à temps ?`;

const FEDEX_DOUBLON = `Fedex Home
Tracking
Track Another Shipment
Local Scan Time
Help
Duplicate results found
More than one shipment was found with the following tracking number(s). Please click on the tracking number(s) below to find your shipment.
123456789012
OUR COMPANY
About FedEx`;

const GLS_AUCUN = `Group
Parcel tracking
Track your parcel online at any time: All you have to do is simply enter one or more parcel numbers.
Unfortunately there are no results.
Please check your entry.
It is also possible, that your parcel has not reached us yet. Please try again later.
Parcel Search
Parcel numbers`;

// --- les cas ----------------------------------------------------------------------------

test("Mondial Relay : numero inconnu, puis un colis pris en charge (le « suivi global » n'est pas une livraison)", () => {
  assert.equal(lisPage("MR", { titre: "Suivi de colis - Mondial Relay", texte: MR_INTROUVABLE }).etat, "introuvable");
  const r = lisPage("MR", { titre: "Suivi de colis - Mondial Relay", texte: MR_PRIS });
  assert.equal(r.etat, "trouve");
  assert.equal(r.statutBrut, "Colis pris en charge en Point Relais");
  const physiques = r.evenements.filter((e) => e.physique);
  assert.equal(physiques.length, 1);
  assert.equal(physiques[0].survenuLe, "2026-10-09T20:31:00+02:00");
  assert.ok(!r.evenements.some((e) => e.etape === "delivered"), "les etapes possibles ne sont pas des evenements");
  const etiquette = r.evenements.find((e) => !e.physique);
  assert.equal(etiquette.etape, "info_received");
});

test("Mondial Relay : etiquette seulement -> aucun evenement physique", () => {
  const r = lisPage("MR", { texte: "STATUT\nColis en préparation chez l'expéditeur\nSUIVI DÉTAILLÉ DE MON COLIS\n10/10/2026\nColis en préparation chez l'expéditeur\n08:12\nJe m'informe" });
  assert.equal(r.etat, "trouve");
  assert.ok(r.evenements.every((e) => !e.physique));
});

test("DHL : echec de suivi = numero inconnu ; la FAQ de la page ne compte pas (« livré » hors du suivi)", () => {
  const r = lisPage("DHL", { titre: "Suivi - DHL - France", texte: DHL_ECHEC });
  assert.equal(r.etat, "introuvable");
});

test("FedEx : plusieurs envois pour ce numero -> a choisir sur la page", () => {
  const r = lisPage("FEDEX", { titre: "Detailed Tracking", texte: FEDEX_DOUBLON });
  assert.equal(r.etat, "ambigu");
});

test("GLS : aucun resultat", () => {
  assert.equal(lisPage("GLS", { titre: "Parcel Tracking | GLS Parcel Service", texte: GLS_AUCUN }).etat, "introuvable");
});

test("une page de protection n'est jamais lue comme un statut", () => {
  for (const [titre, texte] of [
    ["Just a moment...", "Vérification que vous êtes humain"],
    ["Attention Required! | Cloudflare", "Sorry, you have been blocked"],
    ["Access Denied", "You don't have permission to access"],
    ["Suivi - DHL", "Your tracking attempt has been blocked."],
  ]) {
    const r = lisPage("MR", { titre, texte });
    assert.equal(r.etat, "bloque", titre);
    assert.deepEqual(r.evenements, []);
  }
  // une page normale qui mentionne un captcha dans son code n'est pas bloquee
  assert.equal(estBloque({ titre: "Suivi | UPS - France", texte: "Livré\nLivré à LONGVIEW, TX US" }), false);
});

test("une page lue mais sans formule reconnue : illisible, jamais une preuve", () => {
  const r = lisPage("DHL", { texte: "Saisissez votre/vos numéro(s) de suivi\nSuivre\nStatut : code 7Z\nQuestions fréquemment posées" });
  assert.equal(r.etat, "illisible");
  assert.deepEqual(r.evenements, []);
});

test("les formules : etiquette, prise en charge, transit, livraison, retour", () => {
  const cas = {
    "Label Created": ["info_received", false],
    "Shipment information received": ["info_received", false],
    "Les données électroniques de l'envoi ont été transmises": ["info_received", false],
    "En attente de prise en charge": ["info_received", false],
    "Picked up": ["in_transit", true],
    "We have your package": ["in_transit", true],
    "In transit": ["in_transit", true],
    "Arrivé au centre de tri": ["in_transit", true],
    "Out for delivery": ["out_for_delivery", true],
    "Colis disponible en Point Relais": ["available_for_pickup", true],
    "Votre colis est mis à disposition du vendeur": ["available_for_pickup", true],
    "Delivered": ["delivered", true],
    "Colis livré au destinataire": ["delivered", true],
    "Retourné à l'expéditeur": ["exception", true],
    "Livraison prévue demain": ["unknown", false],
    "Code 7Z": ["unknown", false],
  };
  for (const [libelle, [etape, physique]] of Object.entries(cas)) {
    const r = litLibelle(libelle);
    assert.equal(r.etape, etape, libelle);
    assert.equal(r.physique, physique, libelle);
  }
});

test("les dates des pages : 09/10/2026, 2026-10-09, 9 octobre 2026, October 9, 2026", () => {
  assert.equal(litDate("09/10/2026"), "2026-10-09");
  assert.equal(litDate("le 2026-10-09 a 10:00"), "2026-10-09");
  assert.equal(litDate("jeudi 9 octobre 2026"), "2026-10-09");
  assert.equal(litDate("October 9, 2026"), "2026-10-09");
  assert.equal(litDate("09.10.2026"), "2026-10-09");
  assert.equal(litDate("pas de date"), null);
});
