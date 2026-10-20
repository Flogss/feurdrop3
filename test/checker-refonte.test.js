// La refonte du checker (octobre 2026), de bout en bout contre un faux
// serveur La Poste (SIMULE, au format de sa documentation) :
//   - Redrop d'un colis oublie : de retour « à poster » a 0 €, suivi et
//     historique gardes, jamais deux, rien d'autre ne bouge ;
//   - la regle « hors délai » : retire de la liste active, jamais supprime,
//     jamais une verification simplement bloquee ni un colis mis a jour ;
//   - les speciaux ne partent plus avec « Dropper » La Poste : on choisit
//     les transporteurs de speciaux a dropper ;
//   - l'impression automatique : tous les transporteurs au choix, la file
//     filtree cote serveur.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase, demarreApp } = require("./aide");
const { creeFauxLaPoste } = require("./fixtures/faux-laposte");

environnementDeTest();
const faux = creeFauxLaPoste();
const db = require("../src/db");
let depots;
let app;

before(async () => {
  process.env.LAPOSTE_SUIVI_URL = await faux.demarre();
  depots = require("../src/controle/depots");
  app = await demarreApp();
});
after(async () => {
  await app.ferme();
  await faux.ferme();
});
beforeEach(() => {
  videBase();
  faux.vide();
  faux.appels.length = 0;
  Object.assign(process.env, { CONTROLE_LAPOSTE_INTERVALLE_MS: "20", OKAPI_KEY: faux.cle });
  db.setSetting("auto_print_filtres", "{}");
});

const H = 3600 * 1000;
const isoIlYa = (h) => new Date(Date.now() - h * H).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const ev = (h, code, label = code) => ({ code, label, date: isoIlYa(h) });
function drope(numero, { carrier = "LP", heures = 2, expediteur = "Alice", type = "normal" } = {}) {
  const c = db.addColis(expediteur, { fileId: `F-${numero}-${Math.random()}`, fileKind: "pdf", carrier, type, fileName: `${numero}.pdf` });
  db.markPrinted([c.id], "test");
  db.dropColis(c.id);
  db.db.prepare("UPDATE colis SET created_at = datetime('now', ?), dropped_at = datetime('now', ?) WHERE id = ?").run(`-${heures + 12} hours`, `-${heures} hours`, c.id);
  return c.id;
}
const enAttente = (expediteur, carrier, type = "normal") => {
  const c = db.addColis(expediteur, { fileId: `F-${Math.random()}`, fileKind: "pdf", carrier, type, fileName: "x.pdf" });
  db.markPrinted([c.id], "test");
  return c.id;
};
const colis = (id) => db.getColisById(id);
const suivi = (numero) => db.db.prepare("SELECT * FROM controle_suivis WHERE numero = ?").get(numero);
const actif = (colisId) => depots.vue().lignes.some((l) => l.colisId === colisId);
const stockNormal = () => db.getStocks().normal;

// --- Redrop ---------------------------------------------------------------------------------

test("Redrop : le colis oublie revient « à poster » a 0 €, suivi et historique gardes, jamais deux", async () => {
  faux.suivi("6A20000000001", [ev(30, "DR1", "Votre colis va bientôt nous être confié")]);
  const id = drope("6A20000000001", { heures: 26 });
  const autre = drope("6A20000000002", { heures: 26 });
  await depots.synchronise();
  const avant = colis(id);
  assert.equal(depots.detail(id).controle.categorie, "non_confirme");
  const evenementsAvant = db.db.prepare("SELECT COUNT(*) AS c FROM controle_evenements WHERE numero = '6A20000000001'").get().c;
  const stockAvant = stockNormal();

  // depuis le site (la route du checker)
  let r = await app.appel(`/api/depots/${id}/redrop`, { methode: "POST", corps: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.deja, false);
  const rid = r.json.nouveau.id;
  assert.equal(r.json.redrop.enAttente, rid);
  const nouveau = colis(rid);
  assert.deepEqual([nouveau.status, nouveau.price, nouveau.price_locked, nouveau.redrop_de], ["pending", 0, 1, id]);
  assert.ok(nouveau.printed_at, "l'etiquette est deja imprimee : pas de retour dans la file d'impression");
  // l'origine ne bouge pas : prix, paiement, date de drop
  assert.deepEqual(colis(id), avant);
  assert.equal(colis(autre).status, "dropped", "les autres colis ne bougent pas");
  // la ligne du controle le dit ; plus d'alerte dessus
  const l = depots.vue().lignes.find((x) => x.colisId === id);
  assert.equal(l.redrop.enAttente, rid);
  assert.equal(l.attention, false);
  assert.equal(depots.vue().compteurs.redropsEnAttente, 1);
  // rejoue (double appui, reseau coupe) : le meme, jamais deux
  r = await app.appel(`/api/depots/${id}/redrop`, { methode: "POST", corps: {} });
  assert.equal(r.json.deja, true);
  assert.equal(r.json.nouveau.id, rid);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM colis WHERE redrop_de = ?").get(id).c, 1);

  // il part avec la prochaine tournee : 0 €, pas de pochette de plus
  const d = await app.appel("/api/colis/drop-all", { methode: "POST", corps: {} });
  assert.equal(d.json.count, 1);
  assert.equal(d.json.value, 0);
  assert.equal(stockNormal(), stockAvant, "la pochette a deja ete comptee au premier drop");
  // une seule ligne pour ce numero, celle du redrop ; l'historique est garde
  const lignes = depots.vue().lignes.filter((x) => x.numero === "6A20000000001");
  assert.equal(lignes.length, 1);
  assert.equal(lignes[0].colisId, rid);
  assert.equal(lignes[0].redrop.de, id);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM controle_evenements WHERE numero = '6A20000000001'").get().c, evenementsAvant);
  // le depot est enfin pris en charge : la ligne du redrop passe « confirme »
  faux.suivi("6A20000000001", [ev(0.5, "PC1", "Votre colis a été déposé"), ev(30, "DR1", "Votre colis va bientôt nous être confié")]);
  db.db.prepare("UPDATE controle_suivis SET prochaine_le = datetime('now', '-1 minute'), verifie_le = datetime('now', '-1 hour')").run();
  await depots.synchronise();
  assert.equal(depots.detail(rid).controle.categorie, "confirme");
  assert.equal(actif(rid), false);
  // le chiffre du jour du drop d'origine n'a pas bouge
  assert.equal(colis(id).price, avant.price);
});

test("Redrop refuse : colis deja pris en charge, ou pas dropé", async () => {
  faux.suivi("6A20000000003", [ev(1, "PC1", "Votre colis a été déposé")]);
  const id = drope("6A20000000003", { heures: 5 });
  await depots.synchronise();
  let r = await app.appel(`/api/depots/${id}/redrop`, { methode: "POST", corps: {} });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /pas oublié/);
  const attente = enAttente("Alice", "LP");
  r = await app.appel(`/api/depots/${attente}/redrop`, { methode: "POST", corps: {} });
  assert.equal(r.status, 409);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM colis WHERE redrop_de IS NOT NULL").get().c, 0);
});

test("Redrop : changer son type ne lui redonne pas de prix ; annuler son drop ne rend pas de pochette", () => {
  const id = drope("6A20000000004", { heures: 30 });
  const { colis: r } = db.redropColis(id);
  db.setColisType(r.id, "lit");
  assert.equal(colis(r.id).price, 0);
  const stock = stockNormal();
  const drop = db.dropColis(r.id);
  db.consumeStock(drop);
  assert.equal(stockNormal(), stock);
  const annule = db.undropColis(r.id);
  db.restoreStock(annule);
  assert.equal(stockNormal(), stock);
});

// --- Hors delai ---------------------------------------------------------------------------

test("hors délai : retire de la liste active (jamais supprime) ; jamais un colis mis a jour, bloque, en attente ou gardé", async () => {
  // etiquette seule, drope il y a 9 jours, rien depuis : retire
  faux.suivi("6A30000000001", [ev(230, "DR1", "Votre colis va bientôt nous être confié")]);
  const vieux = drope("6A30000000001", { heures: 216 });
  // une nouvelle recente du transporteur (hier) : garde
  faux.suivi("6A30000000002", [ev(20, "ZZ1", "Information de suivi mise à jour"), ev(230, "DR1")]);
  const bouge = drope("6A30000000002", { heures: 216 });
  // jamais lu (lecture en echec) : garde
  faux.comporte("6A30000000003", "panne");
  const panne = drope("6A30000000003", { heures: 216 });
  // UPS sans API : verification simplement bloquee, garde
  const ups = drope("1Z999AA10123456799", { heures: 216, carrier: "UPS" });
  // recent : garde
  faux.suivi("6A30000000004", [ev(30, "DR1")]);
  const recent = drope("6A30000000004", { heures: 26 });
  const avant = JSON.stringify(db.db.prepare("SELECT * FROM colis ORDER BY id").all());
  await depots.synchronise();
  await depots.synchronise();
  assert.ok(suivi("6A30000000001").archive_le, "hors délai");
  assert.match(suivi("6A30000000001").archive_motif, /Hors délai : dropé il y a 9 j, aucune prise en charge/);
  assert.equal(JSON.parse(suivi("6A30000000001").archive_detail).regle, "hors_delai");
  for (const id of [bouge, panne, ups, recent]) assert.equal(actif(id), true, `garde ${id}`);
  assert.equal(actif(vieux), false);
  // rien n'est supprime : le colis, ses evenements, l'historique
  assert.equal(JSON.stringify(db.db.prepare("SELECT * FROM colis ORDER BY id").all()), avant);
  assert.ok(db.db.prepare("SELECT COUNT(*) AS c FROM controle_evenements WHERE numero = '6A30000000001'").get().c > 0);
  const v = depots.vue();
  assert.ok(v.historique.retires.some((h) => h.colisId === vieux && h.retire.regle === "hors_delai"));
  // « Vérifier » le remet dans la liste, et la regle le laisse tranquille
  await depots.verifieColis(vieux);
  await depots.synchronise();
  assert.equal(actif(vieux), true);
  assert.ok(suivi("6A30000000001").garde_le);
  // la regle se regle (CONTROLE_ARCHIVE_JOURS) ; 0 la coupe
  process.env.CONTROLE_ARCHIVE_JOURS = "0";
  db.db.prepare("UPDATE controle_suivis SET garde_le = NULL").run();
  await depots.synchronise();
  assert.equal(actif(vieux), true);
  delete process.env.CONTROLE_ARCHIVE_JOURS;
});

test("compteurs : chaque colis de la liste compte une fois ; « Pas encore scanné » = non confirmes", async () => {
  faux.suivi("6A40000000001", [ev(5, "DR1")]);
  faux.suivi("6A40000000002", [ev(1, "PC1", "Déposé")]);
  faux.comporte("6A40000000003", "invalide");
  drope("6A40000000001", { heures: 4 });
  drope("6A40000000002", { heures: 4 });
  drope("6A40000000003", { heures: 4 });
  drope("1Z999AA10123456798", { heures: 4, carrier: "UPS" });
  await depots.synchronise();
  const { compteurs: c, lignes } = depots.vue();
  assert.equal(c.pasEncoreScanne, 1);
  assert.equal(c.incorrect, 1);
  assert.equal(c.confirme, 1);
  const somme = ["non_confirme", "a_verifier", "bloque", "en_attente", "incorrect"].reduce((n, k) => n + c[k], 0);
  assert.equal(somme, c.actifs);
  assert.equal(lignes.length, c.actifs);
  assert.equal(c.actifs + c.confirme + c.retires, c.total);
});

// --- Speciaux ------------------------------------------------------------------------------

test("« Dropper » La Poste n'emporte plus les speciaux ; on choisit les transporteurs de speciaux a dropper", async () => {
  const lp = enAttente("Alice", "LP");
  const spLp = enAttente("Alice", "LP", "special");
  const spMr = enAttente("Bob", "MR", "special");
  const spUps = enAttente("Bob", "UPS", "special");
  // le resume : une ligne « Spéciaux », detaillee par transporteur
  const s = await app.appel("/api/stats");
  const ligneLp = s.json.byCarrier.find((c) => c.carrier === "LP");
  const ligneSp = s.json.byCarrier.find((c) => c.carrier === "SPECIAL");
  assert.equal(ligneLp.pending_count, 1);
  assert.equal(ligneSp.pending_count, 3);
  assert.deepEqual(ligneSp.detail.map((d) => d.carrier).sort(), ["LP", "MR", "UPS"]);

  let r = await app.appel("/api/colis/drop-carrier/LP", { methode: "POST", corps: {} });
  assert.equal(r.json.count, 1);
  assert.equal(colis(lp).status, "dropped");
  assert.equal(colis(spLp).status, "pending", "le special La Poste reste");

  // rien de choisi : refuse
  r = await app.appel("/api/colis/drop-specials", { methode: "POST", corps: { carriers: [] } });
  assert.equal(r.status, 400);
  r = await app.appel("/api/colis/drop-specials", { methode: "POST", corps: { carriers: ["LP", "MR"] } });
  assert.equal(r.json.count, 2);
  assert.deepEqual([colis(spLp).status, colis(spMr).status, colis(spUps).status], ["dropped", "dropped", "pending"]);
  // l'ancienne app (sans choix) : « SPECIAL » = tous les speciaux restants
  r = await app.appel("/api/colis/drop-carrier/SPECIAL", { methode: "POST", corps: {} });
  assert.equal(r.json.count, 1);
  assert.equal(colis(spUps).status, "dropped");
});

// --- Impression automatique ------------------------------------------------------------------

test("impression auto : tous les transporteurs au choix, et seuls les choisis partent", async () => {
  db.setAutoPrintEnabled(true);
  let r = await app.appel("/api/print/auto");
  const codes = r.json.options.transporteurs.map((t) => t.code);
  for (const c of ["LP", "MR", "CHRONO", "UPS", "DPD", "GLS", "DHL"]) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes("BJ"), "les BJ sont une categorie");
  r = await app.appel("/api/print/auto", { methode: "POST", corps: { filtres: { transporteurs: ["DHL", "DPD"] } } });
  assert.deepEqual(r.json.filtres.transporteurs, ["DHL", "DPD"]);
  const nouveau = (carrier) => db.addColis("Alice", { fileId: `F-${Math.random()}`, fileKind: "pdf", carrier, fileName: "x.pdf" }).id;
  const dhl = nouveau("DHL");
  nouveau("LP");
  const dpd = nouveau("DPD");
  nouveau("MR");
  assert.deepEqual(db.fileAuto().map((c) => c.id).sort(), [dhl, dpd].sort());
  // garde par le serveur : le telephone et le site lisent le meme choix
  assert.deepEqual((await app.appel("/api/print/auto")).json.filtres.transporteurs, ["DHL", "DPD"]);
});

test("espace expediteur : un colis redropé n'apparait qu'une fois (sa derniere ligne), « Pas encore scanné » suit", async () => {
  const { creePortail, portailPour } = require("../src/portail");
  faux.suivi("6A20000000009", [ev(40, "DR1", "Votre colis va bientôt nous être confié")]);
  const id = drope("6A20000000009", { heures: 30, expediteur: "Alice" });
  await depots.synchronise();
  const jeton = creePortail(db.getOrCreateSender("Alice").id).sender.portail_jeton;
  let p = portailPour(jeton);
  assert.equal(p.colis.length, 1);
  assert.equal(p.colis[0].depot?.etat, "pas_encore");
  const { colis: r } = db.redropColis(id);
  p = portailPour(jeton);
  assert.equal(p.total, 1, "jamais deux lignes pour un meme colis");
  assert.equal(p.colis[0].etape === "drope", false, "de retour avant le drop");
  db.dropColis(r.id);
  p = portailPour(jeton);
  assert.equal(p.total, 1);
  assert.equal(p.colis[0].etape, "drope");
});
