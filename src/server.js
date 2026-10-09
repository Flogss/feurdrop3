require("dotenv").config();

// Le meme depot fait tourner deux services Railway : le dashboard (bot, base,
// site), et le portail des expediteurs sur son propre domaine
// (DROP_ROLE=portail), qui n'ouvre ni la base ni le bot -- voir portailSeul.js.
if (process.env.DROP_ROLE === "portail") {
  require("./portailSeul");
  return;
}

// Filet de securite : une promesse rejetee que personne n'attend (un envoi
// Telegram en tache de fond, par exemple) est consignee au lieu d'arreter le
// processus -- et avec lui le site, le bot et l'impression. Les routes async
// passent par routeAsync (voir http.js) et ne devraient jamais arriver ici.
process.on("unhandledRejection", (raison) => {
  console.error("[process] promesse rejetee non geree :", raison instanceof Error ? raison.stack : raison);
});

const os = require("os");
const { creeApp } = require("./app");
const { startBot } = require("./bot");
const { startSuiviBot } = require("./suivi/runner");
const { getPrintToken, ouvreBase } = require("./db");

// La base s'ouvre ici, avant tout le reste : migrations appliquees (ou
// refus de demarrer si l'une echoue), diagnostic dans les logs.
ouvreBase();
const app = creeApp();

// Adresses ou le site repond vraiment. localhost ne sert que sur cette
// machine : pour ouvrir le dashboard depuis le telephone, c'est l'adresse du
// reseau local qu'il faut, et elle change selon le wifi.
function addresses(port) {
  const lines = [`http://localhost:${port}`];

  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      lines.push(`http://${iface.address}:${port}   (${name})`);
    }
  }

  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PUBLIC_DOMAIN;
  if (domain) lines.push(`https://${domain}   (public)`);
  return lines;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  for (const line of addresses(PORT)) console.log(`[server] ${line}`);
  // Le jeton de l'agent d'impression n'apparait plus en clair dans les
  // journaux : seulement sa provenance et ses 4 derniers caracteres, de quoi
  // verifier que le Mac a le bon. Pour l'afficher : npm run jeton-impression
  // (voir agent/README.md).
  const jeton = getPrintToken();
  console.log(
    `[print] jeton de l'agent d'impression : ${process.env.PRINT_TOKEN ? "PRINT_TOKEN" : "gardé en base"} (…${jeton.slice(-4)})`
  );
});

startBot();
startSuiviBot();
