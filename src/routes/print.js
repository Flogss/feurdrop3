const express = require("express");
const {
  getPrintableSummary,
  getPrintableColis,
  getLitPrintable,
  countLitPrintable,
  getColisById,
  deleteColis,
  markPrinted,
} = require("../db");
const { carrierLabel } = require("../carrier");
const { buildLabelsPdf, markButtonsPrinted, refreshGroupStats, getBot } = require("../bot");

// Impression depuis le site. Meme chaine que /imprime sur Telegram -- memes
// etiquettes, meme mise en page, meme marquage -- mais le PDF s'ouvre dans un
// onglet, ou le navigateur sait l'imprimer.
//
// Le PDF n'est pas servi par un GET qui imprimerait au passage : un
// rafraichissement de page aurait alors marque les etiquettes une deuxieme
// fois. On construit par POST, on garde le resultat quelques minutes, et
// l'onglet vient le chercher par son numero.

const router = express.Router();

const jobs = new Map(); // id -> { pdf, name, at }
const JOB_TTL_MS = 15 * 60 * 1000;

function purge() {
  const limite = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.at < limite) jobs.delete(id);
}

function fail(res, err, status = 400) {
  res.status(status).json({ error: err.message || String(err) });
}

// --- Ce qu'il y a a imprimer -------------------------------------------------

router.get("/resume", (req, res) => {
  const scope = req.query.scope === "printed" ? "printed" : "new";
  const categories = getPrintableSummary({ scope }).map((row) => ({
    code: row.carrier,
    label: carrierLabel(row.carrier),
    count: row.count,
    roll: false,
  }));

  const lit = countLitPrintable({ scope });
  if (lit > 0) {
    // les LIT sortent sur le rouleau 210 mm, pas sur la thermique 4x6
    categories.push({ code: "LIT", label: "LIT", count: lit, roll: true });
  }

  res.json({
    scope,
    categories,
    total: categories.reduce((sum, c) => sum + c.count, 0),
  });
});

// Le detail d'une categorie : de quoi deplier la liste et agir colis par colis.
router.get("/colis", (req, res) => {
  const scope = req.query.scope === "printed" ? "printed" : "new";
  const code = req.query.categorie;
  const rows = code === "LIT" ? getLitPrintable({ scope }) : getPrintableColis(code, { scope });

  res.json({
    colis: rows.map((row) => ({
      id: row.id,
      sender: row.sender_name,
      fileName: row.file_name,
      kind: row.file_kind,
      carrier: row.carrier_group || row.carrier,
    })),
  });
});

// --- Construction du PDF -----------------------------------------------------

function rowsFor({ categorie, ids, scope }) {
  if (Array.isArray(ids) && ids.length > 0) {
    return ids.map((id) => getColisById(Number(id))).filter((row) => row && row.file_id);
  }
  if (categorie === "LIT") return getLitPrintable({ scope });
  if (categorie === "*") {
    return getPrintableSummary({ scope }).flatMap((row) => getPrintableColis(row.carrier, { scope }));
  }
  return getPrintableColis(categorie, { scope });
}

router.post("/build", async (req, res) => {
  const { categorie = "*", ids = null, scope = "new" } = req.body || {};
  try {
    const rows = rowsFor({ categorie, ids, scope });
    if (rows.length === 0) return fail(res, new Error("aucune etiquette a imprimer"));

    // un lot de LIT sort sur le rouleau ; tout le reste au format thermique
    const roll = categorie === "LIT" || rows.every((row) => row.type === "lit");
    const built = await buildLabelsPdf(rows, { roll });
    if (!built.pdf) {
      // dire POURQUOI : "rien a imprimer" tout seul ne laisse aucune prise
      const causes = [...new Set((built.failed || []).map((f) => f.reason))].slice(0, 2);
      const manquants = (built.missing || []).length;
      const detail = causes.length
        ? ` : ${causes.join(" ; ")}`
        : manquants > 0
          ? ` : ${manquants} fichier(s) introuvable(s) sur Telegram (message supprime ou trop vieux)`
          : "";
      return fail(res, new Error(`aucune etiquette lisible${detail}`));
    }

    purge();
    const id = Math.random().toString(36).slice(2, 10);
    const nom = categorie === "*" ? "toutes" : String(categorie).toLowerCase();
    jobs.set(id, { pdf: built.pdf, name: `etiquettes-${nom}.pdf`, at: Date.now() });

    // les etiquettes sorties ne doivent plus ressortir, ici comme sur Telegram
    markPrinted(built.printedIds, "dashboard");
    const bot = getBot();
    if (bot) markButtonsPrinted(bot, built.printedIds);
    refreshGroupStats();

    res.json({
      jobId: id,
      url: `/api/print/job/${id}.pdf`,
      count: built.printedIds.length,
      pages: built.pages ?? null,
      roll,
      lengthMm: built.lengthMm ?? null,
      missing: (built.missing || []).length,
      failed: (built.failed || []).length,
    });
  } catch (err) {
    fail(res, err, 500);
  }
});

// L'onglet ouvert par le navigateur vient chercher le PDF ici. `inline` pour
// qu'il s'affiche dans la visionneuse au lieu d'etre telecharge.
router.get("/job/:id.pdf", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("PDF expire : relance l'impression.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${job.name}"`);
  res.send(job.pdf);
});

// --- Retirer un colis --------------------------------------------------------

router.delete("/colis/:id", (req, res) => {
  const colis = getColisById(Number(req.params.id));
  if (!colis) return fail(res, new Error("colis introuvable"), 404);

  deleteColis(colis.id);
  // le fichier part aussi du fil Telegram, comme /del
  const bot = getBot();
  if (bot && colis.chat_id && colis.message_id) {
    bot.deleteMessage(colis.chat_id, colis.message_id).catch(() => {});
  }
  refreshGroupStats();
  res.json({ ok: true, id: colis.id });
});

module.exports = router;
