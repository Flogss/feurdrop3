const crypto = require("crypto");
const express = require("express");
const { isAutoPrintEnabled, getUnprintedLabels, countUnprintedLabels, markPrinted, getPrintToken, avecSource } = require("../db");
const { buildLabelsPdf } = require("../bot");
const { routeAsync } = require("../http");

// L'agent d'impression automatique : il tourne sur le Mac relie a
// l'imprimante, demande regulierement s'il y a du nouveau, recupere un PDF
// deja au format 4x6, l'imprime, puis confirme.
//
// Il n'a pas de session du dashboard : son acces, c'est SON jeton
// (X-Print-Token), verifie sur chacune de ces trois routes et sur rien
// d'autre. Le jeton voyage dans l'en-tete, jamais dans l'adresse : une
// adresse finit dans les journaux d'acces, les proxys et l'historique.
//
// Monte sur /api/print AVANT la verification de session : toute autre
// adresse sous /api/print passe a la suite (et donc a la session).

const router = express.Router();

function jetonValable(req) {
  const fourni = String(req.get("x-print-token") || "");
  const attendu = getPrintToken();
  return fourni.length === attendu.length && crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(attendu));
}

function exigeJetonAgent(req, res, next) {
  res.set("Cache-Control", "no-store");
  if (!jetonValable(req)) return res.status(401).json({ error: "Jeton d'impression invalide" });
  // ce que l'agent fait apparait comme tel dans le journal
  avecSource("imprimante", next);
}

// Sondage de l'agent : volontairement minuscule, il tourne toutes les 20 s.
router.get("/queue", exigeJetonAgent, (req, res) => {
  res.json({ enabled: isAutoPrintEnabled(), count: isAutoPrintEnabled() ? countUnprintedLabels() : 0 });
});

// Le PDF pret a imprimer. Les identifiants partent dans un en-tete : l'agent
// ne confirmera qu'apres impression reussie, donc rien n'est perdu si le Mac
// s'eteint au mauvais moment.
router.get(
  "/next",
  exigeJetonAgent,
  routeAsync(async (req, res) => {
    if (!isAutoPrintEnabled()) return res.status(409).json({ error: "Impression automatique desactivee" });

    const rows = getUnprintedLabels();
    if (rows.length === 0) return res.status(204).end();

    try {
      const { pdf, pages, printedIds } = await buildLabelsPdf(rows);
      if (!pdf) return res.status(204).end();
      res.set({
        "Content-Type": "application/pdf",
        "X-Drop-Colis-Ids": printedIds.join(","),
        "X-Drop-Pages": String(pages),
      });
      res.send(pdf);
    } catch (err) {
      console.error("[print] preparation impossible :", err.message);
      res.status(500).json({ error: err.message });
    }
  })
);

router.post("/done", exigeJetonAgent, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  // l'agent du Mac n'a pas d'utilisateur : il apparait comme tel dans le menu
  // de reimpression
  const job = markPrinted(ids, "Impression auto");
  res.json({ ok: true, marked: ids.length, job });
});

module.exports = router;
