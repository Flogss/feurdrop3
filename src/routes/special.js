const express = require("express");
const { listePaires, getPaire } = require("../specials");
const { getBot } = require("../bot");

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
      colis: p.colis_id
        ? { id: p.colis_id, fileName: p.file_name, note: p.note, printed: Boolean(p.printed_at) }
        : null,
    })),
  });
});

// L'image du code, recuperee chez Telegram. Le lien Telegram contient le
// token du bot : il ne sort pas du serveur, c'est l'image qui passe.
// Un code ne change jamais : on garde les derniers en memoire pour que le
// defilement devant le locker ne depende pas du reseau a chaque image.
const cache = new Map(); // paireId -> { bytes, type }
const CACHE_MAX = 60;

router.get("/code/:id", async (req, res) => {
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
    const bytes = Buffer.from(await reponse.arrayBuffer());
    const type = reponse.headers.get("content-type") || "image/jpeg";

    cache.set(id, { bytes, type });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(bytes);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
