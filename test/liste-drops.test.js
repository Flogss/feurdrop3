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
  // plus de 20 etiquettes publiees dans ce fichier : le plafond de Telegram
  // (20 envois par minute dans le groupe) ferait attendre la minute suivante
  process.env.GROUP_SENDS_PER_MIN = "1000";
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
  assert.ok(await faux.attends(() => reponses(/Liste PARIS94 notée : 4 étiquettes pas encore reçues : 8R50345899012 \(La Poste · 1kg\), 8R49597374149 \(La Poste\), 8R49597373395 \(La Poste\), 8571271394 \(Mondial Relay\)\.\nEnvoie-moi le PDF/).length === 1), "liste comprise");

  faux.fichier("PDF4", await pdfDe(4));
  const avant = envoisGroupe().length;
  faux.livre(pdf("PDF4", "PARIS94_2026-10-20.pdf", ANNONCE));
  assert.ok(await faux.attends(() => colisTous().length === 4, 8000), "4 colis");

  const colis = colisTous();
  assert.deepEqual(colis.map((c) => c.file_name), ["8R50345899012.pdf", "8R49597374149.pdf", "8R49597373395.pdf", "8571271394.pdf"]);
  assert.deepEqual(colis.map((c) => c.carrier), ["LP", "LP", "LP", "MR"]);
  assert.deepEqual(colis.map((c) => c.note), ["1kg", null, null, null]);
  // le poids se paie : 4 € + 1 kg × 1 €
  assert.deepEqual(colis.map((c) => c.poids_g), [1000, null, null, null]);
  assert.deepEqual(colis.map((c) => c.price), [5, 4, 4, 4]);
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
  await faux.attends(() => reponses(/3 étiquettes pas encore reçues/).length === 1);
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
  assert.ok(await faux.attends(() => reponses(/a 3 pages, mais la liste PARIS94 annonce 4 étiquettes pas encore reçues/).length === 1, 8000));
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

test("un poids dans la description se paie, /poids le corrige", async () => {
  faux.fichier("PDFP", await pdfDe(1));
  const envoi = pdf("PDFP", "colis.pdf", "📦 mondial relay\n5kg");
  faux.livre(envoi);
  assert.ok(await faux.attends(() => colisTous().length === 1, 8000));
  const c = colisTous()[0];
  assert.equal(c.poids_g, 5000);
  assert.equal(c.price, 9, "4 € + 5 kg × 1 €");
  assert.equal(c.note, "5kg", "le poids en note");

  // /poids 2 en reponse au fichier
  faux.livre({
    message: {
      message_id: numero++,
      from: { id: ADMIN, first_name: "Flo" },
      chat: { id: ADMIN, type: "private" },
      date: maintenant(),
      text: "/poids 2",
      reply_to_message: { message_id: envoi.message.message_id, chat: { id: ADMIN, type: "private" }, date: maintenant() },
    },
  });
  assert.ok(await faux.attends(() => colisTous()[0].poids_g === 2000));
  assert.equal(colisTous()[0].price, 6);
  assert.equal(colisTous()[0].note, "2kg", "la note suit le poids corrige");
  assert.ok(await faux.attends(() => reponses(/2 kg · 6\.00 EUR/).length === 1));
});

test("« DPD 2 KG » ou « DPD 2560G » en description : poids en note, kilos payes", async () => {
  faux.fichier("PDFD", await pdfDe(1));
  faux.livre(pdf("PDFD", "etiquette-dpd.pdf", "DPD 2 KG"));
  assert.ok(await faux.attends(() => colisTous().length === 1, 8000));
  let c = colisTous()[0];
  assert.deepEqual([c.carrier, c.poids_g, c.note, c.price], ["DPD", 2000, "2kg", 6], "4 € + 2 kg × 1 €");

  faux.fichier("PDFG", await pdfDe(1));
  faux.livre(pdf("PDFG", "etiquette-dpd-2.pdf", "DPD 2560G"));
  assert.ok(await faux.attends(() => colisTous().length === 2, 8000));
  c = colisTous()[1];
  assert.deepEqual([c.carrier, c.poids_g, c.note], ["DPD", 2560, "2,56kg"]);
  assert.ok(c.price > 6 && c.price <= 7, `2,56 kg payes : ${c.price}`);

  // une note ecrite a la main n'est jamais remplacee par le poids
  faux.fichier("PDFS", await pdfDe(1));
  faux.livre(pdf("PDFS", "sans-poids.pdf", "DPD"));
  assert.ok(await faux.attends(() => colisTous().length === 3, 8000));
  assert.equal(colisTous()[2].note, null, "pas de poids, pas de note");
});

// numeros factices, de la forme de ceux du fournisseur
const LISTE_HIER = `📋 Mes drops du jour — PARIS94 (3 colis)

📅 27/10/2026 — 3 colis
  📄 8R50000000001
  📄 CZ200000001FR
  📄 8570000001

🆕 Bordereau pas encore prêt · 📄 À déposer maintenant`;

const LISTE_DU_JOUR = `📋 Mes drops du jour — PARIS94 (5 colis)

Ta liste du jour : ce qu'il te reste à déposer.

📅 28/10/2026 — 2 colis
  🆕 XX100000001JB (2560g)
  🆕 8R50000000002

📅 27/10/2026 — 3 colis
  📄 8R50000000001
  📄 CZ200000001FR
  📄 8570000001

🆕 Bordereau pas encore prêt · 📄 À déposer maintenant

📊 Total : 5 colis`;

const ANNONCE_DU_JOUR = `📄 Nouveau PDF !

📍 PARIS94 - 28/10/2026

📦 Total : 2 bordereaux
🆕 Nouveaux : 2

━━━━━━━━━━━━━━━━━━━━━━
🎯 SUIVIS SPÉCIAUX :

⚖️ Avec poids (1) :
  • XX100000001JB → 2.6kg

━━━━━━━━━━━━━━━━━━━━━━

⏰ Tu as 48h pour déposer !`;

test("la liste du jour avec les anciens deja recus : le PDF des 2 nouveaux, coupe en 2, le poids au gramme en note", async () => {
  // la veille : 3 etiquettes deja recues
  faux.livre(texte(LISTE_HIER));
  await faux.attends(() => reponses(/Liste PARIS94 notée : 3 étiquettes/).length === 1);
  faux.fichier("PDFH", await pdfDe(3));
  faux.livre(pdf("PDFH", "PARIS94_2026-10-27.pdf"));
  assert.ok(await faux.attends(() => colisTous().length === 3, 8000));

  // la liste du jour reprend les anciens : seuls les 2 nouveaux sont attendus
  faux.livre(texte(LISTE_DU_JOUR));
  assert.ok(
    await faux.attends(
      () => reponses(/2 étiquettes pas encore reçues : XX100000001JB \(Chronopost · 2,56kg\), 8R50000000002 \(La Poste\) · 3 déjà reçues, pas recomptées/).length === 1
    ),
    "seuls les nouveaux sont attendus"
  );

  faux.fichier("PDFJ", await pdfDe(2));
  const avant = envoisGroupe().length;
  faux.livre(pdf("PDFJ", "PARIS94_2026-10-28.pdf", ANNONCE_DU_JOUR));
  assert.ok(await faux.attends(() => colisTous().length === 5, 8000), "2 colis de plus");

  const nouveaux = colisTous().slice(3);
  assert.deepEqual(nouveaux.map((c) => c.file_name), ["XX100000001JB.pdf", "8R50000000002.pdf"]);
  assert.deepEqual(nouveaux.map((c) => c.carrier), ["CHRONO", "LP"]);
  // le poids de la liste (2560g) l'emporte sur l'arrondi de l'annonce (2.6kg)
  assert.deepEqual(nouveaux.map((c) => c.poids_g), [2560, null]);
  assert.deepEqual(nouveaux.map((c) => c.note), ["2,56kg", null]);

  const envois = envoisGroupe().slice(avant);
  assert.equal(envois.length, 2, "une page par etiquette, les anciens pas republies");
  for (const [i, e] of envois.entries()) assert.deepEqual(await largeurs(e.params._fichiers.document.octets), [200 + i], `page ${i + 1}`);
});
