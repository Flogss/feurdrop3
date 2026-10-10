// La Poste, Colissimo, Boite jaune, Chronopost et DPD France : l'API officielle Suivi v2
// de La Poste (plateforme Okapi, https://developer.laposte.fr), avec la cle
// deja utilisee par le bot de suivi (OKAPI_KEY).
//
// Teste sur de vrais numeros FeurDrop (octobre 2026) :
//   DR1  "Votre Colissimo va bientot nous etre confie ! Il est en cours de
//        preparation chez votre expediteur."      -> etiquette seulement
//   PC1  "Votre colis a ete depose dans un point postal." -> depot prouve
//   ET1, EP1, MD1, AG1, DI1...                     -> le colis circule
//   400 sur un numero mal forme ; 401 pour une cle refusee.
//
// Un appel = un numero (la syntaxe multi-numeros est reputee peu fiable, voir
// suivi/bot/okapi.js). La cadence et les pauses sont gerees par la file
// (controle/depots.js) : ici, un seul essai par appel, et une erreur dit
// clairement de quoi il s'agit.

const BASE = () => (process.env.LAPOSTE_SUIVI_URL || "https://api.laposte.fr/suivi/v2").replace(/\/+$/, "");
const DELAI_MS = () => Number(process.env.CONTROLE_LAPOSTE_DELAI_MS || 20000);

class ErreurTransporteur extends Error {
  // type : "invalide" (numero refuse), "limite" (trop vite : pause),
  // "bloque" (acces interdit : longue pause), "config" (cle absente ou
  // refusee), "passagere" (reseau, 5xx : reessayer plus tard)
  constructor(type, message, { pauseMs = null } = {}) {
    super(message);
    this.name = "ErreurTransporteur";
    this.type = type;
    this.pauseMs = pauseMs;
  }
}

const estConfigure = () => Boolean(process.env.OKAPI_KEY);
let dejaReussi = false; // une cle qui a deja repondu 200 n'est pas "fausse" sur un 401

// --- Lecture des codes evenement ---------------------------------------------------
// Liste de reference (2020, a completer : des codes comme MD1 ou MD4 existent) :
// https://github.com/e-amzallag/laposte-suivi-api -- un code inconnu n'est
// JAMAIS une preuve de depot.
const INCIDENTS = {
  RE1: "Retourné à l'expéditeur",
  DI2: "Distribué à l'expéditeur (retour)",
  ND1: "Non distribuable",
  DO3: "Retenu en douane",
  PB1: "Problème en cours",
};

function lisCode(code) {
  const c = String(code || "").toUpperCase();
  if (/^DR/.test(c)) return { etape: "info_received", physique: false };
  if (INCIDENTS[c]) return { etape: "exception", physique: true, incident: INCIDENTS[c] };
  if (/^(PC|ET|EP|DO)/.test(c)) return { etape: "in_transit", physique: true };
  if (/^PB/.test(c)) return { etape: "in_transit", physique: true, resolu: true }; // PB2 : probleme resolu
  if (/^MD/.test(c)) return { etape: "out_for_delivery", physique: true };
  if (/^AG/.test(c)) return { etape: "available_for_pickup", physique: true };
  if (/^DI/.test(c)) return { etape: "delivered", physique: true };
  return { etape: "unknown", physique: false };
}

// Un evenement La Poste dans la forme commune du controle des depots.
function versEvenement(e) {
  const lu = lisCode(e.code);
  return {
    cle: `${e.code || "?"}|${e.date || ""}|${e.order ?? ""}`,
    survenuLe: e.date || null,
    code: e.code || null,
    libelle: e.label || null,
    lieu: null, // l'API Suivi v2 ne donne pas de lieu par evenement
    etape: lu.etape,
    physique: lu.physique,
    incident: lu.incident || null,
    resolu: Boolean(lu.resolu),
    ordre: Number.isFinite(e.order) ? e.order : null,
    source: "laposte",
    brut: e,
  };
}

/**
 * Le suivi d'un numero. Renvoie { trouve, evenements, final, produit } ;
 * leve une ErreurTransporteur sinon.
 */
async function verifie(numero) {
  const cle = process.env.OKAPI_KEY;
  if (!cle) throw new ErreurTransporteur("config", "OKAPI_KEY absente : l'API La Poste n'est pas configurée");
  let reponse;
  try {
    reponse = await fetch(`${BASE()}/idships/${encodeURIComponent(numero)}?lang=fr_FR`, {
      headers: { Accept: "application/json", "X-Okapi-Key": cle },
      signal: AbortSignal.timeout(DELAI_MS()),
    });
  } catch (err) {
    throw new ErreurTransporteur("passagere", err.name === "TimeoutError" ? "La Poste ne répond pas (délai dépassé)" : "La Poste injoignable");
  }
  let corps = null;
  try {
    corps = await reponse.json();
  } catch {
    corps = null;
  }

  if (reponse.status === 403) {
    // en pratique : une restriction d'adresse IP sur l'application La Poste
    throw new ErreurTransporteur("bloque", "La Poste refuse l'accès (HTTP 403) : restriction d'adresse IP sur la clé ?", { pauseMs: 6 * 3600e3 });
  }
  if (reponse.status === 401) {
    // trop d'appels : La Poste met la cle "au piquet" plusieurs minutes, avec
    // le meme code qu'une cle refusee
    if (dejaReussi) throw new ErreurTransporteur("limite", "La Poste ralentit les appels (HTTP 401) : pause automatique", { pauseMs: 10 * 60e3 });
    throw new ErreurTransporteur("config", "Clé La Poste refusée (HTTP 401) : vérifier OKAPI_KEY");
  }
  if (reponse.status === 429) {
    const apres = Number(reponse.headers.get("retry-after"));
    throw new ErreurTransporteur("limite", "Quota La Poste atteint (HTTP 429) : pause automatique", {
      pauseMs: Number.isFinite(apres) && apres > 0 ? apres * 1000 : 2 * 60e3,
    });
  }
  if (reponse.status >= 500) throw new ErreurTransporteur("passagere", `La Poste indisponible (HTTP ${reponse.status})`);
  if (reponse.status === 400) {
    dejaReussi = true;
    throw new ErreurTransporteur("invalide", corps?.returnMessage || "Numéro refusé par La Poste");
  }
  if (reponse.status === 404) {
    dejaReussi = true;
    return { trouve: false, evenements: [], final: false, produit: null };
  }
  if (!reponse.ok) throw new ErreurTransporteur("passagere", `Réponse inattendue de La Poste (HTTP ${reponse.status})`);

  dejaReussi = true;
  const s = corps?.shipment;
  if (!s) return { trouve: false, evenements: [], final: false, produit: null };
  const evenements = (Array.isArray(s.event) ? s.event : []).map(versEvenement);
  return { trouve: true, evenements, final: Boolean(s.isFinal), produit: s.product || null };
}

module.exports = { verifie, estConfigure, lisCode, versEvenement, ErreurTransporteur };
