const store = require("./store");
const laposte = require("./sources/laposte");
const osm = require("./sources/osm");
const boites = require("./sources/boitesjaunes");
const fedex = require("./sources/fedex");
const ups = require("./sources/ups");
const { statusAt, deadline, toMinutes, toClock } = require("./hours");
const { haversine, estimateMatrix, optimize } = require("./route");
const { allowedFor, LOCKER_CARRIERS } = require("./lockers");

// Construction d'une tournee de depot.
//
// L'ordre des priorites est celui demande, et il n'est jamais inverse :
//   1. le point accepte vraiment ce transporteur ;
//   2. le point existe vraiment (verifie) ;
//   3. il sera ouvert -- et accepte encore les colis -- a l'heure de passage ;
//   4. seulement ensuite, le trajet le plus court.

const SEARCH_RADIUS = 5000;
const MAX_PER_CARRIER = 8;

function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function distanceFrom(start, point) {
  return haversine(start, point);
}

// --- Candidats ---------------------------------------------------------------

// Rafraichit les points La Poste autour du depart et les enregistre. C'est la
// seule source qu'on peut marquer "verifie" sans l'avoir vue de ses yeux :
// c'est le referentiel de l'operateur, et il publie lui-meme ses heures
// limites de depot.
async function refreshLaPoste(start, day) {
  const found = await laposte.searchPoints({ ...start, radius: SEARCH_RADIUS });
  const hours = await laposte.fetchHours(found.map((p) => p.source_ref), day);

  const saved = [];
  for (const point of found) {
    const dayHours = hours.get(point.source_ref) || null;
    const carriers = laposte.carriersFrom(dayHours);
    // un site sans heure limite de depot publiee ce jour-la n'est pas presente
    // comme prenant les colis
    if (carriers.length === 0) continue;

    const stored = store.upsertPoint({ ...point, carriers, trust: store.TRUST.verified });
    store.saveHours(stored.id, day, dayHours);
    saved.push(stored.id);
  }
  return saved.length;
}

// Points OpenStreetMap : enregistres en "a verifier", jamais mieux. Overpass
// met des secondes a repondre et sature souvent : une zone deja ratissee dans
// la journee n'est pas redemandee.
async function refreshOsm(start, day) {
  const { cell, fresh } = store.sweptRecently("osm", start.lat, start.lng);
  if (fresh) return 0;
  // marque tout de suite : deux calculs lances coup sur coup ne doivent pas
  // interroger Overpass deux fois
  store.markSwept(cell, 1);

  try {
    // midi : evite qu'un decalage de fuseau fasse changer de jour de la semaine
    const found = await osm.searchPoints({ ...start, radius: 3000, day: new Date(`${day}T12:00:00`) });
    for (const point of found) {
      const stored = store.upsertPoint({ ...point, trust: store.TRUST.unverified });
      if (point.hours) store.saveHours(stored.id, day, point.hours);
    }
    store.markSwept(cell, 24);
    return found.length;
  } catch (err) {
    // on reessaiera dans une heure, pas a chaque calcul
    throw err;
  }
}

// Boites aux lettres de rue autour du depart, avec leur heure de levee.
// Meme statut que les bureaux de poste : c'est le referentiel de La Poste.
async function refreshBoitesJaunes(start, day) {
  const found = await boites.searchPoints({ ...start, radius: 1500, day });
  for (const point of found) {
    const stored = store.upsertPoint({ ...point, trust: store.TRUST.verified });
    if (point.hours) store.saveHours(stored.id, day, point.hours);
  }
  return found.length;
}

// Points de depot FedEx. Source eteinte tant que la cle n'est pas posee : on
// le signale au lieu de faire croire qu'il n'y a rien.
async function refreshFedex(start, day) {
  if (!fedex.isConfigured()) return null;
  const { cell, fresh } = store.sweptRecently("fedex", start.lat, start.lng);
  if (fresh) return 0;
  store.markSwept(cell, 1);

  const found = await fedex.searchPoints({
    address: start.street || start.label,
    postalCode: start.postcode,
    city: start.city,
    day,
  });
  for (const point of found) {
    const stored = store.upsertPoint({ ...point, trust: store.TRUST.verified });
    if (point.hours) store.saveHours(stored.id, day, point.hours);
  }
  store.markSwept(cell, 24);
  return found.length;
}

// Points de depot UPS. Meme regle que FedEx : eteinte sans identifiants.
async function refreshUps(start, day) {
  if (!ups.isConfigured()) return null;
  const { cell, fresh } = store.sweptRecently("ups", start.lat, start.lng);
  if (fresh) return 0;
  store.markSwept(cell, 1);

  const found = await ups.searchPoints({ lat: start.lat, lng: start.lng, day });
  for (const point of found) {
    const stored = store.upsertPoint({ ...point, trust: store.TRUST.verified });
    if (point.hours) store.saveHours(stored.id, day, point.hours);
  }
  store.markSwept(cell, 24);
  return found.length;
}

// Points utilisables pour un transporteur, du plus proche au plus loin.
//
// Deux filtres, dans cet ordre :
//   - un point dont on SAIT qu'il n'accepte plus de colis a l'heure du depart
//     est ecarte tout de suite : mieux vaut un detour qu'une porte fermee.
//     Un point dont on ignore les horaires est garde -- on ne l'ecarte pas
//     sur une supposition ;
//   - regle 11 : si un point verifie existe, les points "a verifier" sortent.
function candidatesFor(carrier, start, day, departAt, excluded = new Set(), includeLockers = false) {
  const all = store
    .pointsForCarrier(carrier)
    .filter((point) => !excluded.has(point.id))
    // par defaut aucun casier automatique, et jamais pour un reseau ou le
    // depot en casier n'existe pas (voir lockers.js)
    .filter((point) => allowedFor(point, carrier, includeLockers))
    .map((point) => ({
      ...point,
      distance: distanceFrom(start, point),
      hours: store.getHours(point.id, day),
    }))
    .filter((point) => {
      // une levee ratee n'empeche pas de poster : on ne retire jamais une
      // boite aux lettres du choix
      if (point.hours && point.hours.soft) return true;
      const limit = deadline(point.hours, carrier);
      return limit === null || limit === undefined || limit > departAt;
    })
    .sort((a, b) => a.distance - b.distance);

  const verified = all.filter((p) => p.trust === store.TRUST.verified);
  const usable = verified.length > 0 ? verified : all;
  return usable.slice(0, MAX_PER_CARRIER);
}

// --- Choix des arrets --------------------------------------------------------

// Un point qui prend plusieurs de nos transporteurs vaut mieux que deux
// points : c'est un arret en moins, donc du temps en moins.
function chooseStops(needs, pools) {
  const remaining = new Map(needs.map((n) => [n.carrier, n.count]));
  const stops = [];
  const unserved = [];

  while (remaining.size > 0) {
    let best = null;

    for (const carrier of remaining.keys()) {
      for (const point of pools.get(carrier) || []) {
        if (stops.some((s) => s.point.id === point.id)) continue;
        const covers = [...remaining.keys()].filter((c) =>
          (pools.get(c) || []).some((p) => p.id === point.id)
        );
        const score = {
          point,
          covers,
          verified: point.trust === store.TRUST.verified,
          distance: point.distance,
        };
        if (
          !best ||
          score.covers.length > best.covers.length ||
          (score.covers.length === best.covers.length &&
            ((score.verified && !best.verified) ||
              (score.verified === best.verified && score.distance < best.distance)))
        ) {
          best = score;
        }
      }
    }

    if (!best) {
      unserved.push(...remaining.keys());
      break;
    }

    stops.push({
      point: best.point,
      carriers: best.covers,
      counts: best.covers.map((c) => ({ carrier: c, count: remaining.get(c) })),
    });
    best.covers.forEach((c) => remaining.delete(c));
  }

  return { stops, unserved };
}

// --- Plan --------------------------------------------------------------------

// Le moment ou le point n'accepte plus nos colis : la plus contraignante des
// heures limites parmi les transporteurs qu'on y depose.
function stopDeadline(stop) {
  const limits = stop.carriers
    .map((carrier) => deadline(stop.point.hours, carrier))
    .filter((value) => value !== null && value !== undefined);
  return limits.length > 0 ? Math.min(...limits) : null;
}

// Un arret "souple" : une boite aux lettres, dont la levee se rate sans
// consequence autre qu'un jour de plus.
function isSoft(stop) {
  return Boolean(stop.point.hours && stop.point.hours.soft);
}

async function buildPlan({
  start,
  needs,
  day = today(),
  departAt = null,
  refresh = true,
  useOsm = true,
  includeLockers = false,
}) {
  if (!start || typeof start.lat !== "number" || typeof start.lng !== "number") {
    throw new Error("position de depart manquante");
  }
  const wanted = (needs || []).filter((n) => n.carrier && n.count > 0);
  if (wanted.length === 0) throw new Error("aucun colis a deposer");

  const sources = { laposte: 0, boites: 0, fedex: 0, ups: 0, osm: 0, pending: false, errors: [] };
  if (refresh) {
    // La Poste repond en une seconde : on l'attend. Overpass met parfois une
    // minute ou ne repond pas du tout ; on ne fait pas patienter quelqu'un qui
    // a des colis dans les bras pour une source de secours. Elle se met a jour
    // en tache de fond et servira au calcul suivant.
    const asks = (code) => wanted.some((n) => n.carrier === code);

    await Promise.all([
      asks("LP") || asks("CHRONO")
        ? refreshLaPoste(start, day)
            .then((n) => (sources.laposte = n))
            .catch((err) => sources.errors.push(`La Poste : ${err.message}`))
        : Promise.resolve(),
      asks("BJ")
        ? refreshBoitesJaunes(start, day)
            .then((n) => (sources.boites = n))
            .catch((err) => sources.errors.push(`Boites aux lettres : ${err.message}`))
        : Promise.resolve(),
      asks("FEDEX")
        ? refreshFedex(start, day)
            .then((n) => {
              if (n === null) sources.errors.push("FedEx : cle API non configuree");
              else sources.fedex = n;
            })
            .catch((err) => sources.errors.push(`FedEx : ${err.message}`))
        : Promise.resolve(),
      asks("UPS")
        ? refreshUps(start, day)
            .then((n) => {
              if (n === null) sources.errors.push("UPS : identifiants API non configures");
              else sources.ups = n;
            })
            .catch((err) => sources.errors.push(`UPS : ${err.message}`))
        : Promise.resolve(),
    ]);

    if (useOsm && !store.sweptRecently("osm", start.lat, start.lng).fresh) {
      sources.pending = true;
      refreshOsm(start, day).catch((err) => console.warn("[plan] OpenStreetMap :", err.message));
    }
  }

  const depart = departAt ?? nowMinutes();

  // Un arret peut rester atteint trop tard malgre le meilleur ordre possible :
  // on l'ecarte alors et on recommence avec le candidat suivant. Quelques
  // essais suffisent ; au-dela, c'est qu'il n'y a pas de solution et il vaut
  // mieux le dire que tourner en rond.
  const excluded = new Set();
  let best = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pools = new Map(
      wanted.map((n) => [
        n.carrier,
        candidatesFor(n.carrier, start, day, depart, excluded, includeLockers),
      ])
    );
    const { stops, unserved } = chooseStops(wanted, pools);
    const withDeadline = stops.map((stop) => ({
      ...stop,
      deadline: stopDeadline(stop),
      soft: isSoft(stop),
    }));
    const matrix = estimateMatrix([start, ...withDeadline.map((s) => s.point)]);
    const run = optimize({ stops: withDeadline, matrix, departAt: depart });

    const candidate = { stops: withDeadline, unserved, matrix, run };
    if (!best || run.late < best.run.late) best = candidate;
    if (run.late === 0) break;

    // on retire l'arret rate le plus tardif et on retente
    const late = run.order
      .map((index, rank) => ({ index, arrival: run.arrivals[rank] }))
      .filter(({ index, arrival }) => {
        const stop = withDeadline[index];
        if (stop.soft) return false; // une levee ratee ne justifie pas de changer de boite
        return stop.deadline !== null && stop.deadline !== undefined && arrival > stop.deadline;
      });
    if (late.length === 0) break;
    excluded.add(withDeadline[late[late.length - 1].index].point.id);
  }

  const { stops: withDeadline, unserved, matrix, run } = best;

  const ordered = run.order.map((index, rank) => {
    const stop = withDeadline[index];
    const arrival = run.arrivals[rank];
    const status = statusAt(stop.point.hours, arrival, stop.carriers[0]);
    return {
      rank: rank + 1,
      point: stop.point,
      carriers: stop.carriers,
      counts: stop.counts,
      arrival: toClock(Math.round(arrival)),
      arrivalMinutes: Math.round(arrival),
      status,
      late: !stop.soft && stop.deadline !== null && arrival > stop.deadline,
      legMeters: matrix.meters[rank === 0 ? 0 : run.order[rank - 1] + 1][index + 1],
    };
  });

  return {
    day,
    departAt: toClock(depart),
    includeLockers,
    start,
    stops: ordered,
    unserved,
    sources,
    summary: {
      stops: ordered.length,
      colis: wanted.reduce((sum, n) => sum + n.count, 0),
      meters: run.meters,
      minutes: Math.round(run.minutes),
      late: run.late,
      estimated: matrix.estimated,
    },
    links: mapsLinks(start, ordered),
  };
}

function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

// --- Liens vers les applications de navigation -------------------------------

function coords(place) {
  return `${place.lat},${place.lng}`;
}

function mapsLinks(start, stops) {
  if (stops.length === 0) return { google: null, apple: null };
  const points = stops.map((s) => s.point);
  const destination = points[points.length - 1];
  const waypoints = points.slice(0, -1);

  const google = new URL("https://www.google.com/maps/dir/");
  google.searchParams.set("api", "1");
  google.searchParams.set("origin", coords(start));
  google.searchParams.set("destination", coords(destination));
  if (waypoints.length > 0) {
    google.searchParams.set("waypoints", waypoints.map(coords).join("|"));
  }
  google.searchParams.set("travelmode", "driving");

  // Plans enchaine les etapes avec "to:" ; au-dela d'une poignee d'arrets il
  // vaut mieux basculer sur Google Maps
  const apple = `https://maps.apple.com/?saddr=${coords(start)}&daddr=${points
    .map(coords)
    .join("+to:")}&dirflg=d`;

  return { google: google.toString(), apple };
}

module.exports = {
  buildPlan,
  refreshLaPoste,
  refreshBoitesJaunes,
  refreshFedex,
  refreshUps,
  refreshOsm,
  candidatesFor,
  today,
  nowMinutes,
  mapsLinks,
};
