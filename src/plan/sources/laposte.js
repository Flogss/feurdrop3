const { fetchJson, withParams } = require("../http");

// Reseau La Poste, depuis l'open data de La Poste elle-meme (data.laposte.fr,
// portail data-fair). Gratuit, sans cle, et c'est le referentiel de
// l'operateur : c'est la seule source de ce projet qu'on peut considerer
// fiable sans l'avoir verifiee soi-meme.
//
// Deux jeux de donnees complementaires :
//   - les points de contact : bureaux, agences communales, relais poste ;
//   - le calendrier d'ouverture, jour par jour, qui donne surtout les HEURES
//     LIMITES DE DEPOT. C'est l'information qui compte : un Franprix relais
//     poste ouvert jusqu'a 22h peut refuser un colis apres 15h.

const BASE = "https://data.laposte.fr/data-fair/api/v1/datasets";
const POINTS = "laposte-poincont2";
const CALENDAR = "tjwztt6h44ve52i7fln6rbxz";

const POINT_FIELDS = [
  "identifiant_a",
  "libelle_du_site",
  "caracteristique_du_site",
  "adresse",
  "complement_d_adresse",
  "code_postal",
  "localite",
  "latitude",
  "longitude",
].join(",");

const CALENDAR_FIELDS = [
  "identifiant",
  "date_calendrier",
  "plage_horaire_1",
  "plage_horaire_2",
  "plage_horaire_3",
  "heure_limite_depot_colis",
  "heure_limite_depot_chrono",
].join(",");

// Points de contact dans un rayon donne, les plus proches d'abord.
async function searchPoints({ lat, lng, radius = 4000, limit = 40 }) {
  const data = await fetchJson(
    withParams(`${BASE}/${POINTS}/lines`, {
      size: limit,
      geo_distance: `${lng},${lat},${radius}`,
      select: POINT_FIELDS,
    })
  );

  return (data.results || [])
    .filter((row) => row.latitude && row.longitude)
    .map((row) => ({
      source: "laposte",
      source_ref: row.identifiant_a,
      name: row.libelle_du_site,
      kind: row.caracteristique_du_site,
      address: [row.adresse, row.complement_d_adresse].filter(Boolean).join(", "),
      postal_code: row.code_postal,
      city: row.localite,
      lat: row.latitude,
      lng: row.longitude,
      distance: row._geo_distance,
    }));
}

function cleanRange(value) {
  const range = (value || "").trim();
  if (!range || range.toUpperCase() === "FERME") return null;
  return /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(range) ? range : null;
}

function cleanTime(value) {
  const time = (value || "").trim();
  return /^\d{1,2}:\d{2}$/.test(time) ? time : null;
}

// Horaires et heures limites de depot d'une liste de sites, pour une date.
// Renvoie une Map identifiant -> horaires. Un site absent de la reponse n'a
// pas d'horaires connus ce jour-la : on ne comble pas le trou.
async function fetchHours(refs, day) {
  const list = [...new Set(refs.filter(Boolean))];
  const hours = new Map();
  if (list.length === 0) return hours;

  // le service accepte une requete par lot, mais pas illimitee
  const CHUNK = 40;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const qs = `identifiant:(${chunk.map((ref) => `"${ref}"`).join(" OR ")}) AND date_calendrier:"${day}"`;
    const data = await fetchJson(
      withParams(`${BASE}/${CALENDAR}/lines`, { size: chunk.length, qs, select: CALENDAR_FIELDS })
    );

    for (const row of data.results || []) {
      const ranges = [row.plage_horaire_1, row.plage_horaire_2, row.plage_horaire_3]
        .map(cleanRange)
        .filter(Boolean);
      hours.set(row.identifiant, {
        source: "laposte",
        ranges,
        cutoffColis: cleanTime(row.heure_limite_depot_colis),
        cutoffChrono: cleanTime(row.heure_limite_depot_chrono),
      });
    }
  }
  return hours;
}

// Ce que le site accepte, d'apres La Poste et pas d'apres nous : un site qui
// publie une heure limite de depot colis accepte les colis, les autres non.
function carriersFrom(hours) {
  if (!hours) return [];
  const carriers = [];
  if (hours.cutoffColis) carriers.push("LP");
  if (hours.cutoffChrono) carriers.push("CHRONO");
  return carriers;
}

module.exports = { searchPoints, fetchHours, carriersFrom };
