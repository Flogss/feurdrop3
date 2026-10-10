const path = require("path");
const express = require("express");
const compression = require("compression");

// L'application Express du dashboard, sans rien demarrer : ni ecoute du port,
// ni bot, ni lecture du .env. server.js la lance ; les tests la montent sur un
// port libre avec une base jetable.
const LIMITE_JSON = "100kb";
const LIMITE_LISTE_SUIVI = "8mb";

function creeApp() {
  const apiRouter = require("./routes/api");
  const printRouter = require("./routes/print");
  const specialRouter = require("./routes/special");
  const suiviRouter = require("./routes/suivi");
  const portail = require("./routes/portail");
  const depots = require("./routes/depots");
  const { DOMAINE_PORTAIL } = require("./portail");
  const { gestionErreurs } = require("./http");
  const { entetesSecurite, entetesFichier } = require("./securite");
  const { servirPaquets } = require("./assemblage");

  const app = express();
  // derriere le proxy de Railway : l'adresse du visiteur (limiteur d'essais du
  // portail) vient de ses en-tetes
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(entetesSecurite);
  // Le site pese ~175 Ko de JS/CSS/HTML et les reponses de l'API sont du JSON
  // tres repetitif : compresses, c'est environ quatre fois moins a telecharger,
  // ce qui se sent surtout en 4G.
  app.use(compression());
  // Taille des corps JSON, route par route. Le depot d'une liste de numeros
  // de suivi a la sienne (10 000 numeros font ~140 Ko, un gros export bien
  // plus) ; tout le reste du dashboard envoie quelques octets et garde la
  // limite d'Express (100 Ko). L'ordre compte : un corps deja lu n'est pas
  // relu, c'est donc le premier analyseur qui fixe la limite -- monte apres
  // le global, celui du suivi ne servait jamais et une liste de 140 Ko
  // repartait en 413.
  app.use("/api/suivi/verifier", express.json({ limit: LIMITE_LISTE_SUIVI }));
  app.use(express.json({ limit: LIMITE_JSON }));
  // les colis d'un espace expediteur (son jeton est sa cle : voir portail.js),
  // demandes par le service du portail
  app.use("/api/portail", portail.router);
  // controle des depots (verifications aupres des transporteurs)
  app.use("/api/depots", depots.router);
  app.use("/api", apiRouter);
  app.use("/api/print", printRouter);
  app.use("/api/special", specialRouter);
  app.use("/api/suivi", suiviRouter);
  // en local seulement : la page d'un expediteur, faute de domaine de portail
  if (!DOMAINE_PORTAIL) app.get("/expediteur/:jeton", portail.pagePortail);
  // /app.js et /styles.css : assembles depuis public/js/ et public/css/
  app.use(servirPaquets());
  app.use(express.static(path.join(__dirname, "..", "public"), { setHeaders: entetesFichier }));
  // en dernier : une erreur imprevue devient une reponse JSON, jamais un arret
  app.use(gestionErreurs);
  return app;
}

module.exports = { creeApp, LIMITE_JSON, LIMITE_LISTE_SUIVI };
