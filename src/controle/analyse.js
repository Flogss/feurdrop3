// La seule question du controle : le transporteur a-t-il reellement pris en
// charge ce colis, oui ou non ?
//
// Fonction pure : le colis (statut et dates FeurDrop), son suivi, ses
// evenements (deja traduits : API La Poste, page lue sur le Mac, constat fait
// a la main) -> un des quatre statuts, et son explication.
//
//   confirme      « Posté confirmé » : un evenement PHYSIQUE, date APRES la
//                 reception de l'etiquette par FeurDrop, prouve que le
//                 transporteur a eu le colis (depose, pris en charge, en
//                 transit, en point relais, livre... ou un retour : on ne
//                 retourne que ce qu'on a eu). Ce qui arrive ENSUITE (retour,
//                 « mis a disposition du vendeur », souci de livraison) reste
//                 consultable dans le detail, sans alerte : le depot, lui, est
//                 prouve et ne se defait jamais.
//   non_confirme  « Non confirmé » : le transporteur ne connait que
//                 l'etiquette ou les informations electroniques.
//   a_verifier    « À vérifier » : numero inconnu ou ambigu, page illisible,
//                 lecture en echec -- lu, mais pas assez pour conclure.
//   en_attente    « En attente de lecture » : rien n'a encore ete lu (le Mac
//                 est hors ligne, la file de l'API n'y est pas encore) ; ce
//                 n'est pas un verdict.
//   bloque        « Vérification bloquée » : le site refuse la consultation
//                 automatique (protection, pause) ou impose une verification
//                 a la main (UPS). Ce n'est JAMAIS « non deposé ».
//   incorrect     « Numéro incorrect » : le transporteur l'a dit lui-meme --
//                 numero refuse (format invalide), ou inconnu a plusieurs
//                 lectures bien apres le drop. Jamais sur un delai depasse,
//                 une panne, une page incomplete ou une protection anti-robot.
//
// Regles : jamais « confirme » sans un evenement physique date ; un code ou
// un libelle inconnu ne prouve rien ; une erreur reseau ou un CAPTCHA ne
// disent rien du colis.
//
// Un scan ANTERIEUR a la reception de l'etiquette ne prouve RIEN pour ce
// depot : FeurDrop ne peut pas deposer un colis avant d'avoir son etiquette.
// C'est un ancien parcours du meme numero (etiquette reutilisee, numero deja
// vu sur un autre colis -- les evenements sont ranges par numero). Les
// accepter faisait passer en « Posté confirmé » des colis encore en attente
// de depot (regle retiree en octobre 2026).

const { jourParis, ajouteJours, jourDeLaSemaine } = require("../dates");

const LIBELLES = {
  confirme: "Posté confirmé",
  non_confirme: "Pas encore scanné",
  a_verifier: "À vérifier",
  bloque: "Vérification bloquée",
  en_attente: "En attente de lecture",
  incorrect: "Numéro incorrect",
};
const ETAPES_PHYSIQUES = new Set(["in_transit", "out_for_delivery", "available_for_pickup", "delivered", "exception"]);

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
// "Avant la reception de l'etiquette" : les dates portent leur fuseau ; la
// marge couvre les ecarts d'horloge et un bot qui aurait traite l'etiquette
// en retard. Un ancien parcours date, lui, de jours ou de semaines.
const MARGE_ANCIEN = 6 * HEURE;

const PREUVE_FR = {
  in_transit: "Pris en charge",
  out_for_delivery: "En cours de livraison",
  available_for_pickup: "En point de retrait",
  exception: "Pris en charge (suite : retour ou souci)",
};
const CONSTAT_PERIME = 24 * HEURE; // un "pas encore" constate a la main est a refaire le lendemain
// les erreurs qui ne disent rien du colis (le transporteur ou la page n'a pas repondu)
const ERREURS_TECHNIQUES = new Set(["passagere", "incomplet", "autre_numero"]);

const SOURCES_FR = { laposte: "API La Poste", ups: "API UPS", dhl: "API DHL", navigateur: "page officielle lue sur le Mac", manuel: "constat à la main" };

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

// un evenement donne au jour seulement : sa date, sans heure inventee
const quandLisible = (e) => (e?.jourSeul ? heureLisible(e.ms).slice(0, 5) : heureLisible(e?.ms));

function decrit(e) {
  if (!e) return null;
  return {
    le: e.survenuLe,
    ms: e.ms,
    jourSeul: Boolean(e.jourSeul),
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
  // (un redrop porte la date de reception de l'etiquette d'origine : c'est la
  // meme etiquette, le meme parcours)
  const recuMs = sqlVersMs(colis.recu_le || colis.created_at);
  const dropeMs = sqlVersMs(colis.dropped_at);
  const seuilAncien = recuMs != null ? recuMs - MARGE_ANCIEN : null;

  const tous = evenements
    .map((e) => ({ ...e, ms: versMs(e.survenuLe) }))
    .sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity) || (b.ordre ?? 0) - (a.ordre ?? 0));
  // un evenement donne au jour seulement (sans heure) se compare au jour :
  // « 09/10 · Colis pris en charge » le jour de la reception de l'etiquette
  // n'est pas un ancien parcours
  const ancien = (e) => {
    if (seuilAncien == null || e.ms == null) return false;
    if (e.jourSeul) return jourParis(e.ms) < jourParis(recuMs);
    return e.ms < seuilAncien;
  };
  const passe = (e) => (e.jourSeul ? jourParis(e.ms) <= jourParis(maintenant) : e.ms <= maintenant + HEURE);
  // le constat manuel le plus recent fait foi parmi les constats
  const dernierConstat = tous.find((e) => e.source === "manuel") || null;
  const lusTransporteur = tous.filter((e) => e.source !== "manuel");
  const retenus = [...lusTransporteur, ...(dernierConstat ? [dernierConstat] : [])].sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity));

  const dernier = decrit(lusTransporteur[0] || null);
  // (une livraison d'un ancien parcours ne dit rien de ce colis)
  const livre = lusTransporteur.some((e) => e.etape === "delivered" && !e.incident && !ancien(e));
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
  // (datee, d'une etape physique, APRES la reception de l'etiquette, pas dans
  // le futur ; un constat a la main est date de l'instant ou il est fait)
  const physiques = retenus.filter((e) => e.ms != null && e.physique && (e.source === "manuel" || ETAPES_PHYSIQUES.has(e.etape)) && passe(e));
  const preuves = physiques.filter((e) => !ancien(e)).sort((a, b) => a.ms - b.ms || (a.ordre ?? 0) - (b.ordre ?? 0));
  if (preuves.length) {
    const p = preuves.find((e) => e.etape !== "delivered" && e.etape !== "exception") || preuves.find((e) => e.etape !== "delivered") || preuves[0];
    const preuve = decrit(p);
    // la suite : le dernier evenement notable apres la prise en charge (retour,
    // disponible chez le vendeur, souci, livraison) -- pour le detail, sans alerte
    const apres = retenus.find((e) => e.ms != null && e.ms > p.ms && (e.incident || ["delivered", "available_for_pickup", "exception"].includes(e.etape)));
    const suite = apres ? { libelle: apres.libelle || ETAPES_FR[apres.etape], le: apres.survenuLe, etape: apres.etape, retour: Boolean(apres.incident) } : null;
    if (p.source === "manuel") {
      const vu = { MANUEL_TRANSIT: "En transit : constaté", MANUEL_LIVRE: "Livré après prise en charge : constaté" }[p.code] || "Prise en charge constatée";
      return resultat("confirme", `${vu} à la main sur la page officielle le ${heureLisible(p.ms)}.`, { preuve, suite });
    }
    const seulementLivre = preuves.every((e) => e.etape === "delivered");
    const ou = p.source && p.source !== "laposte" ? ` — ${SOURCES_FR[p.source] || p.source}` : "";
    const raison = seulementLivre
      ? `Livré le ${quandLisible(preuve)} : aucun scan de prise en charge n'est remonté avant la livraison, mais le colis a bien circulé${ou}.`
      : `${PREUVE_FR[preuve.etape] || "Scan"} le ${quandLisible(preuve)} : « ${preuve.statut} »${preuve.lieu ? ` (${preuve.lieu})` : ""}${ou}.`;
    return resultat("confirme", raison, { preuve, suite });
  }

  // --- constats a la main sans preuve -------------------------------------------------
  if (dernierConstat && (dernierConstat.code === "MANUEL_PAS_ENCORE" || dernierConstat.code === "MANUEL_ETIQUETTE")) {
    const perime = dernierConstat.ms != null && maintenant - dernierConstat.ms > CONSTAT_PERIME;
    return resultat(
      "non_confirme",
      `Pas encore pris en charge d'après la page officielle (constaté le ${heureLisible(dernierConstat.ms)})${perime ? " : à revérifier" : ""}.`,
      { enRetard: retard || perime }
    );
  }
  if (dernierConstat && dernierConstat.code === "MANUEL_INCONNU") {
    return resultat("a_verifier", `Statut inconnu sur la page officielle (constaté le ${heureLisible(dernierConstat.ms)}) : aucune prise en charge visible, à revoir.`, {
      enRetard: retard,
    });
  }
  if (dernierConstat && dernierConstat.code === "MANUEL_BLOQUE") {
    return resultat("bloque", `La page officielle n'a pas pu être consultée (constaté le ${heureLisible(dernierConstat.ms)}) : à refaire plus tard.`);
  }
  if (dernierConstat && dernierConstat.code === "MANUEL_PROBLEME") {
    return resultat("a_verifier", `Problème signalé à la main le ${heureLisible(dernierConstat.ms)}, sans prise en charge visible : à regarder sur la page officielle.`, { enRetard: true });
  }

  // --- un statut que la liste ne connait pas, apres la reception de l'etiquette ---
  // (une formule nouvelle du transporteur peut etre une vraie prise en charge :
  // a regarder, jamais « pas encore scanne » ni retire de la liste sans un regard)
  const nonReconnus = lusTransporteur.filter((e) => e.etape === "unknown" && e.ms != null && !ancien(e) && passe(e));
  if (nonReconnus.length) {
    const reperes = lusTransporteur.filter((e) => e.etape !== "unknown" && e.ms != null);
    const dernierRepere = reperes.length ? Math.max(...reperes.map((e) => e.ms)) : -Infinity;
    const recent = nonReconnus.reduce((a, b) => (b.ms > a.ms ? b : a));
    if (recent.ms >= dernierRepere) {
      return resultat("a_verifier", `Statut transporteur non reconnu depuis la réception de l'étiquette (« ${recent.libelle || recent.code || "?"} ») : à vérifier sur la page officielle.`, {
        enRetard: retard,
        nonReconnu: true,
      });
    }
  }

  // --- un ancien parcours seulement : ce n'est pas CE depot ---------------------------
  const anciens = physiques.filter(ancien);
  if (anciens.length) {
    const dernierAncien = anciens.reduce((a, b) => (b.ms > a.ms ? b : a));
    return resultat(
      "non_confirme",
      `Aucune prise en charge depuis la réception de l'étiquette (${heureLisible(recuMs)}) : le suivi ne montre qu'un ancien parcours de ce numéro (dernier scan le ${quandLisible(dernierAncien)}, « ${dernierAncien.libelle || ETAPES_FR[dernierAncien.etape]} »).`,
      { enRetard: retard, ancienParcours: true }
    );
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
    const api = transporteur.methode === "laposte" ? "L'API La Poste n'est pas configurée (OKAPI_KEY)" : `L'API officielle de ${transporteur.nom} n'est pas configurée`;
    return resultat("a_verifier", `${api} : aucune vérification automatique possible.`, { enRetard: true, nonConfigure: true });
  }
  if (suivi?.code_erreur === "invalide") {
    return resultat("incorrect", `Numéro refusé par ${transporteur.nom} (${suivi.erreur || "format invalide"}) : le numéro de suivi est incorrect, ce n'est ni un délai ni une panne.`, {
      enRetard: true,
    });
  }
  if (suivi?.code_erreur === "ambigu") return resultat("a_verifier", `${suivi.erreur || "Plusieurs envois pour ce numéro"} : à choisir sur la page officielle.`, { enRetard: true });
  // une panne, un delai, une page incomplete : une erreur technique, pas un
  // verdict -- la lecture est refaite d'elle-meme ; au 4e echec de suite, a regarder
  const technique = suivi?.code_erreur && ERREURS_TECHNIQUES.has(suivi.code_erreur) && (suivi.essais || 0) < 4;
  if (suivi?.code_erreur && !technique) return resultat("a_verifier", `Dernière vérification en échec : ${suivi.erreur || suivi.code_erreur}. Rien n'est conclu sur le colis.`, { enRetard: retard });
  const echec = technique ? ` Dernière tentative en échec (${suivi.erreur || suivi.code_erreur}) : nouvel essai automatique, rien n'est conclu.` : "";
  if (!suivi || suivi.trouve == null) {
    // rien n'a encore ete lu : ce n'est pas un verdict
    return resultat(
      "en_attente",
      (transporteur.methode === "navigateur"
        ? `En attente de lecture : ${transporteur.nom} se lit sur sa page officielle, par l'app Drop du Mac (dès qu'elle est ouverte et connectée).`
        : `En attente de lecture : ${transporteur.nom} est dans la file de vérification automatique.`) + echec,
      { enRetard: false, erreurTechnique: Boolean(technique) }
    );
  }
  if (suivi.trouve === 1) {
    return resultat("a_verifier", `Connu de ${transporteur.nom}, sans évènement lisible : à regarder sur la page officielle.${echec}`, { enRetard: retard });
  }
  // inconnu du transporteur : normal juste apres le drop (pas encore de
  // prise en charge) ; au-dela du delai, a regarder -- et retire de la file
  // s'il le reste (relu 12 h plus tard pour en etre sur)
  if (!retard) return resultat("non_confirme", `Pas encore connu de ${transporteur.nom} (délai normal après un drop) : pas de prise en charge.`, { enRetard: false });
  // inconnu a plusieurs lectures, bien apres le drop : le transporteur le dit
  // lui-meme, le numero est incorrect (une seule lecture : on relit d'abord)
  if ((suivi.inconnu_lectures || 0) >= 2) {
    return resultat(
      "incorrect",
      `Inconnu de ${transporteur.nom} à ${suivi.inconnu_lectures} lectures, ${depuis} h après le drop : le numéro de suivi (ou le transporteur) est incorrect.`,
      { enRetard: true, inconnu: true }
    );
  }
  return resultat(
    "a_verifier",
    `Toujours inconnu de ${transporteur.nom} ${depuis} h après le drop : numéro ou transporteur à vérifier. Relu dans quelques heures pour en être sûr.`,
    { enRetard: true, inconnu: true }
  );
}

module.exports = { analyseDepot, enRetard, LIBELLES, ETAPES_FR, versMs };
