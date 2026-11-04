// « Créer un itinéraire — Boîtes jaunes » : depuis un depart, N boites dans
// un rayon, et la tournee la plus rapide en voiture pour les deposer.
//
//   1. les boites du rayon (boites.js : donnees ouvertes La Poste, copie
//      locale), sans les positions douteuses ; deux boites a moins de 20 m
//      font un seul arret ;
//   2. la matrice des temps routiers entre le depart et les ~100 arrets les
//      plus proches (routage.js : OSRM, une seule requete, gardee 15 min
//      pour « Recalculer ») ;
//   3. la meilleure selection de N arrets et leur ordre (optimise.js) ;
//   4. le trajet routier de cette tournee (une requete) : c'est lui qui donne
//      la geometrie, les temps et les distances affiches.
const { boitesAutour, distanceM } = require("./boites");
const { matrice, trajet, ErreurRoutage, FOURNISSEUR, MAX_POINTS_MATRICE } = require("./routage");
const { meilleuresTournees } = require("./optimise");
const { chercheAdresse, ErreurGeocodage } = require("./geocodage");

const NOMBRE_MAX = 25;
const RAYON_MIN_KM = 0.3;
const RAYON_MAX_KM = 30;
const MEME_ARRET_M = 20;

class ErreurItineraire extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// --- L'heure de Paris (heures limites de depot, heures d'arrivee) -----------------

const FORMAT_PARIS = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function momentParis(ms) {
  const p = Object.fromEntries(FORMAT_PARIS.formatToParts(ms).map((x) => [x.type, x.value]));
  return { jour: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const enMinutes = (hhmm) => {
  const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// l'heure limite qui vaut ce jour-la (pas de levee le dimanche)
const limiteDuJour = (arret, jour) => (jour === "Sun" ? null : jour === "Sat" ? arret.limiteSamedi : arret.limiteSemaine);

// --- Les arrets : une ou plusieurs boites au meme endroit -------------------------

function regroupe(boites) {
  const grille = new Map();
  const cellule = (lat, lon) => `${Math.floor(lat / 0.0004)}:${Math.floor(lon / 0.0006)}`;
  const arrets = [];
  for (const b of boites) {
    const [ci, cj] = cellule(b.lat, b.lon).split(":").map(Number);
    let voisin = null;
    for (let di = -1; di <= 1 && !voisin; di += 1) {
      for (let dj = -1; dj <= 1 && !voisin; dj += 1) {
        for (const a of grille.get(`${ci + di}:${cj + dj}`) || []) {
          if (distanceM(a, b) <= MEME_ARRET_M) {
            voisin = a;
            break;
          }
        }
      }
    }
    if (voisin) {
      voisin.ids.push(b.id);
      // la boite levee le plus tard vaut pour l'arret
      if ((enMinutes(b.limiteSemaine) ?? -1) > (enMinutes(voisin.limiteSemaine) ?? -1)) voisin.limiteSemaine = b.limiteSemaine;
      if ((enMinutes(b.limiteSamedi) ?? -1) > (enMinutes(voisin.limiteSamedi) ?? -1)) voisin.limiteSamedi = b.limiteSamedi;
      continue;
    }
    const a = { ...b, ids: [b.id] };
    arrets.push(a);
    const k = cellule(b.lat, b.lon);
    if (!grille.has(k)) grille.set(k, []);
    grille.get(k).push(a);
  }
  return arrets;
}

// --- La matrice, gardee un moment (« Recalculer » ne la redemande pas) ------------

const MATRICES = new Map();
const MATRICE_TTL_MS = 15 * 60 * 1000;
async function matriceGardee(depart, arrets) {
  const cle = `${depart.lat.toFixed(5)},${depart.lon.toFixed(5)}|${arrets.map((a) => a.id).join(",")}`;
  const deja = MATRICES.get(cle);
  if (deja && Date.now() - deja.le < MATRICE_TTL_MS) return { ...deja.m, gardee: true };
  const m = await matrice([depart, ...arrets]);
  MATRICES.set(cle, { m, le: Date.now() });
  while (MATRICES.size > 20) MATRICES.delete(MATRICES.keys().next().value);
  return { ...m, gardee: false };
}

// --- Liens de navigation ------------------------------------------------------------

const coord = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
function morceaux(points, parLien) {
  // points[0] = depart ; chaque lien repart de la derniere boite du precedent
  const liens = [];
  for (let debut = 0; debut < points.length - 1; debut += parLien + 1) {
    liens.push(points.slice(debut, Math.min(points.length, debut + parLien + 2)));
  }
  return liens;
}
function liensNavigation(depart, arrets) {
  const points = [depart, ...arrets];
  // Apple Plans (iOS 18.4 / macOS 15.4) : etapes en « waypoint » repete
  const apple = morceaux(points, 14).map((m) => {
    const p = new URLSearchParams({ source: coord(m[0]), destination: coord(m[m.length - 1]), mode: "driving" });
    for (const w of m.slice(1, -1)) p.append("waypoint", coord(w));
    return `https://maps.apple.com/directions?${p.toString().replace(/%2C/g, ",")}`;
  });
  // Google Maps : 9 etapes au plus par lien
  const google = morceaux(points, 9).map((m) => {
    const p = new URLSearchParams({ api: "1", origin: coord(m[0]), destination: coord(m[m.length - 1]), travelmode: "driving" });
    if (m.length > 2) p.set("waypoints", m.slice(1, -1).map(coord).join("|"));
    return `https://www.google.com/maps/dir/?${p.toString().replace(/%2C/g, ",").replace(/%7C/g, "|")}`;
  });
  return { applePlans: apple, googleMaps: google };
}

// --- Le calcul ----------------------------------------------------------------------

function lisParametres(corps = {}) {
  const nombre = Math.floor(Number(corps.nombre ?? 8));
  if (!Number.isFinite(nombre) || nombre < 1 || nombre > NOMBRE_MAX) throw new ErreurItineraire(`Nombre de boîtes : entre 1 et ${NOMBRE_MAX}.`);
  const rayonKm = Number(corps.rayonKm ?? 3);
  if (!Number.isFinite(rayonKm) || rayonKm < RAYON_MIN_KM || rayonKm > RAYON_MAX_KM) {
    throw new ErreurItineraire(`Rayon : entre ${RAYON_MIN_KM} et ${RAYON_MAX_KM} km.`);
  }
  const variante = Math.max(0, Math.floor(Number(corps.variante ?? 0)) || 0);
  const exclure = new Set((Array.isArray(corps.exclure) ? corps.exclure : []).slice(0, 500).map(String));
  return { nombre, rayonKm, variante, exclure, leveeAVenir: corps.leveeAVenir === true };
}

async function resousDepart(depart = {}) {
  const lat = Number(depart.lat);
  const lon = Number(depart.lon);
  if (depart.lat != null && depart.lon != null) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new ErreurItineraire("Position de départ invalide.");
    return { lat, lon, label: typeof depart.label === "string" ? depart.label.slice(0, 200) : null, origine: depart.origine === "gps" ? "gps" : "adresse" };
  }
  if (typeof depart.adresse === "string" && depart.adresse.trim()) {
    const [lieu] = await chercheAdresse(depart.adresse, { limite: 1 });
    if (!lieu) throw new ErreurItineraire(`Adresse introuvable : « ${depart.adresse.trim().slice(0, 80)} ».`, 404);
    return { lat: lieu.lat, lon: lieu.lon, label: lieu.label, origine: "adresse" };
  }
  throw new ErreurItineraire("Choisis un départ : ta position ou une adresse.");
}

async function calculeItineraire(corps = {}, { maintenant = Date.now() } = {}) {
  const p = lisParametres(corps);
  const depart = await resousDepart(corps.depart);
  const rayonM = p.rayonKm * 1000;

  const zone = await boitesAutour(depart, rayonM);
  const avertissements = [];
  let boites = zone.boites.filter((b) => !p.exclure.has(b.id));
  const ici = momentParis(maintenant);
  if (p.leveeAVenir) {
    const avant = boites.length;
    boites = boites.filter((b) => (enMinutes(limiteDuJour(b, ici.jour)) ?? -1) > ici.minutes + 10);
    if (ici.jour === "Sun") avertissements.push("Pas de levée le dimanche : aucune boîte n'a de levée à venir aujourd'hui.");
    else if (boites.length < avant) avertissements.push(`${avant - boites.length} boîte${avant - boites.length > 1 ? "s" : ""} déjà levée${avant - boites.length > 1 ? "s" : ""} aujourd'hui, écartée${avant - boites.length > 1 ? "s" : ""}.`);
  }
  const arrets = regroupe(boites);
  if (arrets.length === 0) {
    throw new ErreurItineraire(
      `Aucune boîte jaune ${p.leveeAVenir ? "avec une levée à venir " : ""}dans un rayon de ${String(p.rayonKm).replace(".", ",")} km.`,
      404
    );
  }

  // les arrets les plus proches, autant que la matrice en accepte
  const pool = arrets.slice(0, MAX_POINTS_MATRICE() - 1);
  const m = await matriceGardee(depart, pool);
  const n = Math.min(p.nombre, pool.length);
  const tournees = meilleuresTournees(m.durees, m.distances, n, { variantes: Math.max(4, p.variante + 1) });
  if (tournees.length === 0) throw new ErreurItineraire("Aucune boîte n'est accessible en voiture depuis ce départ.", 422);
  const choisie = tournees[p.variante % tournees.length];
  const ordre = choisie.ordre.map((i) => pool[i - 1]);
  if (ordre.length < p.nombre) {
    avertissements.unshift(
      `Seulement ${ordre.length} boîte${ordre.length > 1 ? "s" : ""} accessible${ordre.length > 1 ? "s" : ""} dans ${String(p.rayonKm).replace(".", ",")} km (${p.nombre} demandée${p.nombre > 1 ? "s" : ""}).`
    );
  }

  // le vrai trajet : temps, distances et trace viennent d'OSRM
  const route = await trajet([depart, ...ordre]);
  let cumul = 0;
  const resultat = ordre.map((a, i) => {
    const troncon = route.troncons[i];
    cumul += troncon.duree;
    const arrivee = maintenant + cumul * 1000;
    const la = momentParis(arrivee);
    const limite = limiteDuJour(a, la.jour);
    return {
      ordre: i + 1,
      id: a.id,
      ids: a.ids,
      boites: a.ids.length,
      lat: a.lat,
      lon: a.lon,
      adresse: a.adresse,
      commune: a.commune,
      cp: a.cp,
      limiteSemaine: a.limiteSemaine,
      limiteSamedi: a.limiteSamedi,
      // deposee a l'arrivee prevue, la lettre part-elle aujourd'hui ?
      limiteDuJour: limite,
      apresLimite: limite ? la.minutes > enMinutes(limite) : null,
      depuisPrecedent: { duree: troncon.duree, distance: troncon.distance },
      arriveeDans: cumul,
      ecartRouteM: route.accroches[i + 1]?.ecartM ?? null,
    };
  });

  return {
    depart: { lat: depart.lat, lon: depart.lon, label: depart.label, origine: depart.origine },
    rayonKm: p.rayonKm,
    demande: p.nombre,
    arrets: resultat,
    total: { duree: route.duree, distance: route.distance },
    geometrie: route.geometrie,
    // les autres boites de la zone, en fond de carte
    autres: arrets
      .filter((a) => !ordre.includes(a))
      .slice(0, 500)
      .map((a) => [Math.round(a.lat * 1e5) / 1e5, Math.round(a.lon * 1e5) / 1e5]),
    zone: { arrets: arrets.length, boites: boites.length, imprecises: zone.imprecises, comparees: pool.length },
    variante: p.variante % tournees.length,
    variantes: tournees.length,
    liens: liensNavigation(depart, ordre),
    avertissements,
    sources: {
      boites: { nom: "La Poste · données ouvertes (ODbL)", miseAJour: zone.miseAJourSource, lecture: zone.source },
      routage: FOURNISSEUR(),
      matriceGardee: m.gardee,
    },
    calculeLe: new Date(maintenant).toISOString(),
  };
}

module.exports = { calculeItineraire, ErreurItineraire, ErreurRoutage, ErreurGeocodage, regroupe, liensNavigation, lisParametres };
