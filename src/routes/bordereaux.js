// /api/bordereaux : l'etude des etiquettes (voir src/bordereaux/). Derriere la
// session du dashboard, comme le reste de l'API.
//   GET  /                    liste (?filtre=tous|a_imprimer|imprimes|deposes&q=&avant=)
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

const router = express.Router();

const idDe = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

router.get("/", (req, res) => {
  const filtre = Object.hasOwn(bordereaux.FILTRES, req.query.filtre) ? req.query.filtre : "tous";
  const avant = Number(req.query.avant);
  res.json(
    bordereaux.liste({
      filtre,
      q: String(req.query.q || "").slice(0, 80),
      avant: Number.isInteger(avant) ? avant : null,
    })
  );
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

router.put("/:id/annotation", (req, res) => {
  const id = idDe(req);
  const texte = req.body?.texte;
  if (texte !== null && texte !== undefined && typeof texte !== "string") return res.status(400).json({ error: "Note invalide." });
  if (!id || !bordereaux.detail(id)) return res.status(404).json({ error: "Étiquette introuvable." });
  res.json({ annotation: bordereaux.annote(id, texte || "") });
});

module.exports = router;
