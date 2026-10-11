// Le lecteur des pages officielles (controle/pages.js), avec les vrais
// textes relevés dans WebKit sur le Mac de FeurDrop (octobre 2026, numeros
// factices) : jamais de preuve sans une formule qui la dit, jamais de
// conclusion sur une page de protection.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lisPage, litLibelle, litDate, litHeure, estBloque } = require("../src/controle/pages");

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

// la page d'un colis (structure vue le 09/10/2026 sur un vrai numero : la
// date, le titre du jour, puis des paires heure / evenement)
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
Colis pris en charge en Point Relais
12:42
Colis en préparation chez l'expéditeur
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
  const r = lisPage("MR", { titre: "Suivi de colis - Mondial Relay", texte: MR_PRIS }, "4278870015");
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
  const r = lisPage("MR", { texte: "NUMÉRO DE COLIS\n78870016\nSTATUT\nColis en préparation chez l'expéditeur\nSUIVI DÉTAILLÉ DE MON COLIS\n10/10/2026\nColis en préparation chez l'expéditeur\n08:12\nColis en préparation chez l'expéditeur\nJe m'informe" }, "4278870016");
  assert.equal(r.etat, "trouve");
  assert.ok(r.evenements.every((e) => !e.physique));
});

test("DHL : echec de suivi = numero inconnu ; la FAQ de la page ne compte pas (« livré » hors du suivi)", () => {
  const r = lisPage("DHL", { titre: "Suivi - DHL - France", texte: DHL_ECHEC });
  assert.equal(r.etat, "introuvable");
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

test("les formules de chaque transporteur : etiquette, prise en charge, transit, livraison, retour ; jamais le futur", () => {
  const cas = [
    ["MR", "Colis en préparation chez l'expéditeur", "info_received", false],
    ["MR", "Colis pris en charge en Point Relais", "in_transit", true],
    ["MR", "Colis remis à Mondial Relay", "in_transit", true],
    ["MR", "Colis disponible en Point Relais", "available_for_pickup", true],
    ["MR", "Colis livré au destinataire", "delivered", true],
    // remis au vendeur : la suite d'une prise en charge (un retour), pas une anomalie
    ["MR", "Votre colis est mis à disposition du vendeur", "exception", true],
    ["MR", "En attente de prise en charge", "unknown", false],
    ["MR", "Votre colis sera déposé en Point Relais", "unknown", false],
    ["DHL", "Label Created", "info_received", false],
    ["DHL", "Shipment information received", "info_received", false],
    ["DHL", "Les données électroniques de l'envoi ont été transmises", "info_received", false],
    ["DHL", "Picked up", "in_transit", true],
    ["DHL", "In transit", "in_transit", true],
    ["DHL", "Arrivé au centre de tri", "in_transit", true],
    ["DHL", "Out for delivery", "out_for_delivery", true],
    ["DHL", "Delivered", "delivered", true],
    ["DHL", "Retourné à l'expéditeur", "exception", true],
    ["DHL", "Livraison prévue demain", "unknown", false],
    ["DHL", "The shipment will be picked up", "unknown", false],
    ["GLS", "The parcel data was entered into the GLS IT system; the parcel was not yet handed over to GLS.", "info_received", false],
    ["GLS", "The parcel was handed over to GLS.", "in_transit", true],
    ["GLS", "The parcel has been delivered.", "delivered", true],
    ["GLS", "The parcel is expected to be delivered during the day.", "unknown", false],
    ["MR", "Code 7Z", "unknown", false],
  ];
  for (const [code, libelle, etape, physique] of cas) {
    const r = litLibelle(libelle, code);
    assert.equal(r.etape, etape, `${code} ${libelle}`);
    assert.equal(r.physique, physique, `${code} ${libelle}`);
  }
});

test("la page doit etre celle de CE numero : une autre page n'est jamais attribuee", () => {
  // la page affiche les 8 derniers chiffres d'un autre colis
  const r = lisPage("MR", { titre: "Suivi de colis - Mondial Relay", texte: MR_PRIS }, "4278870099");
  assert.equal(r.etat, "autre_numero");
  assert.deepEqual(r.evenements, []);
});

test("page incomplete (suivi pas encore affiche, ou seulement la banniere de cookies) : ni statut, ni blocage", () => {
  const cookies = "Mondial Relay\nNous utilisons des cookies pour améliorer votre expérience.\nAccepter & Fermer\nContinuer sans accepter\nParamétrer";
  const r = lisPage("MR", { titre: "Suivi de colis - Mondial Relay", texte: cookies }, "4278870015");
  assert.equal(r.etat, "incomplet");
  assert.equal(estBloque({ titre: "Suivi de colis", texte: cookies }), false, "une banniere de cookies n'est pas un defi");
  // la banniere au-dessus d'un vrai suivi : la page est lue
  assert.equal(lisPage("MR", { texte: `${cookies}\n${MR_PRIS}` }, "4278870015").etat, "trouve");
});

test("DHL (page SIMULEE, aucun vrai numero disponible) : dates a points, statut en tete ignore, evenements dates", () => {
  const texte = `Saisissez votre/vos numéro(s) de suivi
Suivre
JJD0146000128653732
Livré
09.10.2026 14:02 Bonn, Allemagne
L'envoi a été livré.
08.10.2026 09:15
L'envoi a été traité dans le centre de tri
07.10.2026 18:40
Les données électroniques de l'envoi ont été transmises
Questions fréquemment posées
Pourquoi mon envoi a-t-il été livré en retard ?`;
  const r = lisPage("DHL", { titre: "Suivi - DHL", texte, url: "https://www.dhl.com/fr-fr/home/suivi.html?tracking-id=JJD0146000128653732" }, "JJD0146000128653732");
  assert.equal(r.etat, "trouve");
  assert.deepEqual(
    r.evenements.map((e) => [e.etape, e.survenuLe]),
    [
      ["delivered", "2026-10-09T14:02:00+02:00"],
      ["in_transit", "2026-10-08T09:15:00+02:00"],
      ["info_received", "2026-10-07T18:40:00+02:00"],
    ]
  );
  assert.equal(lisPage("DHL", { texte }, "JJD0146000128653799").etat, "autre_numero");
});

test("les heures : 20:31, 20h31, 8:31 PM, 12:05 AM", () => {
  assert.equal(litHeure("20:31"), "20:31");
  assert.equal(litHeure("à 20h31"), "20:31");
  assert.equal(litHeure("8:31 PM"), "20:31");
  assert.equal(litHeure("12:05 AM"), "00:05");
  assert.equal(litHeure("pas d'heure"), null);
});

test("les dates des pages : 09/10/2026, 2026-10-09, 9 octobre 2026, October 9, 2026", () => {
  assert.equal(litDate("09/10/2026"), "2026-10-09");
  assert.equal(litDate("le 2026-10-09 a 10:00"), "2026-10-09");
  assert.equal(litDate("jeudi 9 octobre 2026"), "2026-10-09");
  assert.equal(litDate("October 9, 2026"), "2026-10-09");
  assert.equal(litDate("09.10.2026"), "2026-10-09");
  assert.equal(litDate("9 Oct 2026"), "2026-10-09");
  assert.equal(litDate("pas de date"), null);
});
