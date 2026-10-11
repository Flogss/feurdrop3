const { TRANSPORTEURS: SUIVIS } = require("../suiviColis");

// Comment chaque transporteur est controle, d'apres des essais reels sur les
// numeros de FeurDrop et la lecture de leurs conditions d'utilisation
// (octobre 2026). Trois methodes :
//
//   "laposte"     automatique, sur le serveur, par l'API officielle Suivi v2
//                 de La Poste : La Poste, Colissimo, boites jaunes, Chronopost
//                 -- et DPD France (meme groupe, Geopost : 35 numeros DPD sur
//                 36 reconnus).
//   "navigateur"  automatique, sur le Mac : l'app Drop ouvre la page de suivi
//                 officielle dans WebKit (le moteur de Safari), depuis la
//                 connexion du Mac, une page a la fois, et envoie le texte
//                 affiche au serveur qui le lit (controle/pages.js). Essaye :
//                 Mondial Relay, DHL, FedEx et GLS s'affichent normalement
//                 (une requete du serveur, elle, recoit « Access Denied » ou
//                 un defi Cloudflare). Aucune de leurs conditions lues
//                 n'interdit cette consultation (celles d'InPost/Mondial Relay
//                 interdisent l'automatisation de leur « Application », c.-a-d.
//                 l'app avec compte, pas la page publique de suivi). Un
//                 interrupteur par transporteur permet de la couper.
//   "manuel"      la page officielle s'ouvre, on note ce qu'on voit : UPS, dont
//                 les conditions interdisent expressement « les systemes
//                 d'interrogation automatises » de son suivi.
//
// Aucun contournement : pas de faux navigateur, pas de rotation d'adresses,
// pas de resolution de CAPTCHA. Une protection rencontree = arret et pause ;
// la page reste a ouvrir a la main.

const METHODES = {
  LP: { methode: "laposte" },
  CHRONO: { methode: "laposte" },
  DPD: { methode: "laposte" },
  MR: { methode: "navigateur" },
  DHL: { methode: "navigateur" },
  FEDEX: { methode: "navigateur" },
  GLS: { methode: "navigateur" },
  UPS: {
    methode: "manuel",
    raison: "Les conditions d'utilisation d'UPS interdisent toute consultation automatisée de son suivi : la page officielle s'ouvre, tu notes ce que tu vois.",
  },
};

// Plus aucun transporteur hors controle (Mondial Relay est lu sur le Mac).
const NON_CONTROLES = {};

const INCONNU = { methode: "manuel", raison: "Transporteur sans vérification automatique : à vérifier sur la page officielle." };

// L'adresse que lit le Mac : le suivi officiel, numero deja saisi.
const PAGES = {
  // GLS renvoie vers sa page de groupe, en anglais : on y va directement
  GLS: (n) => `https://gls-group.eu/FR/fr/suivi-colis?match=${n}`,
};

/** { code, nom, methode, raison, lien(numero), page, pageLue(numero) } */
function transporteur(code, { lectureCoupee = [] } = {}) {
  const base = METHODES[code] || INCONNU;
  // le Mac ne lit pas ce transporteur (interrupteur coupe) : a la main
  const coupe = base.methode === "navigateur" && lectureCoupee.includes(code);
  const m = coupe ? { methode: "manuel", raison: "Lecture automatique coupée dans les réglages du contrôle : à vérifier sur la page officielle." } : base;
  const suivi = SUIVIS[code];
  const lien = (numero) => (suivi?.lien ? suivi.lien(encodeURIComponent(numero)) : suivi?.page || null);
  return {
    code,
    nom: suivi?.nom || code || "Inconnu",
    methode: m.methode,
    raison: m.raison || null,
    lien,
    page: suivi?.page || null,
    pageLue: (numero) => (PAGES[code] ? PAGES[code](encodeURIComponent(numero)) : lien(numero)),
    lisible: base.methode === "navigateur",
  };
}

const METHODES_AUTOMATIQUES = {
  laposte: { nom: "API La Poste (officielle)" },
  navigateur: { nom: "Page officielle lue par l'app Drop sur le Mac" },
};

// Les transporteurs que le Mac sait lire (pour les reglages).
const LISIBLES = Object.entries(METHODES)
  .filter(([, m]) => m.methode === "navigateur")
  .map(([code]) => code);

module.exports = { transporteur, METHODES, METHODES_AUTOMATIQUES, NON_CONTROLES, LISIBLES };
