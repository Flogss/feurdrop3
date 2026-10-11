// La seule question du controle : le transporteur a-t-il reellement pris en
// charge ce colis, oui ou non ?
//
// Fonction pure : le colis (statut et dates FeurDrop), son suivi, ses
// evenements (deja traduits : API La Poste, page lue sur le Mac, constat fait
// a la main) -> un des quatre statuts, et son explication.
//
//   confirme      « Posté confirmé » : un evenement PHYSIQUE prouve que le
//                 transporteur a eu le colis (depose, pris en charge, en
//                 transit, en point relais, livre... ou un retour : on ne
//                 retourne que ce qu'on a eu). Ce qui arrive ENSUITE (retour,
//                 « mis a disposition du vendeur », souci de livraison) reste
//                 consultable dans le detail, sans alerte : le depot, lui, est
//                 prouve et ne se defait jamais.
//   non_confirme  « Non confirmé » : le transporteur ne connait que
//                 l'etiquette ou les informations electroniques.
//   a_verifier    « À vérifier » : pas encore lu, numero inconnu ou ambigu,
//                 page illisible, lecture en echec -- pas assez pour conclure.
//   bloque        « Vérification bloquée » : le site refuse la consultation
//                 automatique (protection, pause) ou impose une verification
//                 a la main (UPS). Ce n'est JAMAIS « non deposé ».
//
// Regles : jamais « confirme » sans un evenement physique date ; un code ou
// un libelle inconnu ne prouve rien ; une erreur reseau ou un CAPTCHA ne
// disent rien du colis. Un scan physique ANTERIEUR a la reception de
// l'etiquette compte aussi (boites jaunes deja passees en point relais), et
// la raison le dit.

const { jourParis, ajouteJours, jourDeLaSemaine } = require("../dates");

const LIBELLES = {
  confirme: "Posté confirmé",
  non_confirme: "Non confirmé",
  a_verifier: "À vérifier",
  bloque: "Vérification bloquée",
};

const ETAPES_FR = {
  info_received: "Étiquette créée",
  in_transit: "Pris en charge / en transit",
  out_for_delivery: "En cours de livraison",
  available_for_pickup: "Disponible au retrait",
  delivered: "Livré",
  exception: "Suite après prise en charge",
  unknown: "Statut non reconnu",
};

const HEURE = 3600 * 1000;
// "Avant la reception de l'etiquette" : les dates portent leur fuseau, la
// marge ne couvre que les ecarts d'horloge.
const MARGE_ANCIEN = 2 * HEURE;

const PREUVE_FR = {
  in_transit: "Pris en charge",
  out_for_delivery: "En cours de livraison",
  available_for_pickup: "En point de retrait",
  exception: "Pris en charge (suite : retour ou souci)",
};
const CONSTAT_PERIME = 24 * HEURE; // un "pas encore" constate a la main est a refaire le lendemain
const SOURCES_FR = { laposte: "API La Poste", navigateur: "page officielle lue sur le Mac", manuel: "constat à la main" };

const sqlVersMs = (s) => (s ? Date.parse(`${String(s).replace(" ", "T")}Z`) : null);

function versMs(texte) {
  if (!texte) return null;
  const ms = Date.parse(texte);
  return Number.isNaN(ms) ? null : ms;
}

// Le delai normal pour qu'un premier scan remonte, sans compter les dimanches.
function enRetard(depuisMs, maintenantMs, delaiHeures) {
  if (!depuisMs) return false;
  let dimanches = 0;
  for (let j = jourParis(depuisMs), fin = jourParis(maintenantMs); j <= fin && dimanches < 60; j = ajouteJours(j, 1)) {
    if (jourDeLaSemaine(j) === 0) dimanches += 1;
  }
  return maintenantMs - depuisMs - dimanches * 24 * HEURE > delaiHeures * HEURE;
}

const heureLisible = (ms) =>
  ms == null
    ? "?"
    : new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ms);

function decrit(e) {
  if (!e) return null;
  return {
    le: e.survenuLe,
    ms: e.ms,
    statut: e.libelle || ETAPES_FR[e.etape] || e.code || "—",
    lieu: e.lieu || null,
    etape: e.etape || null,
    code: e.code || null,
    source: e.source || null,
  };
}

/**
 * colis        { status, created_at, dropped_at } (dates UTC de la base)
 * suivi        la ligne controle_suivis, ou null (jamais verifie)
 * evenements   [{ survenuLe, code, libelle, lieu, etape, physique, incident, resolu, ordre, source }]
 * transporteur { methode: "laposte"|"navigateur"|"manuel", nom, raison }
 * pause        la pause en cours de la methode ({ jusqua, motif }) ou null
 * configure    la methode automatique a-t-elle ce qu'il lui faut ?
 */
function analyseDepot({ colis, suivi = null, evenements = [], transporteur, pause = null, configure = true, maintenant = Date.now(), delaiHeures = 48 }) {
  const recuMs = sqlVersMs(colis.created_at);
  const dropeMs = sqlVersMs(colis.dropped_at);
  const seuilAncien = recuMs != null ? recuMs - MARGE_ANCIEN : null;

  const tous = evenements
    .map((e) => ({ ...e, ms: versMs(e.survenuLe) }))
    .sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || (b.ordre ?? 0) - (a.ordre ?? 0));
  const ancien = (e) => seuilAncien != null && e.ms != null && e.ms < seuilAncien;
  // le constat manuel le plus recent fait foi parmi les constats
  const dernierConstat = tous.find((e) => e.source === "manuel") || null;
  const lusTransporteur = tous.filter((e) => e.source !== "manuel");
  const retenus = [...lusTransporteur, ...(dernierConstat ? [dernierConstat] : [])].sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity));

  const dernier = decrit(lusTransporteur[0] || null);
  const livre = lusTransporteur.some((e) => e.etape === "delivered" && !e.incident);
  const commun = {
    dernierEvenement: dernier,
    dernierStatut: dernier ? { etape: dernier.etape, libelle: ETAPES_FR[dernier.etape] || "Statut non reconnu" } : null,
    constat: dernierConstat ? { resultat: dernierConstat.code, le: dernierConstat.survenuLe, par: dernierConstat.par || null } : null,
    livre,
    suite: null,
  };
  const retard = enRetard(dropeMs, maintenant, delaiHeures);
  const depuis = dropeMs ? Math.max(0, Math.round((maintenant - dropeMs) / HEURE)) : null;
  const resultat = (categorie, raison, extra = {}) => ({ categorie, libelle: LIBELLES[categorie], raison, enRetard: false, preuve: null, ...commun, ...extra });

  // --- preuve physique : le depot est prouve, et le reste --------------------------
  const preuves = retenus.filter((e) => e.ms != null && e.physique).sort((a, b) => a.ms - b.ms || (a.ordre ?? 0) - (b.ordre ?? 0));
  if (preuves.length) {
    const p = preuves.find((e) => e.etape !== "delivered" && e.etape !== "exception") || preuves.find((e) => e.etape !== "delivered") || preuves[0];
    const preuve = decrit(p);
    // la suite : le dernier evenement notable apres la prise en charge (retour,
    // disponible chez le vendeur, souci, livraison) -- pour le detail, sans alerte
    const apres = retenus.find((e) => e.ms != null && e.ms > p.ms && (e.incident || ["delivered", "available_for_pickup", "exception"].includes(e.etape)));
    const suite = apres ? { libelle: apres.libelle || ETAPES_FR[apres.etape], le: apres.survenuLe, etape: apres.etape, retour: Boolean(apres.incident) } : null;
    if (p.source === "manuel") return resultat("confirme", `Prise en charge constatée à la main sur la page officielle le ${heureLisible(p.ms)}.`, { preuve, suite });
    const seulementLivre = preuves.every((e) => e.etape === "delivered");
    const avant = ancien(p) ? ` (scan antérieur à la réception de l'étiquette, le ${heureLisible(recuMs)})` : "";
    const ou = p.source && p.source !== "laposte" ? ` — ${SOURCES_FR[p.source] || p.source}` : "";
    const raison = seulementLivre
      ? `Livré le ${heureLisible(preuve.ms)}${avant} : aucun scan de prise en charge n'est remonté avant la livraison, mais le colis a bien circulé${ou}.`
      : `${PREUVE_FR[preuve.etape] || "Scan"} le ${heureLisible(preuve.ms)}${avant} : « ${preuve.statut} »${preuve.lieu ? ` (${preuve.lieu})` : ""}${ou}.`;
    return resultat("confirme", raison, { preuve, suite });
  }

  // --- constats a la main sans preuve -------------------------------------------------
  if (dernierConstat && dernierConstat.code === "MANUEL_PAS_ENCORE") {
    const perime = dernierConstat.ms != null && maintenant - dernierConstat.ms > CONSTAT_PERIME;
    return resultat(
      "non_confirme",
      `Pas encore pris en charge d'après la page officielle (constaté le ${heureLisible(dernierConstat.ms)})${perime ? " : à revérifier" : ""}.`,
      { enRetard: retard || perime }
    );
  }
  if (dernierConstat && dernierConstat.code === "MANUEL_PROBLEME") {
    return resultat("a_verifier", `Problème signalé à la main le ${heureLisible(dernierConstat.ms)}, sans prise en charge visible : à regarder sur la page officielle.`, { enRetard: true });
  }

  // --- etiquette seulement ---------------------------------------------------------------
  const informatifs = lusTransporteur.filter((e) => e.etape === "info_received");
  if (informatifs.length) {
    const raison = retard
      ? `Aucune prise en charge ${depuis} h après le drop : le transporteur ne connaît que l'étiquette.`
      : `Étiquette connue du transporteur, pas encore de prise en charge (drop il y a ${depuis ?? "?"} h : délai normal, premier scan attendu sous ${delaiHeures} h).`;
    return resultat("non_confirme", raison, { enRetard: retard });
  }

  // --- donnees presentes mais illisibles --------------------------------------------------
  if (lusTransporteur.length) {
    return resultat("a_verifier", `Statut transporteur non reconnu (« ${dernier.statut} ») : à vérifier sur la page officielle.`, { enRetard: retard });
  }

  // --- rien de lisible ------------------------------------------------------------------
  if (transporteur.methode === "manuel") {
    return resultat("bloque", transporteur.raison, { enRetard: retard, manuel: true });
  }
  if (pause) {
    const ou = transporteur.methode === "navigateur" ? "la page officielle reste à ouvrir à la main" : "la page officielle reste disponible";
    return resultat("bloque", `${transporteur.nom} : ${pause.motif}. Nouvel essai après ${heureLisible(sqlVersMs(pause.jusqua))} ; en attendant, ${ou}.`, { enRetard: retard });
  }
  if (suivi?.code_erreur === "bloque") {
    return resultat("bloque", `${transporteur.nom} a affiché une vérification anti-robot à la dernière lecture : ${suivi.erreur || "consultation refusée"}.`, { enRetard: retard });
  }
  if (!configure) {
    return resultat("a_verifier", "L'API La Poste n'est pas configurée (OKAPI_KEY) : aucune vérification automatique possible.", { enRetard: true });
  }
  if (suivi?.code_erreur === "invalide") return resultat("a_verifier", `Numéro refusé par ${transporteur.nom} : ${suivi.erreur || "format invalide"}.`, { enRetard: true });
  if (suivi?.code_erreur === "ambigu") return resultat("a_verifier", `${suivi.erreur || "Plusieurs envois pour ce numéro"} : à choisir sur la page officielle.`, { enRetard: true });
  if (suivi?.code_erreur) return resultat("a_verifier", `Dernière vérification en échec : ${suivi.erreur || suivi.code_erreur}. Rien n'est conclu sur le colis.`, { enRetard: retard });
  if (!suivi || suivi.trouve == null) {
    return resultat(
      "a_verifier",
      transporteur.methode === "navigateur"
        ? `Pas encore vérifié : ${transporteur.nom} se lit sur sa page officielle, depuis l'app Drop du Mac (« Tout vérifier »).`
        : "Pas encore vérifié : la vérification automatique est en file d'attente.",
      { enRetard: retard }
    );
  }
  return resultat(
    "a_verifier",
    retard
      ? `Toujours inconnu de ${transporteur.nom} ${depuis} h après le drop : numéro ou transporteur à vérifier.`
      : `Pas encore connu de ${transporteur.nom} (délai normal après un drop).`,
    { enRetard: retard }
  );
}

module.exports = { analyseDepot, enRetard, LIBELLES, ETAPES_FR, versMs };
