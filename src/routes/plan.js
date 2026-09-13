const express = require("express");
const { getCarrierSummary } = require("../db");
const { carrierLabel, CARRIERS } = require("../carrier");
const plan = require("../plan");
const store = require("../plan/store");
const geocode = require("../plan/geocode");

const router = express.Router();

// "BJ" est un type de colis, pas un reseau de depot ; "Inconnu" attend encore
// son transporteur. Ni l'un ni l'autre ne peut etre route vers un point relais.
const NOT_ROUTABLE = new Set(["BJ", "Inconnu"]);
const KNOWN = new Set(CARRIERS.map((c) => c.code));

function fail(res, err, status = 400) {
  res.status(status).json({ error: err.message || String(err) });
}

// Ce qu'il y a a deposer, pris directement dans les colis en attente : pas de
// saisie manuelle, le bot connait deja le transporteur de chaque colis.
router.get("/needs", (req, res) => {
  const rows = getCarrierSummary().map((row) => ({
    carrier: row.carrier,
    label: carrierLabel(row.carrier),
    count: row.pending_count,
    value: row.pending_value,
    routable: !NOT_ROUTABLE.has(row.carrier) && KNOWN.has(row.carrier),
    known: store.pointsForCarrier(row.carrier).length,
  }));
  res.json({ needs: rows });
});

// --- Position de depart ------------------------------------------------------

router.get("/geocode", async (req, res) => {
  try {
    res.json({ results: await geocode.search(req.query.q || "") });
  } catch (err) {
    fail(res, err, 502);
  }
});

router.get("/reverse", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return fail(res, new Error("coordonnees invalides"));
  }
  try {
    res.json({ place: await geocode.reverse(lat, lng) });
  } catch (err) {
    fail(res, err, 502);
  }
});

// --- Points de depot ---------------------------------------------------------

router.get("/points", (req, res) => {
  const { carrier } = req.query;
  const points = carrier ? store.pointsForCarrier(carrier) : store.allPoints();
  res.json({ points, counts: store.countPoints() });
});

// Ajout manuel. Sans coordonnees, on geocode l'adresse : un point sans
// position ne sert a rien dans un trajet.
router.post("/points", async (req, res) => {
  const { name, address, postal_code, city, carriers, lat, lng, trust, note } = req.body || {};
  if (!name || !Array.isArray(carriers) || carriers.length === 0) {
    return fail(res, new Error("nom et transporteurs obligatoires"));
  }

  try {
    let position = { lat, lng };
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) {
      const query = [address, postal_code, city].filter(Boolean).join(" ");
      const [found] = await geocode.search(query, { limit: 1 });
      if (!found) return fail(res, new Error("adresse introuvable en Ile-de-France"));
      position = { lat: found.lat, lng: found.lng };
    }

    const point = store.upsertPoint({
      source: "manuel",
      source_ref: null,
      name,
      address: address || "",
      postal_code: postal_code || null,
      city: city || null,
      lat: position.lat,
      lng: position.lng,
      kind: "Ajoute a la main",
      carriers,
      trust: trust === "verified" ? store.TRUST.verified : store.TRUST.unverified,
      note: note || null,
    });
    res.json({ point });
  } catch (err) {
    fail(res, err);
  }
});

// Import d'une liste. Chaque ligne est geocodee si elle n'a pas de
// coordonnees ; les lignes inutilisables sont renvoyees telles quelles pour
// que rien ne disparaisse en silence.
router.post("/points/import", async (req, res) => {
  const { points, trust } = req.body || {};
  if (!Array.isArray(points) || points.length === 0) {
    return fail(res, new Error("liste vide"));
  }

  const level = trust === "verified" ? store.TRUST.verified : store.TRUST.unverified;
  const imported = [];
  const rejected = [];

  for (const raw of points.slice(0, 2000)) {
    try {
      const carriers = (Array.isArray(raw.carriers) ? raw.carriers : [raw.carrier])
        .filter(Boolean)
        .filter((c) => KNOWN.has(c));
      if (!raw.name || carriers.length === 0) throw new Error("nom ou transporteur manquant");

      let { lat, lng } = raw;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const query = [raw.address, raw.postal_code, raw.city].filter(Boolean).join(" ");
        const [found] = await geocode.search(query, { limit: 1 });
        if (!found) throw new Error("adresse introuvable");
        lat = found.lat;
        lng = found.lng;
      }

      imported.push(
        store.upsertPoint({
          source: "import",
          source_ref: raw.ref || `${raw.name}|${raw.address || ""}|${raw.postal_code || ""}`,
          name: raw.name,
          address: raw.address || "",
          postal_code: raw.postal_code || null,
          city: raw.city || null,
          lat,
          lng,
          kind: raw.kind || "Liste importee",
          carriers,
          trust: level,
        })
      );
    } catch (err) {
      rejected.push({ raw, reason: err.message });
    }
  }

  res.json({ imported: imported.length, rejected, counts: store.countPoints() });
});

router.patch("/points/:id", (req, res) => {
  const point = store.getPoint(Number(req.params.id));
  if (!point) return fail(res, new Error("point introuvable"), 404);

  const { trust, carriers } = req.body || {};
  if (trust && Object.values(store.TRUST).includes(trust)) store.setTrust(point.id, trust);
  if (Array.isArray(carriers) && carriers.length > 0) {
    store.addNetworks(point.id, carriers.filter((c) => KNOWN.has(c)));
  }
  res.json({ point: store.getPoint(point.id) });
});

router.delete("/points/:id", (req, res) => {
  store.deletePoint(Number(req.params.id));
  res.json({ ok: true, counts: store.countPoints() });
});

// Retour d'experience : c'est ce qui fait la fiabilite de la base au fil du
// temps. Un depot reussi verifie le point ; un refus le condamne.
router.post("/visit", (req, res) => {
  const { pointId, carrier, result, note } = req.body || {};
  if (!pointId || !["ok", "ferme", "refuse", "introuvable"].includes(result)) {
    return fail(res, new Error("visite invalide"));
  }
  const point = store.recordVisit({ pointId: Number(pointId), carrier, result, note });
  res.json({ point });
});

// --- Calcul du trajet --------------------------------------------------------

router.post("/compute", async (req, res) => {
  const { start, needs, day, departAt, useOsm } = req.body || {};
  try {
    const result = await plan.buildPlan({
      start,
      needs: (needs || []).filter((n) => !NOT_ROUTABLE.has(n.carrier)),
      day: day || plan.today(),
      departAt: Number.isFinite(departAt) ? departAt : null,
      useOsm: useOsm !== false,
    });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
