// Les adresses : le service de geocodage de la Geoplateforme (IGN, Base
// Adresse Nationale), public et sans cle. Pour le depart choisi a la main
// (suggestions au fil de la frappe) et pour nommer une position GPS.
const BASE = () => (process.env.GEOCODAGE_URL || "https://data.geopf.fr/geocodage").replace(/\/+$/, "");
const ENTETES = { "User-Agent": "FeurDrop/1.0 (itineraire boites jaunes)", Accept: "application/json" };

class ErreurGeocodage extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function appelle(chemin, parametres) {
  let r;
  try {
    r = await fetch(`${BASE()}/${chemin}?${new URLSearchParams(parametres)}`, { headers: ENTETES, signal: AbortSignal.timeout(10000) });
  } catch (err) {
    throw new ErreurGeocodage(err.name === "TimeoutError" ? "la recherche d'adresse ne répond pas" : "recherche d'adresse injoignable");
  }
  if (!r.ok) throw new ErreurGeocodage(`recherche d'adresse : HTTP ${r.status}`);
  return r.json();
}

const versLieu = (f) => ({
  label: f.properties?.label || null,
  ville: f.properties?.city || null,
  type: f.properties?.type || null,
  score: f.properties?.score ?? null,
  lat: f.geometry?.coordinates?.[1],
  lon: f.geometry?.coordinates?.[0],
});

/** Suggestions pour une adresse tapee ; `pres` : les resultats proches d'abord. */
async function chercheAdresse(texte, { pres = null, limite = 5 } = {}) {
  const q = String(texte || "").trim().slice(0, 200);
  if (q.length < 3) return [];
  const parametres = { q, limit: String(Math.min(10, Math.max(1, limite))), autocomplete: "1" };
  if (pres && Number.isFinite(pres.lat) && Number.isFinite(pres.lon)) {
    parametres.lat = String(pres.lat);
    parametres.lon = String(pres.lon);
  }
  const d = await appelle("search", parametres);
  return (d.features || []).map(versLieu).filter((l) => l.label && Number.isFinite(l.lat) && Number.isFinite(l.lon));
}

/** L'adresse la plus proche d'une position (null si rien a moins de 300 m). */
async function nommePosition(lat, lon) {
  const d = await appelle("reverse", { lat: String(lat), lon: String(lon), limit: "1" });
  const f = d.features?.[0];
  if (!f || (f.properties?.distance ?? 0) > 300 || !f.properties?.label) return null;
  return versLieu(f);
}

module.exports = { chercheAdresse, nommePosition, ErreurGeocodage };
