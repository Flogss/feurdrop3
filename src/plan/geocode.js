const { fetchJson, withParams } = require("./http");

// Geocodage par la Base Adresse Nationale : le referentiel officiel des
// adresses francaises, gratuit et sans cle. On ne garde que l'Ile-de-France,
// puisque c'est la seule region ou on poste.

const BAN = "https://api-adresse.data.gouv.fr";
const IDF_DEPARTMENTS = ["75", "77", "78", "91", "92", "93", "94", "95"];

function isIleDeFrance(postcode) {
  return IDF_DEPARTMENTS.includes(String(postcode || "").slice(0, 2));
}

function toPlace(feature) {
  const p = feature.properties || {};
  const [lng, lat] = feature.geometry?.coordinates || [];
  return {
    label: p.label,
    street: [p.housenumber, p.street].filter(Boolean).join(" ") || p.name || "",
    postcode: p.postcode,
    city: p.city,
    context: p.context,
    lat,
    lng,
    score: p.score,
  };
}

// Adresses correspondant a une recherche libre, les plus pertinentes d'abord.
async function search(query, { limit = 5 } = {}) {
  const clean = (query || "").trim();
  if (clean.length < 3) return [];

  const data = await fetchJson(
    withParams(`${BAN}/search/`, { q: clean, limit: limit * 3, autocomplete: 0 })
  );
  return (data.features || [])
    .map(toPlace)
    .filter((place) => place.lat && isIleDeFrance(place.postcode))
    .slice(0, limit);
}

// Adresse la plus proche de coordonnees GPS (bouton "me localiser").
async function reverse(lat, lng) {
  const data = await fetchJson(withParams(`${BAN}/reverse/`, { lat, lon: lng, limit: 1 }));
  const feature = (data.features || [])[0];
  if (!feature) return null;
  const place = toPlace(feature);
  // on garde les coordonnees du GPS, pas celles de l'adresse trouvee
  return { ...place, lat, lng };
}

module.exports = { search, reverse, isIleDeFrance, IDF_DEPARTMENTS };
