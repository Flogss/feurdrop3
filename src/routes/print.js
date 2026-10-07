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
const { numerosDesColis } = require("../specials");
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

// Impression depuis le site et l'app. Meme chaine que /imprime sur Telegram --
// memes etiquettes, meme mise en page -- mais le PDF s'ouvre dans un onglet
// (site) ou dans la fenetre d'impression du systeme (app).
//
// Une etiquette n'est marquee "imprimee" que lorsqu'elle l'a vraiment ete :
//   - site : quand l'onglet ouvre le PDF (le premier chargement du PDF) --
//     un onglet bloque, jamais ouvert, ou un PDF expire ne marque rien ;
//   - app : quand la fenetre d'impression d'iOS ou de macOS confirme que
//     l'impression est partie (POST /job/:id/imprime). Une impression
//     annulee ne marque rien.
// Avant, tout etait marque des la construction du PDF : une etiquette dont
// le PDF ne s'ouvrait pas, ou dont l'impression etait annulee, quittait la
// liste "a imprimer" sans etre jamais sortie -- elle etait oubliee.

const router = express.Router();

const jobs = new Map(); // id -> { pdf, name, at, ids, marque }
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
  // un special porte le numero de sa paire : c'est lui qui le relie a son
  // code-barre devant le locker
  const numeros = numerosDesColis(rows.filter((r) => r.type === "special").map((r) => r.id));

  res.json({
    colis: rows.map((row) => ({
      special: numeros.get(row.id) || null,
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
    // rien n'est marque ici : voir l'en-tete du fichier
    jobs.set(id, { pdf: built.pdf, name: `etiquettes-${nom}.pdf`, at: Date.now(), ids: built.printedIds, marque: false });

    res.json({
      jobId: id,
      url: `/api/print/job/${id}.pdf`,
      count: built.printedIds.length,
      // les colis du PDF : l'app les renvoie pour confirmer l'impression
      ids: built.printedIds,
      pages: built.pages ?? null,
      roll,
      lengthMm: built.lengthMm ?? null,
      // ce qui n'a pas pu entrer dans le PDF reste "a imprimer" : on le dit
      missing: (built.missing || []).length,
      failed: (built.failed || []).length,
      absents: [...(built.missing || []), ...(built.failed || [])].map((x) => ({ label: x.label, reason: x.reason })),
    });
  } catch (err) {
    fail(res, err, 500);
  }
});

// Marque une fournee comme imprimee (une seule fois par PDF) : plus de
// ressortie, ici comme sur Telegram, et "Deja imprime" sous les fichiers.
function marqueFournee(ids, par) {
  if (!ids.length) return 0;
  markPrinted(ids, par);
  const bot = getBot();
  if (bot) markButtonsPrinted(bot, ids);
  refreshGroupStats();
  return ids.length;
}

// L'onglet ouvert par le navigateur vient chercher le PDF ici. `inline` pour
// qu'il s'affiche dans la visionneuse au lieu d'etre telecharge. Le premier
// chargement marque les etiquettes (un rafraichissement ne remarque rien) ;
// `?marquer=0` : l'app telecharge le PDF et confirmera apres l'impression.
router.get("/job/:id.pdf", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("PDF expire : relance l'impression.");
  if (req.query.marquer !== "0" && !job.marque) {
    job.marque = true;
    marqueFournee(job.ids, "dashboard");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${job.name}"`);
  res.send(job.pdf);
});

// L'app : la fenetre d'impression a confirme. Les identifiants viennent de la
// fournee (ou, si le serveur a redemarre entre-temps, de la requete : ce sont
// ceux que la construction avait renvoyes).
router.post("/job/:id/imprime", (req, res) => {
  const job = jobs.get(req.params.id);
  const ids = job
    ? job.ids
    : Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (job?.marque) return res.json({ ok: true, marked: 0, deja: true });
  if (job) job.marque = true;
  const par = typeof req.body?.par === "string" && req.body.par.trim() ? req.body.par.trim().slice(0, 40) : "app";
  res.json({ ok: true, marked: marqueFournee(ids, par) });
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
