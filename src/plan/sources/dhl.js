const { fetchJson, withParams } = require("../http");
const { looksLikeLocker } = require("../lockers");

// Points de depot DHL, via leur API "Location Finder" (developer.dhl.com).
//
// Pourquoi une API et pas leur site : le localisateur DHL est une application
// JavaScript qui parle a un service protege, et OpenStreetMap ne connait que
// trois points DHL dans toute l'Ile-de-France. Leur API, elle, est gratuite et
// documentee -- il suffit d'une cle dans DHL_API_KEY.
//
// Sans cle, la source reste eteinte et le dit.

const HOST = process.env.DHL_API_HOST || "https://api.dhl.com";
const KEY = process.env.DHL_API_KEY || "";

function isConfigured() {
  return Boolean(KEY);
}

// DHL note les jours en vocabulaire schema.org : "http://schema.org/Monday".
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hhmm(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || "").trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

// Horaires du jour demande. Un jour absent de la reponse veut dire ferme ce
// jour-la, ce qui est une information : on la garde, plage vide.
function hoursFor(place, day) {
  const list = place?.openingHours;
  if (!Array.isArray(list) || list.length === 0) return null;

  const wanted = DAYS[new Date(`${day}T12:00:00`).getDay()];
  const ranges = list
    .filter((h) => String(h.dayOfWeek || "").endsWith(wanted))
    .map((h) => {
      const opens = hhmm(h.opens);
      const closes = hhmm(h.closes);
      return opens && closes ? `${opens}-${closes}` : null;
    })
    .filter(Boolean);

  return { source: "dhl", ranges };
}

async function searchPoints({ lat, lng, day, radius = 5000, limit = 15 }) {
  if (!isConfigured()) throw new Error("DHL : cle manquante (DHL_API_KEY)");

  const data = await fetchJson(
    withParams(`${HOST}/location-finder/v1/find-by-geo`, {
      latitude: lat,
      longitude: lng,
      radius,
      limit,
      countryCode: "FR",
    }),
    { timeout: 15000, headers: { "DHL-API-Key": KEY } }
  ).catch((err) => {
    throw new Error(/401|403/.test(err.message) ? `cle refusee par DHL (${err.message})` : err.message);
  });

  return (data.locations || [])
    .map((entry) => {
      const place = entry.place || {};
      const address = place.address || {};
      const geo = place.geo || {};
      if (!geo.latitude || !geo.longitude) return null;

      const name = entry.name || entry.location?.keyword || "Point DHL";
      const kind = entry.location?.type || "Service Point";

      return {
        source: "dhl",
        source_ref: String(entry.location?.ids?.[0]?.locationId || entry.url || name),
        name,
        kind,
        locker: /locker|packstation/i.test(kind) || looksLikeLocker({ name, kind }),
        address: address.streetAddress || "",
        postal_code: address.postalCode || null,
        city: address.addressLocality || null,
        lat: geo.latitude,
        lng: geo.longitude,
        carriers: ["DHL"],
        hours: hoursFor(place, day),
      };
    })
    .filter(Boolean);
}

module.exports = { searchPoints, isConfigured };
