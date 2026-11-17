// /api/bordereaux : l'etude des etiquettes (voir src/bordereaux/). Derriere la
// session du dashboard, comme le reste de l'API.
//   GET  /                    liste (?filtre=tous|a_imprimer|imprimes|deposes&q=
//                             &transporteur=LP|aucun&depuis=AAAA-MM-JJ&jusqua=
//                             &categorie=<id>|aucune&tri=recent|ancien|transporteur
//                             &decalage=, ou l'ancien &avant=)
//   GET  /categories          les categories (et leur nombre d'etiquettes)
//   POST /categories          { nom, couleur } ; PATCH /categories/:id ; DELETE /categories/:id
//   PUT  /:id/categorie       { categorie: <id>|null } : classer une etiquette
//   GET  /etat                l'index : etiquettes lues, a lire, en echec
//   GET  /recherche?q=        un numero dans les codes lus et les numeros de suivi
//   GET  /:id                 une etiquette : colis, suivi, codes (sans la relire)
//   POST /:id/analyse         la lire maintenant ({ force: true } : la relire)
//   GET  /:id/fichier         le fichier d'origine, tel quel (?telecharger=1)
//   PUT  /:id/annotation      { texte } : la note d'etude, a part du fichier
const express = require("express");
const { routeAsync } = require("../http");
const bordereaux = require("../bordereaux");
const { ErreurLecteur } = require("../bordereaux/decodeur");
const editeur = require("../bordereaux/editeur");
const { getColisById } = require("../db");

const router = express.Router();

const idDe = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const entier = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

router.get("/", (req, res) => {
  const filtre = Object.hasOwn(bordereaux.FILTRES, req.query.filtre) ? req.query.filtre : "tous";
  const categorie = req.query.categorie === "aucune" ? "aucune" : entier(req.query.categorie);
  res.json(
    bordereaux.liste({
      filtre,
      q: String(req.query.q || "").slice(0, 80),
      avant: entier(req.query.avant),
      decalage: entier(req.query.decalage),
      transporteur: /^[A-Za-z0-9_]{1,20}$/.test(req.query.transporteur || "") ? req.query.transporteur : null,
      depuis: String(req.query.depuis || ""),
      jusqua: String(req.query.jusqua || ""),
      categorie,
      tri: Object.hasOwn(bordereaux.TRIS, req.query.tri) ? req.query.tri : "recent",
    })
  );
});

// --- Categories (un classement a part : jamais dans les etiquettes) ----------------------

router.get("/categories", (req, res) => res.json({ categories: bordereaux.categories(), couleurs: bordereaux.COULEURS }));

router.post("/categories", (req, res) => {
  const r = bordereaux.creeCategorie(req.body?.nom, req.body?.couleur);
  if (r.erreur) return res.status(400).json({ error: r.erreur });
  res.status(201).json(r);
});

router.patch("/categories/:id", (req, res) => {
  const r = bordereaux.modifieCategorie(entier(req.params.id), { nom: req.body?.nom, couleur: req.body?.couleur });
  if (r.erreur) return res.status(r.status || 400).json({ error: r.erreur });
  res.json(r);
});

router.delete("/categories/:id", (req, res) => {
  if (!bordereaux.supprimeCategorie(entier(req.params.id))) return res.status(404).json({ error: "Catégorie introuvable." });
  res.json({ ok: true });
});

router.get("/etat", (req, res) => res.json(bordereaux.etat()));

router.get("/recherche", (req, res) => {
  res.json(bordereaux.recherche(String(req.query.q || "").slice(0, 60)));
});

router.get("/:id", (req, res) => {
  const id = idDe(req);
  const d = id && bordereaux.detail(id);
  if (!d) return res.status(404).json({ error: "Étiquette introuvable." });
  res.json(d);
});

router.post(
  "/:id/analyse",
  routeAsync(async (req, res) => {
    const id = idDe(req);
    if (!id || !bordereaux.detail(id)) return res.status(404).json({ error: "Étiquette introuvable." });
    try {
      res.json(await bordereaux.analyseEtDetail(id, { force: req.body?.force === true }));
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      const lecteur = err instanceof ErreurLecteur;
      if (!lecteur) console.error(`[bordereaux] colis #${id} :`, err.message);
      // l'echec reste visible sur la page (« fichier introuvable sur Telegram »)
      res.status(lecteur ? 503 : 502).json({ error: `Lecture impossible : ${err.message}`, detail: bordereaux.detail(id) });
    }
  })
);

router.get(
  "/:id/fichier",
  routeAsync(async (req, res) => {
    const id = idDe(req);
    if (!id) return res.status(404).json({ error: "Étiquette introuvable." });
    // deja vu par ce navigateur : rien a renvoyer (le fichier ne change pas)
    const connue = bordereaux.empreinteConnue(id);
    if (connue && req.get("If-None-Match") === `"${connue}"`) return res.status(304).end();
    let f;
    try {
      f = await bordereaux.fichierOriginal(id);
    } catch (err) {
      return res.status(502).json({ error: `Fichier inaccessible : ${err.message}` });
    }
    if (!f) return res.status(404).json({ error: "Étiquette introuvable." });
    const extension = { pdf: "pdf", jpeg: "jpg", png: "png", gif: "gif", webp: "webp" }[f.type] || "bin";
    const nom = (f.nom || `etiquette-${id}`).replace(/\.[a-z0-9]{2,5}$/i, "") + `.${extension}`;
    const telecharger = req.query.telecharger === "1" || !f.type;
    res.set({
      "Content-Type": f.mime,
      "Content-Length": String(f.octets.length),
      // le nom du fichier d'origine (accents compris), jamais interprete
      "Content-Disposition": `${telecharger ? "attachment" : "inline"}; filename="${nom.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nom)}`,
      "Cache-Control": "private, max-age=600",
      ETag: `"${f.empreinte}"`,
    });
    // seuls un PDF ou une image (reconnus a leurs octets) s'ouvrent dans le
    // navigateur ; tout le reste se telecharge (octet-stream, nosniff)
    res.end(Buffer.from(f.octets.buffer, f.octets.byteOffset, f.octets.byteLength));
  })
);

// --- L'editeur : un document de travail a part ------------------------------------------
//   GET    /:id/travail          le brouillon (ou null)
//   PUT    /:id/travail          { modele } : sauvegarde automatique
//   DELETE /:id/travail          repartir de l'original
//   POST   /:id/code             { format, valeur } : un code regenere (apercu)
//   POST   /:id/travail/export   { modele } : le NOUVEAU PDF (l'original ne bouge pas)

function repondEditeur(res, err) {
  if (err instanceof editeur.ErreurEditeur) {
    return res.status(err.status).json({ error: err.message, protege: err.protege || false, transporteur: err.transporteur || null });
  }
  if (err instanceof ErreurLecteur) return res.status(503).json({ error: err.message });
  console.error("[editeur]", err);
  return res.status(500).json({ error: `Impossible : ${err.message}` });
}

router.get("/:id/travail", (req, res) => {
  const id = idDe(req);
  if (!id || !bordereaux.detail(id)) return res.status(404).json({ error: "Étiquette introuvable." });
  res.json({ travail: editeur.brouillon(id) });
});

router.put("/:id/travail", (req, res) => {
  const id = idDe(req);
  if (!id || !bordereaux.detail(id)) return res.status(404).json({ error: "Étiquette introuvable." });
  try {
    res.json(editeur.gardeBrouillon(id, req.body?.modele));
  } catch (err) {
    repondEditeur(res, err);
  }
});

router.delete("/:id/travail", (req, res) => {
  const id = idDe(req);
  if (!id || !bordereaux.detail(id)) return res.status(404).json({ error: "Étiquette introuvable." });
  res.json({ efface: require("../bordereaux/base").effaceTravail(id) });
});

router.post(
  "/:id/code",
  routeAsync(async (req, res) => {
    const id = idDe(req);
    const colis = id ? getColisById(id) : null;
    if (!colis || !colis.file_id) return res.status(404).json({ error: "Étiquette introuvable." });
    try {
      // le code de l'etiquette elle-meme (deplace ou redimensionne) : verifie
      // contre ce qui a ete lu, jamais d'apres la page
      const codeId = Number.isInteger(req.body?.codeId) ? req.body.codeId : null;
      const lu = codeId ? bordereaux.codesDuColis(id).find((c) => c.id === codeId) : null;
      const original = Boolean(lu && lu.lisible && lu.valeur === req.body?.valeur && lu.format === req.body?.format);
      const { format, valeur, largeur, hauteur, chemin } = await editeur.genereCode(String(req.body?.format || ""), req.body?.valeur, { colis, original });
      res.json({ format, valeur, largeur, hauteur, chemin });
    } catch (err) {
      repondEditeur(res, err);
    }
  })
);

router.post(
  "/:id/travail/export",
  routeAsync(async (req, res) => {
    const id = idDe(req);
    if (!id || !bordereaux.detail(id)) return res.status(404).json({ error: "Étiquette introuvable." });
    try {
      const { pdf, nom } = await editeur.exporte(id, req.body?.modele, { telecharge: bordereaux.telecharge, codesLus: bordereaux.codesDuColis(id) });
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${nom.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nom)}`,
        "Cache-Control": "no-store",
      });
      res.end(Buffer.from(pdf));
    } catch (err) {
      repondEditeur(res, err);
    }
  })
);

router.put("/:id/categorie", (req, res) => {
  const id = idDe(req);
  const valeur = req.body?.categorie;
  if (valeur !== null && !Number.isInteger(valeur)) return res.status(400).json({ error: "Catégorie invalide." });
  const r = id ? bordereaux.classe(id, valeur) : { status: 404, erreur: "Étiquette introuvable." };
  if (r.erreur) return res.status(r.status || 400).json({ error: r.erreur });
  res.json(r);
});

router.put("/:id/annotation", (req, res) => {
  const id = idDe(req);
  const texte = req.body?.texte;
  if (texte !== null && texte !== undefined && typeof texte !== "string") return res.status(400).json({ error: "Note invalide." });
  if (!id || !bordereaux.detail(id)) return res.status(404).json({ error: "Étiquette introuvable." });
  res.json({ annotation: bordereaux.annote(id, texte || "") });
});

module.exports = router;
