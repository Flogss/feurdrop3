const express = require("express");
const { routeAsync } = require("../http");
const depots = require("../controle/depots");

// Controle des depots : ce que les transporteurs disent des colis dropes (voir
// controle/depots.js). Ouvrir la page ne lit que la base : seuls les boutons
// « Vérifier » et « Relancer » interrogent un transporteur.

const router = express.Router();

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

router.get("/:colisId", (req, res) => {
  try {
    res.json(depots.detail(Number(req.params.colisId)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Un seul colis, tout de suite (si son transporteur le permet et n'est pas en pause).
router.post(
  "/:colisId/verifier",
  routeAsync(async (req, res) => {
    try {
      res.json(await depots.verifieColis(Number(req.params.colisId)));
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  })
);

// Constat fait a la main sur la page officielle : "pris", "pas_encore",
// "probleme", ou "annule" pour l'effacer.
router.post("/:colisId/constat", (req, res) => {
  try {
    res.json(depots.constate(Number(req.params.colisId), String(req.body?.resultat || "")));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = { router };
