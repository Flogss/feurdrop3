// DHL : l'API officielle « Shipment Tracking - Unified »
// (https://developer.dhl.com), avec une cle gratuite : DHL_API_KEY. Sans
// elle, la page officielle DHL est lue par l'app Drop du Mac.
//
// Le format suivi est celui de la documentation DHL :
//   GET https://api-eu.dhl.com/track/shipments?trackingNumber=...&language=fr
//   en-tete DHL-API-Key ; 404 = aucun envoi ; 429 = trop d'appels.
//   shipments[0].events[] : { timestamp (ISO), location.address.addressLocality,
//   statusCode : pre-transit | transit | delivered | failure | unknown,
//   status, description }
// Pas encore essaye avec une vraie cle : teste contre un faux serveur au meme
// format (test/fixtures/faux-transporteurs.js).

const { ErreurTransporteur } = require("./laposte");
const { litLibelle } = require("./pages");

const BASE = () => (process.env.DHL_API_URL || "https://api-eu.dhl.com").replace(/\/+$/, "");
const estConfigure = () => Boolean(process.env.DHL_API_KEY);

function versEvenement(e, i) {
  const code = String(e.statusCode || "").toLowerCase();
  const texte = e.description || e.status || "";
  // le code de DHL, confirme par sa phrase (lecteur DHL des pages) :
  // « pre-transit » n'est jamais une preuve, « transit » seulement si la
  // phrase ne dit pas le contraire
  const phrase = litLibelle(texte, "DHL");
  let lu;
  if (code === "pre-transit") lu = { etape: "info_received", physique: false };
  else if (code === "delivered") lu = phrase.etape === "info_received" ? phrase : { etape: "delivered", physique: true };
  else if (code === "transit") lu = phrase.etape === "info_received" ? phrase : { etape: phrase.physique ? phrase.etape : "in_transit", physique: true };
  else lu = phrase.physique && !phrase.suite ? phrase : { etape: phrase.etape === "info_received" ? "info_received" : code === "failure" ? "exception" : "unknown", physique: false };
  return {
    // stable d'une lecture a l'autre (jamais l'index : un nouvel evenement
    // arrive en tete)
    cle: `dhl|${e.timestamp || ""}|${code}|${texte.slice(0, 80)}`,
    survenuLe: e.timestamp || null,
    code: e.statusCode || null,
    libelle: texte || null,
    lieu: e.location?.address?.addressLocality || null,
    etape: lu.etape,
    physique: lu.physique,
    incident: code === "failure" ? texte.slice(0, 120) || "Incident DHL" : null,
    resolu: false,
    ordre: 1000 - i,
    source: "dhl",
    brut: e,
  };
}

async function verifie(numero) {
  if (!estConfigure()) throw new ErreurTransporteur("config", "DHL_API_KEY absente : DHL se lit sur le Mac");
  let r;
  try {
    r = await fetch(`${BASE()}/track/shipments?trackingNumber=${encodeURIComponent(numero)}&language=fr`, {
      headers: { Accept: "application/json", "DHL-API-Key": process.env.DHL_API_KEY },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new ErreurTransporteur("passagere", err.name === "TimeoutError" ? "DHL ne répond pas (délai dépassé)" : "DHL injoignable");
  }
  if (r.status === 401) throw new ErreurTransporteur("config", "Clé DHL refusée (DHL_API_KEY)");
  if (r.status === 403) throw new ErreurTransporteur("bloque", "DHL refuse l'accès (HTTP 403)", { pauseMs: 6 * 3600e3 });
  if (r.status === 429) throw new ErreurTransporteur("limite", "Quota DHL atteint (HTTP 429)", { pauseMs: 60 * 60e3 });
  if (r.status >= 500) throw new ErreurTransporteur("passagere", `DHL indisponible (HTTP ${r.status})`);
  if (r.status === 404) return { trouve: false, evenements: [], final: false, produit: null };
  if (r.status === 400) throw new ErreurTransporteur("invalide", "Numéro refusé par DHL");
  if (!r.ok) throw new ErreurTransporteur("passagere", `Réponse inattendue de DHL (HTTP ${r.status})`);
  const corps = await r.json().catch(() => null);
  const envoi = corps?.shipments?.[0];
  if (!envoi) return { trouve: false, evenements: [], final: false, produit: null };
  const evenements = (Array.isArray(envoi.events) ? envoi.events : []).map(versEvenement);
  return { trouve: true, evenements, final: String(envoi.status?.statusCode || "") === "delivered", produit: envoi.service || "dhl" };
}

module.exports = { verifie, estConfigure, versEvenement };
