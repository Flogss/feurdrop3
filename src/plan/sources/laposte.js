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

// Departements franciliens : on ne poste pas ailleurs.
const IDF = ["75", "77", "78", "91", "92", "93", "94", "95"];

// Tout le reseau francilien d'un coup (environ 1500 points). Cherchee dans un
// rayon, la liste plafonnait a quelques dizaines de points autour du depart ;
// chargee entiere une fois pour toutes, elle couvre toute la region et les
// calculs suivants ne touchent plus au reseau.
async function loadIleDeFrance({ onBatch } = {}) {
  const qs = `code_postal:(${IDF.map((d) => `${d}*`).join(" OR ")})`;
  let url = withParams(`${BASE}/${POINTS}/lines`, { size: 500, qs, select: POINT_FIELDS });
  let total = 0;

  // le service pagine avec un curseur `next` : on le suit jusqu'au bout
  while (url) {
    const data = await fetchJson(url, { timeout: 25000 });
    const batch = (data.results || []).filter((row) => row.latitude && row.longitude).map(toPoint);
    if (batch.length === 0) break;
    total += batch.length;
    if (onBatch) onBatch(batch);
    url = data.next || null;
  }
  return total;
}

function toPoint(row) {
  return {
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
  };
}

// Points de contact dans un rayon donne, les plus proches d'abord.
async function searchPoints({ lat, lng, radius = 4000, limit = 40 }) {
  const data = await fetchJson(
    withParams(`${BASE}/${POINTS}/lines`, {
      size: limit,
      geo_distance: `${lng},${lat},${radius}`,
      select: POINT_FIELDS,
    })
  );

  return (data.results || []).filter((row) => row.latitude && row.longitude).map(toPoint);
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

// Les commerces du reseau -- relais poste et points partenaires -- prennent
// aussi les colis DPD, ce que l'open data ne dit pas. Les bureaux de poste et
// les agences communales, non.
const DPD_KINDS = new Set(["Relais poste", "Point partenaire"]);

// Ce qu'un site accepte d'apres sa seule nature, avant d'avoir lu son
// calendrier. Sert a savoir de quoi est fait le reseau ; c'est le calendrier
// du jour qui tranche ensuite, site par site.
function carriersForKind(kind) {
  if (kind === "Bureau de Poste") return ["LP", "CHRONO"];
  if (DPD_KINDS.has(kind)) return ["LP", "CHRONO", "DPD"];
  return ["LP"]; // agences postales communales et intercommunales
}

// Ce que le site accepte, d'apres La Poste et pas d'apres nous : un site qui
// publie une heure limite de depot colis accepte les colis, les autres non.
function carriersFrom(hours, kind) {
  if (!hours) return [];
  const carriers = [];
  if (hours.cutoffColis) {
    carriers.push("LP");
    if (DPD_KINDS.has(kind)) carriers.push("DPD");
  }
  if (hours.cutoffChrono) carriers.push("CHRONO");
  return carriers;
}

module.exports = { searchPoints, loadIleDeFrance, fetchHours, carriersFrom, carriersForKind, IDF };
