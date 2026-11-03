// /bj puis des fichiers « BOITEJAUNE6N00034692547.pdf » puis /stopbj : les
// liens de suivi La Poste d'un bloc, dans l'ordre d'envoi ; les fichiers ne
// comptent pas. Avec le vrai bot face a un faux serveur Telegram.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, videBase } = require("./aide");
const { creeFauxTelegram } = require("./fixtures/faux-telegram");

environnementDeTest();
const ADMIN = 111;
const faux = creeFauxTelegram();

let db;
let bot;
let numero = 1;
const maintenant = () => Math.floor(Date.now() / 1000);
const de = () => ({ message_id: numero++, from: { id: ADMIN, first_name: "Flo" }, chat: { id: ADMIN, type: "private" }, date: maintenant() });
const commande = (t) => ({ message: { ...de(), text: t, entities: [{ type: "bot_command", offset: 0, length: t.length }] } });
const fichier = (nom) => ({ message: { ...de(), document: { file_id: `F-${nom}-${numero}`, file_unique_id: `U-${nom}-${numero}`, file_name: nom, mime_type: "application/pdf" } } });

const colisTous = () => db.db.prepare("SELECT * FROM colis").all();
const messages = (motif) => faux.appelsDe("sendMessage").filter((a) => Number(a.params.chat_id) === ADMIN && motif.test(String(a.params.text)));
const LIEN = "https://www.laposte.fr/outils/suivre-vos-envois?code=";

before(async () => {
  process.env.TELEGRAM_API_URL = await faux.demarre();
  process.env.TELEGRAM_ALLOWED_USERS = String(ADMIN);
  process.env.FILE_REPRISES_MS = "";
  process.env.REPLY_TTL_MS = "20";
  process.env.BATCH_DEBOUNCE_MS = "50";
  process.env.GROUP_WRITE_INTERVAL_MS = "5";
  db = require("../src/db");
  bot = require("../src/bot").startBot();
});

after(async () => {
  for (let n = -1; n !== faux.appels.length; ) {
    n = faux.appels.length;
    await new Promise((r) => setTimeout(r, 600));
  }
  await bot.stopPolling({ cancel: true }).catch(() => {});
  await faux.ferme();
});

beforeEach(() => videBase());

test("lecture du numero dans le nom du fichier", () => {
  const { numeroDuFichier } = require("../src/bot/liensBj");
  assert.equal(numeroDuFichier("BOITEJAUNE6N00034692547.pdf"), "6N00034692547");
  assert.equal(numeroDuFichier("boitejaune_6N00034692547.PDF"), "6N00034692547");
  assert.equal(numeroDuFichier("BOITE JAUNE 6N00034692547.pdf"), "6N00034692547");
  assert.equal(numeroDuFichier("6N00034692547.pdf"), "6N00034692547");
  assert.equal(numeroDuFichier("BOITEJAUNE.pdf"), null);
  assert.equal(numeroDuFichier(null), null);
});

test("/bj, 30 fichiers, /stopbj : 30 liens La Poste d'un bloc, dans l'ordre, et aucun colis", async () => {
  faux.livre(commande("/bj"));
  assert.ok(await faux.attends(() => messages(/Mode BJ/).length >= 1), "mode BJ annonce");

  // numeros factices, de la forme des vrais
  const numeros = Array.from({ length: 30 }, (_, i) => `6N0000000${String(1000 + i)}`);
  for (const n of numeros) faux.livre(fichier(`BOITEJAUNE${n}.pdf`));
  // un doublon et un fichier sans numero
  faux.livre(fichier(`BOITEJAUNE${numeros[3]}.pdf`));
  faux.livre(fichier("BOITEJAUNE.pdf"));
  await new Promise((r) => setTimeout(r, 400));

  faux.livre(commande("/stopbj"));
  assert.ok(await faux.attends(() => messages(/liens La Poste \(boîte jaune\)/).length === 1, 8000), "les liens arrivent");
  const envoi = messages(/liens La Poste \(boîte jaune\)/)[0];
  const texte = String(envoi.params.text);
  assert.match(texte, /^📮 30 liens La Poste \(boîte jaune\)/);
  assert.match(texte, /1 doublon ignoré/);
  assert.match(texte, /sans numéro : BOITEJAUNE\.pdf/);
  const liens = texte.split("\n").filter((l) => l.startsWith("https://"));
  assert.deepEqual(liens, numeros.map((n) => `${LIEN}${n}`), "un lien par numero, dans l'ordre d'envoi");
  assert.ok(String(envoi.params.disable_web_page_preview) === "true", "sans apercu");

  // les fichiers ne sont pas des colis
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(colisTous().length, 0);
});

test("apres /stopbj, un fichier redevient un colis ; /stopbj sans mode le dit", async () => {
  faux.livre(commande("/stopbj"));
  assert.ok(await faux.attends(() => messages(/Pas de mode BJ en cours/).length >= 1));

  faux.livre(commande("/bj"));
  await faux.attends(() => messages(/Mode BJ/).length >= 2);
  faux.livre(commande("/stopbj"));
  assert.ok(await faux.attends(() => messages(/Mode BJ arrêté : aucun numéro lu/).length === 1));

  faux.fichier("F-colis", Buffer.from("%PDF-1.4"));
  faux.livre({ message: { ...de(), document: { file_id: "F-colis", file_unique_id: "U-colis", file_name: "6A07648914126.pdf", mime_type: "application/pdf" } } });
  assert.ok(await faux.attends(() => colisTous().length === 1, 8000), "le fichier suivant est un colis");
});
