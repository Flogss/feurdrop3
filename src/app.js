const path = require("path");
const express = require("express");
const compression = require("compression");

// L'application Express du dashboard, sans rien demarrer : ni ecoute du port,
// ni bot, ni lecture du .env. server.js la lance ; les tests la montent sur un
// port libre avec une base jetable.
const LIMITE_JSON = "100kb";
const LIMITE_LISTE_SUIVI = "8mb";

// Qui peut entrer, et par ou (voir aussi SECURITE.md) :
//
//   OUVERT A TOUS (rien de prive) :
//     GET  /connexion, et les fichiers de la page de connexion (styles.css,
//          connexion.js, icones, manifest.json, sw.js, particules.js) ;
//     POST /api/auth/connexion, POST /api/auth/deconnexion.
//   AVEC SA PROPRE CLE :
//     /api/portail/:jeton  -- le jeton d'un expediteur : ses colis, rien d'autre
//                             (le service du portail l'appelle par le reseau
//                             prive de Railway) ;
//     /api/print/queue, /api/print/next, /api/print/done
//                          -- le jeton de l'agent d'impression (X-Print-Token).
//   TOUT LE RESTE : une session du dashboard (cookie du site ou jeton de
//   l'app), verifiee a chaque requete -- 401 sans elle, pour l'API ; la page
//   de connexion, pour le site. Ecritures du site : jeton anti-CSRF en plus.
function creeApp() {
  const apiRouter = require("./routes/api");
  const printRouter = require("./routes/print");
  const agentRouter = require("./routes/agent");
  const specialRouter = require("./routes/special");
  const suiviRouter = require("./routes/suivi");
  const portail = require("./routes/portail");
  const depots = require("./routes/depots");
  const auth = require("./auth");
  const { DOMAINE_PORTAIL } = require("./portail");
  const { gestionErreurs } = require("./http");
  const { entetesSecurite, entetesFichier } = require("./securite");
  const { servirPaquets } = require("./assemblage");
  const PUBLIC = path.join(__dirname, "..", "public");

  const app = express();
  // derriere le proxy de Railway : l'adresse du visiteur (limiteurs d'essais)
  // et le protocole (https) viennent de ses en-tetes
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(entetesSecurite);
  // en production, rien ne passe en clair
  app.use(auth.httpsObligatoire);
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

  // --- 1. ouvert a tous, ou protege par sa propre cle --------------------------
  // les colis d'un espace expediteur (son jeton est sa cle : voir portail.js)
  app.use("/api/portail", portail.router);
  // l'agent d'impression du Mac (son jeton : voir routes/agent.js)
  app.use("/api/print", agentRouter);
  // se connecter, se deconnecter
  app.use("/api/auth", auth.routesPubliques);
  app.get("/connexion", auth.pageConnexion);
  // ce dont la page de connexion a besoin (et le portail en local) : aucune donnee
  app.use(servirPaquets({ seulement: ["styles.css"] }));
  for (const fichier of ["connexion.js", "favicon.svg", "icon-192.png", "icon-512.png", "manifest.json", "sw.js", "particules.js", "portail.css", "portail.js"]) {
    app.get(`/${fichier}`, (req, res) => res.sendFile(path.join(PUBLIC, fichier), { headers: fichier === "sw.js" ? { "Cache-Control": "no-cache" } : {} }));
  }
  // en local seulement : la page d'un expediteur, faute de domaine de portail
  if (!DOMAINE_PORTAIL) app.get("/expediteur/:jeton", portail.pagePortail);

  // --- 2. l'API du dashboard : session obligatoire --------------------------------
  app.use("/api", auth.exigeSession);
  app.use("/api/auth", auth.routesPrivees);
  // controle des depots (verifications aupres des transporteurs)
  app.use("/api/depots", depots.router);
  app.use("/api", apiRouter);
  app.use("/api/print", printRouter);
  app.use("/api/special", specialRouter);
  app.use("/api/suivi", suiviRouter);
  app.use("/api", (req, res) => res.status(404).json({ error: "Introuvable" }));

  // --- 3. les pages et fichiers du dashboard : session obligatoire ------------------
  app.use(auth.exigeSessionPage);
  // /app.js : assemble depuis public/js/ (voir assemblage.js)
  app.use(servirPaquets({ seulement: ["app.js"] }));
  app.use(express.static(PUBLIC, { setHeaders: entetesFichier, cacheControl: false }));
  // en dernier : une erreur imprevue devient une reponse JSON, jamais un arret
  app.use(gestionErreurs);
  return app;
}

module.exports = { creeApp, LIMITE_JSON, LIMITE_LISTE_SUIVI };
