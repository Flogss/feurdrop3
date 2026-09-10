const express = require("express");
const {
  db,
  DEFAULT_PRICE,
  DEFAULT_LIT_PRICE,
  updateSenderPrices,
  setColisType,
  quickAddColis,
  quickRemoveColis,
  getDailySeries,
  getWeeklySeries,
  getBestDay,
  getDebtsBySender,
  markSenderPaid,
  getStock,
  adjustStock,
  getMergeCandidates,
  mergeSendersIntoOther,
  mergeSenderInto,
  getCarrierSummary,
  dropByCarrier,
  dropAll,
  dropBySender,
  getTourStart,
  startTour,
  endTour,
  recordTour,
  getDayTours,
  saveLastTour,
  getLastTour,
  clearLastTour,
  serverNow,
  tourScope,
  getArrivedDuringTour,
  saveSubscription,
  deleteSubscription,
  markPushSeen,
  getPendingSummary,
} = require("../db");
const { getPublicKey, sendToAll, countSubscriptions, notifyTourStart } = require("../push");
const { refreshGroupStats } = require("../bot");

// SMIC horaire NET francais, sert de point de comparaison apres une tournee :
// c'est ce qu'on touche vraiment, donc comparable a l'argent des colis.
// (~9,40 EUR net pour 11,88 EUR brut depuis novembre 2024.)
// Revalorise regulierement : surchargeable sans redeploiement via la variable
// d'environnement SMIC_HOURLY.
const SMIC_HOURLY = Number(process.env.SMIC_HOURLY || 9.4);

const router = express.Router();

// Toute modification de colis ou de tarifs faite depuis le site change le
// nombre / la valeur en attente : on met a jour l'image postee dans le groupe
// Telegram (les appels rapproches sont regroupes cote bot).
const STATS_AFFECTING = /^\/(colis|senders)/;
router.use((req, res, next) => {
  if (req.method === "GET" || !STATS_AFFECTING.test(req.path)) return next();
  res.on("finish", () => {
    if (res.statusCode < 400) refreshGroupStats();
  });
  next();
});

router.get("/stats", (req, res) => {
  // Pendant une tournee, tout ce qui est "a dropper" ne compte que le sac :
  // les colis arrives depuis le depart sont montres a part.
  const tour = tourScope();
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending'${tour.clause}`
    )
    .get(...tour.params);
  const dropped = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'dropped'")
    .get();
  const today = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis
       WHERE status = 'dropped' AND date(dropped_at) = date('now')`
    )
    .get();
  // le "en attente" par expediteur suit la meme regle que le bouton Drop
  const pendingInScope = tour.params.length
    ? "status = 'pending' AND created_at <= @tourStart"
    : "status = 'pending'";
  const bySender = db
    .prepare(
      `SELECT sender_name,
              SUM(CASE WHEN ${pendingInScope} THEN 1 ELSE 0 END) AS pending_count,
              SUM(CASE WHEN ${pendingInScope} THEN price ELSE 0 END) AS pending_value,
              SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) AS dropped_count,
              SUM(CASE WHEN status = 'dropped' THEN price ELSE 0 END) AS dropped_value
       FROM colis GROUP BY sender_name ORDER BY pending_count DESC`
    )
    .all(...(tour.params.length ? [{ tourStart: tour.params[0] }] : []));
  const litPending = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending' AND type = 'lit'${tour.clause}`
    )
    .get(...tour.params);
  const bjPending = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending' AND type = 'bj'${tour.clause}`
    )
    .get(...tour.params);
  const arrived = getArrivedDuringTour();

  res.json({
    pendingCount: pending.count,
    pendingValue: pending.value,
    droppedCount: dropped.count,
    droppedValue: dropped.value,
    todayCount: today.count,
    todayValue: today.value,
    litPendingCount: litPending.count,
    litPendingValue: litPending.value,
    bjPendingCount: bjPending.count,
    bjPendingValue: bjPending.value,
    bySender,
    byCarrier: getCarrierSummary(),
    tour: {
      startedAt: getTourStart(),
      arrivedCount: arrived.count,
      arrivedValue: arrived.value,
      // heure du serveur : le chrono du navigateur s'y recale pour ne pas
      // deriver si les deux horloges different
      now: serverNow(),
      last: getLastTour(),
    },
  });
});

// --- Tournee ----------------------------------------------------------------
router.post("/tour/start", (req, res) => {
  const startedAt = startTour();
  notifyTourStart();
  res.json({ ok: true, startedAt });
});

// Retour de tournee : ce qu'on a emporte a ete poste, donc on le marque drope
// et la tournee se referme (les colis recus pendant redeviennent droppables).
router.post("/tour/finish", (req, res) => {
  const startedAt = getTourStart();
  const bag = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending'${
        startedAt ? " AND created_at <= ?" : ""
      }`
    )
    .get(...(startedAt ? [startedAt] : []));

  const count = dropAll();
  if (count > 0) adjustStock(-count);
  const endedAt = serverNow();
  endTour();

  let summary = null;
  if (startedAt) {
    const seconds = Math.max(
      0,
      Math.round((Date.parse(`${endedAt.replace(" ", "T")}Z`) - Date.parse(`${startedAt.replace(" ", "T")}Z`)) / 1000)
    );
    recordTour({ startedAt, endedAt, seconds, count, value: bag.value });

    // le cumul du jour inclut la tournee qu'on vient d'enregistrer : une
    // deuxieme sortie s'ajoute a la premiere pour le taux horaire
    const day = getDayTours(endedAt);
    summary = {
      startedAt,
      endedAt,
      seconds,
      count,
      value: bag.value,
      smicHourly: SMIC_HOURLY,
      day: {
        sessions: day.sessions,
        seconds: day.seconds,
        count: day.count,
        value: day.value,
      },
    };
    saveLastTour(summary);
  }

  res.json({ ok: true, count, value: bag.value, startedAt, endedAt, summary, stock: getStock() });
});

// Fermeture du resume de tournee affiche sur le dashboard.
router.post("/tour/dismiss-summary", (req, res) => {
  clearLastTour();
  res.json({ ok: true });
});

// Annulation : on referme la tournee sans rien dropper (finalement pas parti,
// ou rien poste).
router.post("/tour/end", (req, res) => {
  endTour();
  res.json({ ok: true, startedAt: null });
});

router.get("/colis", (req, res) => {
  const status = req.query.status === "dropped" ? "dropped" : "pending";
  const rows = db
    .prepare("SELECT * FROM colis WHERE status = ? ORDER BY created_at DESC LIMIT 500")
    .all(status);
  res.json(rows);
});

router.post("/colis/:id/drop", (req, res) => {
  const info = db
    .prepare("UPDATE colis SET status = 'dropped', dropped_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "Colis introuvable ou deja drope" });
  res.json({ ok: true });
});

router.post("/colis/:id/type", (req, res) => {
  const type = req.body.type === "lit" ? "lit" : "normal";
  const updated = setColisType(req.params.id, type);
  if (!updated) return res.status(404).json({ error: "Colis introuvable ou deja drope" });
  res.json(updated);
});

router.post("/colis/drop-all", (req, res) => {
  const count = dropAll();
  if (count > 0) adjustStock(-count);
  res.json({ ok: true, count, stock: getStock() });
});

router.post("/colis/drop-sender/:name", (req, res) => {
  const count = dropBySender(req.params.name);
  if (count > 0) adjustStock(-count);
  res.json({ ok: true, count, stock: getStock() });
});

router.post("/colis/drop-carrier/:carrier", (req, res) => {
  const count = dropByCarrier(req.params.carrier);
  if (count > 0) adjustStock(-count);
  res.json({ ok: true, count, stock: getStock() });
});

router.post("/colis/quick-add/:sender", (req, res) => {
  const colis = quickAddColis(req.params.sender);
  res.json(colis);
});

router.post("/colis/quick-remove/:sender", (req, res) => {
  const removed = quickRemoveColis(req.params.sender);
  if (!removed) return res.status(404).json({ error: "Aucun colis en attente pour cet expediteur" });
  res.json({ ok: true });
});

router.get("/stock", (req, res) => {
  res.json({ stock: getStock() });
});

router.post("/stock/adjust", (req, res) => {
  const delta = Number(req.body.delta);
  if (Number.isNaN(delta)) return res.status(400).json({ error: "Quantite invalide" });
  res.json({ stock: adjustStock(delta) });
});

router.get("/debts", (req, res) => {
  res.json(getDebtsBySender());
});

router.post("/debts/:sender/pay", (req, res) => {
  const count = markSenderPaid(req.params.sender);
  res.json({ ok: true, count });
});

router.get("/stats/revenue", (req, res) => {
  res.json({ bestDay: getBestDay() || null });
});

router.get("/stats/revenue/daily-series", (req, res) => {
  res.json(getDailySeries());
});

router.get("/stats/revenue/weekly-series", (req, res) => {
  res.json(getWeeklySeries());
});

router.get("/senders", (req, res) => {
  res.json(db.prepare("SELECT * FROM senders ORDER BY name ASC").all());
});

router.get("/senders/merge-candidates", (req, res) => {
  res.json(getMergeCandidates());
});

router.post("/senders/merge-to-other", (req, res) => {
  const ids = Array.isArray(req.body.senderIds) ? req.body.senderIds : [];
  const merged = mergeSendersIntoOther(ids);
  res.json({ ok: true, merged });
});

// --- Notifications push -----------------------------------------------------
router.get("/push/key", (req, res) => {
  res.json({ publicKey: getPublicKey(), devices: countSubscriptions() });
});

router.post("/push/subscribe", (req, res) => {
  const { endpoint, keys, label } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: "Abonnement invalide" });
  }
  saveSubscription({ endpoint, keys, label });
  res.json({ ok: true, devices: countSubscriptions() });
});

router.post("/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "Endpoint manquant" });
  deleteSubscription(endpoint);
  res.json({ ok: true, devices: countSubscriptions() });
});

// Le dashboard signale qu'il est sous les yeux : le "+N" des notifications
// repart de zero a partir de la.
router.post("/push/seen", (req, res) => {
  markPushSeen();
  res.json({ ok: true });
});

router.post("/push/test", async (req, res) => {
  const pending = getPendingSummary();
  const result = await sendToAll({
    title: "+3 colis",
    body: `${pending.count} colis en attente · ${pending.value.toFixed(2)} €`,
    tag: "colis",
    url: "/",
  });
  res.json({ ok: true, ...result });
});

router.post("/senders/merge", (req, res) => {
  const sourceId = Number(req.body.sourceId);
  const targetId = Number(req.body.targetId);
  if (!sourceId || !targetId) return res.status(400).json({ error: "Expéditeurs invalides" });
  try {
    res.json({ ok: true, ...mergeSenderInto(sourceId, targetId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/senders", (req, res) => {
  const name = (req.body.name || "").trim();
  const price = Number(req.body.price);
  const litPrice = req.body.litPrice === undefined ? DEFAULT_LIT_PRICE : Number(req.body.litPrice);
  const bjPrice = req.body.bjPrice === undefined ? price : Number(req.body.bjPrice);
  if (
    !name ||
    Number.isNaN(price) || price < 0 ||
    Number.isNaN(litPrice) || litPrice < 0 ||
    Number.isNaN(bjPrice) || bjPrice < 0
  ) {
    return res.status(400).json({ error: "Nom ou prix invalide" });
  }
  try {
    db.prepare("INSERT INTO senders (name, price, lit_price, bj_price) VALUES (?, ?, ?, ?)").run(
      name,
      price,
      litPrice,
      bjPrice
    );
  } catch (err) {
    return res.status(400).json({ error: "Cet expediteur existe deja" });
  }
  res.json(db.prepare("SELECT * FROM senders WHERE name = ?").get(name));
});

router.put("/senders/:id", (req, res) => {
  const patch = {};
  if (req.body.price !== undefined) {
    const price = Number(req.body.price);
    if (Number.isNaN(price) || price < 0) return res.status(400).json({ error: "Prix invalide" });
    patch.price = price;
  }
  if (req.body.litPrice !== undefined) {
    const litPrice = Number(req.body.litPrice);
    if (Number.isNaN(litPrice) || litPrice < 0) return res.status(400).json({ error: "Prix LIT invalide" });
    patch.litPrice = litPrice;
  }
  if (req.body.bjPrice !== undefined) {
    const bjPrice = Number(req.body.bjPrice);
    if (Number.isNaN(bjPrice) || bjPrice < 0) return res.status(400).json({ error: "Prix BJ invalide" });
    patch.bjPrice = bjPrice;
  }
  const sender = updateSenderPrices(req.params.id, patch);
  if (!sender) return res.status(404).json({ error: "Expediteur introuvable" });
  res.json(sender);
});

router.delete("/senders/:id", (req, res) => {
  db.prepare("DELETE FROM senders WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.get("/config", (req, res) => {
  res.json({ defaultPrice: DEFAULT_PRICE, defaultLitPrice: DEFAULT_LIT_PRICE });
});

module.exports = router;
