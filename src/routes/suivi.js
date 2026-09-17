const express = require("express");
const store = require("../suivi/store");
const engine = require("../suivi/engine");

// Lecture des verifications de numeros de suivi faites par le bot
// suivi-colissimo. Rien ne s'ecrit ici : le dashboard regarde, le bot travaille.

const router = express.Router();

// une liste de 10 000 numeros fait dans les 140 ko : la limite par defaut
// d'express (100 ko) la refuserait sans explication
router.use(express.json({ limit: "8mb" }));

// Vue d'ensemble : de quoi peindre l'ecran d'un coup, sans multiplier les
// allers-retours.
router.get("/overview", (req, res) => {
  const state = store.status();
  if (!state.ready) return res.json({ ready: false, reason: state.reason, tried: state.tried });

  res.json({
    ready: true,
    db: { path: state.path, jobs: state.jobs, results: state.results, numbers: state.numbers },
    totalChecked: store.totalChecked(),
    summary: store.summary(),
    labels: store.labels(),
    recheckable: store.recheckable(),
    // seules les verifications en cours ont leur place a l'ecran : les
    // anciennes se resument a un total
    running: store.jobs(12).filter((j) => j.running),
  });
});

// Etat de la verification en cours. Appele plusieurs fois par seconde pendant
// l'animation : il ne touche pas la base, tout vient de la memoire.
router.get("/live", (req, res) => {
  res.json(engine.live({ since: Number(req.query.since) || 0 }));
});

// Ce qu'on peut relancer, et combien.
router.get("/recheck", (req, res) => {
  res.json({ categories: store.recheckable(), running: engine.isRunning() });
});

// Relance les numeros d'une ou plusieurs categories non finales.
router.post("/recheck", async (req, res) => {
  const wanted = Array.isArray(req.body?.milestones) ? req.body.milestones : [];
  try {
    const numbers = store.numbersToRecheck(wanted);
    if (numbers.length === 0) return fail(res, new Error("aucun numero dans ces categories"));
    const limit = Number(req.body?.limit) || 0;
    res.json(await engine.startCheck({
      numbers: limit > 0 ? numbers.slice(0, limit) : numbers,
      source: `recheck ${wanted.join("+")}`,
    }));
  } catch (err) {
    fail(res, err);
  }
});

// Mise en attente d'une liste collee ou d'un fichier depose.
router.post("/verifier", async (req, res) => {
  try {
    const parsed = await engine.parse(req.body?.text);
    if (parsed.valid.length === 0) {
      return fail(res, new Error("aucun numero valide dans cette liste"));
    }
    const started = await engine.startCheck({
      numbers: parsed.valid,
      source: req.body?.name || "liste collee",
    });
    res.json({
      ...started,
      invalid: parsed.invalid.length,
      duplicates: parsed.duplicates,
      lus: parsed.total,
    });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/annuler", (req, res) => {
  res.json({ cancelled: engine.cancel() });
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

// L'adresse IP que le monde exterieur voit quand ce serveur appelle une API.
// Rien a voir avec l'adresse interne de la machine : un conteneur heberge sort
// derriere une passerelle, et c'est CETTE adresse-la que La Poste compare a sa
// liste d'IP autorisees.
router.get("/ip-sortie", async (req, res) => {
  try {
    const answer = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(8000),
    });
    const { ip } = await answer.json();
    res.json({ ip, note: "adresse a autoriser dans la console La Poste" });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
