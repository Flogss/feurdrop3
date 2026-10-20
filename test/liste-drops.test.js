// La liste du jour (« 📋 Mes drops du jour ») puis son PDF : une etiquette par
// page, dans l'ordre de la liste, chacune sous son numero (donc son
// transporteur), la note du poids posee, et jamais deux fois le meme numero.
// Avec le vrai bot face a un faux serveur Telegram.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase } = require("./aide");
const { creeFauxTelegram } = require("./fixtures/faux-telegram");

environnementDeTest();
const GROUPE = -1004388459228;
const ADMIN = 111;
const faux = creeFauxTelegram();

let db;
let bot;
let numero = 1;
const maintenant = () => Math.floor(Date.now() / 1000);

const LISTE = `📋 Mes drops du jour — PARIS94 (4 colis)

Ta liste du jour : ce qu'il te reste à déposer.

📅 20/10/2026 — 4 colis
  📄 8R50345899012 (1000g)
  📄 8R49597374149
  📄 8R49597373395
  📄 8571271394

🆕 Bordereau pas encore prêt · 📄 À déposer maintenant

📊 Total : 4 colis`;

const ANNONCE = `📄 Nouveau PDF !

📍 PARIS94 - 20/10/2026

📦 Total : 4 bordereaux
🆕 Nouveaux : 4

━━━━━━━━━━━━━━━━━━━━━━
🎯 SUIVIS SPÉCIAUX :

⚖️ Avec poids (1) :
  • 8R50345899012 → 1.0kg

━━━━━━━━━━━━━━━━━━━━━━

⏰ Tu as 48h pour déposer !
📄 Nouveau PDF reçu ꜰᴇᴜʀᴍᴀɴ {𝘃𝟮 𝗯𝗶𝗼} ! 4 colis à déposer. Go go go !`;

const fournisseur = { type: "user", sender_user: { id: 999, is_bot: true, first_name: "Feurman", username: "feurman_bot" }, date: maintenant() };

function texte(t) {
  return { message: { message_id: numero++, from: { id: ADMIN, first_name: "Flo" }, chat: { id: ADMIN, type: "private" }, date: maintenant(), forward_origin: fournisseur, text: t } };
}

function pdf(fileId, nom, caption) {
  return {
    message: {
      message_id: numero++,
      from: { id: ADMIN, first_name: "Flo" },
      chat: { id: ADMIN, type: "private" },
      date: maintenant(),
      forward_origin: fournisseur,
      document: { file_id: fileId, file_unique_id: `u${fileId}`, file_name: nom, mime_type: "application/pdf" },
      ...(caption ? { caption } : {}),
    },
  };
}

// un PDF de `n` pages ; la page i mesure 200 + i points de large : on retrouve
// ainsi quelle page est partie sous quel numero
async function pdfDe(n) {
  const { PDFDocument } = require("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i += 1) doc.addPage([200 + i, 300]);
  return doc.save();
}

async function largeurs(octets) {
  const { PDFDocument } = require("pdf-lib");
  const doc = await PDFDocument.load(octets);
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

const colisTous = () => db.db.prepare("SELECT * FROM colis ORDER BY id").all();
const reponses = (motif) => faux.appelsDe("sendMessage").filter((a) => Number(a.params.chat_id) === ADMIN && motif.test(String(a.params.text)));
const envoisGroupe = () => faux.appelsDe("sendDocument").filter((a) => Number(a.params.chat_id) === GROUPE);

before(async () => {
  process.env.TELEGRAM_API_URL = await faux.demarre();
  process.env.TELEGRAM_ALLOWED_USERS = String(ADMIN);
  process.env.FILE_REPRISES_MS = "";
  process.env.REPLY_TTL_MS = "20";
  process.env.REPLY_LECTURE_MS = "20";
  process.env.BATCH_DEBOUNCE_MS = "50";
  process.env.GROUP_WRITE_INTERVAL_MS = "5";
  db = require("../src/db");
  bot = require("../src/bot").startBot();
});

after(async () => {
  // le bot finit ses envois (boutons, recapitulatif) avant qu'on coupe : sinon
  // il les reessaie longtemps contre un serveur ferme
  for (let n = -1; n !== faux.appels.length; ) {
    n = faux.appels.length;
    await new Promise((r) => setTimeout(r, 600));
  }
  await bot.stopPolling({ cancel: true }).catch(() => {});
  await faux.ferme();
});

beforeEach(() => videBase());

test("lecture des deux messages", () => {
  const { lisListeDrops, lisAnnoncePdf, notePoids } = require("../src/bot/listeDrops");
  const l = lisListeDrops(LISTE);
  assert.equal(l.nom, "PARIS94");
  assert.deepEqual(
    l.entrees.map((e) => [e.numero, e.pret, e.grammes]),
    [
      ["8R50345899012", true, 1000],
      ["8R49597374149", true, null],
      ["8R49597373395", true, null],
      ["8571271394", true, null],
    ]
  );
  // la legende (« 🆕 Bordereau… ») n'est pas un numero ; un numero en double
  // ne compte qu'une fois ; « 🆕 » = pas encore dans le PDF
  const autre = lisListeDrops("📋 Mes drops du jour — X (3)\n📄 8R11111111111\n🆕 8R22222222222\n📄 8R11111111111\n📄 857000000");
  assert.deepEqual(autre.entrees.map((e) => [e.numero, e.pret]), [["8R11111111111", true], ["8R22222222222", false], ["857000000", true]]);

  const a = lisAnnoncePdf(ANNONCE);
  assert.equal(a.nom, "PARIS94");
  assert.deepEqual(a.poids, { "8R50345899012": 1000 });
  assert.equal(notePoids(1000), "1kg");
  assert.equal(notePoids(1500), "1,5kg");
  assert.equal(notePoids(750), "750g");
  assert.equal(lisListeDrops("bonjour"), null);
});

test("la liste puis le PDF de 4 pages : 4 etiquettes, chacune sous son numero, son transporteur et son poids", async () => {
  faux.livre(texte(LISTE));
  assert.ok(await faux.attends(() => reponses(/Liste PARIS94 notée : 4 étiquettes à déposer \(La Poste ×3, Mondial Relay ×1\)/).length === 1), "liste comprise");

  faux.fichier("PDF4", await pdfDe(4));
  const avant = envoisGroupe().length;
  faux.livre(pdf("PDF4", "PARIS94_2026-10-20.pdf", ANNONCE));
  assert.ok(await faux.attends(() => colisTous().length === 4, 8000), "4 colis");

  const colis = colisTous();
  assert.deepEqual(colis.map((c) => c.file_name), ["8R50345899012.pdf", "8R49597374149.pdf", "8R49597373395.pdf", "8571271394.pdf"]);
  assert.deepEqual(colis.map((c) => c.carrier), ["LP", "LP", "LP", "MR"]);
  assert.deepEqual(colis.map((c) => c.note), ["1kg", null, null, null]);
  assert.ok(colis.every((c) => c.type === "normal" && c.file_id && c.chat_id === GROUPE));
  // les boutons (Imprimé, Clean, Del) sous CHAQUE etiquette, pas seulement
  // sous celle qui porte la note
  const boutonsSous = (c) =>
    faux.appelsDe("editMessageReplyMarkup").some((a) => Number(a.params.message_id) === c.message_id && Number(a.params.chat_id) === GROUPE);
  assert.ok(await faux.attends(() => colis.every(boutonsSous)), `boutons sous ${colis.filter((c) => !boutonsSous(c)).map((c) => c.file_name)}`);
  assert.equal(colis[0].sender_name, "@feurman_bot");

  // une page par envoi, dans l'ordre de la liste
  const envois = envoisGroupe().slice(avant);
  assert.equal(envois.length, 4);
  assert.deepEqual(envois.map((e) => e.params._fichiers.document.nom), colis.map((c) => c.file_name));
  for (const [i, e] of envois.entries()) {
    assert.deepEqual(await largeurs(e.params._fichiers.document.octets), [200 + i], `page ${i + 1}`);
    assert.equal(Number(e.params.message_thread_id), 2, "topic des normaux");
  }
  assert.ok(await faux.attends(() => reponses(/découpé : 4 étiquettes \(La Poste ×3, Mondial Relay ×1\)/).length === 1));
  assert.equal(reponses(/1kg/).length >= 1, true);

  // la liste est consommee : un autre PDF suit le chemin habituel
  assert.equal(require("../src/bot/listeDrops").listeEnAttente(ADMIN), null);
});

test("jamais deux fois le meme numero : le meme PDF renvoye ne recompte rien", async () => {
  faux.fichier("PDF4b", await pdfDe(4));
  faux.livre(texte(LISTE));
  await faux.attends(() => reponses(/Liste PARIS94/).length >= 1);
  faux.livre(pdf("PDF4b", "PARIS94_2026-10-20.pdf"));
  assert.ok(await faux.attends(() => colisTous().length === 4, 8000));

  const envoisAvant = envoisGroupe().length;
  faux.livre(texte(LISTE));
  await new Promise((r) => setTimeout(r, 200));
  faux.livre(pdf("PDF4b", "PARIS94_2026-10-20.pdf"));
  assert.ok(await faux.attends(() => reponses(/Déjà reçus, pas recomptés : 8R50345899012, 8R49597374149, 8R49597373395, 8571271394/).length === 1, 8000));
  assert.equal(colisTous().length, 4);
  assert.equal(envoisGroupe().length, envoisAvant, "rien de republie");
});

test("un bordereau pas encore pret n'a pas de page : l'ordre saute la ligne « 🆕 »", async () => {
  faux.livre(texte("📋 Mes drops du jour — PARIS94 (3 colis)\n  📄 8R50345899099\n  🆕 8R49597374100\n  📄 8571271300"));
  await faux.attends(() => reponses(/2 étiquettes à déposer.*1 bordereau pas encore prêt/).length === 1);
  faux.fichier("PDF2", await pdfDe(2));
  faux.livre(pdf("PDF2", "PARIS94_2026-10-21.pdf"));
  assert.ok(await faux.attends(() => colisTous().length === 2, 8000));
  assert.deepEqual(colisTous().map((c) => [c.file_name, c.carrier]), [["8R50345899099.pdf", "LP"], ["8571271300.pdf", "MR"]]);
});

test("un nombre de pages qui ne colle pas : rien n'est decoupe au hasard", async () => {
  faux.livre(texte(LISTE));
  await faux.attends(() => reponses(/Liste PARIS94/).length >= 1);
  faux.fichier("PDF3", await pdfDe(3));
  faux.livre(pdf("PDF3", "PARIS94_2026-10-20.pdf"));
  assert.ok(await faux.attends(() => reponses(/a 3 pages, mais la liste PARIS94 annonce 4 étiquettes/).length === 1, 8000));
  assert.equal(colisTous().length, 0);
});

test("l'annonce arrivee apres le PDF pose la note sur l'etiquette deja recue", async () => {
  faux.livre(texte(LISTE.replace(" (1000g)", "")));
  await faux.attends(() => reponses(/Liste PARIS94/).length >= 1);
  faux.fichier("PDF4c", await pdfDe(4));
  faux.livre(pdf("PDF4c", "PARIS94_2026-10-20.pdf"));
  assert.ok(await faux.attends(() => colisTous().length === 4, 8000));
  assert.equal(colisTous()[0].note, null);

  faux.livre(texte(ANNONCE));
  assert.ok(await faux.attends(() => colisTous()[0].note === "1kg"));
});

test("sans liste, un PDF suit le chemin habituel (un colis, copie a l'identique)", async () => {
  faux.fichier("PDF1", await pdfDe(4));
  faux.livre(pdf("PDF1", "etiquettes.pdf"));
  assert.ok(await faux.attends(() => colisTous().length === 1, 8000));
  assert.equal(colisTous()[0].file_id, "PDF1");
});
