// Choisir N boites parmi les candidates ET l'ordre de passage qui rendent la
// tournee la plus courte en voiture, depuis le depart (sans retour).
//
// Ce n'est pas « les N plus proches » : sur la matrice des temps routiers
// (asymetrique : sens uniques, demi-tours), on cherche le chemin le plus
// rapide qui passe par exactement N boites. Le probleme est difficile en
// toute generalite (un voyageur de commerce ou l'on choisit aussi les
// villes) ; avec une centaine de candidates et une vingtaine d'arrets au
// plus, une recherche locale tres complete donne l'optimum en pratique :
//   1. construction par insertion la moins chere, depuis plusieurs premiers
//      arrets (les plus rapides a atteindre) ;
//   2. amelioration jusqu'a ce que plus rien ne gagne : changer une boite
//      pour une autre (a sa meilleure place), deplacer un arret, deplacer un
//      bloc de 2-3 arrets, inverser un morceau du chemin (2-opt) ;
//   3. pour proposer « une autre tournee », la meilleure tournee qui se passe
//      de l'une des boites de la meilleure, et ainsi de suite.
// Tout se joue en memoire sur la matrice : aucune requete de plus.

const INFINI = Number.POSITIVE_INFINITY;

// Le cout d'un trajet a -> b : son temps, et la distance pour departager
// deux trajets aussi rapides (1 km = 1 s).
function coutsDe(durees, distances) {
  const n = durees.length;
  const c = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const t = durees[i]?.[j];
      const d = distances?.[i]?.[j];
      c[i][j] = i === j ? 0 : Number.isFinite(t) && t !== null ? t + (Number.isFinite(d) ? d / 1000 : 0) : INFINI;
    }
  }
  return c;
}

function coutChemin(c, chemin) {
  let total = 0;
  for (let i = 0; i < chemin.length - 1; i += 1) total += c[chemin[i]][chemin[i + 1]];
  return total;
}

// Le surcout d'inserer x avant la position p (p = longueur : a la fin).
function surcout(c, chemin, x, p) {
  const a = chemin[p - 1];
  if (p === chemin.length) return c[a][x];
  const b = chemin[p];
  return c[a][x] + c[x][b] - c[a][b];
}

function meilleurePlace(c, chemin, x) {
  let mieux = { p: -1, delta: INFINI };
  for (let p = 1; p <= chemin.length; p += 1) {
    const delta = surcout(c, chemin, x, p);
    if (delta < mieux.delta) mieux = { p, delta };
  }
  return mieux;
}

// Insertion la moins chere jusqu'a N arrets.
function construit(c, n, depart, candidates) {
  const chemin = [...depart];
  const dedans = new Set(chemin);
  while (chemin.length - 1 < n) {
    let mieux = null;
    for (const x of candidates) {
      if (dedans.has(x)) continue;
      const m = meilleurePlace(c, chemin, x);
      if (!mieux || m.delta < mieux.delta) mieux = { x, ...m };
    }
    if (!mieux || !Number.isFinite(mieux.delta)) break;
    chemin.splice(mieux.p, 0, mieux.x);
    dedans.add(mieux.x);
  }
  return chemin;
}

const EPS = 1e-9;

// Recherche locale : on applique la premiere amelioration trouvee, jusqu'a
// ce qu'aucun mouvement ne fasse gagner.
function ameliore(c, chemin, candidates) {
  let courant = [...chemin];
  let cout = coutChemin(c, courant);
  const n = courant.length - 1;
  for (let tour = 0; tour < 500; tour += 1) {
    let gagne = false;

    // 1. changer une boite pour une autre, a sa meilleure place
    const dedans = new Set(courant);
    for (let i = 1; i <= n && !gagne; i += 1) {
      const sans = [...courant.slice(0, i), ...courant.slice(i + 1)];
      const base = coutChemin(c, sans);
      for (const x of candidates) {
        if (dedans.has(x) && x !== courant[i]) continue;
        const m = meilleurePlace(c, sans, x);
        if (base + m.delta < cout - EPS) {
          sans.splice(m.p, 0, x);
          courant = sans;
          cout = base + m.delta;
          gagne = true;
          break;
        }
      }
    }
    if (gagne) continue;

    // 2. deplacer un bloc de 1, 2 ou 3 arrets ailleurs dans le chemin
    for (let longueur = 1; longueur <= 3 && !gagne; longueur += 1) {
      for (let i = 1; i + longueur - 1 <= n && !gagne; i += 1) {
        const bloc = courant.slice(i, i + longueur);
        const reste = [...courant.slice(0, i), ...courant.slice(i + longueur)];
        for (let p = 1; p <= reste.length; p += 1) {
          if (p === i) continue;
          const essai = [...reste.slice(0, p), ...bloc, ...reste.slice(p)];
          const ce = coutChemin(c, essai);
          if (ce < cout - EPS) {
            courant = essai;
            cout = ce;
            gagne = true;
            break;
          }
        }
      }
    }
    if (gagne) continue;

    // 3. inverser un morceau (2-opt ; la matrice n'est pas symetrique, on
    // recalcule le morceau)
    for (let i = 1; i < n && !gagne; i += 1) {
      for (let j = i + 1; j <= n && !gagne; j += 1) {
        const essai = [...courant.slice(0, i), ...courant.slice(i, j + 1).reverse(), ...courant.slice(j + 1)];
        const ce = coutChemin(c, essai);
        if (ce < cout - EPS) {
          courant = essai;
          cout = ce;
          gagne = true;
        }
      }
    }
    if (!gagne) break;
  }
  return { chemin: courant, cout };
}

// La meilleure tournee de n arrets parmi `candidates` (indices de la
// matrice ; 0 = le depart), depuis plusieurs premiers arrets.
function meilleureParmi(c, n, candidates, { departs = 12 } = {}) {
  const atteignables = candidates.filter((x) => Number.isFinite(c[0][x]));
  const k = Math.min(n, atteignables.length);
  if (k === 0) return null;
  const premiers = [...atteignables].sort((a, b) => c[0][a] - c[0][b]).slice(0, departs);
  let mieux = null;
  const essais = [construit(c, k, [0], atteignables), ...premiers.map((x) => construit(c, k, [0, x], atteignables))];
  for (const depart of essais) {
    if (depart.length - 1 < k) continue;
    const r = ameliore(c, depart, atteignables);
    if (Number.isFinite(r.cout) && (!mieux || r.cout < mieux.cout - EPS)) mieux = r;
  }
  return mieux;
}

/**
 * Les meilleures tournees de `n` arrets, de la plus rapide a la moins rapide,
 * chacune avec une selection de boites differente. `durees`, `distances` :
 * la matrice routiere, l'indice 0 etant le depart.
 *   -> [{ ordre: [indices des arrets, dans l'ordre], cout }]
 */
function meilleuresTournees(durees, distances, n, { variantes = 1 } = {}) {
  const c = coutsDe(durees, distances);
  const tous = Array.from({ length: c.length - 1 }, (_, i) => i + 1);
  const meilleure = meilleureParmi(c, n, tous);
  if (!meilleure) return [];
  const trouvees = new Map();
  const cle = (chemin) => [...chemin.slice(1)].sort((a, b) => a - b).join(",");
  const garde = (r) => {
    if (!r) return;
    const k = cle(r.chemin);
    if (!trouvees.has(k) || trouvees.get(k).cout > r.cout) trouvees.set(k, r);
  };
  garde(meilleure);
  // d'autres tournees : la meilleure qui se passe d'une (puis de deux) des
  // boites deja proposees
  const aEcarter = [[...meilleure.chemin.slice(1)].map((x) => [x])];
  for (let profondeur = 0; profondeur < 2 && trouvees.size < variantes; profondeur += 1) {
    const suivants = [];
    for (const groupe of aEcarter[profondeur] || []) {
      if (trouvees.size >= variantes + 2) break;
      const interdits = new Set(groupe);
      const r = meilleureParmi(c, n, tous.filter((x) => !interdits.has(x)), { departs: 6 });
      if (r && r.chemin.length - 1 === meilleure.chemin.length - 1) {
        garde(r);
        for (const x of r.chemin.slice(1)) suivants.push([...groupe, x]);
      }
    }
    aEcarter.push(suivants.slice(0, 12));
  }
  return [...trouvees.values()].sort((a, b) => a.cout - b.cout).map((r) => ({ ordre: r.chemin.slice(1), cout: r.cout }));
}

module.exports = { meilleuresTournees, coutsDe, coutChemin };
