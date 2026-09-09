const webpush = require("web-push");
const {
  getSetting,
  setSetting,
  listSubscriptions,
  deleteSubscription,
  countSubscriptions,
  countColisSince,
  getPendingSummary,
} = require("./db");

// Les cles VAPID identifient le serveur aupres d'Apple/Google. On les prend
// dans l'environnement si elles y sont, sinon on en genere une paire au
// premier demarrage et on la garde en base (le volume Railway est persistant).
// Changer ces cles invalide tous les abonnements existants, d'ou le stockage.
function loadVapidKeys() {
  const fromEnv = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY;
  if (fromEnv) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }

  const publicKey = getSetting("vapid_public_key", null);
  const privateKey = getSetting("vapid_private_key", null);
  if (publicKey && privateKey) return { publicKey, privateKey };

  const generated = webpush.generateVAPIDKeys();
  setSetting("vapid_public_key", generated.publicKey);
  setSetting("vapid_private_key", generated.privateKey);
  console.log("[push] nouvelles cles VAPID generees et sauvegardees en base");
  return generated;
}

const keys = loadVapidKeys();
// Apple et Google exigent un contact (mailto: ou https://) dans le JWT, sinon
// ils refusent le push. Une URL du site fait l'affaire, pas besoin d'e-mail.
const CONTACT = process.env.PUSH_CONTACT || "https://feurdrop3-production.up.railway.app";
webpush.setVapidDetails(CONTACT, keys.publicKey, keys.privateKey);

function getPublicKey() {
  return keys.publicKey;
}

// Envoie une notification a tous les appareils abonnes. Les endpoints que le
// service de push declare morts (404/410) sont supprimes : sur iOS un
// abonnement est revoque des que l'icone est retiree de l'ecran d'accueil.
async function sendToAll(payload) {
  const subs = listSubscriptions();
  if (subs.length === 0) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, { TTL: 3600, urgency: "high" });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          deleteSubscription(sub.endpoint);
          removed += 1;
        } else {
          console.error("[push] echec envoi", err.statusCode || "", err.message);
        }
      }
    })
  );

  return { sent, removed };
}

// Notification "nouveaux colis" : c'est l'equivalent du son de vente Shopify.
// Volontairement minimale : le nombre de colis arrives depuis la derniere fois
// que le site a ete ouvert, puis le total en attente et sa valeur.
// Le "+N" se cumule : si trois colis arrivent un par un sans qu'on ouvre le
// dashboard, la troisieme notification affiche +3 et remplace les precedentes
// (meme tag).
function notifyNewColis({ count }) {
  const pending = getPendingSummary();
  const since = countColisSince(getSetting("push_seen_at", null));
  const added = since ? since.count : count;

  return sendToAll({
    title: `+${added} colis`,
    body: `${pending.count} colis en attente · ${pending.value.toFixed(2)} €`,
    tag: "colis",
    url: "/",
  }).catch((err) => console.error("[push] notifyNewColis", err.message));
}

// Depart en tournee : rappel de ce qu'on emporte.
function notifyTourStart() {
  const pending = getPendingSummary();
  return sendToAll({
    title: `🚚 ${pending.value.toFixed(2)} € en cours de drop`,
    body: `${pending.count} colis dans le sac`,
    tag: "tour",
    url: "/",
  }).catch((err) => console.error("[push] notifyTourStart", err.message));
}

module.exports = { getPublicKey, sendToAll, notifyNewColis, notifyTourStart, countSubscriptions };
