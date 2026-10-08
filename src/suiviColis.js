// Le suivi d'un colis chez son transporteur : retrouver son numero de suivi
// dans ce qu'on sait de lui (nom du fichier, legende) et construire le lien de
// la page officielle du transporteur.
//
// Ajouter un transporteur = ajouter une entree a TRANSPORTEURS : son nom, sa
// page de suivi, la forme de ses numeros et le lien qui ouvre un numero.
//
// Chaque lien a ete verifie sur le site officiel (octobre 2026) : il ouvre le
// suivi avec le numero deja saisi. Un transporteur sans lien direct (`lien`
// absent) garde sa page officielle (`page`) : le portail copie alors le
// numero avant de l'ouvrir, plutot que d'inventer une adresse.

const TRANSPORTEURS = {
  LP: {
    nom: "La Poste",
    page: "https://www.laposte.fr/outils/suivre-vos-envois",
    lien: (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`,
    motifs: [
      // Colissimo, lettre suivie : 6A07648914126, 8R48055558763 (aussi au
      // milieu d'un nom de fichier : BOITEJAUNE6N00031133081)
      { re: /(?<!\d)(\d[A-Z]\d{11})(?!\d)/, distinctif: true },
      // international : XN471249401FR
      { re: /^([A-Z]{2}\d{9}FR)$/, distinctif: true },
      // arrive de l'etranger (CF518373960DE) : La Poste le suit aussi
      { re: /^([A-Z]{2}\d{9}[A-Z]{2})$/ },
    ],
  },
  CHRONO: {
    nom: "Chronopost",
    page: "https://www.chronopost.fr/tracking-no-cms/suivi-page",
    lien: (n) => `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${n}&langue=fr`,
    motifs: [
      // XT269045554TS ; avec FR a la fin, c'est aussi la forme de La Poste
      { re: /^([A-Z]{2}\d{9}(?!FR)[A-Z]{2})$/, distinctif: true },
      { re: /^([A-Z]{2}\d{9}FR)$/ },
    ],
  },
  MR: {
    nom: "Mondial Relay",
    page: "https://www.mondialrelay.fr/suivi-de-colis/",
    // le code postal du destinataire, que demande le formulaire, n'est pas
    // necessaire avec un vrai numero
    lien: (n) => `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${n}`,
    motifs: [
      // 8, 10 ou 12 chiffres ; 14 pour les lockers (74725995540101)
      { re: /^(\d{8}|\d{10}|\d{12})$/ },
      { re: /^(\d{10}0101)$/ },
      // nom de fichier "5675568916MG.pdf"
      { re: /^(\d{10})[A-Z]{2}$/ },
      // le code-barre complet (26 chiffres) : ses 10 premiers chiffres sont
      // le numero (les deux ouvrent le meme colis chez Mondial Relay)
      { re: /^(\d{10})0101\d{12}$/ },
    ],
  },
  DPD: {
    nom: "DPD",
    page: "https://www.dpd.com/fr/fr/",
    // l'adresse que construit le formulaire de dpd.com/fr ; elle mene au
    // suivi officiel (dpdgroup.com/fr/mydpd/my-parcels/search?parcelNumber=…)
    lien: (n) => `https://my.dpd.fr/${n}`,
    motifs: [
      // 14 chiffres, parfois suivis d'une cle de controle
      { re: /^(0\d{13})\d?$/, distinctif: true },
      { re: /^(\d{14})\d?$/ },
    ],
  },
  UPS: {
    nom: "UPS",
    page: "https://www.ups.com/track?loc=fr_FR",
    lien: (n) => `https://www.ups.com/track?loc=fr_FR&tracknum=${n}&requester=ST/trackdetails`,
    motifs: [{ re: /(1Z[0-9A-Z]{16})$/, distinctif: true }],
  },
  DHL: {
    nom: "DHL",
    page: "https://www.dhl.com/fr-fr/home/suivi.html",
    lien: (n) => `https://www.dhl.com/fr-fr/home/suivi.html?tracking-id=${n}&submit=1`,
    motifs: [
      // DHL Paket : JJD014600012865373270
      { re: /^(JJD\d{16,22})$/, distinctif: true },
      // DHL Express : 10 chiffres
      { re: /^(\d{10})$/ },
    ],
  },
  FEDEX: {
    nom: "FedEx",
    page: "https://www.fedex.com/fedextrack/",
    lien: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
    motifs: [{ re: /^(\d{12,22})$/ }],
  },
  GLS: {
    nom: "GLS",
    page: "https://gls-group.com/FR/fr/suivi-colis/",
    lien: (n) => `https://gls-group.com/FR/fr/suivi-colis/?match=${n}`,
    motifs: [{ re: /^(\d{11,12})$/ }],
  },
};

// Des noms de fichier qui disent a eux seuls le transporteur, quoi qu'en
// pense le dashboard : "Locker_74725995540101.pdf" et "5677787663MG.pdf" sont
// des Mondial Relay.
const NOMS_EXPLICITES = [
  { re: /^LOCKER[_ -]?(\d{14})$/i, code: "MR" },
  { re: /^(\d{10})MG$/i, code: "MR" },
];

// Quand le numero trouve n'a pas la forme du transporteur affiche (detection
// trompee par une legende, "PR DHL & GLS"), une forme qui n'appartient qu'a un
// seul transporteur tranche : 1Z… est forcement UPS, JJD… forcement DHL.
// Dans cet ordre : du plus sur au moins sur.
const ORDRE_DISTINCTIF = ["UPS", "DHL", "LP", "CHRONO", "DPD"];

// "6A07648914126 (2).pdf" -> "6A07648914126"
function sansExtension(nom) {
  return String(nom || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s*\(\d+\)$/, "");
}

// Les morceaux qui peuvent etre un numero de suivi.
function candidats(colis) {
  const liste = [];
  for (const texte of [sansExtension(colis.file_name), colis.caption || ""]) {
    const haut = texte.toUpperCase();
    for (const jeton of haut.split(/[^A-Z0-9]+/)) if (jeton.length >= 8) liste.push(jeton);
    // un numero ecrit par groupes : "46 8481 6076"
    for (const m of haut.matchAll(/(?<![A-Z0-9])\d{2,5}(?: \d{2,5}){1,6}(?![A-Z0-9])/g)) {
      const joint = m[0].replace(/ /g, "");
      if (joint.length >= 10 && joint.length <= 22) liste.push(joint);
    }
  }
  return liste;
}

function chercheChez(code, jetons, { distinctifsSeulement = false } = {}) {
  const transporteur = TRANSPORTEURS[code];
  if (!transporteur) return null;
  for (const motif of transporteur.motifs) {
    if (distinctifsSeulement && !motif.distinctif) continue;
    for (const jeton of jetons) {
      const m = jeton.match(motif.re);
      if (m) return { code, numero: m[1] };
    }
  }
  return null;
}

// Le transporteur du colis tel que le dashboard le connait (une boite jaune
// part par La Poste).
function transporteurDuColis(colis) {
  return colis.type === "bj" ? "LP" : colis.carrier || null;
}

// { code, numero } ou null. Le transporteur du dashboard d'abord ; a defaut,
// une forme de numero qui ne trompe pas.
function trouveSuivi(colis) {
  const nom = sansExtension(colis.file_name).trim();
  for (const regle of NOMS_EXPLICITES) {
    const m = nom.match(regle.re);
    if (m) return { code: regle.code, numero: m[1].toUpperCase() };
  }
  const jetons = candidats(colis);
  if (jetons.length === 0) return null;
  const code = transporteurDuColis(colis);
  if (code) {
    const trouve = chercheChez(code, jetons);
    if (trouve) return trouve;
  }
  for (const autre of ORDRE_DISTINCTIF) {
    if (autre === code) continue;
    const trouve = chercheChez(autre, jetons, { distinctifsSeulement: true });
    if (trouve) return trouve;
  }
  return null;
}

// Ce que le portail affiche pour suivre un colis : le numero, le transporteur,
// le lien direct (null si le transporteur n'en a pas) et sa page de suivi.
function suiviDuColis(colis) {
  const trouve = trouveSuivi(colis);
  if (!trouve) return null;
  const t = TRANSPORTEURS[trouve.code];
  return {
    numero: trouve.numero,
    transporteur: trouve.code,
    nom: t.nom,
    lien: t.lien ? t.lien(encodeURIComponent(trouve.numero)) : null,
    page: t.page,
  };
}

module.exports = { TRANSPORTEURS, trouveSuivi, suiviDuColis, transporteurDuColis };
