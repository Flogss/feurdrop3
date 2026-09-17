require("dotenv").config();
const os = require("os");
const path = require("path");
const express = require("express");
const apiRouter = require("./routes/api");
const planRouter = require("./routes/plan");
const suiviRouter = require("./routes/suivi");
const { startBot } = require("./bot");
const { getPrintToken } = require("./db");

const app = express();
app.use(express.json());
app.use("/api", apiRouter);
app.use("/api/plan", planRouter);
app.use("/api/suivi", suiviRouter);
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
