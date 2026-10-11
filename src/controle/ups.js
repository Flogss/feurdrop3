// UPS : l'API officielle « Tracking » (https://developer.ups.com), la seule
// facon autorisee d'automatiser le suivi UPS -- ses conditions d'utilisation
// interdisent les « systèmes d'interrogation automatisés » sur son site.
//
// Il faut une application UPS (gratuite) : UPS_CLIENT_ID et UPS_CLIENT_SECRET.
// Sans elles, UPS reste « à la main » (la page officielle s'ouvre).
//
// Le format suivi est celui de la documentation UPS (Track API v1) :
//   jeton  POST /security/v1/oauth/token  (Basic client_id:secret,
//          grant_type=client_credentials) -> { access_token, expires_in }
//   suivi  GET  /api/track/v1/details/{numero}  (Bearer, transId,
//          transactionSrc) -> trackResponse.shipment[0].package[0].activity[]
//          avec status.type : M (étiquette / facturation reçue), MV (annulée),
//          P (enlevé), I (en transit), O (en livraison), D (livré),
//          X (exception), RS (retour à l'expéditeur), DO, DD, W.
// Pas encore essaye avec de vrais identifiants : teste contre un faux serveur
// au meme format (test/fixtures/faux-transporteurs.js).

const { randomUUID } = require("crypto");
const { ErreurTransporteur } = require("./laposte");

const BASE = () => (process.env.UPS_API_URL || "https://onlinetools.ups.com").replace(/\/+$/, "");
const estConfigure = () => Boolean(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET);

// ce qu'un type d'activite UPS prouve
const TYPES = {
  M: { etape: "info_received", physique: false },
  MV: { etape: "info_received", physique: false },
  P: { etape: "in_transit", physique: true },
  I: { etape: "in_transit", physique: true },
  O: { etape: "out_for_delivery", physique: true },
  D: { etape: "delivered", physique: true },
  DO: { etape: "delivered", physique: true },
  DD: { etape: "delivered", physique: true },
  W: { etape: "in_transit", physique: true },
  RS: { etape: "exception", physique: true, incident: "Retourné à l'expéditeur" },
  // une exception peut arriver avant l'enlevement : jamais une preuve seule
  X: { etape: "exception", physique: false, incident: "Exception UPS" },
};
// une description qui dit que UPS n'a pas encore le colis l'emporte sur le type
const PAS_ENCORE = /not (yet )?received|has not received|label (created|has been created)|shipper created a label|billing information|n.a pas encore (re[cç]u|le colis)|[ée]tiquette cr[ée]{1,2}e/i;

let jeton = null;

async function obtientJeton() {
  if (jeton && jeton.expire > Date.now() + 60 * 1000) return jeton.valeur;
  let r;
  try {
    r = await fetch(`${BASE()}/security/v1/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ErreurTransporteur("passagere", "UPS injoignable (jeton)");
  }
  if (r.status === 401 || r.status === 403) throw new ErreurTransporteur("config", "Identifiants UPS refusés (UPS_CLIENT_ID / UPS_CLIENT_SECRET)");
  if (!r.ok) throw new ErreurTransporteur("passagere", `UPS : jeton indisponible (HTTP ${r.status})`);
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new ErreurTransporteur("passagere", "UPS : réponse de jeton inattendue");
  jeton = { valeur: j.access_token, expire: Date.now() + Number(j.expires_in || 3600) * 1000 };
  return jeton.valeur;
}

// "20261009" + "203100" (+ "-05:00") -> ISO
function enIso(date, heure, decalage) {
  if (!/^\d{8}$/.test(String(date || ""))) return null;
  const d = String(date), h = /^\d{6}$/.test(String(heure || "")) ? String(heure) : "120000";
  const z = /^[+-]\d{2}:\d{2}$/.test(String(decalage || "")) ? decalage : "+00:00";
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}${z}`;
}

function versEvenement(a, i) {
  const st = a.status || {};
  let lu = TYPES[String(st.type || "").toUpperCase()] || { etape: "unknown", physique: false };
  if (lu.physique && PAS_ENCORE.test(st.description || "")) lu = { etape: "info_received", physique: false };
  const ville = a.location?.address?.city;
  const survenuLe = enIso(a.date, a.time, a.gmtOffset);
  return {
    // stable d'une lecture a l'autre (un nouvel evenement arrive en tete :
    // jamais l'index, sinon tout serait double)
    cle: `ups|${a.date || ""}|${a.time || ""}|${st.code || st.type || "?"}|${String(st.description || "").slice(0, 80)}`,
    survenuLe,
    code: st.code || st.type || null,
    libelle: st.description || null,
    lieu: ville ? `${ville}${a.location?.address?.countryCode ? ` (${a.location.address.countryCode})` : ""}` : null,
    etape: lu.etape,
    physique: lu.physique,
    incident: lu.incident || null,
    resolu: false,
    ordre: 1000 - i,
    source: "ups",
    brut: a,
  };
}

const introuvable = (corps) =>
  [...(corps?.response?.errors || []), ...(corps?.trackResponse?.shipment?.[0]?.warnings || [])].some(
    (e) => /^TW0001$/.test(String(e.code || "")) || /not found|introuvable/i.test(String(e.message || ""))
  );

async function verifie(numero) {
  if (!estConfigure()) throw new ErreurTransporteur("config", "UPS_CLIENT_ID / UPS_CLIENT_SECRET absents : UPS se vérifie à la main");
  const valeur = await obtientJeton();
  let r;
  try {
    r = await fetch(`${BASE()}/api/track/v1/details/${encodeURIComponent(numero)}?locale=fr_FR&returnSignature=false&returnMilestones=false&returnPOD=false`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${valeur}`, transId: randomUUID().replace(/-/g, "").slice(0, 32), transactionSrc: "FeurDrop" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new ErreurTransporteur("passagere", err.name === "TimeoutError" ? "UPS ne répond pas (délai dépassé)" : "UPS injoignable");
  }
  const corps = await r.json().catch(() => null);
  if (r.status === 401) {
    jeton = null;
    throw new ErreurTransporteur("passagere", "UPS : jeton expiré, nouvel essai");
  }
  if (r.status === 403) throw new ErreurTransporteur("bloque", "UPS refuse l'accès (HTTP 403)", { pauseMs: 6 * 3600e3 });
  if (r.status === 429) throw new ErreurTransporteur("limite", "Quota UPS atteint (HTTP 429)", { pauseMs: 15 * 60e3 });
  if (r.status >= 500) throw new ErreurTransporteur("passagere", `UPS indisponible (HTTP ${r.status})`);
  if (r.status === 404 || introuvable(corps)) return { trouve: false, evenements: [], final: false, produit: null };
  if (r.status === 400) throw new ErreurTransporteur("invalide", corps?.response?.errors?.[0]?.message || "Numéro refusé par UPS");
  if (!r.ok) throw new ErreurTransporteur("passagere", `Réponse inattendue d'UPS (HTTP ${r.status})`);
  const colis = corps?.trackResponse?.shipment?.[0]?.package?.[0];
  if (!colis) return { trouve: false, evenements: [], final: false, produit: null };
  const evenements = (Array.isArray(colis.activity) ? colis.activity : []).map(versEvenement);
  return { trouve: true, evenements, final: evenements.some((e) => e.etape === "delivered"), produit: "ups" };
}

module.exports = { verifie, estConfigure, versEvenement, TYPES, _remiseAZero: () => (jeton = null) };
