const { TRANSPORTEURS: SUIVIS } = require("../suiviColis");
const ups = require("./ups");
const dhl = require("./dhl");

// Comment chaque transporteur est controle (octobre 2026), d'apres des essais
// reels et la lecture de leurs conditions d'utilisation. Toujours la methode
// officielle quand elle existe :
//
//   "laposte"     API officielle Suivi v2 de La Poste, sur le serveur : La
//                 Poste, Colissimo, boites jaunes, Chronopost et DPD France
//                 (meme groupe) -- en production depuis octobre.
//   "ups"         API officielle UPS Tracking, sur le serveur, des que
//                 UPS_CLIENT_ID / UPS_CLIENT_SECRET sont poses. Sans eux : a
//                 la main (« manuel ») -- les conditions d'UPS interdisent la
//                 lecture automatisee de son site.
//   "dhl"         API officielle DHL (DHL_API_KEY), sur le serveur. Sans cle :
//                 la page officielle, lue par le Mac.
//   "navigateur"  la page officielle, lue par l'app Drop du Mac depuis sa
//                 connexion (WebKit, un profil garde, une page a la fois) :
//                 Mondial Relay et GLS (pas d'API ouverte), DHL sans cle.
//                 Essaye : les pages s'affichent ; aucune de leurs conditions
//                 lues n'interdit cette consultation. Un interrupteur par
//                 transporteur permet de la couper.
//   "manuel"      la page officielle s'ouvre, on note ce qu'on voit.
//
// Aucun contournement : pas de faux navigateur, pas de rotation d'adresses,
// pas de resolution de CAPTCHA. Une protection rencontree = arret et pause.

const BASES = {
  LP: { methode: "laposte" },
  CHRONO: { methode: "laposte" },
  DPD: { methode: "laposte" },
  MR: { methode: "navigateur" },
  GLS: { methode: "navigateur" },
};

const RAISON_UPS = "UPS n'est pas automatisé : ses conditions interdisent la lecture automatisée de son site, et son API officielle demande des identifiants (UPS_CLIENT_ID / UPS_CLIENT_SECRET) pas encore posés. La page officielle s'ouvre, tu notes ce que tu vois.";

function methodeDe(code) {
  if (code === "UPS") return ups.estConfigure() ? { methode: "ups" } : { methode: "manuel", raison: RAISON_UPS };
  if (code === "DHL") return dhl.estConfigure() ? { methode: "dhl" } : { methode: "navigateur" };
  return BASES[code] || { methode: "manuel", raison: "Transporteur sans vérification automatique : à vérifier sur la page officielle." };
}

// Plus aucun transporteur hors controle.
const NON_CONTROLES = {};

// L'adresse que lit le Mac : le suivi officiel, numero deja saisi.
const PAGES = {
  // GLS renvoie vers sa page de groupe, en anglais : on y va directement
  GLS: (n) => `https://gls-group.eu/FR/fr/suivi-colis?match=${n}`,
};

// Le rythme de chaque site lu par le Mac : une personne, pas un robot.
const RYTHMES = { MR: 3000, GLS: 3500, DHL: 4000 };

/** { code, nom, methode, raison, lien(numero), page, pageLue(numero), lisible, rythmeMs } */
function transporteur(code, { lectureCoupee = [] } = {}) {
  const base = methodeDe(code);
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
    rythmeMs: RYTHMES[code] || 3000,
  };
}

const METHODES_AUTOMATIQUES = {
  laposte: { nom: "API La Poste (officielle)" },
  ups: { nom: "API UPS (officielle)" },
  dhl: { nom: "API DHL (officielle)" },
  navigateur: { nom: "Page officielle lue par l'app Drop sur le Mac" },
};

// Les transporteurs que le Mac sait lire (pour les reglages).
const LISIBLES = ["MR", "GLS", "DHL"];

module.exports = { transporteur, METHODES_AUTOMATIQUES, NON_CONTROLES, LISIBLES, RYTHMES };
