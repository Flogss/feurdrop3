// Ordre de passage. Deux contraintes, dans cet ordre : arriver avant que le
// point ferme, puis rouler le moins possible. Un trajet plus court qui fait
// rater une fermeture n'est pas un trajet plus court, c'est un colis a
// ramener.

const EARTH = 6371000;
// Un trajet reel n'est jamais une ligne droite : rues a sens unique, ponts,
// virages. Facteur mesure classique en zone dense.
const ROAD_FACTOR = 1.35;
// Vitesse moyenne porte a porte en Ile-de-France, feux et stationnement
// compris. Volontairement pessimiste.
const URBAN_KMH = 18;

function haversine(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH * Math.asin(Math.sqrt(h));
}

// Matrice des trajets entre tous les points. Sans service de calcul
// d'itineraire, c'est une ESTIMATION a vol d'oiseau corrigee : l'interface doit
// le dire, et c'est Google Maps qui donnera le temps reel.
function estimateMatrix(places) {
  const n = places.length;
  const meters = Array.from({ length: n }, () => new Array(n).fill(0));
  const seconds = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const distance = haversine(places[i], places[j]) * ROAD_FACTOR;
      meters[i][j] = Math.round(distance);
      seconds[i][j] = Math.round((distance / 1000 / URBAN_KMH) * 3600);
    }
  }
  return { meters, seconds, estimated: true };
}

// Deroule un ordre de passage : heure d'arrivee a chaque arret, et arrets
// atteints trop tard.
function simulate(order, matrix, stops, departAt, serviceMinutes) {
  let clock = departAt;
  let from = 0;
  let meters = 0;
  let late = 0;
  let softLate = 0;
  let waited = 0;
  const arrivals = [];

  for (const index of order) {
    const travel = matrix.seconds[from][index + 1];
    meters += matrix.meters[from][index + 1];
    clock += travel / 60;
    arrivals.push(clock);

    const stop = stops[index];
    // arrive avant l'ouverture : on attend devant la porte. Compter cette
    // attente dans la duree suffit a ce que le calcul prefere passer ailleurs
    // d'abord, sans qu'on ait a le lui dire.
    if (stop.opensAt !== null && stop.opensAt !== undefined && clock < stop.opensAt) {
      waited += stop.opensAt - clock;
      clock = stop.opensAt;
      arrivals[arrivals.length - 1] = clock;
    }

    // une echeance "souple" (levee d'une boite aux lettres) se rate sans
    // gravite : on la compte a part et elle ne sert qu'a departager
    if (stop.deadline !== null && stop.deadline !== undefined && clock > stop.deadline) {
      if (stop.soft) softLate += 1;
      else late += 1;
    }
    clock += serviceMinutes;
    from = index + 1;
  }

  return { arrivals, meters, minutes: clock - departAt, late, softLate, waited };
}

// Un trajet est meilleur qu'un autre s'il rate moins de fermetures ; a egalite,
// s'il rate moins de levees ; a egalite encore, s'il roule moins.
function better(a, b) {
  if (!a) return true;
  if (b.late !== a.late) return b.late < a.late;
  if (b.softLate !== a.softLate) return b.softLate < a.softLate;
  // une heure d'attente devant un rideau ferme coute plus cher qu'un detour
  if (Math.abs(b.waited - a.waited) > 1) return b.waited < a.waited;
  return b.meters < a.meters - 1;
}

function* permutations(list) {
  if (list.length <= 1) {
    yield list;
    return;
  }
  for (let i = 0; i < list.length; i += 1) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const tail of permutations(rest)) yield [list[i], ...tail];
  }
}

// Jusqu'a 8 arrets on essaie tous les ordres possibles (40 320 au pire, c'est
// instantane) : le resultat est optimal, pas approche. Au-dela, plus proche
// voisin puis 2-opt.
const EXACT_LIMIT = 8;

function optimize({ stops, matrix, departAt = 9 * 60, serviceMinutes = 4 }) {
  const indexes = stops.map((_, i) => i);
  if (indexes.length === 0) {
    return { order: [], arrivals: [], meters: 0, minutes: 0, late: 0, softLate: 0, waited: 0 };
  }

  let best = null;
  let bestOrder = null;

  if (indexes.length <= EXACT_LIMIT) {
    for (const order of permutations(indexes)) {
      const run = simulate(order, matrix, stops, departAt, serviceMinutes);
      if (better(best, run)) {
        best = run;
        bestOrder = order;
      }
    }
  } else {
    bestOrder = nearestFirst(indexes, matrix, stops);
    best = simulate(bestOrder, matrix, stops, departAt, serviceMinutes);

    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < bestOrder.length - 1; i += 1) {
        for (let j = i + 1; j < bestOrder.length; j += 1) {
          const candidate = [...bestOrder];
          candidate.splice(i, j - i + 1, ...bestOrder.slice(i, j + 1).reverse());
          const run = simulate(candidate, matrix, stops, departAt, serviceMinutes);
          if (better(best, run)) {
            best = run;
            bestOrder = candidate;
            improved = true;
          }
        }
      }
    }
  }

  return { order: bestOrder, ...best };
}

// Depart : le plus proche, mais un point qui ferme tot passe devant.
function nearestFirst(indexes, matrix, stops) {
  const left = new Set(indexes);
  const order = [];
  let from = 0;

  while (left.size > 0) {
    let pick = null;
    for (const index of left) {
      const stop = stops[index];
      const score = {
        deadline: stop.deadline ?? Infinity,
        travel: matrix.seconds[from][index + 1],
        index,
      };
      if (
        !pick ||
        score.deadline < pick.deadline - 30 ||
        (Math.abs(score.deadline - pick.deadline) <= 30 && score.travel < pick.travel)
      ) {
        pick = score;
      }
    }
    order.push(pick.index);
    left.delete(pick.index);
    from = pick.index + 1;
  }
  return order;
}

module.exports = { haversine, estimateMatrix, optimize, simulate, URBAN_KMH, ROAD_FACTOR };
