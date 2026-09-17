const fs = require("fs");
const path = require("path");
const { suiviDbPath } = require("./paths");
const { sharedLimiter, PER_SECOND } = require("./engine");

// Demarrage du bot de suivi depuis le serveur du dashboard.
//
// Ses sources vivent dans bot/ et sont en modules ES, alors que ce projet est
// en CommonJS : d'ou le package.json a part dans ce dossier, et l'import
// dynamique ici. Aucune ligne du bot n'a ete modifiee, il reste identique a
// son projet d'origine.
//
// Les deux bots Telegram n'ont pas le meme jeton et ne se genent donc pas.
// En revanche le meme jeton ne peut pas etre interroge depuis deux machines :
// si celui-ci tourne ici, il ne doit plus tourner sur le Mac.

function readConfig() {
  const token = process.env.SUIVI_BOT_TOKEN || "";
  const okapiKey = process.env.OKAPI_KEY || "";
  const allowed = (process.env.SUIVI_ALLOWED_CHATS || process.env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const missing = [];
  if (!token) missing.push("SUIVI_BOT_TOKEN");
  if (!okapiKey) missing.push("OKAPI_KEY");
  // sans restriction, n'importe qui tombant sur le bot consommerait le quota
  if (allowed.length === 0) missing.push("SUIVI_ALLOWED_CHATS (ou TELEGRAM_CHAT_ID)");

  return { token, okapiKey, allowed, missing };
}

async function startSuiviBot() {
  const { token, okapiKey, allowed, missing } = readConfig();

  if (missing.length > 0) {
    console.log(`[suivi] bot en veille : ${missing.join(", ")} manquant(s)`);
    return null;
  }

  const dbFile = suiviDbPath();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const existed = fs.existsSync(dbFile);

  try {
    const { Bot } = await import("./bot/bot.js");
    const bot = new Bot({
      token,
      allowedChats: allowed,
      okapiKey,
      dbFile,
      maxPerSec: PER_SECOND,
      concurrency: Number(process.env.SUIVI_CONCURRENCY) || 5,
    });

    // Le bot se fabrique son propre limiteur ; on lui substitue celui du site.
    // Les deux tapent la meme cle Okapi, et La Poste bloque une cle qui
    // depasse : deux limiteurs a 10/s feraient 20/s. Un seul robinet.
    bot.limiter = await sharedLimiter();

    console.log(
      `[suivi] ${dbFile} (${existed ? "existante" : "NOUVELLE"}) · ${allowed.length} chat(s) autorise(s) · ${PER_SECOND}/s`
    );
    // start() ne rend la main qu'a l'arret du bot : on le laisse tourner a
    // cote du serveur web plutot que de l'attendre
    bot.start().catch((err) => console.error("[suivi] arret :", err.message));
    return bot;
  } catch (err) {
    console.error("[suivi] demarrage impossible :", err.message);
    return null;
  }
}

module.exports = { startSuiviBot };
