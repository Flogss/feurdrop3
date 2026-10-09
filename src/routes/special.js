const express = require("express");
const { listePaires, getPaire } = require("../specials");
const { getBot, finiCodeSeul } = require("../bot");
const { renduPng } = require("../rasterInk");
const { routeAsync } = require("../http");

// Mode locker : les codes-barres du topic special, dans l'ordre des numeros
// imprimes sur les etiquettes. Devant le locker, on lit "#3" sur le colis et
// le telephone montre le code #3.

const router = express.Router();

router.get("/paires", (req, res) => {
  res.json({
    paires: listePaires().map((p) => ({
      id: p.id,
      numero: p.numero,
      sender: p.sender_name,
      code: p.code,
      // un code qui ne va avec aucun PDF : il n'est pas "incomplet"
      seul: p.seul,
      colis: p.colis_id
        ? { id: p.colis_id, fileName: p.file_name, note: p.note, printed: Boolean(p.printed_at) }
        : null,
    })),
  });
});

// "Fait" sur un code seul : il n'y a pas de colis a droper, la paire s'en va
// une fois le locker ouvert.
router.post("/paires/:id/fini", (req, res) => {
  const paire = finiCodeSeul(Number(req.params.id));
  if (!paire) return res.status(404).json({ error: "code seul introuvable" });
  res.json({ ok: true });
});

// L'image du code, recuperee chez Telegram. Le lien Telegram contient le
// token du bot : il ne sort pas du serveur, c'est l'image qui passe.
// Un code ne change jamais : on garde les derniers en memoire pour que le
// defilement devant le locker ne depende pas du reseau a chaque image.
const cache = new Map(); // paireId -> { bytes, type }
const CACHE_MAX = 60;

router.get("/code/:id", routeAsync(async (req, res) => {
  const id = Number(req.params.id);
  const deja = cache.get(id);
  if (deja) {
    res.setHeader("Content-Type", deja.type);
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.send(deja.bytes);
  }

  const paire = getPaire(id);
  if (!paire || !paire.code_file_id) return res.status(404).json({ error: "code introuvable" });
  const bot = getBot();
  if (!bot) return res.status(503).json({ error: "bot non demarre" });

  try {
    const lien = await bot.getFileLink(paire.code_file_id);
    const reponse = await fetch(lien);
    if (!reponse.ok) throw new Error(`Telegram HTTP ${reponse.status}`);
    let bytes = Buffer.from(await reponse.arrayBuffer());
    let type = reponse.headers.get("content-type") || "image/jpeg";

    // un code arrive parfois en PDF : un navigateur ne l'affiche pas dans une
    // balise image, on le rend donc en PNG, recadre sur le code
    if (paire.code_file_kind === "pdf" || bytes.subarray(0, 5).toString() === "%PDF-") {
      const png = await renduPng(bytes);
      if (!png) throw new Error("rendu du PDF impossible (poppler absent ?)");
      bytes = png;
      type = "image/png";
    }

    cache.set(id, { bytes, type });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(bytes);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

module.exports = router;
