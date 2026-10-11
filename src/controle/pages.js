// Ce que disent les pages officielles de suivi, telles que l'app Drop du Mac
// les a lues (le texte visible de la page, avec son titre et son adresse).
//
// Le Mac ne fait que lire : c'est ici, et seulement ici, que ce texte devient
// une decision -- une seule logique, testee, pour tous les appareils.
//
// Essais reels depuis le Mac de FeurDrop, dans WebKit (octobre 2026) :
//   Mondial Relay  la page s'affiche (HTTP 200, pas de defi) ; numero
//                  inconnu : « Nous n'avons identifie aucun colis portant ce
//                  numero de suivi » ; un colis : « SUIVI DETAILLE DE MON
//                  COLIS », des dates (09/10/2026), des heures et des
//                  libelles (« Colis pris en charge en Point Relais »,
//                  « Colis en preparation chez l'expediteur »).
//   DHL            la page s'affiche ; numero inconnu : « Desole, votre
//                  tentative de suivi a echoue ».
//   FedEx          la page s'affiche ; numero ambigu : « Duplicate results
//                  found ».
//   GLS            la page s'affiche (en anglais) ; numero inconnu :
//                  « Unfortunately there are no results ».
// Les libelles des colis reels de DHL, FedEx et GLS n'ont pas pu etre vus
// (aucun numero reel disponible) : ils sont reconnus par des formules
// generiques ; un texte non reconnu n'est JAMAIS une preuve (« a verifier »,
// avec le texte brut garde pour la page).

// --- Une protection anti-robot affichee a la place du suivi ------------------------

const BLOCAGES = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /acc[eè]s refus[ée]/i,
  /your tracking attempt has been blocked/i,
  /verify (that )?you are (a )?human/i,
  /v[ée]rifi(ez|er) que vous [eê]tes (un )?humain/i,
  /unusual traffic/i,
  /trafic inhabituel/i,
  /pardon our interruption/i,
  /request unsuccessful/i,
  /are you a robot/i,
  /[eê]tes-vous un robot/i,
  /complete the security check/i,
];

function estBloque({ titre = "", texte = "" }) {
  const debut = `${titre}\n${String(texte).slice(0, 800)}`;
  return BLOCAGES.some((re) => re.test(debut));
}

// --- Les formules qui disent ou en est un colis -----------------------------------

// l'etiquette seulement : le transporteur attend le colis
const ETIQUETTE = [
  /en pr[ée]paration chez l.exp[ée]diteur/i,
  /[ée]tiquette (cr[ée]{1,2}e|g[ée]n[ée]r[ée]e|imprim[ée]e)/i,
  /label (created|printed)/i,
  /informations? (de l.envoi |d.exp[ée]dition )?(re[cç]ues?|transmises?)/i,
  /donn[ée]es ([ée]lectroniques )?(de l.envoi |du colis )?(ont [ée]t[ée] )?(re[cç]ues|transmises)/i,
  /shipment information (received|sent)/i,
  /electronic (shipment )?(information|notification)/i,
  /parcel data (was|has been|have been) (entered|transmitted|received)/i,
  /(colis|envoi) annonc[ée]/i,
  /en attente (de (la )?|du )?(prise en charge|colis|d[ée]p[oô]t)/i,
  /va bient[oô]t nous [eê]tre confi[ée]/i,
  /not yet (handed|received)|awaiting (collection|drop.?off)/i,
];

// le transporteur a eu le colis entre les mains (dans l'ordre : du plus
// precis au plus general)
const ETAPES = [
  // (pas de \b : en JavaScript il ne voit pas la fin de « livré »)
  { etape: "delivered", re: /(?<!en cours de )(?<!out for )(?<![a-zà-ÿ])(livr[ée]e?|delivered|distribu[ée]e?|remis au destinataire|r[ée]cup[ée]r[ée] par le destinataire|collected by (the )?(recipient|consignee))(?![a-zà-ÿ])/i },
  { etape: "out_for_delivery", re: /en cours de livraison|out for delivery|en livraison|with (the )?courier|chez le livreur/i },
  { etape: "available_for_pickup", re: /disponible (en|au|dans (le|la|un|une))? ?(point|relais|locker|consigne|bureau)|mis[e]? [àa] disposition|available (for|at)|ready for (pickup|collection)|[àa] retirer/i },
  { etape: "in_transit", re: /pris en charge|prise en charge|remis [àa] (mondial relay|dhl|fedex|gls|chronopost|colissimo|la poste|ups)|d[ée]pos[ée]|collect[ée]|picked up|we have your package|nous avons votre colis|handed over|received (by|at|in)|arriv[ée]e?|arrived|d[ée]part|departed|en transit|in transit|acheminement|centre de tri|plateforme|hub|sort(ed|ing)|on (its|the) way|en route|scann[ée]|processed at|trait[ée] (au|dans)|douane|customs/i },
];
// apres la prise en charge, ce sont des suites (retour, souci) : on les
// garde pour le detail, jamais comme une « anomalie » du depot
const SUITES = /retour|return(ed)?|renvoy|non distribuable|undeliverable|refus[ée]|refused|incident|probl[eè]me|exception|adresse (incompl[eè]te|erron[ée]e)|address (problem|issue)|vendeur|exp[ée]diteur/i;

function litLibelle(libelle) {
  const l = String(libelle || "");
  if (ETIQUETTE.some((re) => re.test(l))) return { etape: "info_received", physique: false };
  for (const { etape, re } of ETAPES) {
    if (re.test(l)) return { etape, physique: true, suite: SUITES.test(l) ? true : undefined };
  }
  // un retour, un souci : le colis a forcement ete entre les mains du transporteur
  if (SUITES.test(l)) return { etape: "exception", physique: true, suite: true };
  return { etape: "unknown", physique: false };
}

// --- Les dates ----------------------------------------------------------------------

const MOIS = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, fev: 2, fév: 2, mar: 3, apr: 4, avr: 4, jun: 6, jul: 7, juil: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, déc: 12,
};

const deux = (n) => String(n).padStart(2, "0");

// "2026-10-09" (jour seulement) ou null
function litDate(ligne) {
  let m = ligne.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  if (m) return `${m[3]}-${deux(m[2])}-${deux(m[1])}`;
  m = ligne.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = ligne.match(/\b(\d{1,2})(?:er)?\.?\s+([a-zéûô]{3,9})\.?,?\s+(\d{4})\b/i);
  if (m && MOIS[m[2].toLowerCase()]) return `${m[3]}-${deux(MOIS[m[2].toLowerCase()])}-${deux(m[1])}`;
  m = ligne.match(/\b([a-zéûô]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m && MOIS[m[1].toLowerCase()]) return `${m[3]}-${deux(MOIS[m[1].toLowerCase()])}-${deux(m[2])}`;
  return null;
}

function litHeure(ligne) {
  const m = ligne.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  return m ? `${deux(m[1])}:${m[2]}` : null;
}

// heure de Paris -> ISO avec fuseau (l'heure d'ete d'octobre a fin mars : +01:00)
function enIso(jour, heure) {
  if (!jour) return null;
  const [a, mo, j] = jour.split("-").map(Number);
  const ms = Date.UTC(a, mo - 1, j, 12);
  // dernier dimanche de mars / d'octobre
  const dernierDimanche = (mois) => {
    const d = new Date(Date.UTC(a, mois, 0));
    return d.getUTCDate() - d.getUTCDay();
  };
  const ete = ms >= Date.UTC(a, 2, dernierDimanche(3)) && ms < Date.UTC(a, 9, dernierDimanche(10));
  return `${jour}T${heure || "12:00"}:00${ete ? "+02:00" : "+01:00"}`;
}

// --- Le texte d'une page -> des evenements ----------------------------------------------

const lignesDe = (texte) =>
  String(texte || "")
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

// Les lignes d'une section : une date pose le jour, une heure se rattache au
// libelle voisin. Chaque libelle reconnu devient un evenement.
function evenementsDe(lignes, { source = "navigateur" } = {}) {
  const evenements = [];
  let jour = null;
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    const d = litDate(l);
    if (d) jour = d;
    const lu = litLibelle(l);
    if (lu.etape === "unknown") continue;
    // une ligne trop longue est un paragraphe d'aide, pas un evenement
    if (l.length > 140) continue;
    // l'heure suit le libelle sur ces pages (Mondial Relay : libelle, puis heure)
    const heure = litHeure(l) || litHeure(lignes[i + 1] || "") || litHeure(lignes[i - 1] || "");
    const jourLigne = d || jour;
    const libelle = l.replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{4}\b/, "").replace(/\b([01]?\d|2[0-3])[:h][0-5]\d\b/, "").replace(/\s+/g, " ").trim() || l;
    const survenuLe = enIso(jourLigne, heure);
    evenements.push({
      cle: `nav|${jourLigne || "?"}|${heure || "?"}|${libelle.slice(0, 120)}`,
      survenuLe,
      code: null,
      libelle: libelle.slice(0, 200),
      lieu: null,
      etape: lu.etape,
      physique: lu.physique,
      incident: lu.suite ? libelle.slice(0, 120) : null,
      resolu: false,
      ordre: lignes.length - i,
      source,
      brut: { ligne: l },
    });
  }
  // une meme formule lue deux fois (resume + detail) ne compte qu'une fois
  const vus = new Set();
  return evenements.filter((e) => (vus.has(e.cle) ? false : vus.add(e.cle)));
}

const entre = (lignes, debut, fin) => {
  const i = debut ? lignes.findIndex((l) => debut.test(l)) : 0;
  if (i < 0) return null;
  const reste = lignes.slice(i + 1);
  const j = fin ? reste.findIndex((l) => fin.test(l)) : -1;
  return j < 0 ? reste : reste.slice(0, j);
};

// --- Chaque transporteur ---------------------------------------------------------------

const LECTEURS = {
  MR: {
    introuvable: /aucun colis portant ce num[ée]ro|n.avons identifi[ée] aucun colis/i,
    section: (lignes) =>
      entre(lignes, /^suivi d[ée]taill[ée] de mon colis$/i, /^je m.informe$|app.solument|^pour nous suivre$/i) ||
      // a defaut, le statut seul (jamais le « suivi global » : c'est la liste
      // des etapes possibles, livraison comprise, pas ce qui s'est passe)
      entre(lignes, /^statut$/i, /^suivi global|^je m.informe$|app.solument/i),
    statut: (lignes) => {
      const i = lignes.findIndex((l) => /^statut$/i.test(l));
      // la premiere vraie phrase apres « STATUT » (pas une date, pas une heure)
      if (i < 0) return null;
      const bloc = lignes.slice(i + 1, i + 5);
      const fin = bloc.findIndex((l) => /^suivi (global|d[ée]taill[ée])/i.test(l));
      return (fin < 0 ? bloc : bloc.slice(0, fin)).find((l) => !/^[\d/.:h\s-]+$/.test(l)) || null;
    },
  },
  DHL: {
    introuvable: /tentative de suivi a [ée]chou[ée]|tracking attempt (was )?(not successful|failed|unsuccessful)|aucun r[ée]sultat/i,
    section: (lignes) => entre(lignes, /^(saisissez votre|enter your) .*num[ée]ro|^suivre$|^track$/i, /questions fr[ée]quemment pos[ée]es|frequently asked questions/i),
  },
  FEDEX: {
    introuvable: /cannot locate|could not locate|introuvable|not found|nous ne trouvons pas|aucun envoi/i,
    ambigu: /duplicate results found|plusieurs (envois|r[ée]sultats)/i,
    section: (lignes) => entre(lignes, /^(track another shipment|suivre un autre envoi)$/i, /^(our company|notre soci[ée]t[ée])$/i),
  },
  GLS: {
    introuvable: /unfortunately there are no results|aucun r[ée]sultat|pas de r[ée]sultat/i,
    section: (lignes) => entre(lignes, /^(parcel tracking|suivi (de |des )?colis)$/i, /^(parcel search|recherche de colis)$/i),
  },
};

/**
 * Le texte d'une page officielle -> ce qu'elle dit.
 *   { etat: "trouve"|"introuvable"|"ambigu"|"bloque"|"illisible", evenements, statutBrut, motif }
 * Jamais d'evenement physique sans une formule qui le dit.
 */
function lisPage(code, { titre = "", texte = "", url = "" } = {}) {
  if (estBloque({ titre, texte })) {
    return { etat: "bloque", evenements: [], statutBrut: `Protection affichée : « ${titre || String(texte).slice(0, 80)} »`, motif: "le site affiche une vérification anti-robot" };
  }
  const lecteur = LECTEURS[code];
  if (!lecteur) return { etat: "illisible", evenements: [], statutBrut: null, motif: "transporteur sans lecteur de page" };
  const lignes = lignesDe(texte);
  const tout = lignes.join("\n");
  if (lecteur.introuvable.test(tout)) {
    return { etat: "introuvable", evenements: [], statutBrut: "Numéro inconnu sur la page officielle", motif: null };
  }
  if (lecteur.ambigu?.test(tout)) {
    return { etat: "ambigu", evenements: [], statutBrut: "Plusieurs envois portent ce numéro sur la page officielle", motif: "plusieurs envois pour ce numéro : à choisir sur la page officielle" };
  }
  const section = lecteur.section(lignes);
  const evenements = section ? evenementsDe(section) : [];
  const statut = lecteur.statut?.(lignes) || evenements[0]?.libelle || null;
  if (!evenements.length) {
    const apercu = (section || lignes).slice(0, 6).join(" · ").slice(0, 300);
    return { etat: "illisible", evenements: [], statutBrut: apercu || null, motif: `page lue mais statut non reconnu${url ? "" : ""}` };
  }
  return { etat: "trouve", evenements, statutBrut: statut, motif: null };
}

module.exports = { lisPage, litLibelle, litDate, estBloque, evenementsDe, LECTEURS };
