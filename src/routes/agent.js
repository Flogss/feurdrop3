const crypto = require("crypto");
const express = require("express");
const {
  isAutoPrintEnabled,
  markPrinted,
  getPrintToken,
  avecSource,
  fileAuto,
  compteFileAuto,
  ouvreTache,
  majTache,
  confirmeTache,
  echecTache,
  agentVu,
} = require("../db");
const { buildLabelsPdf } = require("../bot");
const { routeAsync } = require("../http");

// L'agent d'impression automatique : il tourne sur le Mac relie a
// l'imprimante, demande regulierement s'il y a du nouveau, recupere un PDF
// deja au format 4x6, l'imprime, puis confirme.
//
// Il n'a pas de session du dashboard : son acces, c'est SON jeton
// (X-Print-Token), verifie sur chacune de ces routes et sur rien
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
// C'est aussi le signe de vie de l'agent, que montre le telephone.
router.get("/queue", exigeJetonAgent, (req, res) => {
  agentVu(req.get("x-drop-imprimante"));
  const enabled = isAutoPrintEnabled();
  res.json({ enabled, count: enabled ? compteFileAuto() : 0 });
});

// Le PDF pret a imprimer. Les identifiants partent dans un en-tete : l'agent
// ne confirmera qu'apres impression reussie, donc rien n'est perdu si le Mac
// s'eteint au mauvais moment.
router.get(
  "/next",
  exigeJetonAgent,
  routeAsync(async (req, res) => {
    if (!isAutoPrintEnabled()) return res.status(409).json({ error: "Impression automatique desactivee" });

    // la file est deja filtree (categories, transporteurs, expediteurs
    // choisis sur le telephone) et sans ce qu'une autre tache a reserve
    const rows = fileAuto();
    if (rows.length === 0) return res.status(204).end();

    // reservees avant la preparation : un second appel ne les ressort pas
    const tache = ouvreTache(rows.map((r) => r.id));
    try {
      const { pdf, pages, printedIds } = await buildLabelsPdf(rows);
      if (!pdf || printedIds.length === 0) {
        majTache(tache.id, { etat: "echec", ids: [], finie: new Date().toISOString(), erreur: "Rien à imprimer" });
        return res.status(204).end();
      }
      majTache(tache.id, { ids: printedIds, pages });
      res.set({
        "Content-Type": "application/pdf",
        "X-Drop-Colis-Ids": printedIds.join(","),
        "X-Drop-Pages": String(pages),
        "X-Drop-Job": tache.id,
      });
      res.send(pdf);
    } catch (err) {
      console.error("[print] preparation impossible :", err.message);
      echecTache(tache.id, `Préparation : ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  })
);

// Seule la confirmation de l'agent fait passer une tache a « imprimée ».
// Rejouee (le Mac a imprime puis perdu le reseau), elle ne marque rien deux
// fois.
router.post("/done", exigeJetonAgent, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  const job = typeof req.body?.job === "string" ? req.body.job.slice(0, 40) : null;
  if (!job && ids.length === 0) return res.json({ ok: true, deja: false, marked: 0, job: null });
  // l'agent du Mac n'a pas d'utilisateur : il apparait comme tel dans le menu
  // de reimpression
  const r = confirmeTache({ job, ids }, markPrinted);
  res.json({ ok: true, deja: r.deja, marked: r.deja ? 0 : r.marques, job: r.fournee });
});

// L'impression a echoue sur le Mac (imprimante absente, `lp` refuse) : les
// etiquettes repartent dans la file, et le telephone voit l'erreur.
router.post("/echec", exigeJetonAgent, (req, res) => {
  const job = typeof req.body?.job === "string" ? req.body.job.slice(0, 40) : "";
  const t = echecTache(job, req.body?.erreur);
  if (!t) return res.status(404).json({ error: "Tache inconnue" });
  res.json({ ok: true, etat: t.etat });
});

module.exports = router;
