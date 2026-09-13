const { fetchJson } = require("../http");
const { parseOsmHours } = require("../hours");

// OpenStreetMap, via Overpass. Gratuit et sans compte, mais contributif :
// dans Paris intra-muros on y trouve une dizaine de Mondial Relay la ou il en
// existe des centaines, et un point ferme depuis deux ans peut y rester. Tout
// ce qui sort d'ici est donc marque "a verifier" et ne sert que faute de
// mieux.
//
// La Poste n'est volontairement pas cherchee ici : son propre referentiel est
// complet et fiable (voir sources/laposte.js).

// Les instances publiques d'Overpass saturent regulierement (504) : on essaie
// les miroirs l'un apres l'autre avant d'abandonner.
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const TRY_MS = 9000; // par serveur
const BUDGET_MS = 18000; // pour l'ensemble des essais
const REGION_TRY_MS = 120000; // la requete regionale est autrement plus lourde

// Marques reconnues sans ambiguite. Une marque absente de cette table n'est
// rattachee a aucun transporteur : mieux vaut ne rien proposer que proposer un
// point qui refusera le colis.
const BRANDS = [
  { match: /mondial\s*relay/i, carriers: ["MR"] },
  { match: /pickup/i, carriers: ["CHRONO", "DPD"] },
  { match: /chronopost/i, carriers: ["CHRONO"] },
  { match: /\bdpd\b/i, carriers: ["DPD"] },
  { match: /\bups\b/i, carriers: ["UPS"] },
  { match: /\bdhl\b/i, carriers: ["DHL"] },
  { match: /\bgls\b/i, carriers: ["GLS"] },
];

function carriersFor(tags) {
  const label = `${tags.brand || ""} ${tags.operator || ""} ${tags.name || ""}`;
  const found = new Set();
  for (const brand of BRANDS) {
    if (brand.match.test(label)) brand.carriers.forEach((c) => found.add(c));
  }
  return [...found];
}

const BRAND_FILTER = "Mondial Relay|Pickup|Chronopost|DPD|UPS|DHL|GLS";

// Emprise de l'Ile-de-France. Une seule requete pour toute la region vaut
// mieux qu'un ratissage autour de chaque depart : le resultat couvre les
// endroits ou on n'est pas encore alle.
const IDF_BBOX = "48.10,1.40,49.25,3.60";

function buildQuery(area, timeout) {
  const filters = [
    `nwr["brand"~"${BRAND_FILTER}",i]${area};`,
    `nwr["operator"~"${BRAND_FILTER}",i]${area};`,
  ].join("");
  return `[out:json][timeout:${timeout}];(${filters});out center tags;`;
}

// Points relais trouves autour d'un point. `day` sert a interpreter les
// horaires OSM pour la bonne journee.
// `region: true` charge toute l'Ile-de-France ; sinon un rayon autour d'un
// point. La requete regionale met une trentaine de secondes : elle n'a sa
// place qu'en tache de fond.
async function searchPoints({ lat, lng, radius = 2500, day = new Date(), region = false }) {
  const area = region ? `(${IDF_BBOX})` : `(around:${radius},${lat},${lng})`;
  const body = new URLSearchParams({ data: buildQuery(area, region ? 180 : 30) });
  let data = null;
  let lastError = null;
  // budget global : on ne fait pas attendre une tournee parce qu'un serveur
  // benevole sature. Au-dela, on s'en passe et on le dit.
  const until = Date.now() + (region ? REGION_TRY_MS * ENDPOINTS.length : BUDGET_MS);

  for (const endpoint of ENDPOINTS) {
    if (Date.now() >= until) break;
    try {
      data = await fetchJson(endpoint, {
        method: "POST",
        body,
        timeout: Math.min(region ? REGION_TRY_MS : TRY_MS, until - Date.now()),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!data) throw lastError || new Error("aucun serveur Overpass n'a repondu");

  const points = [];
  for (const element of data.elements || []) {
    const tags = element.tags || {};
    const carriers = carriersFor(tags);
    if (carriers.length === 0) continue;

    const lat2 = element.lat ?? element.center?.lat;
    const lng2 = element.lon ?? element.center?.lon;
    if (!lat2 || !lng2) continue;

    const ranges = parseOsmHours(tags.opening_hours, day);
    points.push({
      source: "osm",
      source_ref: `${element.type}/${element.id}`,
      name: tags.name || tags.brand || tags.operator || "Point relais",
      kind: tags.amenity === "parcel_locker" ? "Casier automatique" : "Commerce",
      locker: tags.amenity === "parcel_locker",
      address: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
      postal_code: tags["addr:postcode"] || null,
      city: tags["addr:city"] || null,
      lat: lat2,
      lng: lng2,
      carriers,
      // horaires seulement si on a su les lire ; sinon on laisse vide
      hours: ranges
        ? { source: "osm", ranges: ranges.map((r) => `${pad(r.start)}-${pad(r.end)}`) }
        : null,
    });
  }
  return points;
}

function pad(minutes) {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

module.exports = { searchPoints, carriersFor };
