const crypto = require("crypto");
const express = require("express");
const { portailPour, portailExiste, actualisePortail, etatActualisationPortail, redropPortail, statsPortail } = require("../portail");
const { pageHtml, ENTETES, ENTETES_PAGE, limiteur } = require("../portailCommun");
const { suiviDuColis } = require("../suiviColis");
const { heureParis } = require("../dates");
const { AUTO_GROUP_CHAT_ID } = require("../bot/config");
const { ecritureGroupe, escapeHtml } = require("../bot/outils");

// Les colis d'un espace expediteur, sans connexion : le jeton est la cle.
// Rien ici ne touche au dashboard -- seulement les colis que le jeton designe.
//
// En ligne, l'expediteur ne vient jamais ici : sa page est servie par le
// service du portail, sur son propre domaine (voir portailSeul.js), qui
// demande ces colis par le reseau prive de Railway.

const router = express.Router();

// 30 liens faux par quart d'heure et par adresse, puis plus rien jusqu'a la
// fin du quart d'heure.
const essais = limiteur({ fenetreMs: 15 * 60 * 1000, max: 30 });

// GET /api/portail/<jeton>?n=60 : les colis de l'expediteur, et rien d'autre.
// La reponse porte une empreinte (ETag) : tant que rien ne bouge, le
// rafraichissement automatique recoit un 304 vide.
router.get("/:jeton", (req, res) => {
  res.set(ENTETES);
  if (essais.bloque(req.ip)) return res.status(429).json({ error: "Trop d'essais. Réessaie dans un quart d'heure." });
  const donnees = portailPour(req.params.jeton, { nombre: req.query.n });
  if (!donnees) {
    essais.echec(req.ip);
    return res.status(404).json({ error: "Ce lien n'est pas valide, ou n'est plus actif." });
  }
  const corps = JSON.stringify(donnees);
  const etag = `"${crypto.createHash("sha1").update(corps).digest("base64url")}"`;
  res.set("ETag", etag);
  if (req.get("if-none-match") === etag) return res.status(304).end();
  res.type("application/json").send(corps);
});

// « Actualiser statuts La Poste » : lance la relecture (en fond) des colis La
// Poste de cet expediteur, puis sa progression. Le jeton designe l'expediteur ;
// rien d'autre n'est lu ni renvoye.
router.post("/:jeton/actualisation", (req, res) => {
  res.set(ENTETES);
  if (essais.bloque(req.ip)) return res.status(429).json({ error: "Trop d'essais. Réessaie dans un quart d'heure." });
  const etat = actualisePortail(req.params.jeton);
  if (!etat) {
    essais.echec(req.ip);
    return res.status(404).json({ error: "Ce lien n'est pas valide, ou n'est plus actif." });
  }
  res.status(etat.refuse ? 429 : 202).json(etat);
});

router.get("/:jeton/actualisation", (req, res) => {
  res.set(ENTETES);
  const etat = etatActualisationPortail(req.params.jeton);
  if (!etat) return res.status(404).json({ error: "Ce lien n'est pas valide, ou n'est plus actif." });
  res.json(etat);
});

// --- Redrop demande par l'expediteur ------------------------------------------------
// Le colis repasse « à imprimer » a 0 €, et le groupe Telegram est prevenu
// (dans le topic General par defaut : REDROP_TOPIC_ID, le nombre a la fin du
// lien t.me/c/<groupe>/<N> ; 1 = General).
const TOPIC_REDROP = () => Number(process.env.REDROP_TOPIC_ID || 1);

const FORMAT_JOUR = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" });

function messageRedrop({ origine, colis, expediteur }) {
  const suivi = suiviDuColis(origine);
  const fichier = origine.file_name || (suivi ? `${suivi.numero}.pdf` : `colis #${origine.id}`);
  const drop = origine.dropped_at ? `${FORMAT_JOUR.format(new Date(`${origine.dropped_at.replace(" ", "T")}Z`))} à ${heureParis(origine.dropped_at)}` : null;
  return [
    "♻️ <b>Redrop demandé</b>",
    "",
    `📄 <code>${escapeHtml(fichier)}</code> à redrop`,
    `👤 par <b>${escapeHtml(expediteur)}</b>`,
    suivi ? `🚚 ${escapeHtml(suivi.nom)} · <code>${escapeHtml(suivi.numero)}</code>` : null,
    drop ? `📦 déjà dropé ${escapeHtml(drop)}` : null,
    "",
    `🖨 De nouveau <b>à imprimer</b> · prix <b>0 €</b>${colis.type === "bj" ? " · boîte jaune" : ""}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

async function annonceRedrop(infos) {
  const bot = require("../bot").getBot();
  if (!bot) return;
  const topic = TOPIC_REDROP();
  const envoie = (avecTopic) =>
    ecritureGroupe(
      () =>
        bot.sendMessage(AUTO_GROUP_CHAT_ID, messageRedrop(infos), {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(avecTopic && topic > 1 ? { message_thread_id: topic } : {}),
        }),
      { envoi: true }
    );
  try {
    await envoie(true);
  } catch (err) {
    // un topic disparu : le message part quand meme, dans General
    if (topic > 1 && /thread/i.test(err.message)) await envoie(false).catch(() => {});
    else console.error("[portail] annonce du redrop impossible :", err.message);
  }
}

router.post("/:jeton/redrop", (req, res) => {
  res.set(ENTETES);
  if (essais.bloque(req.ip)) return res.status(429).json({ error: "Trop d'essais. Réessaie dans un quart d'heure." });
  const r = redropPortail(req.params.jeton, req.body?.ref);
  if (r.introuvable) {
    essais.echec(req.ip);
    return res.status(404).json({ error: "Ce lien n'est pas valide, ou n'est plus actif." });
  }
  if (r.erreur) return res.status(r.status || 400).json({ error: r.erreur });
  if (!r.deja) {
    console.log(`[portail] redrop demandé par ${r.expediteur} : colis ${r.origine.id} -> ${r.colis.id}, à imprimer, 0 €`);
    annonceRedrop(r).catch(() => {});
  }
  res.json({ ok: true, deja: r.deja, colis: r.vue });
});

// Les stats de l'expediteur : des nombres de colis, jamais d'argent.
router.get("/:jeton/stats", (req, res) => {
  res.set(ENTETES);
  if (essais.bloque(req.ip)) return res.status(429).json({ error: "Trop d'essais. Réessaie dans un quart d'heure." });
  const stats = statsPortail(req.params.jeton);
  if (!stats) {
    essais.echec(req.ip);
    return res.status(404).json({ error: "Ce lien n'est pas valide, ou n'est plus actif." });
  }
  const corps = JSON.stringify(stats);
  const etag = `"${crypto.createHash("sha1").update(corps).digest("base64url")}"`;
  res.set("ETag", etag);
  if (req.get("if-none-match") === etag) return res.status(304).end();
  res.type("application/json").send(corps);
});

// Tout le reste sous /api/portail n'existe pas.
router.use((req, res) => res.status(404).json({ error: "Introuvable" }));

// La page sur le serveur du dashboard (/expediteur/<jeton>) : seulement en
// local, quand aucun domaine de portail n'est configure (PORTAIL_URL).
function pagePortail(req, res) {
  res.set(ENTETES_PAGE);
  if (essais.bloque(req.ip)) return res.status(429).type("html").send(pageHtml());
  const valide = portailExiste(req.params.jeton);
  if (!valide) essais.echec(req.ip);
  res.status(valide ? 200 : 404).type("html").send(pageHtml());
}

module.exports = { router, pagePortail, messageRedrop };
