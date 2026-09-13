const { fetchJson } = require("../http");

// Points de depot FedEx, via leur API "Location Search" (developer.fedex.com).
//
// Contrairement aux autres sources de ce dossier, celle-ci demande un compte :
// une cle et un secret a creer sur developer.fedex.com, puis a poser dans
// FEDEX_API_KEY et FEDEX_API_SECRET. Sans eux la source reste eteinte et le
// dit -- elle ne renvoie pas une liste vide qui passerait pour "il n'y a aucun
// point FedEx dans le coin".

const HOST = process.env.FEDEX_API_HOST || "https://apis.fedex.com";
const KEY = process.env.FEDEX_API_KEY || "";
const SECRET = process.env.FEDEX_API_SECRET || "";

function isConfigured() {
  return Boolean(KEY && SECRET);
}

// --- Jeton OAuth -------------------------------------------------------------
// FedEx delivre un jeton d'environ une heure. On le garde en memoire et on le
// renouvelle une minute avant l'echeance.
let token = null;
let tokenExpiry = 0;

async function accessToken() {
  if (token && Date.now() < tokenExpiry) return token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: KEY,
    client_secret: SECRET,
  });
  const data = await fetchJson(`${HOST}/oauth/token`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 12000,
  }).catch((err) => {
    // un 401 ici n'est pas une panne : c'est la cle ou le secret qui ne vont
    // pas. Le dire evite de chercher ailleurs.
    throw new Error(
      /401|403/.test(err.message)
        ? `cle ou secret refuses par FedEx (${err.message})`
        : err.message
    );
  });

  token = data.access_token;
  tokenExpiry = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
  return token;
}

// --- Recherche ---------------------------------------------------------------

const DAYS = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

function hhmm(value) {
  const match = /^(\d{2}):(\d{2})/.exec(String(value || ""));
  return match ? `${match[1]}:${match[2]}` : null;
}

// Horaires du jour demande, tels que FedEx les publie. Si le jour n'est pas
// dans la reponse, on ne sait pas : on ne remplit rien.
function hoursFor(detail, day) {
  const weekday = new Date(`${day}T12:00:00`).getDay();
  const entry = (detail.storeHours || []).find((h) => DAYS[h.dayofweek] === weekday);
  if (!entry) return null;

  const ranges = (entry.exceptionalHours || entry.operationalHours || [])
    .map((r) => {
      const begins = hhmm(r.begins);
      const ends = hhmm(r.ends);
      return begins && ends ? `${begins}-${ends}` : null;
    })
    .filter(Boolean);

  return ranges.length > 0 ? { source: "fedex", ranges } : null;
}

// Points FedEx acceptant un DEPOT autour d'une adresse. `address` doit etre
// l'adresse de depart : l'API cherche par adresse, pas par coordonnees.
async function searchPoints({ address, postalCode, city, day, limit = 10 }) {
  if (!isConfigured()) throw new Error("FedEx : cle et secret manquants (FEDEX_API_KEY/SECRET)");

  const data = await fetchJson(`${HOST}/location/v1/locations`, {
    method: "POST",
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${await accessToken()}`,
      "x-locale": "fr_FR",
    },
    body: JSON.stringify({
      locationsSummaryRequestControlParameters: { maxResults: limit, distance: { units: "KM", value: 10 } },
      locationSearchCriterion: "ADDRESS",
      location: {
        address: {
          streetLines: [address].filter(Boolean),
          city,
          postalCode,
          countryCode: "FR",
        },
      },
      sort: { criteria: "DISTANCE", order: "ASCENDING" },
      // le point doit accepter qu'on lui remette un colis, pas seulement en
      // distribuer : c'est toute la difference entre un depot et un retrait
      locationCapabilities: [{ transferOfPossessionType: "DROPOFF" }],
      multipleMatchesAction: "RETURN_ALL",
    }),
  });

  const list = data.output?.locationDetailList || [];
  return list
    .map((detail) => {
      const address2 = detail.contactAndAddress?.address || {};
      const coords = detail.geoPositionalCoordinates || {};
      if (!coords.latitude || !coords.longitude) return null;

      return {
        source: "fedex",
        source_ref: detail.locationId,
        name: detail.contactAndAddress?.contact?.companyName || `FedEx ${detail.locationId}`,
        kind: detail.locationType || "Point FedEx",
        address: (address2.streetLines || []).join(", "),
        postal_code: address2.postalCode,
        city: address2.city,
        lat: coords.latitude,
        lng: coords.longitude,
        carriers: ["FEDEX"],
        hours: hoursFor(detail, day),
      };
    })
    .filter(Boolean);
}

module.exports = { searchPoints, isConfigured };
