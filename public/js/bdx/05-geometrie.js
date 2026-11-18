// --- Géométrie de l'éditeur, commune à la page et à l'export ------------------------------
// Ce fichier sert deux fois : dans la page de l'editeur (assemble avec
// editeur.js) et sur le serveur, qui dessine le PDF exporte
// (src/bordereaux/editeur.js le charge tel quel). Ce qui s'affiche et ce qui
// s'exporte sortent donc des MEMES calculs.
//
// Coordonnees : points de la page affichee, origine en haut a gauche, y vers
// le bas. Un angle positif tourne dans le sens des aiguilles d'une montre a
// l'ecran (comme CSS). Une matrice [a, b, c, d, e, f] envoie (x, y) sur
// (a x + c y + e, b x + d y + f) -- la convention de CSS et du PDF.

const GeometrieEditeur = (() => {
  const ZOOM_MAX = 8;
  const MODES = ["remplir", "ajuster"];
  const rad = (deg) => ((Number(deg) || 0) * Math.PI) / 180;

  // a puis b : le point passe d'abord par b, puis par a
  const compose = (a, b) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const translation = (x, y) => [1, 0, 0, 1, x, y];
  const echelle = (sx, sy) => [sx, 0, 0, sy, 0, 0];
  const rotation = (deg) => {
    const r = rad(deg);
    return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
  };
  const applique = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

  /** Le reglage d'une image dans son cadre, complete et borne. */
  function cadrage(c) {
    const r = c && typeof c === "object" ? c : {};
    const fini = (v, d) => (Number.isFinite(v) ? v : d);
    return {
      mode: MODES.includes(r.mode) ? r.mode : "remplir",
      zoom: Math.min(ZOOM_MAX, Math.max(1, fini(r.zoom, 1))),
      dx: Math.min(5, Math.max(-5, fini(r.dx, 0))),
      dy: Math.min(5, Math.max(-5, fini(r.dy, 0))),
    };
  }

  /**
   * Ou se pose une image (il x ih pixels) dans un cadre de l x h points :
   * { x, y, l, h } dans le cadre (origine en haut a gauche du cadre, avant
   * sa rotation). « remplir » couvre tout le cadre (rien d'etire : le
   * surplus est coupe), « ajuster » montre l'image entiere. zoom >= 1 agrandit
   * le contenu sans toucher au cadre ; dx, dy deplacent son centre (en
   * fraction du cadre), bornes pour que le contenu ne decouvre jamais un bord
   * qu'il couvrait.
   */
  function contenuImage(l, h, il, ih, c) {
    const r = bornePosition(l, h, il, ih, cadrage(c));
    const base = r.mode === "ajuster" ? Math.min(l / il, h / ih) : Math.max(l / il, h / ih);
    const cl = il * base * r.zoom;
    const ch = ih * base * r.zoom;
    return { x: l / 2 + r.dx * l - cl / 2, y: h / 2 + r.dy * h - ch / 2, l: cl, h: ch };
  }

  /** Le cadrage, avec son decalage ramene dans ce qui est permis. */
  function bornePosition(l, h, il, ih, c) {
    const r = cadrage(c);
    const base = r.mode === "ajuster" ? Math.min(l / il, h / ih) : Math.max(l / il, h / ih);
    const jeuX = Math.abs(il * base * r.zoom - l) / 2 / l;
    const jeuY = Math.abs(ih * base * r.zoom - h) / 2 / h;
    return { ...r, dx: Math.min(jeuX, Math.max(-jeuX, r.dx)), dy: Math.min(jeuY, Math.max(-jeuY, r.dy)) };
  }

  /** Le cadre d'un element -> la page : son repere propre (avant rotation) vers la page. */
  function matriceCadre(e) {
    return compose(translation(e.x + e.l / 2, e.y + e.h / 2), compose(rotation(e.rotation || 0), translation(-e.l / 2, -e.h / 2)));
  }

  /**
   * Un extrait de l'etiquette d'origine (un code, un texte, une image qu'on
   * deplace) : la page d'origine -> le repere propre de l'element, tel qu'il
   * est maintenant. `depart` : son cadre a l'origine ({ x, y, l, h, rotation }).
   * Deplacer ne change que la position du cadre (la matrice ne bouge pas) ;
   * redimensionner etire dans les axes du cadre ; tourner tourne le tout.
   */
  function matriceExtrait(depart, e) {
    const sx = e.l / depart.l;
    const sy = e.h / depart.h;
    return compose(
      translation(e.l / 2, e.h / 2),
      compose(echelle(sx, sy), compose(rotation(-(depart.rotation || 0)), translation(-(depart.x + depart.l / 2), -(depart.y + depart.h / 2))))
    );
  }

  /** Les quatre coins d'un element sur la page (rotation comprise). */
  function coins(e) {
    const m = matriceCadre(e);
    return [applique(m, 0, 0), applique(m, e.l, 0), applique(m, e.l, e.h), applique(m, 0, e.h)];
  }

  /** La boite droite qui contient l'element (rotation comprise). */
  function boite(e) {
    if (!e.rotation) return { x: e.x, y: e.y, l: e.l, h: e.h };
    const p = coins(e);
    const xs = p.map((q) => q.x);
    const ys = p.map((q) => q.y);
    return { x: Math.min(...xs), y: Math.min(...ys), l: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  /** L'angle ramene dans ]-180, 180]. */
  function angle(deg) {
    let a = (Number(deg) || 0) % 360;
    if (a > 180) a -= 360;
    if (a <= -180) a += 360;
    return Math.round(a * 100) / 100;
  }

  return { ZOOM_MAX, MODES, compose, translation, echelle, rotation, applique, cadrage, contenuImage, bornePosition, matriceCadre, matriceExtrait, coins, boite, angle };
})();

if (typeof module === "object" && module.exports) module.exports = GeometrieEditeur;
