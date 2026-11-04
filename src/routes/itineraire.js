// /api/itineraire : les boites jaunes et la tournee en voiture (voir
// src/itineraire/). Derriere la session du dashboard, comme le reste de l'API.
//   GET  /adresses?q=&lat=&lon=   suggestions d'adresse pour le depart
//   GET  /lieu?lat=&lon=          l'adresse d'une position GPS
//   POST /calcul                  { depart, rayonKm, nombre, variante, exclure, leveeAVenir }
//   GET  /tuiles/:z/:x/:y         le fond de carte du site (relaye : la page
//                                 ne charge rien d'ailleurs, voir securite.js)
//   GET  /etat                    la copie des boites La Poste
const express = require("express");
const { routeAsync } = require("../http");
const { calculeItineraire, ErreurItineraire, ErreurRoutage, ErreurGeocodage } = require("../itineraire");
const { chercheAdresse, nommePosition } = require("../itineraire/geocodage");
const { etat } = require("../itineraire/boites");

const router = express.Router();

function repondErreur(res, err) {
  if (err instanceof ErreurItineraire || err instanceof ErreurRoutage || err instanceof ErreurGeocodage) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  console.error("[itineraire]", err);
  return res.status(503).json({ error: `Itinéraire indisponible : ${err.message}` });
}

const position = (q) => {
  const lat = Number(q.lat);
  const lon = Number(q.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
};

router.get(
  "/adresses",
  routeAsync(async (req, res) => {
    try {
      res.json({ lieux: await chercheAdresse(req.query.q, { pres: position(req.query) }) });
    } catch (err) {
      repondErreur(res, err);
    }
  })
);

router.get(
  "/lieu",
  routeAsync(async (req, res) => {
    const p = position(req.query);
    if (!p) return res.status(400).json({ error: "Position invalide." });
    try {
      res.json({ lieu: await nommePosition(p.lat, p.lon) });
    } catch (err) {
      repondErreur(res, err);
    }
  })
);

router.post(
  "/calcul",
  routeAsync(async (req, res) => {
    try {
      res.json(await calculeItineraire(req.body || {}));
    } catch (err) {
      repondErreur(res, err);
    }
  })
);

router.get("/etat", (req, res) => res.json(etat()));

// --- Fond de carte du site ---------------------------------------------------------
// Les tuiles d'OpenStreetMap (l'app native a Apple Plans), relayees et
// gardees en memoire : le navigateur ne contacte que le dashboard, et une
// tuile deja vue ne repart pas chez OpenStreetMap (sa politique d'usage :
// peu de requetes, un User-Agent qui dit qui appelle). La page les assombrit.
const MODELE_TUILES = () => process.env.TUILES_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TUILES = new Map();
const MAX_TUILES = 400;

router.get(
  "/tuiles/:z/:x/:y",
  routeAsync(async (req, res) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(String(req.params.y).replace(/\.png$/, ""));
    const n = 2 ** z;
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= n || y >= n) return res.status(400).end();
    const cle = `${z}/${x}/${y}`;
    let tuile = TUILES.get(cle);
    if (!tuile) {
      let r;
      try {
        r = await fetch(MODELE_TUILES().replace("{z}", z).replace("{x}", x).replace("{y}", y), {
          headers: { "User-Agent": "FeurDrop/1.0 (itineraire boites jaunes)" },
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        return res.status(502).end();
      }
      if (!r.ok) return res.status(r.status === 404 ? 404 : 502).end();
      tuile = { octets: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "image/png" };
      TUILES.set(cle, tuile);
      while (TUILES.size > MAX_TUILES) TUILES.delete(TUILES.keys().next().value);
    } else {
      // la plus recente en dernier : les vieilles partent d'abord
      TUILES.delete(cle);
      TUILES.set(cle, tuile);
    }
    res.set({ "Content-Type": tuile.type, "Cache-Control": "private, max-age=604800" });
    res.send(tuile.octets);
  })
);

module.exports = router;
