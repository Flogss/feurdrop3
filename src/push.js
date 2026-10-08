const webpush = require("web-push");
const {
  getSetting,
  setSetting,
  listSubscriptions,
  deleteSubscription,
  countSubscriptions,
  getPendingSummary,
  summarizeNewColis,
  setPushAnnounced,
} = require("./db");

// "10,50 €", "1 893,00 €"
const euros = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const euro = (v) => euros.format(Number(v) || 0);

// "1 h 12", "34 min"
function duree(secondes) {
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
  return `${Math.max(1, m)} min`;
}

// "boxingmaestro ×2 · SRBOXING ×1 · +2 autres"
function ligneExpediteurs(senders) {
  const tete = senders.slice(0, 3).map((s) => (s.count > 1 ? `${s.name} ×${s.count}` : s.name));
  const reste = senders.length - 3;
  if (reste > 0) tete.push(`+${reste} autre${reste > 1 ? "s" : ""}`);
  return tete.join(" · ");
}

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
// `payload` : le meme message pour tous, ou une fonction qui compose celui de
// chaque appareil (et rend null pour ne rien lui envoyer).
async function sendToAll(payload) {
  const subs = listSubscriptions();
  if (subs.length === 0) return { sent: 0, removed: 0 };

  let sent = 0;
  let removed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      const message = typeof payload === "function" ? payload(sub) : payload;
      if (!message) return;
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(message), { TTL: 3600, urgency: "high" });
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

// Notification "nouveaux colis" : l'equivalent du son de vente Shopify.
// Chaque appareil recoit SON compte : les colis arrives depuis la derniere
// fois que cet appareil a regarde le dashboard (pas depuis la derniere
// notification envoyee, ni depuis qu'un autre appareil a regarde). Une seule
// notification par appareil, remplacee a chaque nouveau lot (meme tag) :
//   +3 nouveaux colis      puis      +5 nouveaux colis
//   10,50 € · boxingmaestro ×2 · SRBOXING
//   45 à dropper · 185,50 €
function messageNouveauxColis(recap, pending) {
  if (!recap || recap.count <= 0) return null;
  return {
    title: titreNouveauxColis(recap.count),
    body: [
      [euro(recap.value), ligneExpediteurs(recap.senders)].filter(Boolean).join(" · "),
      `${pending.count} à dropper · ${euro(pending.value)}`,
    ].join("\n"),
    tag: "colis",
    url: "/",
  };
}

function titreNouveauxColis(n) {
  return n > 1 ? `+${n} nouveaux colis` : "+1 nouveau colis";
}

async function notifyNewColis({ count }) {
  const pending = getPendingSummary();
  const annonces = new Map();
  try {
    await sendToAll((sub) => {
      const recap = summarizeNewColis(sub.seenAt ? { since: sub.seenAt } : { dernier: count });
      // pas de hausse pour CET appareil : sa notification dit deja tout
      if (recap.count <= (sub.announced || 0)) {
        if (recap.count < sub.announced) annonces.set(sub.endpoint, recap.count);
        return null;
      }
      annonces.set(sub.endpoint, recap.count);
      return messageNouveauxColis(recap, pending);
    });
  } catch (err) {
    console.error("[push] notifyNewColis", err.message);
  }
  for (const [endpoint, n] of annonces) setPushAnnounced(endpoint, n);
}

// Depart en tournee : ce qu'on emporte (le sac, pas tout ce qui attend).
function notifyTourStart(sac = getPendingSummary()) {
  return sendToAll({
    title: `🚚 En tournée · ${euro(sac.value)}`,
    body: `${sac.count} colis dans le sac`,
    tag: "tour",
    url: "/",
  }).catch((err) => console.error("[push] notifyTourStart", err.message));
}

// Retour de tournee : ce qu'elle a rapporte, et a quel rythme.
function notifyTourEnd({ count, value, seconds, smicHourly }) {
  const taux = seconds > 0 ? (value * 3600) / seconds : 0;
  const detail = [`${count} colis dropé${count > 1 ? "s" : ""}${seconds > 0 ? ` en ${duree(seconds)}` : ""}`];
  if (seconds > 0) {
    detail.push(`${euro(taux)}/h`);
    if (smicHourly > 0) detail.push(`${(taux / smicHourly).toFixed(1).replace(".", ",")}× le SMIC`);
  }
  return sendToAll({
    title: `✅ Tournée terminée · ${euro(value)}`,
    body: detail.join(" · "),
    tag: "tour",
    url: "/",
  }).catch((err) => console.error("[push] notifyTourEnd", err.message));
}

module.exports = { getPublicKey, sendToAll, notifyNewColis, notifyTourStart, notifyTourEnd, countSubscriptions, euro, titreNouveauxColis };
