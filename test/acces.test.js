// La liste blanche du bot, sans Telegram : qui passe, qui ne passe pas.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { creeControleAcces, listeDepuisEnvironnement, lisListe } = require("../src/bot/acces");

const GROUPE = -1001;
const prive = (id) => ({ from: { id }, chat: { id, type: "private" } });
const dansLeGroupe = (id) => ({ from: { id }, chat: { id: GROUPE, type: "supergroup" } });
const ailleurs = (id) => ({ from: { id }, chat: { id: -2002, type: "group" } });

function fauxBot(statuts, { panne = false } = {}) {
  const appels = [];
  return {
    appels,
    async getChatMember(chatId, userId) {
      appels.push(userId);
      if (panne) throw new Error("ETIMEDOUT");
      const statut = statuts[userId];
      if (statut === undefined) throw new Error("ETELEGRAM: 400 Bad Request: user not found");
      return { status: statut, is_member: statut === "restricted" };
    },
  };
}

test("lecture de la liste : identifiants d'utilisateurs seulement", () => {
  assert.deepEqual(lisListe(" 12, 34 ;56  -1004388459228 abc "), ["12", "34", "56"]);
  assert.deepEqual(listeDepuisEnvironnement({ TELEGRAM_ALLOWED_USERS: "1,2" }), { utilisateurs: ["1", "2"], source: "TELEGRAM_ALLOWED_USERS" });
  assert.deepEqual(listeDepuisEnvironnement({ SUIVI_ALLOWED_CHATS: "9,-5" }), { utilisateurs: ["9"], source: "SUIVI_ALLOWED_CHATS" });
  assert.deepEqual(listeDepuisEnvironnement({}), { utilisateurs: [], source: null });
});

test("liste blanche : partout ; groupe de travail : tout le monde ; ailleurs : personne", async () => {
  const acces = creeControleAcces({ groupeId: GROUPE, utilisateurs: ["1"] });
  const bot = fauxBot({});
  assert.equal(await acces.autorise(bot, prive(1)), true);
  assert.equal(await acces.autorise(bot, ailleurs(1)), true);
  assert.equal(await acces.autorise(bot, dansLeGroupe(99)), true);
  assert.equal(await acces.autorise(bot, ailleurs(99)), false);
  // un message de canal (sans auteur) dans le groupe passe, ailleurs non
  assert.equal(acces.verdictImmediat({ chat: { id: GROUPE, type: "supergroup" } }), true);
  assert.equal(acces.verdictImmediat({ chat: { id: -3, type: "channel" } }), false);
  assert.equal(bot.appels.length, 0, "rien n'a ete demande a Telegram");
});

test("en prive : un membre du groupe passe, un inconnu non, la reponse est gardee", async () => {
  let instant = 0;
  const acces = creeControleAcces({ groupeId: GROUPE, utilisateurs: [], maintenant: () => instant });
  const bot = fauxBot({ 2: "member", 3: "left", 4: "kicked", 5: "restricted", 6: "administrator" });
  assert.equal(acces.verdictImmediat(prive(2)), null, "il faut demander");
  assert.equal(await acces.autorise(bot, prive(2)), true);
  assert.equal(acces.verdictImmediat(prive(2)), true, "garde en memoire");
  assert.equal(await acces.autorise(bot, prive(3)), false);
  assert.equal(await acces.autorise(bot, prive(4)), false);
  assert.equal(await acces.autorise(bot, prive(5)), true, "restreint mais membre");
  assert.equal(await acces.autorise(bot, prive(6)), true);
  assert.equal(await acces.autorise(bot, prive(7)), false, "inconnu de Telegram");
  const appels = bot.appels.length;
  await acces.autorise(bot, prive(2));
  assert.equal(bot.appels.length, appels, "pas de nouvelle question");
  instant += 2 * 60 * 60 * 1000; // deux heures plus tard : on redemande
  await acces.autorise(bot, prive(2));
  assert.equal(bot.appels.length, appels + 1);
});

test("Telegram injoignable : refus, mais rien n'est retenu", async () => {
  const acces = creeControleAcces({ groupeId: GROUPE, utilisateurs: [] });
  const bot = fauxBot({ 2: "member" }, { panne: true });
  assert.equal(await acces.autorise(bot, prive(2)), false);
  assert.equal(acces.verdictImmediat(prive(2)), null, "on redemandera");
});

test("commandes d'administration : la liste blanche seule", async () => {
  const acces = creeControleAcces({ groupeId: GROUPE, utilisateurs: ["1"] });
  const bot = fauxBot({ 2: "member" });
  assert.equal(await acces.autorise(bot, prive(1), { niveau: "admin" }), true);
  assert.equal(await acces.autorise(bot, prive(2), { niveau: "admin" }), false);
  assert.equal(await acces.autorise(bot, dansLeGroupe(2), { niveau: "admin" }), false, "meme dans le groupe");
});

test("TELEGRAM_GROUP_MEMBERS=0 : en prive, la liste blanche seule", async () => {
  const acces = creeControleAcces({ groupeId: GROUPE, utilisateurs: ["1"], membresDuGroupe: false });
  const bot = fauxBot({ 2: "member" });
  assert.equal(await acces.autorise(bot, prive(2)), false);
  assert.equal(bot.appels.length, 0);
});

test("un appui sur un bouton : l'auteur et le chat du message", async () => {
  const acces = creeControleAcces({ groupeId: GROUPE, utilisateurs: [] });
  const bouton = (userId, chat) => ({ id: "cb", data: "c:x:1", from: { id: userId }, message: { message_id: 1, chat } });
  assert.equal(acces.verdictImmediat(bouton(99, { id: GROUPE, type: "supergroup" })), true);
  assert.equal(await acces.autorise(fauxBot({}), bouton(99, { id: 99, type: "private" })), false);
});
