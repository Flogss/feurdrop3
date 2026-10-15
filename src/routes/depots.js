const express = require("express");
const { routeAsync } = require("../http");
const depots = require("../controle/depots");

// Controle des depots : ce que les transporteurs disent des colis dropes (voir
// controle/depots.js). Ouvrir la page ne lit que la base : seuls « Vérifier »,
// « Relancer » et « Tout vérifier » font lire un transporteur.

const router = express.Router();

const qui = (req) => (req.session ? `${req.session.type === "app" ? "app" : "site"}${req.session.appareil ? ` · ${req.session.appareil}` : ""}` : null);

router.get("/", (req, res) => {
  res.json(depots.vue());
});

// La pastille du dashboard : les compteurs seuls.
router.get("/resume", (req, res) => {
  const { compteurs } = depots.vue();
  res.json({ compteurs });
});

// « Relancer les vérifications en attente » : un passage en tache de fond, au
// rythme de chaque transporteur. La reponse part tout de suite.
router.post("/relancer", (req, res) => {
  res.status(202).json({ ok: true, etat: depots.relance() });
});

// --- « Tout vérifier » --------------------------------------------------------------

// Lance (ou complete) la campagne : les API officielles partent aussitot sur
// le serveur ; les pages officielles attendent l'app Drop du Mac.
router.post("/campagne", (req, res) => {
  res.status(202).json(depots.nouvelleCampagne({ par: qui(req), force: Boolean(req.body?.force) }));
});

// La progression (la page la relit toutes les deux secondes pendant la campagne).
router.get("/campagne", (req, res) => {
  res.json(depots.campagne());
});

router.post("/campagne/annuler", (req, res) => {
  res.json(depots.annuleCampagne() || depots.campagne());
});

// L'app du Mac se signale (toutes les 10 s, meme sans campagne) : la page
// sait qu'elle est en ligne, et l'app sait s'il y a des pages a lire.
router.get("/agent", (req, res) => {
  res.json(depots.agent({ nom: String(req.query.nom || qui(req) || "Mac") }));
});

// L'app du Mac : un petit lot de pages a lire (meme transporteur), avec un bail.
router.get("/campagne/travail", (req, res) => {
  res.json(depots.travail({ agent: String(req.query.agent || qui(req) || "Mac"), lot: Number(req.query.lot) || 6 }));
});

// L'app du Mac : ce qu'elle a vu sur chaque page (le serveur le lit lui-meme).
router.post("/campagne/resultats", (req, res) => {
  const resultats = req.body?.resultats;
  if (!Array.isArray(resultats)) return res.status(400).json({ error: "resultats attendus" });
  res.json(depots.recoitResultats(resultats, { agent: String(req.body?.agent || qui(req) || "Mac") }));
});

// Couper (ou rallumer) la lecture automatique d'un transporteur sur le Mac.
router.post("/lecture/:code", (req, res) => {
  try {
    depots.coupeLecture(String(req.params.code).toUpperCase(), req.body?.active === false);
    res.json(depots.etat());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Un colis --------------------------------------------------------------------------

router.get("/:colisId", (req, res) => {
  try {
    res.json(depots.detail(Number(req.params.colisId)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Un seul colis, tout de suite (API) ou par le Mac (page officielle).
router.post(
  "/:colisId/verifier",
  routeAsync(async (req, res) => {
    try {
      res.json(await depots.verifieColis(Number(req.params.colisId), { par: qui(req) }));
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  })
);

// Constat fait a la main sur la page officielle : "etiquette", "pas_encore",
// "pris", "transit", "livre", "inconnu", "bloque",
// "probleme", ou "annule" pour l'effacer.
router.post("/:colisId/constat", (req, res) => {
  try {
    res.json(depots.constate(Number(req.params.colisId), String(req.body?.resultat || ""), { par: qui(req) }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = { router };
