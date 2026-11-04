// Le calcul des trajets en voiture : OSRM, sur le reseau routier
// d'OpenStreetMap (vraies routes, sens uniques, interdictions de tourner,
// vitesses par type de voie). Sans trafic en temps reel : OSRM ne le connait
// pas -- Apple Plans ou Google Maps en tiennent compte une fois la navigation
// lancee.
//
// Par defaut le serveur public du projet OSRM (gratuit, sans cle) : une
// requete par seconde au plus, 100 points par matrice, un User-Agent qui dit
// qui appelle. OSRM_URL pointe ailleurs (un OSRM a soi, par exemple) sans rien
// changer d'autre.
//
// Les temps et distances affiches viennent tous d'ici : si OSRM ne repond
// pas, il n'y a pas d'itineraire -- jamais d'estimation inventee.

const BASE = () => (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
const PROFIL = () => process.env.OSRM_PROFIL || "driving";
const MAX_POINTS_MATRICE = () => Number(process.env.OSRM_MAX_TABLE || 100);
const INTERVALLE_MS = () => Number(process.env.OSRM_INTERVALLE_MS ?? 1100);
const DELAI_MS = 25000;

class ErreurRoutage extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.name = "ErreurRoutage";
    this.status = status;
  }
}

// Une requete a la fois, espacees : la politique du serveur public.
let file = Promise.resolve();
let dernier = 0;
function enFile(tache) {
  const suite = file.then(async () => {
    const attente = dernier + INTERVALLE_MS() - Date.now();
    if (attente > 0) await new Promise((r) => setTimeout(r, attente));
    try {
      return await tache();
    } finally {
      dernier = Date.now();
    }
  });
  file = suite.catch(() => {});
  return suite;
}

const coordonnees = (points) => points.map((p) => `${Number(p.lon).toFixed(6)},${Number(p.lat).toFixed(6)}`).join(";");

async function appelle(service, points, parametres) {
  const url = `${BASE()}/${service}/v1/${PROFIL()}/${coordonnees(points)}?${new URLSearchParams(parametres)}`;
  return enFile(async () => {
    let r;
    try {
      r = await fetch(url, {
        headers: { "User-Agent": "FeurDrop/1.0 (itineraire boites jaunes)", Accept: "application/json" },
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch (err) {
      throw new ErreurRoutage(
        err.name === "TimeoutError" ? "le calcul d'itinéraire ne répond pas (OSRM)" : `calcul d'itinéraire injoignable (OSRM : ${err.message})`
      );
    }
    let corps = null;
    try {
      corps = await r.json();
    } catch {
      /* corps illisible */
    }
    if (r.status === 429) throw new ErreurRoutage("trop de calculs d'itinéraire d'affilée : réessaie dans quelques secondes", { status: 429 });
    if (!r.ok || corps?.code !== "Ok") {
      throw new ErreurRoutage(`le calcul d'itinéraire a échoué (OSRM : ${corps?.message || corps?.code || `HTTP ${r.status}`})`);
    }
    return corps;
  });
}

/**
 * Temps (s) et distances (m) en voiture de chaque point vers chaque autre.
 * null quand OSRM ne trouve aucune route entre deux points.
 */
async function matrice(points) {
  if (points.length < 2) return { durees: [[0]], distances: [[0]] };
  if (points.length > MAX_POINTS_MATRICE()) throw new ErreurRoutage(`matrice limitée à ${MAX_POINTS_MATRICE()} points`, { status: 400 });
  const d = await appelle("table", points, { annotations: "duration,distance" });
  if (!Array.isArray(d.durations) || d.durations.length !== points.length) throw new ErreurRoutage("réponse d'OSRM incomplète (matrice)");
  return { durees: d.durations, distances: d.distances || null };
}

/**
 * Le trajet routier qui passe par les points dans l'ordre : sa geometrie
 * ([lon, lat]), sa duree et sa distance, et celles de chaque troncon.
 */
async function trajet(points) {
  const d = await appelle("route", points, { overview: "full", geometries: "geojson", steps: "false", continue_straight: "false" });
  const route = d.routes?.[0];
  if (!route || !Array.isArray(route.legs) || route.legs.length !== points.length - 1) throw new ErreurRoutage("réponse d'OSRM incomplète (trajet)");
  return {
    duree: route.duration,
    distance: route.distance,
    geometrie: (route.geometry?.coordinates || []).map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]),
    troncons: route.legs.map((l) => ({ duree: l.duration, distance: l.distance })),
    // le point de la route ou chaque arret est rattache (la boite est souvent
    // a quelques metres de la chaussee)
    accroches: (d.waypoints || []).map((w) => ({ nom: w.name || null, ecartM: w.distance ?? null })),
  };
}

const FOURNISSEUR = () => ({
  nom: BASE().includes("project-osrm.org") ? "OSRM · OpenStreetMap" : "OSRM",
  trafic: false,
  attribution: "Itinéraire OSRM · © contributeurs OpenStreetMap",
});

module.exports = { matrice, trajet, ErreurRoutage, FOURNISSEUR, MAX_POINTS_MATRICE };
