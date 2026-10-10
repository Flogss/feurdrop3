// Ce que les donnees du transporteur PROUVENT sur le depot d'un colis.
//
// Fonction pure : le colis (statut et dates FeurDrop), son suivi, ses
// evenements (deja traduits par l'adaptateur du transporteur, ou constates a
// la main) -> une categorie et son explication.
//
//   confirme      un evenement PHYSIQUE date, posterieur a la reception du
//                 colis par FeurDrop : depose, pris en charge, en transit...
//                 (ou une prise en charge constatee a la main sur la page
//                 officielle, dite comme telle) ;
//   non_confirme  le transporteur ne connait que l'etiquette ("en cours de
//                 preparation chez l'expediteur") : depot declare, non prouve.
//                 Dans le delai normal de remontee des scans, c'est dit ;
//   a_verifier    "Verification necessaire" : pas encore verifie, numero
//                 inconnu ou refuse, erreur, donnees ambigues ;
//   bloque        "Verification bloquee" : le site du transporteur refuse les
//                 verifications automatiques, ou il a demande une pause. Ce
//                 n'est PAS "non depose" : rien n'a pu etre lu ;
//   anomalie      retour, non distribuable, probleme signale (apres la
//                 reception de l'etiquette).
//
// Regle d'or : jamais "confirme" sans un evenement physique date. Un code
// inconnu ne prouve rien. "Livre" prouve que le colis a circule, mais la
// preuve affichee reste le scan de prise en charge quand il existe.
// Un scan physique ANTERIEUR a la reception de l'etiquette compte aussi
// (courant chez FeurDrop : boites jaunes deja en point relais, puis de
// nouveau en transit) ; la raison le dit, avec les deux dates.

const { jourParis, ajouteJours, jourDeLaSemaine } = require("../dates");

const LIBELLES = {
  confirme: "Dépôt confirmé",
  non_confirme: "Dépôt non confirmé",
  a_verifier: "Vérification nécessaire",
  bloque: "Vérification bloquée",
  anomalie: "Anomalie de suivi",
};

const ETAPES_FR = {
  info_received: "Étiquette créée",
  in_transit: "Pris en charge / en transit",
  out_for_delivery: "En cours de livraison",
  available_for_pickup: "Disponible au retrait",
  delivered: "Livré",
  exception: "Incident",
  unknown: "Statut non reconnu",
};

const HEURE = 3600 * 1000;
// "Avant la reception de l'etiquette" : les dates La Poste portent leur
// fuseau, la marge ne couvre que les ecarts d'horloge.
const MARGE_ANCIEN = 2 * HEURE;

const PREUVE_FR = { in_transit: "Pris en charge", out_for_delivery: "En cours de livraison", available_for_pickup: "En point de retrait" };
const CONSTAT_PERIME = 24 * HEURE; // un "pas encore pris en charge" constate a la main est a refaire le lendemain

const sqlVersMs = (s) => (s ? Date.parse(`${String(s).replace(" ", "T")}Z`) : null);

// La Poste donne des dates avec fuseau ("2026-10-09T18:45:00+02:00") ; les
// constats manuels sont en ISO UTC.
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
 * transporteur { methode: "laposte"|"manuel", nom, raison }
 * pause        la pause en cours du transporteur ({ jusqua, motif }) ou null
 * configure    la methode automatique a-t-elle ses identifiants ?
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
  };
  const retard = enRetard(dropeMs, maintenant, delaiHeures);
  const depuis = dropeMs ? Math.max(0, Math.round((maintenant - dropeMs) / HEURE)) : null;
  const resultat = (categorie, raison, extra = {}) => ({ categorie, libelle: LIBELLES[categorie], raison, enRetard: false, preuve: null, ...commun, ...extra });

  // --- incidents ----------------------------------------------------------------
  const preuves = retenus.filter((e) => e.ms != null && e.physique).sort((a, b) => a.ms - b.ms || (a.ordre ?? 0) - (b.ordre ?? 0));
  const preuve = decrit(preuves.find((e) => e.etape !== "delivered") || preuves[0]);
  // (un incident d'avant la reception de l'etiquette appartient a un ancien parcours)
  const incidents = retenus.filter((e) => e.incident && !ancien(e));
  if (incidents.length) {
    const i = incidents[0];
    // un "probleme en cours" depasse par une suite normale (livraison,
    // probleme resolu, nouvelle etape) n'en est plus un
    const depasse = i.code === "PB1" && retenus.some((e) => e.ms != null && i.ms != null && e.ms > i.ms && !e.incident && e.physique);
    if (!depasse) {
      const qui = i.source === "manuel" ? "constaté à la main" : "";
      return resultat("anomalie", `${i.incident} le ${heureLisible(i.ms)}${qui ? ` (${qui})` : ""}${i.libelle && i.source !== "manuel" ? ` : « ${i.libelle} »` : ""}.`, { preuve });
    }
  }

  // --- preuve physique ----------------------------------------------------------
  if (preuve) {
    const p = preuves.find((e) => e.etape !== "delivered") || preuves[0];
    if (p.source === "manuel") return resultat("confirme", `Prise en charge constatée à la main sur la page officielle le ${heureLisible(p.ms)}.`, { preuve });
    const seulementLivre = preuves.every((e) => e.etape === "delivered");
    const avant = ancien(p) ? ` (scan antérieur à la réception de l'étiquette, le ${heureLisible(recuMs)})` : "";
    const raison = seulementLivre
      ? `Livré le ${heureLisible(preuve.ms)}${avant} : aucun scan de prise en charge n'est remonté avant la livraison, mais le colis a bien circulé.`
      : `${PREUVE_FR[preuve.etape] || "Scan"} le ${heureLisible(preuve.ms)}${avant} : « ${preuve.statut} »${preuve.lieu ? ` (${preuve.lieu})` : ""}.`;
    return resultat("confirme", raison, { preuve });
  }

  // --- constat manuel "pas encore" ----------------------------------------------
  if (dernierConstat && dernierConstat.code === "MANUEL_PAS_ENCORE") {
    const perime = dernierConstat.ms != null && maintenant - dernierConstat.ms > CONSTAT_PERIME;
    return resultat(
      "non_confirme",
      `Pas encore pris en charge d'après la page officielle (constaté le ${heureLisible(dernierConstat.ms)})${perime ? " : à revérifier" : ""}.`,
      { enRetard: retard || perime }
    );
  }

  // --- etiquette seulement ------------------------------------------------------
  const informatifs = lusTransporteur.filter((e) => e.etape === "info_received");
  if (informatifs.length) {
    const raison = retard
      ? `Aucun scan de prise en charge ${depuis} h après le drop : le transporteur ne connaît que l'étiquette.`
      : `Étiquette connue du transporteur, pas encore de scan de prise en charge (drop il y a ${depuis ?? "?"} h : délai normal, premier scan attendu sous ${delaiHeures} h).`;
    return resultat("non_confirme", raison, { enRetard: retard });
  }

  // --- donnees presentes mais illisibles ------------------------------------------
  if (lusTransporteur.length) {
    return resultat("a_verifier", `Statut transporteur non reconnu (« ${dernier.statut} ») : à vérifier sur la page officielle.`, { enRetard: retard });
  }

  // --- rien de lisible ----------------------------------------------------------
  if (transporteur.methode === "manuel") {
    return resultat("bloque", transporteur.raison, { enRetard: retard, manuel: true });
  }
  if (!configure) return resultat("a_verifier", "L'API La Poste n'est pas configurée (OKAPI_KEY) : aucune vérification automatique possible.", { enRetard: true });
  if (pause) {
    return resultat("bloque", `${transporteur.nom} : ${pause.motif}. Nouvel essai après ${heureLisible(sqlVersMs(pause.jusqua))} ; en attendant, la page officielle reste disponible.`, {
      enRetard: retard,
    });
  }
  if (suivi?.code_erreur === "invalide") return resultat("a_verifier", `Numéro refusé par ${transporteur.nom} : ${suivi.erreur || "format invalide"}.`, { enRetard: true });
  if (suivi?.code_erreur) return resultat("a_verifier", `Dernière vérification en échec : ${suivi.erreur || suivi.code_erreur}.`, { enRetard: retard });
  if (!suivi || suivi.trouve == null) return resultat("a_verifier", "Pas encore vérifié : la vérification automatique est en file d'attente.", { enRetard: retard });
  return resultat(
    "a_verifier",
    retard
      ? `Toujours inconnu de ${transporteur.nom} ${depuis} h après le drop : numéro ou transporteur à vérifier.`
      : `Pas encore connu de ${transporteur.nom} (délai normal après un drop).`,
    { enRetard: retard }
  );
}

module.exports = { analyseDepot, enRetard, LIBELLES, ETAPES_FR, versMs };
