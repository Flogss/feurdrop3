/* Le rendu du lancement en WebGL2 : la meme scene que l'app (Metal,
   LumiereLancement.swift). Charge dans un worker (OffscreenCanvas, hors du
   fil principal : la page se construit dessous sans faire hoqueter la
   meteorite) ou, a defaut, sur le fil principal.

   La scene, en une passe plein ecran :
   - l'espace graphite, une nebuleuse violette qui derive, trois plans
     d'etoiles en parallaxe (la camera suit la meteorite et avance un peu) ;
   - au loin, une lumiere violette, puis un point qui s'allume ;
   - la meteorite : une vraie roche (relief, eclairage, bord incandescent du
     cote de la course), sa gaine de plasma, son onde de choc, etiree par la
     vitesse (flou de mouvement), qui courbe la lumiere des etoiles ;
   - sa trainee, qui ondule et s'effiloche ;
   - immobilisee au centre, la roche se fissure : la lumiere violette monte
     dans ses failles, puis chaque piece se detache a son tour ;
   - une onde de choc douce (pas d'eclair blanc), puis l'onde qui ouvre
     l'interface.
   Par-dessus, des traits calcules par la carte graphique a partir du
   temps : les braises semees par la trainee, les eclats de la roche (de
   vrais fragments, qui deviennent de l'energie puis sont attires un par un
   sur le symbole de DROP, qu'ils tracent en arrivant), quelques etincelles
   et le symbole trace en lumiere. */

(function (racine) {
  "use strict";

  // Le calendrier (secondes), le meme dans l'app (LaunchSequence.swift).
  const S = {
    point: 0.3, // au loin, un point violet s'allume
    depart: 0.7, // la meteorite se met en route, accelere, traverse
    arrivee: 2.3, // elle freine et s'immobilise au centre ; elle se fissure
    eclat: 2.72, // elle se fragmente
    attraction: 2.94, // ses eclats, devenus energie, sont attires sur le symbole
    logo: 3.72, // le symbole se condense en logo
    revelation: 4.0, // l'onde ouvre l'interface
    dureeRevelation: 0.95,
    vol: 0.66, // le logo rejoint la barre
    fin: 5.05,
    // les entrees courtes : une page rechargee (l'energie se rassemble en
    // logo) et l'arrivee depuis la connexion (le coeur deja au centre)
    retour: 2.95,
    connexion: 2.58,
  };
  // le trace du symbole suit l'arrivee des eclats
  const TRACE = { debut: S.attraction + 0.32, duree: 0.42 };

  const tirage = (i, k) => {
    const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const borne = (x, a, b) => Math.min(Math.max(x, a), b);
  const lisse = (x) => {
    const c = borne(x, 0, 1);
    return c * c * (3 - 2 * c);
  };

  // --- le symbole de DROP (la fleche qui tombe dans le bac) et son contour,
  // dans un carre de cote 1 centre sur l'origine

  function traitsGlyphe() {
    const q = (x, y) => [(x - 12) / 24, (y - 12) / 24];
    const bac = [q(4.5, 14.5), q(4.5, 17.5)];
    for (let i = 1; i <= 6; i++) {
      const a = Math.PI - (i / 6) * (Math.PI / 2);
      bac.push(q(7 + 2.5 * Math.cos(a), 17.5 + 2.5 * Math.sin(a)));
    }
    bac.push(q(17, 20));
    for (let i = 1; i <= 6; i++) {
      const a = Math.PI / 2 - (i / 6) * (Math.PI / 2);
      bac.push(q(17 + 2.5 * Math.cos(a), 17.5 + 2.5 * Math.sin(a)));
    }
    bac.push(q(19.5, 14.5));
    return [[q(12, 3.5), q(12, 14)], [q(7.5, 9.5), q(12, 14), q(16.5, 9.5)], bac];
  }

  const ARRONDI = 0.32;
  function traitContour() {
    const r = ARRONDI, d = 0.5, trait = [];
    const coins = [[[d - r, -d + r], -Math.PI / 2], [[d - r, d - r], 0], [[-d + r, d - r], Math.PI / 2], [[-d + r, -d + r], Math.PI]];
    for (const [c, depart] of coins) {
      for (let i = 0; i <= 8; i++) {
        const a = depart + (i / 8) * (Math.PI / 2);
        trait.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
      }
    }
    trait.push(trait[0]);
    return trait;
  }

  function repartis(nombre, traits) {
    const segs = [];
    for (const t of traits) for (let i = 0; i + 1 < t.length; i++) segs.push([t[i], t[i + 1], Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1])]);
    const total = segs.reduce((s, x) => s + x[2], 0);
    const sortie = [];
    let cumul = 0, i = 0;
    for (let n = 0; n < nombre; n++) {
      const voulu = ((n + 0.5) / nombre) * total;
      while (i < segs.length - 1 && cumul + segs[i][2] < voulu) cumul += segs[i++][2];
      const [a, b, l] = segs[i];
      const f = l > 0 ? borne((voulu - cumul) / l, 0, 1) : 0;
      sortie.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    return sortie;
  }

  // --- la course : une spirale qui part du fond (en haut a droite), passe
  // tout pres en traversant l'ecran, puis revient freiner au centre

  const PARTS_GLYPHE = 0.56; // la taille du glyphe dans le carre du logo
  const PART_CONTOUR = 0.45; // la part des eclats qui dessinent le contour

  // Catmull-Rom centripete : une courbe douce qui passe par chaque point
  function courbe(points, parSegment) {
    const prolonge = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    const P = [prolonge(points[0], points[1]), ...points, prolonge(points.at(-1), points.at(-2))];
    const sortie = [];
    const pas = (a, b) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-3);
    for (let i = 1; i < P.length - 2; i++) {
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
      const t0 = 0, t1 = t0 + pas(p0, p1), t2 = t1 + pas(p1, p2), t3 = t2 + pas(p2, p3);
      const mel = (a, b, ta, tb, t) => a.map((v, j) => ((tb - t) / (tb - ta)) * v + ((t - ta) / (tb - ta)) * b[j]);
      for (let j = 0; j < parSegment; j++) {
        const t = t1 + ((t2 - t1) * j) / parSegment;
        const A1 = mel(p0, p1, t0, t1, t), A2 = mel(p1, p2, t1, t2, t), A3 = mel(p2, p3, t2, t3, t);
        const B1 = mel(A1, A2, t0, t2, t), B2 = mel(A2, A3, t1, t3, t);
        sortie.push(mel(B1, B2, t1, t2, t));
      }
    }
    sortie.push(points.at(-1).slice());
    return sortie;
  }

  // l'avancee le long de la course : un depart doux, une pleine vitesse vers
  // 45 % du trajet, puis un long freinage jusqu'a l'arret
  const profil = (tau) => (1 - Math.cos(Math.PI * Math.pow(borne(tau, 0, 1), 0.8))) / 2;

  function decor(w, h) {
    const petit = Math.min(w, h);
    const k = borne(petit / 400, 0.9, 1.7);
    const centre = [0.5 * w, (w > h ? 0.47 : 0.42) * h];
    const cote = borne(petit * 0.3, 96, 150);
    const R0 = cote * 0.25; // la roche immobile au centre
    const Z_FIN = 0.62;
    const portrait = h > w * 1.15;
    // x, y (parts de l'ecran), profondeur (1 = tout pres)
    const F = portrait
      ? [[0.86, 0.1, 0.04], [0.66, 0.15, 0.14], [0.26, 0.26, 0.58], [0.13, 0.45, 0.92], [0.27, 0.62, 1.0], [0.66, 0.6, 0.86], [0.68, 0.5, 0.72]]
      : [[0.86, 0.14, 0.04], [0.64, 0.19, 0.14], [0.31, 0.3, 0.56], [0.15, 0.55, 0.92], [0.3, 0.8, 1.0], [0.58, 0.79, 0.86], [0.64, 0.61, 0.72]];
    const points = F.map(([x, y, z]) => [x * w, y * h, z]).concat([[centre[0], centre[1], Z_FIN]]);
    const echant = courbe(points, 70);
    const n = echant.length;
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), L = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      [X[i], Y[i], Z[i]] = echant[i];
      L[i] = i ? L[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]) : 0;
    }
    const d = { w, h, k, centre, cote, R0, Rmax: R0 / Z_FIN, Z_FIN, depart: [X[0], Y[0]], longueur: L[n - 1] };
    // le point de la course a la distance s (en pixels)
    d.surCourse = (s) => {
      s = borne(s, 0, d.longueur);
      let a = 0, b = n - 1;
      while (b - a > 1) {
        const m = (a + b) >> 1;
        if (L[m] < s) a = m;
        else b = m;
      }
      const f = L[b] > L[a] ? (s - L[a]) / (L[b] - L[a]) : 0;
      return [X[a] + (X[b] - X[a]) * f, Y[a] + (Y[b] - Y[a]) * f, Z[a] + (Z[b] - Z[a]) * f];
    };
    d.aInstant = (t) => d.surCourse(profil((t - S.depart) / (S.arrivee - S.depart)) * d.longueur);

    // les eclats de la roche : chacun part d'un point de la roche, jaillit,
    // ralentit, devient energie, puis rejoint sa place sur le symbole
    const nombre = w > 900 ? 440 : 320;
    const surContour = Math.floor(nombre * PART_CONTOUR);
    const cibles = repartis(surContour, [traitContour()]).concat(
      repartis(nombre - surContour, traitsGlyphe()).map(([x, y]) => [x * PARTS_GLYPHE, y * PARTS_GLYPHE])
    );
    const E = new Float32Array(nombre * 16);
    cibles.forEach((c, i) => {
      // ou il etait dans la roche (un disque), et vers ou il jaillit
      const a = tirage(i, 1) * 2 * Math.PI, r = Math.sqrt(tirage(i, 2)) * 0.92;
      const sx = Math.cos(a) * r, sy = Math.sin(a) * r;
      const dev = (tirage(i, 3) - 0.5) * 1.1;
      const s = i / (nombre - 1); // son rang sur le trace du symbole
      E.set([
        sx, sy, Math.cos(a + dev), Math.sin(a + dev),
        (80 + 560 * Math.pow(tirage(i, 4), 1.7)) * k, (tirage(i, 5) - 0.5) * 12, (1.3 + 1.6 * tirage(i, 6) + 5.5 * Math.pow(tirage(i, 14), 6)) * k, tirage(i, 7),
        c[0], c[1], S.attraction + s * 0.34 + 0.04 * tirage(i, 8), 0.32 + 0.07 * tirage(i, 9),
        // la courbe d'arrivee tourne surtout dans le meme sens (un tourbillon)
        (0.16 + 0.3 * tirage(i, 10)) * (tirage(i, 11) < 0.82 ? 1 : -1), tirage(i, 12) < 0.3 ? 1 : 0, s, 0.6 + 0.8 * tirage(i, 13),
      ], i * 16);
    });

    // quelques etincelles a l'eclat : de l'elan, pas un feu d'artifice
    const nE = 28;
    const T = new Float32Array(nE * 8);
    for (let i = 0; i < nE; i++) {
      const a = ((i + tirage(i, 11)) / nE) * 2 * Math.PI;
      T.set([Math.cos(a), Math.sin(a), (300 + 520 * tirage(i, 12)) * k, 0.4 + 0.35 * tirage(i, 13), (0.6 + 0.6 * tirage(i, 14)) * k, 0, 0, 0], i * 8);
    }

    // les braises semees par la trainee, plus nombreuses quand elle va vite
    const nB = w > 900 ? 120 : 84;
    const B = new Float32Array(nB * 8);
    let pose = 0;
    for (let i = 0; pose < nB && i < nB * 6; i++) {
      const tau = 0.06 + 0.86 * tirage(i, 21);
      const t = S.depart + tau * (S.arrivee - S.depart);
      const [x0, y0] = d.aInstant(t - 0.01), [x1, y1, z] = d.aInstant(t);
      const v = Math.hypot(x1 - x0, y1 - y0) * 100;
      if (tirage(i, 22) > Math.min(v / (0.9 * Math.max(w, h)), 1) * 1.1 + 0.08) continue;
      const l = Math.max(Math.hypot(x1 - x0, y1 - y0), 1e-3);
      const dx = (x1 - x0) / l, dy = (y1 - y0) / l;
      const recul = (40 + 170 * tirage(i, 23)) * k, cote2 = (-110 + 220 * tirage(i, 24)) * k;
      B.set([t, x1, y1, 0.45 + 0.65 * tirage(i, 25),
        -dx * recul - dy * cote2, -dy * recul + dx * cote2, (0.55 + 1.1 * tirage(i, 26)) * k * (0.45 + 0.55 * Math.min(z, 1)), 0.35 + 0.65 * tirage(i, 27)], pose * 8);
      pose += 1;
    }

    // le symbole trace en lumiere : contour, puis tige, pointe et bac, dans
    // l'ordre ou les eclats arrivent
    const segments = [];
    const ajoute = (traits, echelle, glyphe, de, a) => {
      const paires = [];
      for (const t of traits) for (let i = 0; i + 1 < t.length; i++) paires.push([t[i], t[i + 1]]);
      const total = paires.reduce((s, [p, q]) => s + Math.hypot(q[0] - p[0], q[1] - p[1]), 0);
      let cumul = 0;
      for (const [p, q] of paires) {
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        segments.push(p[0] * echelle, p[1] * echelle, q[0] * echelle, q[1] * echelle, de + (a - de) * (cumul / total), de + (a - de) * ((cumul + l) / total), glyphe ? 1 : 0, 0);
        cumul += l;
      }
    };
    ajoute([traitContour()], 1, false, 0, PART_CONTOUR);
    ajoute(traitsGlyphe(), PARTS_GLYPHE, true, PART_CONTOUR, 1);

    d.eclats = E;
    d.etincelles = T;
    d.braises = B.subarray(0, pose * 8);
    d.segments = new Float32Array(segments);
    // la lumiere violette au loin, d'ou vient la meteorite
    d.lointain = [X[0], Y[0]];
    return d;
  }

  // --- l'etat de la meteorite a l'instant t

  function meteore(d, t) {
    const m = { x: d.depart[0], y: d.depart[1], r: 0, intensite: 0, dx: -1, dy: 0, vitesse: 0, z: 0, angle: 0, fissures: 0, dissolution: 0, chaleur: 0 };
    if (t < S.point - 0.05 || t > S.eclat + 0.3) return m;
    m.angle = 0.85 * t + 0.5 * Math.sin(0.7 * t);
    if (t < S.depart) {
      // le point lointain s'allume, palpite
      const [x0, y0, z0] = d.aInstant(S.depart);
      const [x1, y1] = d.surCourse(4);
      const l = Math.max(Math.hypot(x1 - x0, y1 - y0), 1e-3);
      Object.assign(m, { x: x0, y: y0, z: z0, dx: (x1 - x0) / l, dy: (y1 - y0) / l });
      m.intensite = lisse((t - S.point) / 0.3) * (0.62 + 0.08 * Math.sin(t * 11));
    } else if (t < S.arrivee) {
      const [x, y, z] = d.aInstant(t);
      const [xa, ya] = d.aInstant(t - 1 / 120);
      const vx = (x - xa) * 120, vy = (y - ya) * 120, v = Math.hypot(vx, vy);
      Object.assign(m, { x, y, z });
      if (v > 1) {
        m.dx = vx / v;
        m.dy = vy / v;
      } else {
        const [xb, yb] = d.aInstant(t - 0.05);
        const l = Math.max(Math.hypot(x - xb, y - yb), 1e-3);
        m.dx = (x - xb) / l;
        m.dy = (y - yb) / l;
      }
      m.vitesse = Math.min(v / (1.05 * Math.max(d.w, d.h)), 1);
      const scintille = 1 + 0.06 * Math.sin(t * 47) + 0.04 * Math.sin(t * 29 + 1);
      m.intensite = (0.66 + 0.6 * m.vitesse) * scintille * (0.62 + 0.38 * lisse((t - S.depart) / 0.25));
      m.chaleur = 0.35 + 0.65 * m.vitesse;
    } else {
      // immobile au centre : elle flotte a peine, se fissure, la lumiere
      // monte en deux battements, puis elle se fragmente
      const h = t - S.arrivee;
      m.x = d.centre[0];
      m.y = d.centre[1] + Math.sin(h * 3.2) * 1.2 * d.k * (1 - lisse((t - S.eclat + 0.1) / 0.1));
      m.z = d.Z_FIN;
      const [xb, yb] = d.aInstant(S.arrivee - 0.08);
      const l = Math.max(Math.hypot(m.x - xb, m.y - yb), 1e-3);
      m.dx = (m.x - xb) / l;
      m.dy = (m.y - yb) / l;
      m.fissures = lisse((h - 0.03) / (S.eclat - S.arrivee - 0.05));
      const battement = 0.22 * Math.exp(-((t - (S.eclat - 0.24)) ** 2) / 0.0012) + 0.32 * Math.exp(-((t - (S.eclat - 0.06)) ** 2) / 0.0012);
      m.intensite = 0.78 + 0.35 * m.fissures + battement;
      m.chaleur = 0.25 + 0.3 * (1 - lisse(h / 0.3));
      m.dissolution = lisse((t - S.eclat) / 0.17);
    }
    m.r = Math.max(d.Rmax * m.z, 0.5);
    return m;
  }

  const N_TRAINEE = 28;
  function trainee(d, t, m, sortie) {
    if (!(t > S.depart && t < S.arrivee + 0.35)) return 0;
    const retrait = 1 - lisse((t - (S.arrivee - 0.2)) / 0.5);
    const monte = Math.min((t - S.depart) / 0.18, 1);
    const tTete = Math.min(t, S.arrivee);
    for (let j = 0; j < N_TRAINEE; j++) {
      const tj = Math.max(tTete - j * 0.0135, S.depart);
      const [x, y, z] = d.aInstant(tj);
      const f = 1 - j / (N_TRAINEE - 1);
      sortie[j * 4] = x;
      sortie[j * 4 + 1] = y;
      sortie[j * 4 + 2] = d.Rmax * z * 0.62 * Math.pow(f, 0.75) * (0.45 + 0.55 * m.vitesse) + 0.5;
      sortie[j * 4 + 3] = Math.pow(f, 1.5) * (0.25 + 1.05 * m.vitesse) * monte * retrait;
    }
    return N_TRAINEE;
  }

  function secousse(d, a) {
    if (!(a > 0 && a < 0.4)) return [0, 0];
    const amp = 2.2 * d.k * Math.exp(-a / 0.08);
    return [Math.sin(a * 90) * amp, Math.cos(a * 71) * amp * 0.8];
  }

  // l'onde qui ouvre l'interface : rayon, largeur du bord, eclat du bord
  function onde(d, t) {
    if (t < S.revelation) return [0, 0, 0];
    const s = Math.min((t - S.revelation) / S.dureeRevelation, 1);
    const e = 1 - Math.pow(1 - s, 1.8);
    const bord = (80 + 160 * e) * d.k;
    // jusqu'au coin le plus eloigne (bord compris)
    const coin = Math.hypot(Math.max(d.centre[0], d.w - d.centre[0]), Math.max(d.centre[1], d.h - d.centre[1]));
    return [d.cote * 0.6 + e * (coin + bord * 1.3), bord, Math.pow(1 - s, 1.3) * 0.95];
  }

  // --- les shaders

  const BRUITS = `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float bruit2(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm2(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * bruit2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float bruit3(vec3 p) {
  vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), b = mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x);
  float c = mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), d = mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * bruit3(p); p = p * 2.1 + 5.3; a *= 0.5; } return s / 0.875; }
// les failles de la roche : la distance au bord de sa cellule, et la cellule
vec3 cellules(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0; vec3 id = i;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 r = g + hash33(i + g) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = i + g; } else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d2) - sqrt(d1), hash13(id + 0.37), sqrt(d1));
}
`;

  const SCENE_V = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const SCENE_F = `#version 300 es
precision highp float;
uniform vec2 taille, centre;
uniform float t, echelle;
uniform vec4 tete;       // x, y, rayon, intensite
uniform vec4 mouvement;  // direction x, y, vitesse, profondeur
uniform vec4 roche;      // rotation, fissures, dissolution, chaleur
uniform vec4 eclat;      // age de l'eclat, k, secousse x, y
uniform vec4 onde;       // rayon, bord, eclat du bord, ambiance
uniform vec4 camera;     // decalage x, y, avancee, rayon de la roche
uniform vec4 lointain;   // x, y, eclat
uniform vec4 boite;
uniform int compte;
uniform vec4 trainee[${N_TRAINEE}];
out vec4 sortie;
${BRUITS}
vec3 couche(vec2 q, float cs, float seuil, float eclat_, float r0, vec2 dir, float etire, float graine) {
  vec2 id = floor(q / cs);
  vec2 f = q - id * cs;
  float h = hash12(id + graine);
  if (h < seuil) return vec3(0.0);
  vec2 ou = (vec2(hash12(id + graine + 7.1), hash12(id + graine + 3.7)) * 0.56 + 0.22) * cs;
  vec2 d = f - ou;
  float le = dot(d, dir) / etire, tr = dot(d, vec2(-dir.y, dir.x));
  float r = r0 * (0.55 + hash12(id + graine + 1.3));
  float scintille = 0.62 + 0.38 * sin(t * (1.3 + h * 3.0) + h * 40.0);
  vec3 teinte = mix(vec3(0.74, 0.70, 1.0), vec3(1.0, 0.96, 1.0), hash12(id + graine + 9.0));
  return teinte * exp(-(le * le + tr * tr) / (r * r)) * (h - seuil) / (1.0 - seuil) * eclat_ * scintille / sqrt(etire);
}
vec3 tourne(vec3 n, float a) {
  float c = cos(a), s = sin(a);
  n = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  float c2 = cos(a * 0.37 + 0.6), s2 = sin(a * 0.37 + 0.6);
  return vec3(n.x, c2 * n.y - s2 * n.z, s2 * n.y + c2 * n.z);
}
vec3 doux(vec3 c) { return 1.0 - exp(-c * 1.18); }

void main() {
  vec2 position = vec2(gl_FragCoord.x, taille.y * echelle - gl_FragCoord.y) / echelle;
  vec2 dcR = position - centre;
  // deja decouvert par l'onde : rien a calculer
  if (onde.x > 0.0 && length(dcR) < onde.x - onde.y * 1.35) { sortie = vec4(0.0); return; }
  float k = eclat.y;
  float a = eclat.x;
  float amb = onde.w;
  vec2 p = position - eclat.zw;
  vec2 dc = p - centre;
  float dcl = length(dc);
  float diag = length(taille);
  float R0 = camera.w;
  float v = mouvement.z;
  vec2 dir = mouvement.xy;

  // --- l'espace : graphite profond, une nebuleuse violette qui derive
  vec2 uv = (p - 0.5 * taille) / taille.y;
  vec3 c = vec3(0.021, 0.019, 0.032);
  float n1 = fbm2(uv * 1.6 + vec2(0.022 * t, -0.012 * t) + camera.xy * 0.0006);
  float n2 = fbm2(uv * 3.3 - vec2(0.016 * t, 0.025 * t) + n1 * 1.4);
  c += vec3(0.044, 0.019, 0.092) * smoothstep(0.45, 0.98, n1 + 0.3 * n2);
  c += vec3(0.016, 0.008, 0.040) * n2 * n2;
  // la lumiere violette au loin, d'ou vient la meteorite
  vec2 dl = (p - lointain.xy) / taille.y;
  c += vec3(0.10, 0.045, 0.24) * exp(-length(dl) * 3.0) * (0.4 + 0.6 * lointain.z);
  c *= amb;

  // --- ou lire les etoiles : la meteorite courbe la lumiere, les ondes de
  // choc la font onduler, la camera la suit et avance
  vec2 q = p;
  vec2 dh = p - tete.xy;
  float dd = length(dh);
  if (tete.w > 0.001 && a <= 0.0) {
    float portee = tete.z * 2.4 + 2.0;
    q -= (dh / max(dd, 0.001)) * (3.0 + 11.0 * v) * k * min(mouvement.w, 1.0) * exp(-dd / portee);
  }
  vec2 radial = dc / max(dcl, 0.001);
  float anneau1 = 0.0, anneau2 = 0.0, pr1 = 0.0, pr2 = 0.0;
  if (a > 0.0) {
    pr1 = clamp(a / 1.1, 0.0, 1.0);
    float r1 = (1.0 - pow(1.0 - pr1, 3.0)) * 0.8 * diag;
    float x1 = (dcl - r1) / ((4.0 + 40.0 * pr1) * k);
    anneau1 = exp(-x1 * x1);
    pr2 = clamp((a - 0.14) / 1.0, 0.0, 1.0);
    float r2 = (1.0 - pow(1.0 - pr2, 3.0)) * 0.55 * diag;
    float x2 = (dcl - r2) / ((3.0 + 26.0 * pr2) * k);
    anneau2 = pr2 > 0.0 ? exp(-x2 * x2) : 0.0;
    q -= radial * (12.0 * anneau1 * (1.0 - pr1) + 6.0 * anneau2 * (1.0 - pr2)) * k;
  }
  vec3 etoiles = vec3(0.0);
  etoiles += couche(centre + (q - centre) / (1.0 + 0.9 * camera.z) - camera.xy * 0.22, 46.0 * k, 0.72, 1.05, 1.2 * k, dir, 1.0 + v * 2.3, 11.0);
  etoiles += couche(centre + (q - centre) / (1.0 + 0.45 * camera.z) - camera.xy * 0.1, 28.0 * k, 0.56, 0.8, 0.85 * k, dir, 1.0 + v * 1.3, 23.0);
  etoiles += couche(q - camera.xy * 0.04, 17.0 * k, 0.46, 0.55, 0.62 * k, dir, 1.0 + v * 0.5, 37.0);
  c += etoiles * amb;

  // --- la trainee : son coeur, sa lueur, qui ondule et s'effiloche
  float coeurT = 0.0, lueurT = 0.0;
  if (p.x > boite.x && p.y > boite.y && p.x < boite.z && p.y < boite.w) {
    for (int j = 0; j < ${N_TRAINEE - 1}; j++) {
      if (j + 1 >= compte) break;
      vec4 A = trainee[j], B = trainee[j + 1];
      vec2 pa = p - A.xy, ba = B.xy - A.xy;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.001), 0.0, 1.0);
      float d = length(pa - ba * h);
      float l = max(mix(A.z, B.z, h), 0.3);
      float I = mix(A.w, B.w, h);
      float fj = float(j) + h;
      float ondule = 0.78 + 0.22 * sin(fj * 1.9 - t * 26.0) * sin(fj * 0.7 + t * 9.0);
      float x = d / (l * ondule);
      coeurT = max(coeurT, I * exp(-x * x));
      lueurT += I * 0.2 * exp(-d / (l * 3.2 + 2.0 * k)) * (0.7 + 0.3 * ondule);
    }
  }
  c += mix(vec3(0.46, 0.28, 1.0), vec3(0.95, 0.91, 1.0), clamp(coeurT * 0.9, 0.0, 1.0)) * coeurT * 1.15;
  c += mix(vec3(0.20, 0.09, 0.52), vec3(0.52, 0.34, 1.0), clamp(lueurT * 1.4, 0.0, 1.0)) * lueurT * 1.35;

  // --- la meteorite
  if (tete.w > 0.001) {
    vec2 perp = vec2(-dir.y, dir.x);
    float R = max(tete.z, 0.5);
    // la lumiere s'etire derriere elle (le flou de mouvement), a peine devant
    float lon = dot(dh, dir);
    vec2 e = vec2(lon / (lon < 0.0 ? 1.0 + v * 2.2 : 1.0 + v * 0.25), dot(dh, perp));
    float le = length(e);
    float I = tete.w;
    float vie = 1.0 - roche.z;
    // la lumiere qu'elle jette autour d'elle, son halo
    c += vec3(0.20, 0.09, 0.48) * exp(-dd / (240.0 * k)) * I * 0.11 * vie;
    c += vec3(0.44, 0.28, 1.0) * exp(-le / (R * 2.4 + 3.0 * k)) * I * 0.34 * vie;
    c += vec3(0.82, 0.74, 1.0) * exp(-le / (R * 0.8 + 1.2 * k)) * I * 0.22 * vie;
    // au loin : un point, et ses aigrettes
    float loin = 1.0 - smoothstep(1.5, 7.0, R);
    if (loin > 0.0) {
      float aigrette = exp(-abs(dh.x) / (0.8 * k)) * exp(-abs(dh.y) / (24.0 * k)) + exp(-abs(dh.y) / (0.8 * k)) * exp(-abs(dh.x) / (24.0 * k));
      c += vec3(0.72, 0.62, 1.0) * aigrette * loin * I * 0.45;
      c += vec3(0.95, 0.9, 1.0) * exp(-dd * dd / (2.2 * k * k)) * loin * I * 1.1;
    }
    // l'onde de choc devant elle, et sa gaine de plasma
    vec2 u = e / R;
    if (v > 0.01 && le < R * 4.0) {
      float front = u.x - (1.08 - 0.36 * u.y * u.y);
      float choc = exp(-abs(front) * 4.5) * smoothstep(2.1, 0.5, abs(u.y)) * smoothstep(-1.6, -0.4, u.x);
      c += vec3(0.62, 0.50, 1.0) * choc * v * roche.w * 0.75 * I;
      float gaine = exp(-max(length(u) - 1.0, 0.0) / 0.22) * pow(max(u.x / max(length(u), 0.001), 0.0), 1.5) * step(1.0, length(u));
      c += vec3(0.85, 0.78, 1.0) * gaine * v * roche.w * 0.9 * I;
    }
    // le corps : une roche eclairee (relief, crateres), son bord
    // incandescent du cote de la course, ses failles ; a peine etiree par la
    // vitesse (le flou de mouvement est dans la lumiere) ; a l'eclat, chaque
    // piece se detache a son tour
    vec2 ec = vec2(dot(dh, dir) / (1.0 + v * 0.28), dot(dh, perp)) / R;
    float lc = length(ec);
    // une silhouette irreguliere qui tourne avec la roche
    vec2 sens = ec / max(lc, 0.001);
    float ca = cos(roche.x * 0.8), sa = sin(roche.x * 0.8);
    float bosse = bruit2(vec2(ca * sens.x - sa * sens.y, sa * sens.x + ca * sens.y) * 1.7 + 4.0) - 0.5;
    float rr = lc / (1.0 + 0.16 * bosse);
    float couvre = (1.0 - smoothstep(1.0 - 1.6 / R, 1.0, rr)) * (1.0 - loin);
    if (couvre > 0.0) {
      vec3 n = vec3(ec / (1.0 + 0.16 * bosse), 0.0);
      n.z = sqrt(max(1.0 - dot(n.xy, n.xy), 0.0));
      vec3 tn = tourne(n, roche.x);
      // le relief et sa pente : la surface accroche la lumiere
      float relief = fbm3(tn * 3.4 + 3.1);
      float rx = fbm3((tn + vec3(0.04, 0.0, 0.0)) * 3.4 + 3.1), ry = fbm3((tn + vec3(0.0, 0.04, 0.0)) * 3.4 + 3.1);
      vec3 cr = cellules(tn * 2.2 + 7.3);
      float cratere = 1.0 - smoothstep(0.12, 0.32, cr.z);
      vec3 nb = normalize(n + vec3(relief - rx, relief - ry, 0.0) * 9.0 + vec3(sens * cratere * 0.35, 0.0) * step(0.55, cr.y));
      vec3 L = normalize(vec3(0.62, -0.42, 0.66));
      float diff = clamp(dot(nb, L), 0.0, 1.0);
      vec3 albedo = mix(vec3(0.040, 0.036, 0.058), vec3(0.26, 0.23, 0.32), smoothstep(0.3, 0.78, relief)) * (1.0 - 0.45 * cratere * step(0.55, cr.y));
      vec3 col = albedo * (0.1 + 1.2 * pow(diff, 1.3));
      float avant = clamp(dot(nb, normalize(vec3(1.0, 0.0, 0.3))), 0.0, 1.0);
      col += mix(vec3(0.5, 0.3, 1.0), vec3(1.0, 0.94, 1.0), pow(avant, 6.0)) * pow(avant, 2.6) * roche.w * (0.3 + 1.05 * v) * (0.55 + 0.9 * relief);
      col += vec3(0.48, 0.32, 1.0) * pow(1.0 - n.z, 2.4) * (0.45 + 0.6 * roche.w);
      vec3 vo = cellules(tn * 2.7 + 1.7);
      float fis = (1.0 - smoothstep(0.0, 0.03 + 0.07 * roche.y, vo.x)) * roche.y;
      col += mix(vec3(0.55, 0.35, 1.0), vec3(1.0, 0.95, 1.0), roche.y * roche.y) * fis * 2.4;
      col += vec3(0.30, 0.16, 0.85) * roche.y * roche.y * (1.0 - relief) * 0.9;
      float partie = smoothstep(vo.y - 0.05, vo.y + 0.05, roche.z * 1.12);
      col += vec3(0.7, 0.55, 1.0) * smoothstep(0.0, 0.5, roche.z) * (1.0 - partie) * 0.6;
      couvre *= (1.0 - partie) * min(I * 1.6, 1.0);
      c = mix(c, col, couvre);
    }
  }

  // --- l'eclat : une lumiere violette qui se libere (pas d'eclair blanc),
  // un trait anamorphique, deux ondes de choc
  if (a > 0.0) {
    float f = 0.85 * exp(-a / 0.24) + 0.22 * exp(-a / 0.9);
    c += vec3(0.60, 0.44, 1.0) * exp(-dcl / (R0 * 1.5)) * f * 0.85;
    c += vec3(0.90, 0.85, 1.0) * exp(-dcl * dcl / (R0 * R0 * 0.3)) * exp(-a / 0.11) * 0.5;
    c += vec3(0.30, 0.16, 0.80) * exp(-dcl / (230.0 * k)) * f * 0.13;
    float an = exp(-a / 0.3);
    c += vec3(0.68, 0.58, 1.0) * exp(-abs(dc.y) / (1.1 * k)) * exp(-abs(dc.x) / (0.3 * taille.x)) * an * 0.55;
    c += vec3(0.40, 0.28, 1.0) * exp(-abs(dc.y) / (14.0 * k)) * exp(-abs(dc.x) / (0.24 * taille.x)) * an * 0.12;
    c += vec3(0.70, 0.60, 1.0) * anneau1 * 0.34 * pow(1.0 - pr1, 1.6);
    c += vec3(0.50, 0.38, 1.0) * anneau2 * 0.2 * pow(1.0 - pr2, 1.6);
  }
  c = doux(c);
  // un vignettage doux et un grain de pellicule, a peine
  vec2 vg = (position / taille - 0.5) * vec2(taille.x / taille.y, 1.0);
  c *= 1.0 - 0.32 * smoothstep(0.3, 1.0, length(vg) * 1.15);
  c += (hash12(gl_FragCoord.xy + fract(t * 7.13) * 400.0) - 0.5) * 0.014 * amb;

  // --- la revelation : dans l'onde, l'interface ; sur son bord, une lumiere
  // violette qui se diffracte (lilas dedans, bleu-violet dehors)
  float opacite = 1.0;
  vec3 bord = vec3(0.0);
  float eclatBord = 0.0;
  if (onde.x > 0.0) {
    float r = length(dcR) + (bruit2(dcR / max(length(dcR), 0.001) * 2.6 + t * 1.7) - 0.5) * onde.y * 0.16;
    opacite = 1.0 - smoothstep(onde.x, onde.x - onde.y, r);
    float x = (r - onde.x + onde.y * 0.35) / (onde.y * 0.42);
    eclatBord = exp(-x * x) * onde.z;
    float x2 = (r - onde.x + onde.y * 0.12) / (onde.y * 0.22);
    bord = vec3(0.55, 0.40, 1.0) * eclatBord * 0.55 + vec3(0.92, 0.88, 1.0) * eclatBord * eclatBord * 0.2 + vec3(0.32, 0.42, 1.0) * exp(-x2 * x2) * onde.z * 0.1;
  }
  sortie = vec4(c * opacite + bord, clamp(opacite + eclatBord * 0.3, 0.0, 1.0));
}`;

  // les traits de lumiere : un segment (un point s'il est court), un coeur
  // et une lueur ; chaque sorte calcule sa position a partir du temps.
  // La lueur s'eteint avant le bord du quadrilatere : jamais de carre.
  const TRAIT_COMMUN = `#version 300 es
precision highp float;
uniform vec4 impact;
uniform vec2 taille, centre;
uniform float t, cote, k, r0;
layout(location = 0) in vec4 a0;
layout(location = 1) in vec4 a1;
layout(location = 2) in vec4 a2;
layout(location = 3) in vec4 a3;
out vec2 vP;
flat out vec2 vA, vB;
flat out float vRayon, vHalo, vAlpha, vDegrade, vEtendue, vForme, vAngle, vEtire;
flat out vec3 vCouleur, vLueur;
const float ECLAT = ${S.eclat}, LOGO = ${S.logo}, DEPART = ${S.depart}, ARRIVEE = ${S.arrivee};
const float TRACE0 = ${TRACE.debut}, TRACED = ${TRACE.duree};
const vec3 LILAS = vec3(0.77, 0.67, 1.0), BLANC = vec3(1.0, 0.98, 1.0), VIOLET = vec3(0.55, 0.36, 1.0);
float lisse(float x) { float c = clamp(x, 0.0, 1.0); return c * c * (3.0 - 2.0 * c); }
float entreeSortie(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
void trait(vec2 a, vec2 b, float rayon, float halo, float alpha, vec3 couleur, vec3 lueur, float degrade, float forme, float angle, float etire) {
  a += impact.zw; b += impact.zw;
  vec2 d = b - a;
  float l = length(d);
  vec2 axe = l > 0.01 ? d / l : vec2(1.0, 0.0);
  vec2 cote_ = vec2(-axe.y, axe.x);
  float e = alpha > 0.002 ? rayon * 2.6 + halo * 5.0 : 0.0;
  float sx = (gl_VertexID & 1) == 1 ? 1.0 : -1.0, sy = (gl_VertexID & 2) == 2 ? 1.0 : -1.0;
  vec2 p = (sx < 0.0 ? a - axe * e : b + axe * e) + cote_ * sy * e;
  gl_Position = vec4(p.x / taille.x * 2.0 - 1.0, 1.0 - p.y / taille.y * 2.0, 0.0, 1.0);
  vP = p; vA = a; vB = b;
  vRayon = max(rayon, 0.2); vHalo = max(halo, 0.2); vAlpha = alpha; vDegrade = degrade; vEtendue = max(e, 0.5);
  vForme = forme; vAngle = angle; vEtire = etire;
  vCouleur = couleur; vLueur = lueur;
}
`;

  const TRAITS_V = {
    // a0 : naissance, x, y, vie ; a1 : vx, vy, rayon, eclat
    braise: `${TRAIT_COMMUN}
vec2 position(float age) {
  vec2 p = a0.yz + a1.xy * (1.0 - exp(-2.4 * age)) / 2.4;
  return p + vec2(sin(age * 7.0 + a0.x * 40.0), cos(age * 5.5 + a0.x * 23.0)) * 5.0 * k * age;
}
void main() {
  float age = t - a0.x;
  float alpha = 0.0;
  vec2 p = a0.yz, avant = p;
  if (age > 0.0 && age < a0.w) {
    p = position(age);
    avant = position(max(age - 0.022, 0.0));
    alpha = a1.w * pow(1.0 - age / a0.w, 1.4) * min(age / 0.05, 1.0) * 0.95;
  }
  float froid = clamp(age / a0.w, 0.0, 1.0);
  vec3 c = mix(a1.w > 0.8 ? BLANC : LILAS, VIOLET, froid);
  trait(avant, p, a1.z * 0.75, a1.z * 1.5, alpha, c, VIOLET, 1.0, 0.0, 0.0, 1.0);
}`,
    // a0 : dx, dy, elan, vie ; a1 : largeur
    etincelle: `${TRAIT_COMMUN}
void main() {
  float age = t - ECLAT - 0.03;
  float alpha = 0.0;
  vec2 tete = centre, queue = centre;
  if (age > 0.0 && age < a0.w) {
    float freine = exp(-5.0 * age);
    tete = centre + a0.xy * (a0.z * (1.0 - freine) / 5.0 + r0 * 0.8);
    queue = tete - a0.xy * (min(a0.z * freine * 0.05, 60.0 * k) + 2.0);
    alpha = pow(1.0 - age / a0.w, 1.5) * min(age / 0.05, 1.0) * 0.6;
  }
  trait(queue, tete, a1.x * 0.5, a1.x * 1.4, alpha, BLANC, LILAS, 1.0, 0.0, 0.0, 1.0);
}`,
    // a0 : depart dans la roche (x, y), direction (x, y)
    // a1 : elan, rotation, taille, graine ; a2 : cible (x, y), debut et duree de l'attraction
    // a3 : courbure, blanc, rang sur le trace, allongement
    eclat: `${TRAIT_COMMUN}
vec2 rafale(float tt) {
  float age = max(tt - ECLAT, 0.0);
  vec2 p = centre + a0.xy * r0 + a0.zw * a1.x * (1.0 - exp(-3.2 * age)) / 3.2;
  return p + vec2(sin(age * 2.3 + a1.w * 6.28), cos(age * 1.9 + a1.w * 9.0)) * 7.0 * k * min(age, 1.0);
}
vec2 position(float tt) {
  vec2 b = rafale(tt);
  float e = entreeSortie(clamp((tt - a2.z) / a2.w, 0.0, 1.0));
  vec2 cible = centre + a2.xy * cote;
  vec2 d = cible - b;
  vec2 ctrl = (b + cible) * 0.5 + vec2(-d.y, d.x) * a3.x;
  float w = 1.0 - e;
  return w * w * b + 2.0 * e * w * ctrl + e * e * cible;
}
void main() {
  float age = t - ECLAT;
  float arrivee = a2.z + a2.w;
  float alpha = 0.0;
  // le fragment de roche devient energie
  float forme = lisse((age - 0.05) / 0.3);
  if (age > 0.0) {
    float pose = t > arrivee ? 1.0 + 1.1 * exp(-(t - arrivee) / 0.09) : 1.0;
    float scintille = t > arrivee ? 0.86 + 0.14 * sin(t * 10.0 + a1.w * 50.0) : 1.0;
    alpha = min(age / 0.06, 1.0) * (1.0 - lisse((t - (LOGO + 0.02)) / 0.3)) * min(pose * scintille, 1.8);
  }
  vec2 p = position(t), avant = position(t - 1.0 / 60.0);
  float taille_ = a1.z * mix(1.0, 0.42, forme) * (t > arrivee ? 0.85 : 1.0);
  vec3 c = (a3.y > 0.5 || t > arrivee) ? BLANC : LILAS;
  trait(avant, p, taille_ * 0.55, taille_ * 1.25 + 1.2 * k, alpha, c, VIOLET, 1.0, 1.0 - forme, a1.y * age + a1.w * 6.28, a1.w);
}`,
    // a0 : a, b ; a1 : debut et fin (part du trace), glyphe ?
    neon: `${TRAIT_COMMUN}
void main() {
  float f = clamp((t - TRACE0) / TRACED, 0.0, 1.0);
  float alpha = (1.0 - lisse((t - (LOGO + 0.04)) / 0.3)) * lisse((t - TRACE0) / 0.12);
  vec2 a = centre + a0.xy * cote, b = centre + a0.zw * cote;
  if (f <= a1.x) alpha = 0.0;
  else if (f < a1.y) b = mix(a, b, (f - a1.x) / (a1.y - a1.x));
  bool glyphe = a1.z > 0.5;
  trait(a, b, (glyphe ? 1.15 : 0.85) * k, 3.4 * k, alpha * (glyphe ? 1.0 : 0.8), glyphe ? BLANC : LILAS, VIOLET, 0.0, 0.0, 0.0, 1.0);
}`,
  };

  const TRAIT_F = `#version 300 es
precision highp float;
in vec2 vP;
flat in vec2 vA, vB;
flat in float vRayon, vHalo, vAlpha, vDegrade, vEtendue, vForme, vAngle, vEtire;
flat in vec3 vCouleur, vLueur;
out vec4 sortie;
// un eclat de roche : un polygone irregulier (trois ou quatre faces tirees
// au sort d'apres la graine de l'eclat)
float eclatForme(vec2 p, float g) {
  float d = -1e3;
  float faces = fract(g * 13.7) < 0.5 ? 3.0 : 4.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    if (fi >= faces) break;
    float ang = fi * 6.2831853 / faces + 0.7 * (fract(g * (3.1 + fi * 5.3)) - 0.5);
    float o = 0.42 + 0.3 * fract(g * (7.7 + fi * 2.9));
    d = max(d, dot(p, vec2(cos(ang), sin(ang))) - o);
  }
  return d;
}
void main() {
  vec2 pa = vP - vA, ba = vB - vA;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  float d = length(pa - ba * h);
  float x = d / vRayon;
  float queue = mix(1.0, h, vDegrade);
  // la lueur s'eteint avant le bord du quadrilatere
  float fenetre = 1.0 - smoothstep(vEtendue * 0.55, vEtendue * 0.98, d);
  vec3 c = (vCouleur * exp(-x * x) + vLueur * 0.3 * exp(-d / vHalo)) * queue * fenetre;
  float couvre = 0.0;
  if (vForme > 0.001) {
    // tant que c'est un fragment : un corps de roche sombre, un fil
    // incandescent sur ses aretes, la lumiere violette qui en sort
    vec2 l = vP - vB;
    float ca = cos(vAngle), sa = sin(vAngle);
    l = vec2(ca * l.x - sa * l.y, sa * l.x + ca * l.y) / (vRayon * 2.4);
    float tr = eclatForme(l, vEtire);
    float corps = 1.0 - smoothstep(-0.03, 0.04, tr);
    float arete = exp(-abs(min(tr, 0.0)) * 22.0) * corps;
    vec3 roche = vec3(0.07, 0.06, 0.1) + vec3(0.16, 0.09, 0.36) * smoothstep(-0.5, 0.0, tr);
    vec3 fragment = roche * corps + mix(vLueur, vCouleur, 0.5) * arete * 0.9 + vLueur * 0.22 * exp(-max(tr, 0.0) * 4.0) * fenetre;
    c = mix(c, fragment, vForme);
    couvre = corps * vForme * 0.9;
  }
  c *= vAlpha;
  sortie = vec4(c, clamp(max(max(c.r, max(c.g, c.b)) * 0.5, couvre * vAlpha), 0.0, 1.0));
}`;

  // --- le rendu

  function creeRendu(toile) {
    const gl = toile.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
    if (!gl) return null;

    const programme = (v, f) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, v], [gl.FRAGMENT_SHADER, f]]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const nom = gl.getActiveUniform(p, i).name.replace("[0]", "");
        u[nom] = gl.getUniformLocation(p, nom);
      }
      return { p, u };
    };

    let scene, traits;
    try {
      scene = programme(SCENE_V, SCENE_F);
      traits = Object.fromEntries(Object.entries(TRAITS_V).map(([nom, v]) => [nom, programme(v, TRAIT_F)]));
    } catch (e) {
      console.warn("lancement : shaders", e);
      return null;
    }
    const vaoVide = gl.createVertexArray();

    let d = null, dpr = 1, lots = null, entree = 0;
    const tTrainee = new Float32Array(N_TRAINEE * 4);

    // les donnees des particules, chargees une fois par taille d'ecran
    function charge() {
      const lot = (donnees, parInstance) => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const tampon = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, tampon);
        gl.bufferData(gl.ARRAY_BUFFER, donnees, gl.STATIC_DRAW);
        const pas = parInstance * 16;
        for (let i = 0; i < 4; i++) {
          if (i < parInstance) {
            gl.enableVertexAttribArray(i);
            gl.vertexAttribPointer(i, 4, gl.FLOAT, false, pas, i * 16);
            gl.vertexAttribDivisor(i, 1);
          } else {
            gl.disableVertexAttribArray(i);
            gl.vertexAttrib4f(i, 0, 0, 0, 0);
          }
        }
        gl.bindVertexArray(null);
        return { vao, nombre: donnees.length / (parInstance * 4) };
      };
      lots = {
        braise: lot(d.braises, 2),
        etincelle: lot(d.etincelles, 2),
        eclat: lot(d.eclats, 4),
        neon: lot(d.segments, 2),
      };
    }

    return {
      taille(w, h, ratio) {
        dpr = ratio;
        toile.width = Math.round(w * dpr);
        toile.height = Math.round(h * dpr);
        d = decor(w, h);
        charge();
      },
      /** l'instant de la sequence ou cette entree commence (le fond s'y allume) */
      entree(t0) {
        entree = t0;
      },
      image(t) {
        if (!d) return;
        gl.viewport(0, 0, toile.width, toile.height);
        const m = meteore(d, t);
        const a = t - S.eclat;
        const sec = secousse(d, a);
        const o = onde(d, t);
        const n = trainee(d, t, m, tTrainee);
        let boite = [0, 0, 0, 0];
        if (n) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, marge = 0;
          for (let j = 0; j < n; j++) {
            x0 = Math.min(x0, tTrainee[j * 4]); x1 = Math.max(x1, tTrainee[j * 4]);
            y0 = Math.min(y0, tTrainee[j * 4 + 1]); y1 = Math.max(y1, tTrainee[j * 4 + 1]);
            marge = Math.max(marge, tTrainee[j * 4 + 2]);
          }
          const mg = marge * 22 + 30 * d.k;
          boite = [x0 - mg, y0 - mg, x1 + mg, y1 + mg];
        }
        // l'ambiance : le fond s'allume, s'assombrit quand la roche se
        // fissure (la lumiere se concentre sur elle), puis revient
        const retient = lisse((t - S.arrivee) / 0.3) * (1 - lisse((t - S.eclat) / 0.35));
        const ambiance = lisse((t - entree) / 0.5) * (1 - 0.3 * retient);
        // la camera suit un peu la meteorite et avance doucement
        const cam = m.intensite > 0 && t < S.arrivee ? [(m.x - d.centre[0]) * 0.06, (m.y - d.centre[1]) * 0.06] : [0, 0];
        const avancee = 0.035 * lisse(t / 3.2) + 0.03 * lisse((t - S.eclat) / 0.6);
        const loin = lisse((t - 0.05) / 0.6) * (1 - 0.6 * lisse((t - S.depart) / 0.8));

        gl.disable(gl.BLEND);
        gl.useProgram(scene.p);
        const u = scene.u;
        gl.uniform4f(u.tete, m.x, m.y, m.r, m.intensite);
        gl.uniform4f(u.mouvement, m.dx, m.dy, m.vitesse, m.z);
        gl.uniform4f(u.roche, m.angle, m.fissures, m.dissolution, m.chaleur);
        gl.uniform4f(u.eclat, a, d.k, sec[0], sec[1]);
        gl.uniform4f(u.onde, o[0], o[1], o[2], ambiance);
        gl.uniform4f(u.camera, cam[0], cam[1], avancee, d.R0);
        gl.uniform4f(u.lointain, d.lointain[0], d.lointain[1], loin, 0);
        gl.uniform4f(u.boite, boite[0], boite[1], boite[2], boite[3]);
        gl.uniform2f(u.taille, d.w, d.h);
        gl.uniform2f(u.centre, d.centre[0], d.centre[1]);
        gl.uniform1f(u.t, t);
        gl.uniform1f(u.echelle, dpr);
        gl.uniform1i(u.compte, n);
        gl.uniform4fv(u.trainee, tTrainee);
        gl.bindVertexArray(vaoVide);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // la lumiere des braises, eclats, etincelles et du symbole ; les
        // fragments de roche (encore sombres) cachent ce qui est derriere
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const actifs = {
          braise: t > S.depart && t < S.arrivee + 1.3,
          etincelle: t > S.eclat && t < S.eclat + 0.85,
          eclat: t > S.eclat && t < S.logo + 0.34,
          neon: t > TRACE.debut && t < S.logo + 0.36,
        };
        for (const nom of Object.keys(actifs)) {
          if (!actifs[nom]) continue;
          const pr = traits[nom];
          gl.useProgram(pr.p);
          gl.uniform4f(pr.u.impact, a, d.k, sec[0], sec[1]);
          gl.uniform2f(pr.u.taille, d.w, d.h);
          gl.uniform2f(pr.u.centre, d.centre[0], d.centre[1]);
          gl.uniform1f(pr.u.t, t);
          if (pr.u.cote) gl.uniform1f(pr.u.cote, d.cote);
          if (pr.u.k) gl.uniform1f(pr.u.k, d.k);
          if (pr.u.r0) gl.uniform1f(pr.u.r0, d.R0);
          gl.bindVertexArray(lots[nom].vao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lots[nom].nombre);
        }
        gl.bindVertexArray(null);
      },
      geometrie() {
        return d ? { centre: d.centre, cote: d.cote, k: d.k } : null;
      },
    };
  }

  racine.LancementDrop = { S, creeRendu, decor, onde };
})(typeof self !== "undefined" ? self : window);
