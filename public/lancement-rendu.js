/* Le rendu du lancement en WebGL2 : la meme sequence que l'app (Metal).
   Charge dans un worker (OffscreenCanvas, hors du fil principal : la page
   se construit dessous sans faire hoqueter la meteorite) ou, a defaut, sur
   le fil principal.

   Une passe plein ecran pour la lumiere continue (l'espace graphite et ses
   etoiles que la meteorite courbe, la meteorite et sa trainee, l'impact,
   l'onde qui ouvre l'interface), puis des traits additifs calcules par la
   carte graphique a partir du temps : braises, etincelles, particules qui
   reviennent dessiner le symbole, et le symbole trace en lumiere. */

(function (racine) {
  "use strict";

  const S = { point: 0.12, depart: 0.3, impact: 1.3, logo: 2.12, revelation: 2.45, dureeRevelation: 0.8, vol: 0.62, fin: 3.3 };

  const tirage = (i, k) => {
    const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const lisse = (x) => {
    const c = Math.min(Math.max(x, 0), 1);
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
      const f = l > 0 ? Math.min(Math.max((voulu - cumul) / l, 0), 1) : 0;
      sortie.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    return sortie;
  }

  // --- le decor d'une taille d'ecran : la course et les particules

  const progression = (t) => {
    const tau = Math.min(Math.max((t - S.depart) / (S.impact - S.depart), 0), 1);
    return 1 - Math.pow(1 - Math.pow(tau, 2.4), 1.7);
  };
  const profondeur = (u) => 0.1 + 0.9 * Math.pow(u, 1.6);

  function decor(w, h) {
    const petit = Math.min(w, h);
    const k = Math.min(Math.max(petit / 400, 0.9), 1.7);
    const d = {
      w, h, k,
      depart: [0.1 * w, 0.15 * h],
      controle: [0.74 * w, 0.02 * h],
      centre: [0.5 * w, (w > h ? 0.47 : 0.42) * h],
      cote: Math.min(Math.max(petit * 0.3, 96), 150),
    };
    d.point = (u) => {
      const v = 1 - u;
      return [v * v * d.depart[0] + 2 * u * v * d.controle[0] + u * u * d.centre[0], v * v * d.depart[1] + 2 * u * v * d.controle[1] + u * u * d.centre[1]];
    };

    // les particules : 45 % sur le contour, 55 % sur le symbole
    const nombre = w > 900 ? 480 : 340;
    const surContour = Math.floor(nombre * 0.45);
    const cibles = repartis(surContour, [traitContour()]).concat(repartis(nombre - surContour, traitsGlyphe()).map(([x, y]) => [x * 0.56, y * 0.56]));
    const P = new Float32Array(nombre * 12);
    cibles.forEach((c, i) => {
      const a = tirage(i, 1) * 2 * Math.PI;
      P.set([c[0], c[1], Math.cos(a), Math.sin(a),
        (200 + 560 * tirage(i, 2)) * k, S.impact + 0.1 + 0.3 * tirage(i, 3), 0.48 + 0.24 * tirage(i, 4), (0.18 + 0.25 * tirage(i, 5)) * (tirage(i, 6) < 0.5 ? -1 : 1),
        (0.75 + 1.1 * tirage(i, 7)) * k, tirage(i, 8) < 0.28 ? 1 : 0, 0, 0], i * 12);
    });

    // les etincelles de l'impact
    const E = new Float32Array(48 * 8);
    for (let i = 0; i < 48; i++) {
      const a = ((i + tirage(i, 11)) / 48) * 2 * Math.PI;
      E.set([Math.cos(a), Math.sin(a), (380 + 760 * tirage(i, 12)) * k, 0.45 + 0.4 * tirage(i, 13), (0.7 + 0.8 * tirage(i, 14)) * k, 0, 0, 0], i * 8);
    }

    // les braises semees pendant la course
    const B = new Float32Array(72 * 8);
    for (let i = 0; i < 72; i++) {
      const tau = 0.08 + 0.9 * Math.pow(tirage(i, 21), 0.7);
      const naissance = S.depart + tau * (S.impact - S.depart);
      const u = progression(naissance);
      const p = d.point(u), avant = d.point(Math.max(u - 0.01, 0));
      let dx = p[0] - avant[0], dy = p[1] - avant[1];
      const l = Math.max(Math.hypot(dx, dy), 0.001);
      dx /= l; dy /= l;
      const recul = (30 + 160 * tirage(i, 22)) * k, cote = (-150 + 300 * tirage(i, 23)) * k;
      B.set([naissance, p[0], p[1], 0.25 + 0.4 * tirage(i, 24),
        -dx * recul - dy * cote, -dy * recul + dx * cote, (0.5 + 1.0 * tirage(i, 25)) * k * (0.4 + 0.6 * profondeur(u)), 0.35 + 0.65 * tirage(i, 26)], i * 8);
    }

    // le symbole trace en lumiere : contour, puis tige, pointe et bac
    const segments = [];
    const ajoute = (traits, echelle, glyphe) => {
      const paires = [];
      for (const t of traits) for (let i = 0; i + 1 < t.length; i++) paires.push([t[i], t[i + 1]]);
      const total = paires.reduce((s, [a, b]) => s + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
      let cumul = 0;
      for (const [a, b] of paires) {
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        segments.push(a[0] * echelle, a[1] * echelle, b[0] * echelle, b[1] * echelle, cumul / total, (cumul + l) / total, glyphe ? 1 : 0, 0);
        cumul += l;
      }
    };
    ajoute([traitContour()], 1, false);
    ajoute(traitsGlyphe(), 0.56, true);
    d.particules = P;
    d.etincelles = E;
    d.braises = B;
    d.segments = new Float32Array(segments);
    return d;
  }

  function meteore(d, t) {
    const m = { x: 0, y: 0, intensite: 0, halo: 1, dx: 1, dy: 0, vitesse: 0, z: 0 };
    if (t < S.point || t >= S.impact) return m;
    const u = progression(t);
    const p = d.point(u);
    m.x = p[0]; m.y = p[1];
    m.z = profondeur(u);
    const compression = lisse((t - (S.impact - 0.13)) / 0.13);
    if (t < S.depart) {
      const f = lisse((t - S.point) / 0.14);
      m.intensite = 0.8 * f * (1 + 0.6 * Math.exp(-(t - S.point) / 0.07));
      const tx = d.controle[0] - d.depart[0], ty = d.controle[1] - d.depart[1], l = Math.hypot(tx, ty);
      m.dx = tx / l; m.dy = ty / l;
    } else {
      const avant = d.point(progression(t - 1 / 120));
      const vx = (p[0] - avant[0]) * 120, vy = (p[1] - avant[1]) * 120, v = Math.hypot(vx, vy);
      if (v > 1) { m.dx = vx / v; m.dy = vy / v; }
      m.vitesse = Math.min(v / (1.4 * Math.max(d.w, d.h)), 1);
      const scintille = 1 + 0.07 * Math.sin(t * 53) + 0.05 * Math.sin(t * 31 + 1);
      m.intensite = (0.78 + 0.5 * m.vitesse) * scintille * (1 + 1.4 * compression);
    }
    m.halo = 80 * m.z * d.k * (1 + 0.25 * compression);
    return m;
  }

  const N_TRAINEE = 26;
  function trainee(d, t, m, sortie) {
    if (!(t > S.depart && t < S.impact)) return 0;
    const retrait = 1 - lisse((t - (S.impact - 0.14)) / 0.14);
    const monte = Math.min((t - S.depart) / 0.12, 1);
    for (let j = 0; j < N_TRAINEE; j++) {
      const tj = Math.max(t - j * 0.0125 * retrait, S.depart);
      const u = progression(tj);
      const p = d.point(u);
      const f = 1 - j / (N_TRAINEE - 1);
      sortie[j * 4] = p[0];
      sortie[j * 4 + 1] = p[1];
      sortie[j * 4 + 2] = 7.5 * d.k * profondeur(u) * Math.pow(f, 0.9) + 0.4;
      sortie[j * 4 + 3] = Math.pow(f, 1.7) * (0.3 + 0.95 * m.vitesse) * monte;
    }
    return N_TRAINEE;
  }

  function secousse(d, a) {
    if (!(a > 0 && a < 0.45)) return [0, 0];
    const amp = 3 * d.k * Math.exp(-a / 0.09);
    return [Math.sin(a * 95) * amp, Math.cos(a * 73) * amp * 0.8];
  }

  function onde(d, t) {
    if (t < S.revelation) return [0, 0, 0];
    const s = Math.min((t - S.revelation) / S.dureeRevelation, 1);
    const e = 1 - Math.pow(1 - s, 1.8);
    const bord = (80 + 160 * e) * d.k;
    const coin = Math.hypot(Math.max(d.centre[0], d.w - d.centre[0]), Math.max(d.centre[1], d.h - d.centre[1]));
    return [d.cote * 0.6 + e * (coin + bord * 1.3), bord, Math.pow(1 - s, 1.3) * 0.95];
  }

  // --- les shaders

  const SCENE_V = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const SCENE_F = `#version 300 es
precision highp float;
uniform vec4 tete, mouvement, impact, onde, boite;
uniform vec2 taille, centre;
uniform float t, echelle;
uniform int compte;
uniform vec4 trainee[${N_TRAINEE}];
out vec4 sortie;

float alea(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 doux(vec3 c) { return 1.0 - exp(-c * 1.15); }

void main() {
  vec2 position = vec2(gl_FragCoord.x, taille.y * echelle - gl_FragCoord.y) / echelle;
  // deja decouvert par l'onde : rien a calculer
  if (onde.x > 0.0 && length(position - centre) < onde.x - onde.y * 1.2) { sortie = vec4(0.0); return; }
  float k = impact.y;
  vec2 p = position - impact.zw;
  float diag = length(taille);
  float a = impact.x;

  // le fond : graphite, une nebuleuse violette tres sombre
  vec3 c = vec3(0.027, 0.024, 0.040);
  vec2 uv = p / taille;
  vec2 ecart = (uv - vec2(0.5, 0.42)) * vec2(taille.x / taille.y, 1.0);
  c += vec3(0.034, 0.018, 0.078) * exp(-dot(ecart, ecart) * 2.4) * onde.w;
  c += vec3(0.020, 0.008, 0.048) * exp(-length(uv - vec2(0.15, 0.1)) * 3.2) * onde.w;

  // ou lire les etoiles : la meteorite les ecarte, les ondes de choc les font onduler
  vec2 q = p;
  vec2 dh = p - tete.xy;
  float dd = length(dh);
  if (tete.z > 0.001) {
    float portee = tete.w * 0.55 + 1.0;
    q -= (dh / max(dd, 0.001)) * (6.0 + 18.0 * mouvement.z) * k * mouvement.w * exp(-dd / portee);
  }
  vec2 dc = p - centre;
  float dcl = length(dc);
  vec2 radial = dc / max(dcl, 0.001);
  float anneau1 = 0.0, anneau2 = 0.0, pr1 = 0.0, pr2 = 0.0;
  if (a > 0.0) {
    pr1 = clamp(a / 0.95, 0.0, 1.0);
    float r1 = (1.0 - pow(1.0 - pr1, 3.0)) * 0.85 * diag;
    float x1 = (dcl - r1) / ((3.0 + 34.0 * pr1) * k);
    anneau1 = exp(-x1 * x1);
    pr2 = clamp((a - 0.12) / 0.9, 0.0, 1.0);
    float r2 = (1.0 - pow(1.0 - pr2, 3.0)) * 0.6 * diag;
    float x2 = (dcl - r2) / ((2.0 + 22.0 * pr2) * k);
    anneau2 = pr2 > 0.0 ? exp(-x2 * x2) : 0.0;
    q -= radial * (14.0 * anneau1 * (1.0 - pr1) + 8.0 * anneau2 * (1.0 - pr2)) * k;
  }

  // les etoiles, a peine etirees dans le sens de la course
  float cote = 30.0 * k;
  vec2 caseId = floor(q / cote);
  vec2 dansCase = q - caseId * cote;
  float tir = alea(caseId);
  if (tir > 0.38) {
    vec2 ou = (vec2(alea(caseId + 7.1), alea(caseId + 3.7)) * 0.5 + 0.25) * cote;
    vec2 d = dansCase - ou;
    vec2 dir = mouvement.xy;
    float le = dot(d, dir), tr = dot(d, vec2(-dir.y, dir.x));
    le /= 1.0 + mouvement.z * 3.2 * step(0.001, tete.z);
    float r = (0.45 + alea(caseId + 1.3) * 0.75) * k;
    float scintille = 0.55 + 0.45 * sin(t * (1.5 + tir * 3.0) + tir * 40.0);
    c += vec3(0.82, 0.78, 1.0) * (tir - 0.38) * 1.6 * scintille * exp(-(le * le + tr * tr) / (r * r)) * onde.w;
  }

  // la meteorite : un coeur blanc-violet, un halo, une lumiere douce ; etiree par la vitesse
  if (tete.z > 0.001 && dd < max(tete.w * 9.0, 900.0 * k)) {
    vec2 dir = mouvement.xy;
    float le = dot(dh, dir), tr = dot(dh, vec2(-dir.y, dir.x));
    vec2 e = vec2(le / (1.0 + mouvement.z * 2.6), tr);
    float r = tete.w;
    float rc = r * 0.085;
    float coeur = exp(-dot(e, e) / (rc * rc));
    float halo = exp(-length(e) / (r * 0.26));
    float large = exp(-length(e) / (r * 1.1));
    c += (vec3(1.0, 0.96, 1.0) * coeur * 1.35 + vec3(0.70, 0.58, 1.0) * halo * 0.70 + vec3(0.40, 0.26, 0.92) * large * 0.10) * tete.z;
    c += vec3(0.62, 0.52, 1.0) * exp(-abs(dh.y) / (1.1 * k)) * exp(-abs(dh.x) / (r * 1.5)) * 0.4 * tete.z;
    c += vec3(0.16, 0.08, 0.38) * exp(-dd / (170.0 * k)) * tete.z * 0.22;
  }

  // la trainee : le coeur (max) et sa lueur (somme)
  float coeurT = 0.0, lueurT = 0.0;
  bool pres = p.x > boite.x && p.y > boite.y && p.x < boite.z && p.y < boite.w;
  if (pres) {
    for (int j = 0; j < ${N_TRAINEE - 1}; j++) {
      if (j + 1 >= compte) break;
      vec4 A = trainee[j], B = trainee[j + 1];
      vec2 pa = p - A.xy, ba = B.xy - A.xy;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.001), 0.0, 1.0);
      float d = length(pa - ba * h);
      float l = max(mix(A.z, B.z, h), 0.25);
      float I = mix(A.w, B.w, h);
      float x = d / l;
      coeurT = max(coeurT, I * exp(-x * x));
      lueurT += I * 0.22 * exp(-d / (l * 4.0 + 2.0 * k));
    }
  }
  c += mix(vec3(0.42, 0.26, 0.95), vec3(0.92, 0.88, 1.0), clamp(coeurT, 0.0, 1.0)) * coeurT * 1.25;
  c += vec3(0.48, 0.32, 1.0) * lueurT * 1.3;

  // l'impact : un eclair contenu, le trait anamorphique, les ondes de choc, un voile
  if (a > 0.0) {
    float f = exp(-a / 0.085) + 0.42 * exp(-a / 0.5);
    float xc = dcl / (20.0 * k);
    c += vec3(0.92, 0.86, 1.0) * exp(-xc * xc) * f * 0.62;
    c += vec3(0.60, 0.44, 1.0) * exp(-dcl / (58.0 * k)) * f * 0.6;
    c += vec3(0.34, 0.20, 0.85) * exp(-dcl / (200.0 * k)) * f * 0.09;
    float an = exp(-a / 0.34);
    c += vec3(0.72, 0.62, 1.0) * exp(-abs(dc.y) / (1.2 * k)) * exp(-abs(dc.x) / (0.36 * taille.x)) * an * 0.85;
    c += vec3(0.42, 0.30, 1.0) * exp(-abs(dc.y) / (15.0 * k)) * exp(-abs(dc.x) / (0.28 * taille.x)) * an * 0.16;
    c += vec3(0.74, 0.62, 1.0) * anneau1 * 0.5 * pow(1.0 - pr1, 1.5);
    c += vec3(0.55, 0.42, 1.0) * anneau2 * 0.28 * pow(1.0 - pr2, 1.5);
    c += vec3(0.03, 0.014, 0.07) * exp(-a / 0.5);
  }
  c = doux(c);

  // la revelation : dans l'onde, l'interface ; sur son bord, une lumiere violette
  float opacite = 1.0;
  vec3 bord = vec3(0.0);
  float eclatBord = 0.0;
  if (onde.x > 0.0) {
    opacite = 1.0 - smoothstep(onde.x, onde.x - onde.y, dcl);
    float x = (dcl - onde.x + onde.y * 0.35) / (onde.y * 0.45);
    eclatBord = exp(-x * x) * onde.z;
    bord = vec3(0.55, 0.40, 1.0) * eclatBord * 0.6 + vec3(0.95, 0.90, 1.0) * eclatBord * eclatBord * 0.25;
  }
  sortie = vec4(c * opacite + bord, clamp(opacite + eclatBord * 0.3, 0.0, 1.0));
}`;

  // les traits de lumiere : un segment (un point s'il est court), un coeur
  // et une lueur ; chaque sorte calcule sa position a partir du temps
  const TRAIT_COMMUN = `#version 300 es
precision highp float;
uniform vec4 impact;
uniform vec2 taille, centre;
uniform float t, cote, k;
layout(location = 0) in vec4 a0;
layout(location = 1) in vec4 a1;
layout(location = 2) in vec4 a2;
out vec2 vP;
flat out vec2 vA, vB;
flat out float vRayon, vHalo, vAlpha, vDegrade;
flat out vec3 vCouleur, vLueur;
const float IMPACT = ${S.impact}, LOGO = ${S.logo};
const vec3 LILAS = vec3(0.77, 0.67, 1.0), BLANC = vec3(1.0, 0.98, 1.0), VIOLET = vec3(0.57, 0.38, 1.0);
float lisse(float x) { float c = clamp(x, 0.0, 1.0); return c * c * (3.0 - 2.0 * c); }
float entreeSortie(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
void trait(vec2 a, vec2 b, float rayon, float halo, float alpha, vec3 couleur, vec3 lueur, float degrade) {
  a += impact.zw; b += impact.zw;
  vec2 d = b - a;
  float l = length(d);
  vec2 axe = l > 0.01 ? d / l : vec2(1.0, 0.0);
  vec2 cote = vec2(-axe.y, axe.x);
  float e = alpha > 0.002 ? rayon * 2.5 + halo * 4.5 : 0.0;
  float sx = (gl_VertexID & 1) == 1 ? 1.0 : -1.0, sy = (gl_VertexID & 2) == 2 ? 1.0 : -1.0;
  vec2 p = (sx < 0.0 ? a - axe * e : b + axe * e) + cote * sy * e;
  gl_Position = vec4(p.x / taille.x * 2.0 - 1.0, 1.0 - p.y / taille.y * 2.0, 0.0, 1.0);
  vP = p; vA = a; vB = b;
  vRayon = max(rayon, 0.2); vHalo = max(halo, 0.2); vAlpha = alpha; vDegrade = degrade;
  vCouleur = couleur; vLueur = lueur;
}
`;

  const TRAITS_V = {
    // a0 : naissance, x, y, vie ; a1 : vx, vy, rayon, eclat
    braise: `${TRAIT_COMMUN}
void main() {
  float age = t - a0.x;
  float alpha = 0.0;
  vec2 p = a0.yz;
  if (age > 0.0 && age < a0.w) {
    p += a1.xy * (1.0 - exp(-2.2 * age)) / 2.2;
    alpha = a1.w * pow(1.0 - age / a0.w, 1.5) * 0.9;
  }
  vec3 c = a1.w > 0.85 ? BLANC : LILAS;
  trait(p, p, a1.z * 0.8, a1.z * 1.3, alpha, c, c, 0.0);
}`,
    // a0 : dx, dy, elan, vie ; a1 : largeur
    etincelle: `${TRAIT_COMMUN}
void main() {
  float age = t - IMPACT;
  float alpha = 0.0;
  vec2 tete = centre, queue = centre;
  if (age > 0.0 && age < a0.w) {
    float freine = exp(-5.0 * age);
    tete = centre + a0.xy * (a0.z * (1.0 - freine) / 5.0 + 14.0 * k);
    queue = tete - a0.xy * (min(a0.z * freine * 0.045, 64.0 * k) + 2.0);
    alpha = pow(1.0 - age / a0.w, 1.4) * min(age / 0.06, 1.0) * 0.75;
  }
  trait(queue, tete, a1.x * 0.55, a1.x * 1.4, alpha, BLANC, LILAS, 1.0);
}`,
    // a0 : cible x, y, dir x, y ; a1 : elan, debut, duree, spirale ; a2 : rayon, blanche
    particule: `${TRAIT_COMMUN}
vec2 position(float tt) {
  float age = max(tt - IMPACT, 0.0);
  vec2 eclat = centre + a0.zw * (a1.x * (1.0 - exp(-3.4 * age)) / 3.4);
  float e = entreeSortie(clamp((tt - a1.y) / a1.z, 0.0, 1.0));
  vec2 cible = centre + a0.xy * cote;
  vec2 d = cible - eclat;
  float spirale = a1.w * sin(3.14159265 * e);
  return vec2(eclat.x + d.x * e - d.y * spirale, eclat.y + d.y * e + d.x * spirale);
}
void main() {
  float age = t - IMPACT;
  float arrivee = a1.y + a1.z;
  float pose = t > arrivee ? 1.0 + 0.8 * exp(-(t - arrivee) / 0.12) : 1.0;
  float scintille = t > arrivee ? 0.85 + 0.15 * sin(t * 9.0 + float(gl_InstanceID)) : 1.0;
  float alpha = age > 0.0 ? clamp(age / 0.14, 0.0, 1.0) * (1.0 - lisse((t - (LOGO + 0.02)) / 0.28)) * min(pose * scintille, 1.6) * 0.9 : 0.0;
  float rayon = a2.x * (t > arrivee ? 0.9 : 1.0);
  vec3 c = (a2.y > 0.5 || t > arrivee) ? BLANC : LILAS;
  trait(position(t - 1.0 / 120.0), position(t), rayon * 0.85, rayon * 1.3, alpha, c, LILAS, 0.0);
}`,
    // a0 : a, b ; a1 : debut et fin (part du trace), glyphe ?
    neon: `${TRAIT_COMMUN}
void main() {
  float f = lisse((t - 1.84) / 0.36);
  float alpha = f * (1.0 - lisse((t - (LOGO + 0.06)) / 0.26));
  vec2 a = centre + a0.xy * cote, b = centre + a0.zw * cote;
  if (f <= a1.x) alpha = 0.0;
  else if (f < a1.y) b = mix(a, b, (f - a1.x) / (a1.y - a1.x));
  bool glyphe = a1.z > 0.5;
  trait(a, b, (glyphe ? 1.15 : 0.8) * k, 3.2 * k, alpha * (glyphe ? 1.0 : 0.8), glyphe ? BLANC : LILAS, VIOLET, 0.0);
}`,
  };

  const TRAIT_F = `#version 300 es
precision highp float;
in vec2 vP;
flat in vec2 vA, vB;
flat in float vRayon, vHalo, vAlpha, vDegrade;
flat in vec3 vCouleur, vLueur;
out vec4 sortie;
void main() {
  vec2 pa = vP - vA, ba = vB - vA;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  float d = length(pa - ba * h);
  float x = d / vRayon;
  float queue = mix(1.0, h, vDegrade);
  vec3 c = (vCouleur * exp(-x * x) + vLueur * 0.3 * exp(-d / vHalo)) * vAlpha * queue;
  sortie = vec4(c, max(c.r, max(c.g, c.b)) * 0.6);
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

    let d = null, dpr = 1, lots = null;
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
        for (let i = 0; i < parInstance; i++) {
          gl.enableVertexAttribArray(i);
          gl.vertexAttribPointer(i, 4, gl.FLOAT, false, pas, i * 16);
          gl.vertexAttribDivisor(i, 1);
        }
        gl.bindVertexArray(null);
        return { vao, nombre: donnees.length / (parInstance * 4) };
      };
      lots = {
        braise: lot(d.braises, 2),
        etincelle: lot(d.etincelles, 2),
        particule: lot(d.particules, 3),
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
      image(t) {
        if (!d) return;
        gl.viewport(0, 0, toile.width, toile.height);
        const m = meteore(d, t);
        const a = t - S.impact;
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
          const mg = marge * 36 + 20 * d.k;
          boite = [x0 - mg, y0 - mg, x1 + mg, y1 + mg];
        }

        // la lumiere continue
        gl.disable(gl.BLEND);
        gl.useProgram(scene.p);
        const u = scene.u;
        gl.uniform4f(u.tete, m.x, m.y, m.intensite, m.halo);
        gl.uniform4f(u.mouvement, m.dx, m.dy, m.vitesse, m.z);
        gl.uniform4f(u.impact, a, d.k, sec[0], sec[1]);
        gl.uniform4f(u.onde, o[0], o[1], o[2], lisse(t / 0.45));
        gl.uniform4f(u.boite, boite[0], boite[1], boite[2], boite[3]);
        gl.uniform2f(u.taille, d.w, d.h);
        gl.uniform2f(u.centre, d.centre[0], d.centre[1]);
        gl.uniform1f(u.t, t);
        gl.uniform1f(u.echelle, dpr);
        gl.uniform1i(u.compte, n);
        gl.uniform4fv(u.trainee, tTrainee);
        gl.bindVertexArray(vaoVide);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // la lumiere des braises, etincelles, particules et du symbole s'ajoute
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const actifs = {
          braise: t > S.depart && t < S.impact + 0.8,
          etincelle: t > S.impact && t < S.impact + 0.9,
          particule: t > S.impact && t < S.logo + 0.32,
          neon: t > 1.84 && t < S.logo + 0.34,
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

  racine.LancementDrop = { S, creeRendu, decor };
})(typeof self !== "undefined" ? self : window);
