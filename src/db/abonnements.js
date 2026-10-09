// Abonnements aux notifications push : un appareil chacun, avec son "vu le".
const { db } = require("./connexion");

// Cet appareil vient de regarder le dashboard : son "+N" repart de zero. Les
// autres appareils gardent le leur. Sert aussi a cumuler : tant que cet
// appareil n'a pas regarde, le "+N" compte tous les colis arrives depuis, pas
// seulement le dernier lot.
function markPushSeen(endpoint) {
  if (!endpoint) return 0;
  return db
    .prepare("UPDATE push_subscriptions SET seen_at = datetime('now'), announced = 0 WHERE endpoint = ?")
    .run(endpoint).changes;
}

// Le "+N" que cet appareil affiche desormais.
function setPushAnnounced(endpoint, count) {
  db.prepare("UPDATE push_subscriptions SET announced = ? WHERE endpoint = ?").run(count, endpoint);
}

// --- Notifications push (PWA iOS/Android) -----------------------------------
// Un abonnement = un appareil. iOS peut le revoquer silencieusement, donc le
// client se reabonne a chaque ouverture et on supprime les endpoints morts
// des que le service de push repond 404/410.
function saveSubscription({ endpoint, keys, label }) {
  // un nouvel appareil part de maintenant ; un appareil qui se reabonne
  // garde son "vu le"
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, seen_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       label = COALESCE(excluded.label, push_subscriptions.label),
       last_seen_at = datetime('now')`
  ).run(endpoint, keys.p256dh, keys.auth, label || null);
}

function deleteSubscription(endpoint) {
  return db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes;
}

function listSubscriptions() {
  return db
    .prepare("SELECT endpoint, p256dh, auth, seen_at, announced FROM push_subscriptions")
    .all()
    .map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth }, seenAt: r.seen_at, announced: r.announced }));
}

function countSubscriptions() {
  return db.prepare("SELECT COUNT(*) AS c FROM push_subscriptions").get().c;
}

module.exports = {
  markPushSeen,
  setPushAnnounced,
  saveSubscription,
  deleteSubscription,
  listSubscriptions,
  countSubscriptions,
};
