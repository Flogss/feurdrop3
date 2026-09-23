const express = require("express");
const {
  getPrintableSummary,
  getPrintableColis,
  getLitPrintable,
  countLitPrintable,
  countLitNoted,
  getColisById,
  deleteColis,
  markPrinted,
  dropColis,
  consumeStock,
  setColisPrice,
  setColisNote,
} = require("../db");
const { carrierLabel, CARRIERS } = require("../carrier");
const {
  buildLabelsPdf,
  markButtonsPrinted,
  refreshGroupStats,
  refreshColisButtons,
  corrigeTransporteur,
  getBot,
} = require("../bot");

// "BJ" figure dans la liste des transporteurs parce que /transporteur sait le
// corriger, mais c'est un type de colis : il n'a rien a faire dans le menu.
const TRANSPORTEURS = CARRIERS.filter((c) => c.code !== "BJ").map((c) => ({ code: c.code, label: c.label }));

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
    // combien d'annotes : le site marque la categorie sans avoir a la deplier
    noted: row.noted || 0,
    roll: false,
  }));

  const lit = countLitPrintable({ scope });
  if (lit > 0) {
    // les LIT sortent sur le rouleau 210 mm, pas sur la thermique 4x6
    categories.push({ code: "LIT", label: "LIT", count: lit, noted: countLitNoted({ scope }), roll: true });
  }

  res.json({
    scope,
    categories,
    total: categories.reduce((sum, c) => sum + c.count, 0),
    noted: categories.reduce((sum, c) => sum + c.noted, 0),
    // la liste du menu d'edition vient d'ici : une seule reference
    transporteurs: TRANSPORTEURS,
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
      note: row.note || null,
      price: row.price,
      // le transporteur reel (null si non reconnu), pas le groupe d'affichage
      // ou BJ et LIT masquent le transporteur
      carrier: row.carrier || null,
      type: row.type,
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
    const rows = getPrintableSummary({ scope }).flatMap((row) => getPrintableColis(row.carrier, { scope }));
    // les annotes remontent en tete de la liasse entiere, pas seulement en
    // tete de leur transporteur : ce sont eux qu'on veut sur le dessus
    return [...rows.filter((r) => r.note), ...rows.filter((r) => !r.note)];
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

// --- Modifier un colis -------------------------------------------------------
// Le bouton Edit : prix, note, transporteur. Seuls les champs presents dans la
// requete changent. Chaque champ passe par le meme chemin que sa commande
// Telegram (/prix, /note, /transporteur), pour que le site et le bot ne
// divergent jamais.
router.patch("/colis/:id", (req, res) => {
  const id = Number(req.params.id);
  const colis = getColisById(id);
  if (!colis) return fail(res, new Error("colis introuvable"), 404);

  const corps = req.body || {};
  let appris = "";

  if ("price" in corps) {
    // un champ vide n'est pas "0 EUR" : Number("") vaudrait 0 sans broncher
    const brut = String(corps.price ?? "").trim().replace(",", ".");
    const prix = Number(brut);
    if (!brut || !Number.isFinite(prix) || prix < 0) return fail(res, new Error("prix invalide"));
    // Meme verrou que /prix : un tarif d'expediteur modifie plus tard ne doit
    // pas ecraser un prix fixe a la main. Un prix renvoye tel quel ne verrouille
    // rien -- sinon ouvrir puis enregistrer figerait le tarif sans le vouloir.
    if (prix !== colis.price && !setColisPrice(id, prix)) {
      return fail(res, new Error("prix : colis deja drope"));
    }
  }

  if ("carrier" in corps) {
    const code = corps.carrier || null;
    if (code && !TRANSPORTEURS.some((t) => t.code === code)) {
      return fail(res, new Error(`transporteur inconnu : ${code}`));
    }
    if ((colis.carrier || null) !== code) appris = corrigeTransporteur(id, code)?.appris || "";
  }

  if ("note" in corps) setColisNote(id, corps.note);

  refreshColisButtons(id);
  refreshGroupStats();
  const maj = getColisById(id);
  res.json({ ok: true, id, price: maj.price, carrier: maj.carrier, note: maj.note, appris });
});

// --- Drop a l'unite ----------------------------------------------------------
// Une liasse imprimee part rarement d'un bloc : on solde les colis un par un a
// mesure qu'on les poste. Meme compte de stock que les autres drops du site, et
// le bouton sous le fichier Telegram passe a "Drope".
router.post("/colis/:id/drop", (req, res) => {
  const id = Number(req.params.id);
  const drope = dropColis(id);
  if (!drope) return fail(res, new Error("colis introuvable ou deja drope"), 404);
  consumeStock(drope);
  refreshColisButtons(id);
  refreshGroupStats();
  res.json({ ok: true, id });
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
