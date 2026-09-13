const { fetchJson } = require("../http");
const { looksLikeLocker } = require("../lockers");

// Points de depot UPS, via leur API Locator.
//
// Endpoint et options tires de la specification officielle
// (github.com/UPS-API/api-documentation, Locator.yaml) :
//   POST /api/locations/{version}/search/availabilities/{reqOption}
//   reqOption = 64 -> recherche des UPS Access Points, c'est-a-dire justement
//   les commerces et casiers qui acceptent un depot.
//
// Comme FedEx, cette source demande un compte : UPS_CLIENT_ID et
// UPS_CLIENT_SECRET (developer.ups.com). Sans eux elle reste eteinte et le
// dit, plutot que de laisser croire qu'il n'y a aucun point UPS.

const HOST = process.env.UPS_API_HOST || "https://onlinetools.ups.com/api";
const CLIENT_ID = process.env.UPS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.UPS_CLIENT_SECRET || "";
const VERSION = "v1";
const ACCESS_POINTS = "64";

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

let token = null;
let tokenExpiry = 0;

async function accessToken() {
  if (token && Date.now() < tokenExpiry) return token;

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const data = await fetchJson(`${HOST}/security/v1/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    timeout: 12000,
  }).catch((err) => {
    throw new Error(
      /401|403/.test(err.message) ? `identifiants refuses par UPS (${err.message})` : err.message
    );
  });

  token = data.access_token;
  tokenExpiry = Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000;
  return token;
}

// "0900" -> "09:00"
function hhmm(value) {
  const match = /^(\d{2})(\d{2})$/.exec(String(value || "").trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

// Horaires du jour demande. UPS renvoie une liste par jour de la semaine ;
// si le jour n'y est pas, on ne sait pas et on n'invente pas.
function hoursFor(location, day) {
  const weekday = DAYS[new Date(`${day}T12:00:00`).getDay()];
  const list = [].concat(location.StandardHoursOfOperation?.DayOfWeek || []);
  const entry = list.find((d) => String(d.Day || "").toUpperCase().startsWith(weekday.slice(0, 3)));
  if (!entry) return null;

  const ranges = [].concat(entry.OperatingHours || entry.OpenHours || [])
    .map((r) => {
      const open = hhmm(r.OpenHours || r.Open);
      const close = hhmm(r.CloseHours || r.Close);
      return open && close ? `${open}-${close}` : null;
    })
    .filter(Boolean);

  return ranges.length > 0 ? { source: "ups", ranges } : null;
}

function joinLines(address) {
  return [].concat(address?.AddressLine || []).filter(Boolean).join(", ");
}

async function searchPoints({ lat, lng, day, limit = 10, radiusKm = 8 }) {
  if (!isConfigured()) {
    throw new Error("UPS : identifiants manquants (UPS_CLIENT_ID / UPS_CLIENT_SECRET)");
  }

  const data = await fetchJson(
    `${HOST}/locations/${VERSION}/search/availabilities/${ACCESS_POINTS}?Locale=fr_FR`,
    {
      method: "POST",
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await accessToken()}`,
        transId: `drop-${Date.now()}`,
        transactionSrc: "drop-ctrl",
      },
      body: JSON.stringify({
        LocatorRequest: {
          Request: { RequestAction: "Locator", RequestOption: ACCESS_POINTS },
          OriginAddress: {
            // la recherche par coordonnees evite de dependre de la qualite
            // d'une adresse de depart tapee a la main
            Geocode: { Latitude: String(lat), Longitude: String(lng) },
            AddressKeyFormat: { CountryCode: "FR" },
          },
          Translate: { LanguageCode: "FRA", Locale: "fr_FR" },
          UnitOfMeasurement: { Code: "KM" },
          LocationSearchCriteria: {
            MaximumListSize: String(limit),
            SearchRadius: String(radiusKm),
            AccessPointSearch: { AccessPointStatus: "01" }, // actif et disponible
          },
        },
      }),
    }
  );

  const locations = [].concat(data.LocatorResponse?.SearchResults?.DropLocation || []);
  return locations
    .map((location) => {
      const geo = location.Geocode || {};
      const lat2 = Number(geo.Latitude);
      const lng2 = Number(geo.Longitude);
      if (!Number.isFinite(lat2) || !Number.isFinite(lng2)) return null;

      const address = location.AddressKeyFormat || {};
      const name = address.ConsigneeName || location.LocationName || `Point UPS ${location.LocationID}`;
      const classification = []
        .concat(location.AccessPointInformation?.BusinessClassificationList?.BusinessClassification || [])
        .map((c) => c.Description)
        .filter(Boolean)
        .join(", ");

      return {
        source: "ups",
        source_ref: String(location.LocationID || address.ConsigneeName),
        name,
        kind: classification || "Point relais UPS",
        // UPS ne distingue pas explicitement ses casiers dans cette API :
        // on se rabat sur le libelle, comme ailleurs
        locker: looksLikeLocker({ name, kind: classification }),
        address: joinLines(address),
        postal_code: address.PostcodePrimaryLow || null,
        city: address.PoliticalDivision2 || null,
        lat: lat2,
        lng: lng2,
        carriers: ["UPS"],
        hours: hoursFor(location, day),
      };
    })
    .filter(Boolean);
}

module.exports = { searchPoints, isConfigured };
