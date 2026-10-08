require("dotenv").config();

// Le meme depot fait tourner deux services Railway : le dashboard (bot, base,
// site), et le portail des expediteurs sur son propre domaine
// (DROP_ROLE=portail), qui n'ouvre ni la base ni le bot -- voir portailSeul.js.
if (process.env.DROP_ROLE === "portail") {
  require("./portailSeul");
  return;
}

const os = require("os");
const path = require("path");
const express = require("express");
const compression = require("compression");
const apiRouter = require("./routes/api");
const printRouter = require("./routes/print");
const specialRouter = require("./routes/special");
const suiviRouter = require("./routes/suivi");
const portail = require("./routes/portail");
const { DOMAINE_PORTAIL } = require("./portail");
const { startBot } = require("./bot");
const { startSuiviBot } = require("./suivi/runner");
const { getPrintToken } = require("./db");

const app = express();
// derriere le proxy de Railway : l'adresse du visiteur (limiteur d'essais du
// portail) vient de ses en-tetes
app.set("trust proxy", 1);
// Le site pese ~175 Ko de JS/CSS/HTML et les reponses de l'API sont du JSON
// tres repetitif : compresses, c'est environ quatre fois moins a telecharger,
// ce qui se sent surtout en 4G.
app.use(compression());
app.use(express.json());
// les colis d'un espace expediteur (son jeton est sa cle : voir portail.js),
// demandes par le service du portail
app.use("/api/portail", portail.router);
app.use("/api", apiRouter);
app.use("/api/print", printRouter);
app.use("/api/special", specialRouter);
app.use("/api/suivi", suiviRouter);
// en local seulement : la page d'un expediteur, faute de domaine de portail
if (!DOMAINE_PORTAIL) app.get("/expediteur/:jeton", portail.pagePortail);
app.use(express.static(path.join(__dirname, "..", "public")));

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
  // necessaire pour configurer l'agent d'impression du Mac (voir agent/README.md)
  console.log(`[print] jeton de l'agent d'impression : ${getPrintToken()}`);
});

startBot();
startSuiviBot();
