const crypto = require("crypto");
const express = require("express");
const { portailPour, portailExiste } = require("../portail");
const { PAGE, ENTETES, ENTETES_PAGE, limiteur } = require("../portailCommun");

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

// Tout le reste sous /api/portail n'existe pas.
router.use((req, res) => res.status(404).json({ error: "Introuvable" }));

// La page sur le serveur du dashboard (/expediteur/<jeton>) : seulement en
// local, quand aucun domaine de portail n'est configure (PORTAIL_URL).
function pagePortail(req, res) {
  res.set(ENTETES_PAGE);
  if (essais.bloque(req.ip)) return res.status(429).sendFile(PAGE);
  const valide = portailExiste(req.params.jeton);
  if (!valide) essais.echec(req.ip);
  res.status(valide ? 200 : 404).sendFile(PAGE);
}

module.exports = { router, pagePortail };
