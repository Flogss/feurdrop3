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
} = require("../db");

const router = express.Router();

router.get("/stats", (req, res) => {
  const pending = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending'")
    .get();
  const dropped = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'dropped'")
    .get();
  const today = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis
       WHERE status = 'dropped' AND date(dropped_at) = date('now')`
    )
    .get();
  const bySender = db
    .prepare(
      `SELECT sender_name,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
              SUM(CASE WHEN status = 'pending' THEN price ELSE 0 END) AS pending_value,
              SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) AS dropped_count,
              SUM(CASE WHEN status = 'dropped' THEN price ELSE 0 END) AS dropped_value
       FROM colis GROUP BY sender_name ORDER BY pending_count DESC`
    )
    .all();
  const litPending = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending' AND type = 'lit'")
    .get();
  const bjPending = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS value FROM colis WHERE status = 'pending' AND type = 'bj'")
    .get();

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
  });
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
  const info = db
    .prepare("UPDATE colis SET status = 'dropped', dropped_at = datetime('now') WHERE status = 'pending'")
    .run();
  if (info.changes > 0) adjustStock(-info.changes);
  res.json({ ok: true, count: info.changes, stock: getStock() });
});

router.post("/colis/drop-sender/:name", (req, res) => {
  const info = db
    .prepare(
      "UPDATE colis SET status = 'dropped', dropped_at = datetime('now') WHERE status = 'pending' AND sender_name = ?"
    )
    .run(req.params.name);
  if (info.changes > 0) adjustStock(-info.changes);
  res.json({ ok: true, count: info.changes, stock: getStock() });
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

router.post("/senders", (req, res) => {
  const name = (req.body.name || "").trim();
  const price = Number(req.body.price);
  const litPrice = req.body.litPrice === undefined ? DEFAULT_LIT_PRICE : Number(req.body.litPrice);
  if (!name || Number.isNaN(price) || price < 0 || Number.isNaN(litPrice) || litPrice < 0) {
    return res.status(400).json({ error: "Nom ou prix invalide" });
  }
  try {
    db.prepare("INSERT INTO senders (name, price, lit_price) VALUES (?, ?, ?)").run(name, price, litPrice);
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
