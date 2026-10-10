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

test("donnees anciennes : jamais une preuve, et c'est une anomalie", () => {
  const r = analyse({ colis: colis(24, 48), evenements: [lp(2000, "DI1"), lp(2100, "PC1")] });
  assert.equal(r.categorie, "anomalie");
  assert.match(r.raison, /Suivi antérieur à FeurDrop/);
  // une etiquette creee avant la reception du fichier est normale
  const etiquette = analyse({ colis: colis(5, 30), evenements: [lp(200, "DR1")] });
  assert.equal(etiquette.categorie, "non_confirme");
});

test("scans anterieurs a la reception de l'etiquette : jamais une preuve (cas reel)", () => {
  // 6B00017912600 : etiquette recue par FeurDrop le 09/10 a 17:20 UTC, mais
  // La Poste l'avait deja en transit la veille et en point de retrait le matin
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
  assert.equal(r.categorie, "anomalie");
  assert.equal(r.preuve, null);
  assert.match(r.raison, /avant la réception/);
});

test("boite jaune : l'ancien parcours n'est ni une preuve ni une anomalie", () => {
  const bj = (evenements) =>
    analyseDepot({
      colis: { type: "bj", status: "dropped", created_at: "2026-10-09 12:50:15", dropped_at: "2026-10-09 14:47:15" },
      suivi: { trouve: 1 },
      evenements: evenements.map(versEvenement),
      transporteur: LP,
      maintenant: Date.parse("2026-10-09T20:00:00Z"),
    });
  // cas reel 6Y11147684428 : en point relais le matin, etiquette recue a 12:50 UTC
  const ancien = [
    { code: "AG1", label: "Votre colis est disponible dans votre point de retrait", date: "2026-10-09T10:57:00+02:00" },
    { code: "MD1", label: "Votre colis est sur son site de distribution.", date: "2026-10-09T08:35:31+02:00" },
    { code: "ET1", label: "Votre colis est en transit sur nos plateformes logistiques.", date: "2026-10-08T23:23:31+02:00" },
    { code: "DR1", label: "Votre Colissimo va bientôt nous être confié !", date: "2026-10-08T20:11:00+02:00" },
  ];
  const r = bj(ancien);
  assert.equal(r.categorie, "non_confirme");
  assert.equal(r.preuve, null);
  assert.match(r.raison, /ignorés/);
  // de nouveau en transit apres le drop : depot confirme par CE scan
  const apres = bj([{ code: "ET1", label: "Votre colis est en transit sur nos plateformes logistiques.", date: "2026-10-09T19:30:00+02:00" }, ...ancien]);
  assert.equal(apres.categorie, "confirme");
  assert.equal(apres.preuve.le, "2026-10-09T19:30:00+02:00");
});

test("incidents : retour, non distribuable ; un probleme resolu n'en est plus un", () => {
  const retour = analyse({ colis: colis(100), evenements: [lp(5, "RE1", "Retourné à l'expéditeur"), lp(90, "PC1")] });
  assert.equal(retour.categorie, "anomalie");
  assert.equal(retour.preuve.code, "PC1");
  const probleme = analyse({ colis: colis(50), evenements: [lp(5, "PB1", "Problème en cours"), lp(40, "PC1")] });
  assert.equal(probleme.categorie, "anomalie");
  const resolu = analyse({ colis: colis(50), evenements: [lp(2, "DI1"), lp(5, "PB1"), lp(40, "PC1")] });
  assert.equal(resolu.categorie, "confirme");
});

test("statut transporteur non reconnu : verification necessaire, pas une preuve", () => {
  const r = analyse({ colis: colis(30), evenements: [lp(10, "XX9", "Statut inédit")] });
  assert.equal(r.categorie, "a_verifier");
  assert.match(r.raison, /non reconnu/);
});

test("transporteur sans verification automatique : bloque, jamais « non depose »", () => {
  const mr = transporteur("MR");
  const r = analyse({ colis: colis(30), transporteur: mr, suivi: null, evenements: [] });
  assert.equal(r.categorie, "bloque");
  assert.equal(r.libelle, "Vérification bloquée");
  assert.match(r.raison, /Cloudflare/);
  assert.equal(r.manuel, true);
  assert.ok(mr.lien("1234567890").includes("1234567890"), "lien officiel avec le numero");
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
  const mr = transporteur("MR");
  const constat = (h, code, extra = {}) => ({ survenuLe: isoIlYa(h), code, source: "manuel", ...extra });
  const pris = analyse({ colis: colis(30), transporteur: mr, evenements: [constat(1, "MANUEL_PRIS", { physique: true, etape: "in_transit" })] });
  assert.equal(pris.categorie, "confirme");
  assert.match(pris.raison, /constatée à la main/);
  const pasEncore = analyse({ colis: colis(30), transporteur: mr, evenements: [constat(1, "MANUEL_PAS_ENCORE", { etape: "info_received" })] });
  assert.equal(pasEncore.categorie, "non_confirme");
  const perime = analyse({ colis: colis(80), transporteur: mr, evenements: [constat(30, "MANUEL_PAS_ENCORE", { etape: "info_received" })] });
  assert.match(perime.raison, /à revérifier/);
  assert.equal(perime.enRetard, true);
  const probleme = analyse({ colis: colis(30), transporteur: mr, evenements: [constat(1, "MANUEL_PROBLEME", { incident: "Problème signalé", etape: "exception" })] });
  assert.equal(probleme.categorie, "anomalie");
  // le dernier constat fait foi
  const corrige = analyse({
    colis: colis(30),
    transporteur: mr,
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
