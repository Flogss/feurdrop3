const { TRANSPORTEURS: SUIVIS } = require("../suiviColis");

// Comment chaque transporteur peut etre controle, d'apres des essais reels sur
// les numeros de FeurDrop (octobre 2026). Deux methodes :
//
//   "laposte"  automatique, par l'API officielle Suivi v2 de La Poste. Elle
//              suit La Poste, Colissimo et Chronopost -- et aussi les colis
//              DPD France (35 numeros DPD sur 36 reconnus, avec "PC1 Colis
//              depose par l'expediteur") : DPD et Chronopost sont du meme
//              groupe (Geopost).
//   "manuel"   semi-automatique (UPS, DHL...) : le site du transporteur refuse les
//              verifications automatiques et son API officielle demande des
//              identifiants que FeurDrop n'a pas. Le colis attend un constat
//              fait sur la page officielle (lien direct, numero deja saisi).
//
// Aucun contournement : pas de faux navigateur, pas de rotation d'adresses,
// pas de resolution de CAPTCHA. Une protection rencontree = une pause.

const METHODES = {
  LP: { methode: "laposte" },
  CHRONO: { methode: "laposte" },
  DPD: { methode: "laposte" },
  UPS: {
    methode: "manuel",
    raison: "UPS refuse les vérifications automatiques de sa page de suivi (« Access Denied ») ; son API demande un compte développeur : à vérifier sur la page officielle.",
  },
  DHL: {
    methode: "manuel",
    raison: "DHL bloque les vérifications automatiques (« Your tracking attempt has been blocked ») ; son API demande une clé : à vérifier sur la page officielle.",
  },
  FEDEX: {
    methode: "manuel",
    raison: "FedEx n'offre pas de vérification automatique sans compte développeur : à vérifier sur la page officielle.",
  },
  GLS: {
    methode: "manuel",
    raison: "GLS n'offre pas de vérification automatique sans compte client : à vérifier sur la page officielle.",
  },
};

// Transporteurs hors du controle : leurs colis ne sont que comptes.
// Mondial Relay : son API Webservice officielle (WSI2_TracingColisDetaille),
// essayee avec un vrai compte enseigne (octobre 2026), ne suit que les
// expeditions creees par CETTE enseigne -- les numeros FeurDrop sont refuses
// (STAT 24, ou STAT 99 a 8 chiffres) -- et son site refuse les requetes
// automatiques (Cloudflare). Rien de fiable a lire : il n'est pas controle.
const NON_CONTROLES = {
  MR: "Mondial Relay n'est pas contrôlé : aucune vérification automatique possible.",
};

const INCONNU = { methode: "manuel", raison: "Transporteur sans vérification automatique : à vérifier sur la page officielle." };

/** { code, nom, methode, raison, lien(numero), page } */
function transporteur(code) {
  const m = METHODES[code] || INCONNU;
  const suivi = SUIVIS[code];
  return {
    code,
    nom: suivi?.nom || code || "Inconnu",
    methode: m.methode,
    raison: m.raison || null,
    lien: (numero) => (suivi?.lien ? suivi.lien(encodeURIComponent(numero)) : suivi?.page || null),
    page: suivi?.page || null,
  };
}

const METHODES_AUTOMATIQUES = { laposte: { nom: "API La Poste (officielle)" } };

module.exports = { transporteur, METHODES, METHODES_AUTOMATIQUES, NON_CONTROLES };
