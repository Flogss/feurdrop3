// Le vrai bot, avec la vraie bibliotheque Telegram, face a un faux serveur
// Telegram : la liste blanche filtre fichiers, commandes et boutons, sans
// rien changer pour le groupe de travail ; et la pile HTTP de la bibliotheque
// (mise a jour de ses dependances) envoie toujours fichiers et erreurs comme
// avant.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest } = require("./aide");
const { creeFauxTelegram } = require("./fixtures/faux-telegram");

environnementDeTest();
const GROUPE = -1004388459228;
const ADMIN = 111; // liste blanche
const MEMBRE = 222; // membre du groupe, hors liste
const faux = creeFauxTelegram({ membres: { [MEMBRE]: "member", 333: "left", 334: "kicked", 335: "introuvable" } });

let db;
let bot;
let numero = 1;
const maintenant = () => Math.floor(Date.now() / 1000);

function fichierPrive(userId) {
  return {
    message: {
      message_id: numero++,
      from: { id: userId, first_name: `U${userId}` },
      chat: { id: userId, type: "private" },
      date: maintenant(),
      document: { file_id: `F${numero}`, file_unique_id: `U${numero}`, file_name: "etiquette.pdf", mime_type: "application/pdf" },
    },
  };
}

function commande(userId, texte, chat = { id: userId, type: "private" }) {
  return { message: { message_id: numero++, from: { id: userId, first_name: `U${userId}` }, chat, date: maintenant(), text: texte } };
}

const arriveesDe = (chatId) => db.db.prepare("SELECT COUNT(*) AS n FROM arrivees WHERE chat_id = ?").get(chatId).n;
const messagesA = (chatId, motif) =>
  faux.appelsDe("sendMessage").filter((a) => Number(a.params.chat_id) === chatId && motif.test(String(a.params.text)));

before(async () => {
  process.env.TELEGRAM_API_URL = await faux.demarre();
  process.env.TELEGRAM_ALLOWED_USERS = String(ADMIN);
  process.env.FILE_REPRISES_MS = ""; // pas de reprise differee pendant les tests
  process.env.REPLY_TTL_MS = "20";
  process.env.GROUP_WRITE_INTERVAL_MS = "5";
  db = require("../src/db");
  const { startBot } = require("../src/bot");
  bot = startBot();
});

after(async () => {
  await bot.stopPolling({ cancel: true }).catch(() => {});
  await faux.ferme();
});

test("un inconnu en prive : fichier refuse, rien n'est enregistre", async () => {
  faux.livre(fichierPrive(333));
  assert.ok(await faux.attends(() => messagesA(333, /réservé à l'équipe/).length === 1), "message de refus");
  assert.ok(faux.appelsDe("getChatMember").some((a) => Number(a.params.user_id) === 333), "appartenance verifiee");
  assert.equal(arriveesDe(333), 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, 0);
});

test("un membre du groupe en prive : son fichier est pris en charge", async () => {
  faux.livre(fichierPrive(MEMBRE));
  assert.ok(await faux.attends(() => arriveesDe(MEMBRE) === 1), "fichier inscrit");
  assert.equal(messagesA(MEMBRE, /réservé/).length, 0);
});

test("le groupe de travail fonctionne comme avant, sans verification", async () => {
  const avant = faux.appelsDe("getChatMember").length;
  faux.livre({
    message: {
      message_id: numero++,
      message_thread_id: 2,
      is_topic_message: true,
      from: { id: 333, first_name: "Collegue" },
      chat: { id: GROUPE, type: "supergroup", is_forum: true },
      date: maintenant(),
      document: { file_id: "FG", file_unique_id: "UG", file_name: "MR123.pdf", mime_type: "application/pdf" },
    },
  });
  assert.ok(await faux.attends(() => arriveesDe(GROUPE) === 1), "fichier du groupe inscrit");
  assert.equal(faux.appelsDe("getChatMember").length, avant, "aucun appel d'appartenance pour le groupe");
});

test("/imprime d'un inconnu : refuse, aucun PDF ni menu", async () => {
  faux.livre(commande(334, "/imprime"));
  assert.ok(await faux.attends(() => messagesA(334, /réservé à l'équipe/).length === 1));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(faux.appelsDe("sendDocument").filter((a) => Number(a.params.chat_id) === 334).length, 0);
  assert.equal(messagesA(334, /etiquette/i).length, 0);
});

test("/regles_reset : refuse a un simple membre, accepte pour la liste blanche", async () => {
  db.saveCarrierRule("keyword", "DHL SCAN", "DHL");
  faux.livre(commande(MEMBRE, "/regles_reset"));
  assert.ok(await faux.attends(() => messagesA(MEMBRE, /réservée aux administrateurs/).length === 1));
  assert.equal(db.listCarrierRules().length, 1, "les regles sont intactes");

  faux.livre(commande(ADMIN, "/regles_reset"));
  assert.ok(await faux.attends(() => messagesA(ADMIN, /regle\(s\) oubliee\(s\)/).length === 1));
  assert.equal(db.listCarrierRules().length, 0);
});

test("un bouton presse par un inconnu ne touche a rien", async () => {
  const colis = db.addColis("Alice", { fileId: "fx", fileKind: "pdf", carrier: "MR" });
  db.markPrinted([colis.id], "test");
  faux.livre({
    callback_query: {
      id: "cb-inconnu",
      from: { id: 335, first_name: "Inconnu" },
      chat_instance: "x",
      message: { message_id: 77, chat: { id: 335, type: "private" }, date: maintenant() },
      data: `c:x:${colis.id}`,
    },
  });
  assert.ok(
    await faux.attends(() =>
      faux.appelsDe("answerCallbackQuery").some((a) => a.params.callback_query_id === "cb-inconnu" && /Non autorisé/.test(a.params.text))
    )
  );
  assert.equal(db.getColisById(colis.id).status, "pending");
});

// une etiquette 4x6 de test, avec de l'encre a recadrer
async function etiquettePdf(texte) {
  const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([288, 432]);
  const police = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 20, y: 20, width: 248, height: 392, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  page.drawText(texte, { x: 40, y: 300, size: 24, font: police });
  return doc.save();
}

test("/imprime : l'equipe recoit le PDF fusionne, les etiquettes passent imprimees", async () => {
  const a = db.addColis("Alice", { fileId: "PDF-A", fileKind: "pdf", carrier: "UPS", fileName: "1Z999.pdf" });
  const b = db.addColis("Bob", { fileId: "PDF-B", fileKind: "pdf", carrier: "UPS", fileName: "1Z888.pdf" });
  faux.fichier("PDF-A", await etiquettePdf("ALICE"));
  faux.fichier("PDF-B", await etiquettePdf("BOB"));

  faux.livre(commande(ADMIN, "/imprime ups"));
  const recu = await faux.attends(
    () => faux.appelsDe("sendDocument").some((x) => Number(x.params.chat_id) === ADMIN && /etiquettes-ups\.pdf/.test(x.params._fichiers?.document?.nom || "")),
    15000
  );
  assert.ok(recu, "le PDF fusionne est envoye");
  const envoi = faux.appelsDe("sendDocument").find((x) => Number(x.params.chat_id) === ADMIN);
  assert.equal(envoi.params._fichiers.document.debut, "%PDF-");
  assert.ok(await faux.attends(() => db.getColisById(a.id).printed_at && db.getColisById(b.id).printed_at), "marquees imprimees");
});

test("/fusion puis /stopfusion : les fichiers ne comptent pas et reviennent fusionnes", async () => {
  const avant = db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n;
  faux.livre(commande(ADMIN, "/fusion"));
  await new Promise((r) => setTimeout(r, 400));
  faux.fichier("FUS-1", await etiquettePdf("UN"));
  faux.fichier("FUS-2", await etiquettePdf("DEUX"));
  for (const id of ["FUS-1", "FUS-2"]) {
    faux.livre({
      message: {
        message_id: numero++,
        from: { id: ADMIN, first_name: "Admin" },
        chat: { id: ADMIN, type: "private" },
        date: maintenant(),
        document: { file_id: id, file_unique_id: `u${id}`, file_name: `${id}.pdf`, mime_type: "application/pdf" },
      },
    });
  }
  await new Promise((r) => setTimeout(r, 600));
  faux.livre(commande(ADMIN, "/stopfusion"));
  const recu = await faux.attends(
    () => faux.appelsDe("sendDocument").some((x) => Number(x.params.chat_id) === ADMIN && /^fusion-/.test(x.params._fichiers?.document?.nom || "")),
    15000
  );
  assert.ok(recu, "le PDF de la fusion est envoye");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n, avant, "aucun colis cree");
});

const documentsA = (chatId, motif) =>
  faux.appelsDe("sendDocument").filter((x) => Number(x.params.chat_id) === chatId && motif.test(x.params._fichiers?.document?.nom || ""));

test("/save : refuse a un simple membre, rien n'est envoye", async () => {
  faux.livre(commande(MEMBRE, "/save"));
  assert.ok(await faux.attends(() => messagesA(MEMBRE, /réservée aux administrateurs/).length >= 1));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(documentsA(MEMBRE, /feurdrop-backup/).length, 0);
});

test("/save : la liste blanche recoit le JSON en prive, lisible et verifie", async () => {
  faux.livre(commande(ADMIN, "/save"));
  assert.ok(await faux.attends(() => documentsA(ADMIN, /^feurdrop-backup-.*\.json$/).length === 1, 8000), "document envoye");
  const envoi = documentsA(ADMIN, /feurdrop-backup/)[0];
  assert.match(envoi.params.caption, /✅ Sauvegarde FeurDrop terminée/);
  assert.match(envoi.params.caption, /colis \d+/);
  const { verifieSauvegarde } = require("../src/sauvegarde");
  const texte = envoi.params._fichiers.document.octets.toString("utf8");
  const controle = verifieSauvegarde(texte);
  assert.equal(JSON.parse(texte).donnees.colis.length, db.db.prepare("SELECT COUNT(*) AS n FROM colis").get().n);
  assert.ok(controle.total > 0);
  assert.ok(!texte.includes(process.env.TELEGRAM_BOT_TOKEN));
});

test("/save tape dans le groupe : le fichier part a la destination des sauvegardes, pas dans le groupe", async () => {
  process.env.TELEGRAM_BACKUP_CHAT_ID = "-1009999";
  try {
    faux.livre(commande(ADMIN, "/save", { id: GROUPE, type: "supergroup" }));
    assert.ok(await faux.attends(() => documentsA(-1009999, /feurdrop-backup/).length === 1, 8000));
    assert.equal(documentsA(GROUPE, /feurdrop-backup/).length, 0, "rien dans le groupe");
    assert.ok(await faux.attends(() => messagesA(GROUPE, /Sauvegarde envoyée/).length === 1));
  } finally {
    delete process.env.TELEGRAM_BACKUP_CHAT_ID;
  }
});

test("/save : un envoi rate est signale clairement", async () => {
  faux.forceReponse("sendDocument", 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
  faux.livre(commande(ADMIN, "/save"));
  assert.ok(await faux.attends(() => messagesA(ADMIN, /❌ Sauvegarde créée mais envoi impossible : .*chat not found/).length === 1, 8000));
});

test("la bibliotheque Telegram envoie toujours les fichiers et rapporte les 429", async () => {
  await bot.sendDocument(GROUPE, Buffer.from("%PDF-1.4 essai"), { caption: "essai" }, { filename: "essai.pdf", contentType: "application/pdf" });
  const envoi = faux.appelsDe("sendDocument").at(-1);
  assert.equal(envoi.params._fichiers.document.nom, "essai.pdf");
  assert.equal(envoi.params._fichiers.document.debut, "%PDF-");
  assert.equal(envoi.params.caption, "essai");

  const { delaiDemande } = require("../src/throttle");
  faux.forceReponse("sendMessage", 429, {
    ok: false,
    error_code: 429,
    description: "Too Many Requests: retry after 3",
    parameters: { retry_after: 3 },
  });
  const erreur = await bot.sendMessage(GROUPE, "trop vite").catch((e) => e);
  assert.ok(erreur instanceof Error);
  assert.equal(delaiDemande(erreur), 3);
});
