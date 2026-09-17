const express = require("express");
const store = require("../suivi/store");

// Lecture des verifications de numeros de suivi faites par le bot
// suivi-colissimo. Rien ne s'ecrit ici : le dashboard regarde, le bot travaille.

const router = express.Router();

// Vue d'ensemble : de quoi peindre l'ecran d'un coup, sans multiplier les
// allers-retours.
router.get("/overview", (req, res) => {
  const state = store.status();
  if (!state.ready) return res.json({ ready: false, reason: state.reason, tried: state.tried });

  res.json({
    ready: true,
    db: { path: state.path, jobs: state.jobs, results: state.results, numbers: state.numbers },
    summary: store.summary(),
    labels: store.labels(),
    jobs: store.jobs(12),
  });
});

// Etat des verifications seul : appele en boucle tant qu'une tourne, donc
// garde le plus leger possible.
router.get("/jobs", (req, res) => {
  res.json({ ready: store.status().ready, jobs: store.jobs(12) });
});

// Les numeros portant une actualisation donnee, du plus recent au plus ancien.
router.get("/label", (req, res) => {
  const label = req.query.label ?? null;
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json(store.byLabel(label, { limit, offset }));
});

router.get("/search", (req, res) => {
  res.json({ rows: store.search(req.query.q) });
});

module.exports = router;
