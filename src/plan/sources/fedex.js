const { fetchJson } = require("../http");
const { looksLikeLocker } = require("../lockers");

// Points de depot FedEx, via leur API "Location Search" (developer.fedex.com).
//
// Contrairement aux autres sources de ce dossier, celle-ci demande un compte :
// une cle et un secret a creer sur developer.fedex.com, puis a poser dans
// FEDEX_API_KEY et FEDEX_API_SECRET. Sans eux la source reste eteinte et le
// dit -- elle ne renvoie pas une liste vide qui passerait pour "il n'y a aucun
// point FedEx dans le coin".

const PROD = "https://apis.fedex.com";
const SANDBOX = "https://apis-sandbox.fedex.com";
// Les cles de bac a sable sont refusees en production avec un message clair :
// on bascule alors une fois pour toutes, et on le signale dans le plan pour
// que personne ne prenne des donnees d'essai pour des donnees reelles.
let HOST = process.env.FEDEX_API_HOST || PROD;
let sandbox = HOST === SANDBOX;
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
  const ask = (host) =>
    fetchJson(`${host}/oauth/token`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 12000,
    });

  let data;
  try {
    data = await ask(HOST);
  } catch (err) {
    if (HOST === PROD && /403/.test(err.message)) {
      // "Sandbox credentials not allowed in this environment"
      HOST = SANDBOX;
      sandbox = true;
      console.log("[plan] FedEx : cles de bac a sable, bascule sur apis-sandbox.fedex.com");
      data = await ask(HOST).catch((err2) => {
        throw new Error(`cle ou secret refuses par FedEx (${err2.message})`);
      });
    } else if (/401|403/.test(err.message)) {
      throw new Error(`cle ou secret refuses par FedEx (${err.message})`);
    } else {
      throw err;
    }
  }

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

// La reponse reelle ne suit pas tout a fait la specification : le jour s'y
// appelle `dayOfWeek` (et non `dayofweek`), et `operationalHours` est un objet
// unique, pas un tableau. On accepte les deux formes.

function hhmm(value) {
  const match = /^(\d{2}):(\d{2})/.exec(String(value || ""));
  return match ? `${match[1]}:${match[2]}` : null;
}

// Horaires du jour demande, tels que FedEx les publie. Si le jour n'est pas
// dans la reponse, on ne sait pas : on ne remplit rien.
function hoursFor(detail, day) {
  const weekday = new Date(`${day}T12:00:00`).getDay();
  const entry = (detail.storeHours || []).find(
    (h) => DAYS[h.dayOfWeek || h.dayofweek] === weekday
  );
  if (!entry) return null;
  if (entry.operationalHoursType === "CLOSED_ALL_DAY") {
    return { source: "fedex", ranges: [] }; // ferme ce jour-la, et on le sait
  }

  const ranges = []
    .concat(entry.exceptionalHours || entry.operationalHours || [])
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

  // le jeton d'abord : c'est lui qui peut faire basculer HOST vers le bac a
  // sable, et l'URL doit etre construite APRES cette bascule
  const bearer = await accessToken();

  const data = await fetchJson(`${HOST}/location/v1/locations`, {
    method: "POST",
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${bearer}`,
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
        kind:
          detail.contactAndAddress?.addressAncillaryDetail?.displayName ||
          detail.locationType ||
          "Point FedEx",
        // FedEx a un drapeau pour ca, mais il ne suit pas toujours le
        // libelle ("Locker Lav Express" sort avec lockerAvailability a faux) :
        // on retient le casier des que l'un des deux le dit
        locker:
          Boolean(detail.lockerAvailability) ||
          looksLikeLocker({
            name: detail.contactAndAddress?.contact?.companyName,
            kind: detail.locationType,
          }),
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

function isSandbox() {
  return sandbox;
}

module.exports = { searchPoints, isConfigured, isSandbox };
