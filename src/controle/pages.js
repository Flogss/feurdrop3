// Ce que disent les pages officielles de suivi, telles que l'app Drop du Mac
// les a lues (le texte visible de la page, avec son titre et son adresse).
//
// Le Mac ne fait que lire : c'est ici, et seulement ici, que ce texte devient
// une decision -- une seule logique, testee, pour tous les appareils.
//
// Chaque transporteur a SON lecteur : ou commence le suivi sur la page, quel
// numero elle affiche, comment s'y suivent dates, heures et libelles, et la
// liste exacte de ses formules. Une phrase qui n'est pas dans la liste n'est
// jamais une preuve de depot ; une phrase au futur ou a la negation non plus
// (« sera déposé », « pas encore remis », « will be picked up »).
//
// Lu pour de vrai dans WebKit sur le Mac de FeurDrop (octobre 2026) :
//   Mondial Relay  colis pris en charge (3 vrais numeros) :
//                    SUIVI DÉTAILLÉ DE MON COLIS
//                    09/10/2026                      <- la date du jour
//                    Colis pris en charge en Point Relais   <- titre du jour
//                    20:31                           <- heure, puis
//                    Colis pris en charge en Point Relais   <- l'evenement
//                    12:42
//                    Colis en préparation chez l'expéditeur
//                  Le « SUIVI GLOBAL » au-dessus (préparation / remis /
//                  livré) est la liste des etapes POSSIBLES : jamais lu.
//                  Numero inconnu : « Nous n'avons identifié aucun colis
//                  portant ce numéro de suivi ».
//   DHL            numero inconnu : « Désolé, votre tentative de suivi a
//                  échoué ».
//   GLS            page en anglais ; numero inconnu : « Unfortunately there
//                  are no results ».
// Les libelles DHL et GLS d'un colis reel n'ont pas pu etre vus (pas de vrai
// numero disponible) : leurs listes reprennent leurs formules publiques ;
// une formule absente donne « À vérifier » avec le texte brut garde.

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

// --- Les formules ------------------------------------------------------------------

// au futur, au conditionnel, a la negation : jamais une preuve
const PAS_ENCORE = /pas encore|not yet|n.a pas (encore )?[ée]t[ée]|n.est pas encore|\bsera\b|\bseront\b|\bpr[ée]vue?s?\b|estim[ée]|bient[oô]t|will be|to be (picked|dropped|delivered)|expected|scheduled|planned|[àa] d[ée]poser|doit [eê]tre|en attente de (d[ée]p[oô]t|prise en charge|remise)|awaiting/i;

// l'etiquette ou les donnees seulement (pour chaque transporteur)
const INFO = {
  MR: [/en pr[ée]paration chez l.exp[ée]diteur/i, /colis (cr[ée]{1,2}|enregistr[ée])/i, /[ée]tiquette/i],
  DHL: [
    /donn[ée]es [ée]lectroniques/i,
    /donn[ée]es (de l.envoi |d.exp[ée]dition )?(ont [ée]t[ée] )?(transmises|re[cç]ues)/i,
    /instruction data/i,
    /electronically announced/i,
    /annonc[ée] [ée]lectroniquement/i,
    /shipment information received/i,
    /informations? (de l.envoi |d.exp[ée]dition )?re[cç]ues?/i,
    /label created|[ée]tiquette cr[ée]{1,2}e/i,
  ],
  GLS: [/parcel data (was|has been) (entered|transmitted)/i, /donn[ée]es du colis (ont [ée]t[ée] )?(saisies|transmises)/i, /information (was|has been) (received|transmitted)/i],
};

// Un evenement secondaire : il raconte la suite (une enquete, une
// reclamation), il ne prouve rien a lui seul -- et n'efface jamais une preuve
// deja lue (« Une enquête est en cours » apres « Colis livré »).
const SECONDAIRES = /enqu[eê]te|r[ée]clamation|investigation|claim/i;

// la prise en charge et la suite (pour chaque transporteur), du plus precis
// au plus general ; « suite » = apres la prise en charge (retour, souci)
const ETAPES = {
  MR: [
    // remis au vendeur / a l'expediteur : un retour, apres la prise en charge
    { etape: "exception", re: /(mis|remis)e? [àa] (la )?disposition (du |de l.)(vendeur|exp[ée]diteur)|retourn[ée] (au|[àa] l.)(vendeur|exp[ée]diteur)|retour (vers|chez|[àa]) l.exp[ée]diteur/i, suite: true },
    { etape: "delivered", re: /colis (livr[ée]|remis) (au|à au|a au) destinataire|colis r[ée]cup[ée]r[ée] par le destinataire|colis livr[ée](?![a-zà-ÿ])/i },
    { etape: "available_for_pickup", re: /colis (est )?disponible (au|en|dans)|colis (est )?(mis|d[ée]pos[ée])e? [àa] (la )?disposition/i },
    { etape: "out_for_delivery", re: /en cours de livraison/i },
    // « Colis expédié depuis site logistique », « Colis pris en charge au PR »
    { etape: "in_transit", re: /colis pris en charge|^pris en charge (en|au|par|dans)|colis d[ée]pos[ée] (en|au|dans)|colis remis [àa] mondial relay|colis (en cours d.acheminement|en cours de traitement|achemin[ée])|colis arriv[ée] (sur|au|à|a l|en|dans)|colis (exp[ée]di[ée]|collect[ée]|tri[ée])|colis en cours de tri/i },
    { etape: "exception", re: /retour|renvoy[ée]|non (livr[ée]|distribu)|refus[ée]|incident|probl[eè]me/i, suite: true },
  ],
  DHL: [
    { etape: "delivered", re: /(successfully )?delivered|(a|ont) [ée]t[ée] (distribu|livr)[ée]e?s?|envoi (a [ée]t[ée] )?livr[ée]|distribu[ée] au destinataire|^(envoi |colis )?livr[ée]e?s?(?![a-zà-ÿ])/i },
    { etape: "out_for_delivery", re: /loaded onto the delivery vehicle|with delivery courier|out for delivery|en cours de livraison|charg[ée] dans le v[ée]hicule de livraison/i },
    { etape: "available_for_pickup", re: /ready for (pickup|collection)|disponible (au|en|dans) (point|relais|bureau|packstation)|available for pickup/i },
    { etape: "in_transit", re: /picked up|has been posted|posted by the sender|d[ée]pos[ée] par l.exp[ée]diteur|enlev[ée]|processed (in|at)|trait[ée] (au|dans|à)|arrived (at|in)|arriv[ée] (au|dans|à)|departed|parti (du|de)|in transit|en transit|(sorting|parcel|distribution) cent(er|re)|centre de (tri|distribution)|customs clearance|d[ée]douan/i },
    { etape: "exception", re: /return(ed)? to (sender|shipper)|retourn[ée]|could not be delivered|n.a pas pu [eê]tre (distribu|livr)|refused|refus[ée]/i, suite: true },
  ],
  GLS: [
    { etape: "delivered", re: /has been delivered|a [ée]t[ée] livr[ée]|delivered to|livr[ée] (au|à|a)/i },
    { etape: "available_for_pickup", re: /stored in the (gls )?parcelshop|available (in|at) the (gls )?parcelshop|disponible (au|dans le) (gls )?(parcelshop|relais)/i },
    { etape: "out_for_delivery", re: /out for delivery|en cours de livraison|loaded (onto|on) the delivery vehicle/i },
    { etape: "in_transit", re: /handed over to gls|remis [àa] gls|dropped off at the (gls )?parcelshop|d[ée]pos[ée] (au|dans le) (gls )?(parcelshop|relais)|reached the (parcel|depot)|left the (parcel|depot)|arriv[ée] (au|dans le) (centre|d[ée]p[oô]t)|quitt[ée] le (centre|d[ée]p[oô]t)|in transit|en transit|parcel center|centre de tri/i },
    { etape: "exception", re: /return(ed)? to (sender|shipper)|retourn[ée]|could not be delivered|n.a pas pu [eê]tre livr|refused|refus[ée]/i, suite: true },
  ],
};

// Les libelles de l'API La Poste (La Poste, Colissimo, Chronopost, DPD),
// lus seulement quand leur CODE est inconnu (laposte.js) : une formule
// explicite, jamais un mot isole.
INFO.LP = [
  /va bient[oô]t nous [eê]tre confi|pr[ée]paration chez|[ée]tiquette|annonc[ée]|d[ée]claratif/i,
  // « Vous avez fait une demande d'affranchissement » : un achat d'etiquette
  /affranchissement/i,
  /informations? (de votre (envoi|colis) )?(ont [ée]t[ée] )?re[cç]ues?|donn[ée]es (de l.envoi )?re[cç]ues/i,
];
ETAPES.LP = [
  { etape: "exception", re: /retourn[ée] [àa] l.exp[ée]diteur|retour (vers|[àa]) l.exp[ée]diteur|non distribuable|refus[ée] par le destinataire/i, suite: true },
  { etape: "delivered", re: /colis (a [ée]t[ée] |est )?(livr[ée]|distribu[ée])|(a [ée]t[ée]|est) (livr[ée]|distribu[ée])|distribu[ée] (au|[àa]|dans|en)|remis au destinataire|^(colis )?livr[ée]e?s?(?![a-zà-ÿ])/i },
  // Colissimo : « Votre colis vous attend en point relais »
  { etape: "available_for_pickup", re: /vous attend (en|au|dans|[àa])|disponible (en|au|dans|[àa]) (point|bureau|relais|consigne|agence|locker)|en attente d.[eê]tre retir|peut [eê]tre retir/i },
  { etape: "out_for_delivery", re: /en cours de livraison|en cours de distribution|mis en distribution|en tourn[ée]e de livraison/i },
  // DPD : « Tri effectué en agence »
  { etape: "in_transit", re: /pris en charge|d[ée]pos[ée] (en|au|dans|par)|tri effectu|tri[ée] (en|au|dans|par)|en cours d.acheminement|achemin[ée]|arriv[ée] (sur|au|[àa]|dans|en)|centre de tri|plate-?forme|en transit|exp[ée]di[ée] (depuis|par|de|du)|collect[ée]|en cours de traitement|d[ée]douan|quitt[ée] (le|la|notre)/i },
];

/** une ligne d'un transporteur -> { etape, physique, suite } */
function litLibelle(libelle, code = "MR") {
  const l = String(libelle || "");
  if ((INFO[code] || []).some((re) => re.test(l))) return { etape: "info_received", physique: false };
  // au futur ou a la negation : ce n'est pas arrive
  if (PAS_ENCORE.test(l)) return { etape: "unknown", physique: false };
  // une enquete, une reclamation : la suite, jamais une preuve
  if (SECONDAIRES.test(l)) return { etape: "exception", physique: false, suite: true };
  for (const { etape, re, suite } of ETAPES[code] || []) {
    if (re.test(l)) return { etape, physique: true, suite: suite || undefined };
  }
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

// "20:31", "20h31", "8:31 PM" -> "20:31"
function litHeure(ligne) {
  const m = ligne.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\s*([ap])?\.?\s*m?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === "p";
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return `${deux(h)}:${m[2]}`;
}

const estDate = (l) => Boolean(litDate(l)) && l.replace(/[\d/.:\-\s]/g, "").length < 3;
const estHeure = (l) => /^\s*([01]?\d|2[0-3])[:h][0-5]\d\s*([ap]\.?m\.?)?\s*$/i.test(l);

// heure de Paris -> ISO avec fuseau (heure d'ete de fin mars a fin octobre)
function enIso(jour, heure) {
  if (!jour) return null;
  const [a, mo, j] = jour.split("-").map(Number);
  const ms = Date.UTC(a, mo - 1, j, 12);
  const dernierDimanche = (mois) => {
    const d = new Date(Date.UTC(a, mois, 0));
    return d.getUTCDate() - d.getUTCDay();
  };
  const ete = ms >= Date.UTC(a, 2, dernierDimanche(3)) && ms < Date.UTC(a, 9, dernierDimanche(10));
  return `${jour}T${heure || "12:00"}:00${ete ? "+02:00" : "+01:00"}`;
}

const lignesDe = (texte) =>
  String(texte || "")
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

function evenement(code, { jour, heure, libelle, ordre, ligne }) {
  const lu = litLibelle(libelle, code);
  return {
    cle: `nav|${jour || "?"}|${heure || "?"}|${libelle.slice(0, 120)}`,
    survenuLe: enIso(jour, heure),
    code: null,
    libelle: libelle.slice(0, 200),
    lieu: null,
    etape: lu.etape,
    physique: lu.physique,
    incident: lu.suite ? libelle.slice(0, 120) : null,
    resolu: false,
    ordre,
    source: "navigateur",
    // la ligne telle que la page l'affiche, et sa date (sans date : jamais une preuve)
    brut: { ligne, jour, heure, dateComplete: Boolean(jour) },
  };
}

const sansDoublons = (evenements) => {
  const vus = new Set();
  return evenements.filter((e) => (vus.has(e.cle) ? false : vus.add(e.cle)));
};

// --- Mondial Relay : des jours, un titre, puis des paires heure / evenement ----------

function evenementsMR(section) {
  const jours = [];
  let jour = null;
  for (const l of section) {
    if (estDate(l)) {
      jour = { date: litDate(l), titre: null, paires: [], heure: null };
      jours.push(jour);
    } else if (!jour) {
      continue;
    } else if (estHeure(l)) {
      jour.heure = litHeure(l);
    } else if (jour.titre === null && jour.heure === null) {
      // le titre du jour : le dernier evenement du jour, repete
      jour.titre = l;
    } else {
      jour.paires.push({ heure: jour.heure, libelle: l });
      jour.heure = null;
    }
  }
  const evenements = [];
  let ordre = 10_000;
  for (const j of jours) {
    // un jour sans paire : son titre est son seul evenement (sans heure)
    const liste = j.paires.length ? j.paires : j.titre ? [{ heure: null, libelle: j.titre }] : [];
    for (const p of liste) evenements.push(evenement("MR", { jour: j.date, heure: p.heure, libelle: p.libelle, ordre: ordre--, ligne: p.libelle }));
  }
  // une mise en page differente (date, heure et libelle sur une meme ligne) :
  // la lecture ligne a ligne, qui ne garde que les formules connues
  if (!evenements.length || !evenements.some((e) => e.etape !== "unknown")) {
    const lignes = evenementsLignes("MR", section);
    if (lignes.length) return lignes;
  }
  return sansDoublons(evenements);
}

// --- DHL, GLS : une ligne datee (ou la date au-dessus), un libelle -----------------

function evenementsLignes(code, section) {
  const evenements = [];
  let jour = null;
  let heure = null;
  let ordre = 10_000;
  for (const l of section) {
    const d = litDate(l);
    if (d) jour = d;
    const h = litHeure(l);
    if (h) heure = h;
    if (estDate(l) || estHeure(l)) continue;
    // avant toute date : un resume en tete de page (« Livré »), pas un
    // evenement -- un evenement reel est date
    if (!jour) continue;
    // une ligne trop longue est un paragraphe d'aide, pas un evenement
    if (l.length > 160) continue;
    const libelle = l.replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{4}\b/, "").replace(/\b([01]?\d|2[0-3])[:h][0-5]\d\s*([ap]\.?m\.?)?/i, "").replace(/\s+/g, " ").trim() || l;
    const lu = litLibelle(libelle, code);
    if (lu.etape === "unknown") continue;
    evenements.push(evenement(code, { jour, heure, libelle, ordre: ordre--, ligne: l }));
    heure = null;
  }
  return sansDoublons(evenements);
}

const entre = (lignes, debut, fin) => {
  const i = debut ? lignes.findIndex((l) => debut.test(l)) : 0;
  if (i < 0) return null;
  const reste = lignes.slice(i + 1);
  const j = fin ? reste.findIndex((l) => fin.test(l)) : -1;
  return j < 0 ? reste : reste.slice(0, j);
};

// --- Chaque transporteur ---------------------------------------------------------------

const chiffres = (t) => String(t || "").replace(/\D/g, "");

const LECTEURS = {
  MR: {
    introuvable: /aucun colis portant ce num[ée]ro|n.avons identifi[ée] aucun colis/i,
    // la page affiche le numero (souvent ses 8 derniers chiffres) sous
    // « NUMÉRO DE COLIS », ou sur la meme ligne ; a defaut, une ligne faite du
    // numero seul. Jamais le numero du formulaire de recherche (« composé de
    // 8 chiffres ») : il faut 8 chiffres au moins.
    numeroAffiche: (lignes, numero) => {
      for (let i = 0; i < lignes.length; i++) {
        if (!/num[ée]ro (de |d.)?(colis|suivi|exp[ée]dition)|n° (de )?colis/i.test(lignes[i])) continue;
        const ici = chiffres(lignes[i]);
        const d = ici.length >= 8 ? ici : chiffres(lignes[i + 1] || "");
        if (d.length >= 8 && d.length <= 16) return d;
      }
      const n = chiffres(numero);
      const seul = n && lignes.find((l) => /^[\d\s]{8,16}$/.test(l) && (n.endsWith(chiffres(l)) || chiffres(l).endsWith(n)));
      return seul ? chiffres(seul) : null;
    },
    concerne: (affiche, numero) => Boolean(affiche) && (chiffres(numero).includes(affiche) || affiche.includes(chiffres(numero))),
    section: (lignes) => entre(lignes, /^suivi d[ée]taill[ée] de (mon|votre) colis$/i, /^je m.informe$|app.solument|^pour nous suivre$/i),
    evenements: evenementsMR,
  },
  DHL: {
    introuvable: /tentative de suivi a [ée]chou[ée]|tracking attempt (was )?(not successful|failed|unsuccessful)|aucun r[ée]sultat|no result/i,
    numeroAffiche: (lignes, numero) => (lignes.some((l) => l.replace(/\s/g, "").toUpperCase().includes(numero)) ? numero : null),
    concerne: (affiche, numero) => affiche === numero,
    section: (lignes) => entre(lignes, /^(saisissez votre|enter your) .*(num[ée]ro|tracking)|^suivre$|^track$/i, /questions fr[ée]quemment pos[ée]es|frequently asked questions/i),
    evenements: (section) => evenementsLignes("DHL", section),
  },
  GLS: {
    introuvable: /unfortunately there are no results|aucun r[ée]sultat|pas de r[ée]sultat/i,
    numeroAffiche: (lignes, numero) => (lignes.some((l) => chiffres(l).includes(chiffres(numero))) ? numero : null),
    concerne: (affiche, numero) => affiche === numero,
    section: (lignes) => entre(lignes, /^(parcel tracking|suivi (de |des )?colis)$/i, /^(parcel search|recherche de colis)$/i),
    evenements: (section) => evenementsLignes("GLS", section),
  },
};

/**
 * Le texte d'une page officielle -> ce qu'elle dit, pour CE numero.
 *   { etat: "trouve"|"introuvable"|"ambigu"|"bloque"|"illisible"|"autre_numero"|"incomplet",
 *     evenements, statutBrut, motif }
 * Jamais d'evenement physique sans une formule de la liste, datee.
 */
function lisPage(code, { titre = "", texte = "", url = "" } = {}, numero = null) {
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
  const section = lecteur.section(lignes);
  if (!section) {
    // la page n'a pas (encore) affiche son suivi : rien de conclu
    return { etat: "incomplet", evenements: [], statutBrut: null, motif: "la page n'a pas affiché de suivi (chargement incomplet)" };
  }
  // la page est-elle bien celle de CE colis ?
  if (numero) {
    const n = String(numero).toUpperCase();
    const affiche = lecteur.numeroAffiche(lignes, n);
    const dansAdresse = url && decodeURIComponent(url).toUpperCase().includes(n);
    if (!lecteur.concerne(affiche, n) && !(affiche == null && dansAdresse && code !== "MR")) {
      return { etat: "autre_numero", evenements: [], statutBrut: null, motif: `la page affichée ne correspond pas au numéro ${numero}` };
    }
  }
  const evenements = lecteur.evenements(section);
  if (!evenements.length) {
    const apercu = section.slice(0, 6).join(" · ").slice(0, 300);
    return { etat: "illisible", evenements: [], statutBrut: apercu || null, motif: "page lue mais statut non reconnu" };
  }
  const premier = evenements[0];
  return { etat: "trouve", evenements, statutBrut: premier.libelle, motif: null };
}

module.exports = { lisPage, litLibelle, litDate, litHeure, estBloque, LECTEURS, SECONDAIRES };
