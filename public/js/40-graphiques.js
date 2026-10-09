// --- Graphiques -------------------------------------------------------------------

// Chemin lisse (Catmull-Rom -> Bezier cubique) passant par tous les points.
// `plancher` : la courbe ne plonge jamais sous la ligne de base.
// Les memes courbes que smoothPath, echantillonnees en JS : la tete lumineuse
// suit la courbe sans interroger le SVG (getPointAtLength, 261 appels, gelait
// la page pres d'une demi-seconde a l'arrivee sur Stats).
function echantillonsCourbe(points, plancher = Infinity, parSegment = 18) {
  if (points.length === 0) return [];
  const ech = [{ x: points[0].x, y: points[0].y }];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = Math.min(p1.y + (p2.y - p0.y) / 6, plancher);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = Math.min(p2.y - (p3.y - p1.y) / 6, plancher);
    for (let k = 1; k <= parSegment; k++) {
      const t = k / parSegment;
      const u = 1 - t;
      ech.push({
        x: u * u * u * p1.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p2.x,
        y: u * u * u * p1.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * p2.y,
      });
    }
  }
  return ech;
}

function smoothPath(points, plancher = Infinity) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = Math.min(p1.y + (p2.y - p0.y) / 6, plancher);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = Math.min(p2.y - (p3.y - p1.y) / 6, plancher);
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

let curveChartUid = 0;
const CHART_SPACING = 72; // distance en px entre deux points (echelle 1:1, pas de zoom SVG)
const CHART_PAD = 36;
// SVG en taille reelle (pas de mise a l'echelle par viewBox) : plus large que
// son conteneur, qui defile horizontalement en glisser libre.
const CHART_H = 230;

function areaPathFrom(points, baseY) {
  return `${smoothPath(points, baseY)} L ${points[points.length - 1].x} ${baseY} L ${points[0].x} ${baseY} Z`;
}

function chartGrid(W, padTop, plotH) {
  return [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padTop + plotH * (1 - f) * 0.9 + plotH * 0.1;
      return `<line class="chart-grid-line" x1="0" y1="${y}" x2="${W}" y2="${y}" />`;
    })
    .join("");
}

// La courbe des revenus. Dessinee entiere, puis devoilee par un masque qui
// avance : la tete lumineuse court sur la courbe, les points eclosent a son
// passage et leurs montants montent.
function scrollChartSVG(items, { highlightBest = false, animate = false, spacing = CHART_SPACING } = {}) {
  const H = CHART_H, padTop = 38, padBottom = 38;
  const plotH = H - padTop - padBottom;
  const baseY = H - padBottom;
  const W = Math.max(CHART_PAD * 2 + (items.length - 1) * spacing, 320);
  const max = Math.max(...items.map((i) => i.value), 1);
  const bestIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);
  const uid = curveChartUid++;

  const points = items.map((it, i) => ({ x: CHART_PAD + i * spacing, y: baseY - (it.value / max) * plotH * 0.9 }));
  const cache = animate ? " cache" : "";

  const circles = items
    .map((it, i) => {
      const isBest = highlightBest && i === bestIndex && it.value > 0;
      const p = points[i];
      return `<circle class="chart-dot${isBest ? " best" : ""}${cache}" cx="${p.x}" cy="${p.y}" r="${isBest ? 6 : 4}">
      <title>${it.label} : ${euro(it.value)} (${pluriel(it.count, "colis", "colis")})</title>
    </circle>`;
    })
    .join("");

  const labels = items
    .map((it, i) => {
      const isBest = highlightBest && i === bestIndex && it.value > 0;
      const p = points[i];
      const texte = it.value > 0 ? (animate ? euroGraphe(0) : euroGraphe(it.value)) : "—";
      return `
      <text class="chart-value-label${it.value > 0 ? "" : " is-zero"}${isBest ? " is-best" : ""}${cache}" data-target="${it.value}" x="${p.x}" y="${p.y - 14}" text-anchor="middle">${texte}</text>
      <text class="chart-axis-label" x="${p.x}" y="${H - 12}" text-anchor="middle">${it.label}</text>`;
    })
    .join("");

  const dernier = points[points.length - 1];
  const html = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs>
        <linearGradient id="ligne${uid}" x1="0" y1="0" x2="${W}" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#6e40f0"/>
          <stop offset="0.6" stop-color="#9162ff"/>
          <stop offset="1" stop-color="#ded0ff"/>
        </linearGradient>
        <linearGradient id="aire${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9162ff" stop-opacity="0.48"/>
          <stop offset="1" stop-color="#9162ff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="scan${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c4aaff" stop-opacity="0"/>
          <stop offset="0.55" stop-color="#c4aaff" stop-opacity="0.75"/>
          <stop offset="1" stop-color="#c4aaff" stop-opacity="0"/>
        </linearGradient>
        <radialGradient id="halo${uid}">
          <stop offset="0" stop-color="#ded0ff" stop-opacity="0.9"/>
          <stop offset="1" stop-color="#9162ff" stop-opacity="0"/>
        </radialGradient>
        <filter id="lueur${uid}" x="-10%" y="-60%" width="120%" height="220%">
          <feGaussianBlur stdDeviation="4" result="flou"/>
          <feMerge><feMergeNode in="flou"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <clipPath id="clip${uid}"><rect data-clip x="0" y="-20" width="${animate ? 0 : W}" height="${H + 40}"/></clipPath>
      </defs>
      ${chartGrid(W, padTop, plotH)}
      <g clip-path="url(#clip${uid})">
        <path data-area d="${areaPathFrom(points, baseY)}" fill="url(#aire${uid})"/>
        <path class="chart-line" data-line d="${smoothPath(points, baseY)}" fill="none" stroke="url(#ligne${uid})" filter="url(#lueur${uid})"/>
      </g>
      ${animate ? "" : `<circle class="chart-pulse" cx="${dernier.x}" cy="${dernier.y}" r="6"/>`}
      ${circles}
      ${labels}
      <g data-tete opacity="0">
        <line data-scan x1="0" x2="0" y1="${padTop - 10}" y2="${baseY}" stroke="url(#scan${uid})" stroke-width="1.5"/>
        <circle r="20" fill="url(#halo${uid})"/>
        <circle class="chart-head" r="4.5"/>
      </g>
    </svg>`;
  return { html, points, baseY, W, padTop, echantillons: echantillonsCourbe(points, baseY) };
}

function runCurveReveal(track, geo, { duree = 1900 } = {}) {
  const svg = track.querySelector("svg");
  if (!svg) return;
  const clip = svg.querySelector("[data-clip]");
  const ligne = svg.querySelector("[data-line]");
  const tete = svg.querySelector("[data-tete]");
  const scan = svg.querySelector("[data-scan]");
  const dots = [...svg.querySelectorAll(".chart-dot")];
  const labels = [...svg.querySelectorAll(".chart-value-label[data-target]")];
  const { points, W } = geo;

  const montre = (i, anime) => {
    const dot = dots[i];
    const label = labels[i];
    if (!dot.classList.contains("cache")) return;
    dot.classList.remove("cache");
    label.classList.remove("cache");
    const cible = Number(label.dataset.target);
    if (!anime) {
      if (cible > 0) label.textContent = euroGraphe(cible);
      return;
    }
    dot.classList.add("pop");
    label.classList.add("pop");
    if (cible > 0) animateNumberText(label, cible, euroGraphe, 700);
  };

  const fin = () => {
    clip.setAttribute("width", W);
    points.forEach((_, i) => montre(i, false));
    const dernier = points[points.length - 1];
    const pouls = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    pouls.setAttribute("class", "chart-pulse");
    pouls.setAttribute("cx", dernier.x);
    pouls.setAttribute("cy", dernier.y);
    pouls.setAttribute("r", 6);
    svg.insertBefore(pouls, dots[0]);
    tete.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: "forwards" });
  };

  if (prefersReducedMotion) return fin();

  // ce qui est a gauche de la zone visible est deja la ; le dessin part du
  // bord gauche de ce qu'on voit
  const conteneur = track.closest(".chart-scroll");
  const x0 = Math.max(0, (conteneur?.scrollLeft || 0) - 12);
  const x1 = W;
  points.forEach((p, i) => p.x < x0 && montre(i, false));

  // y(x) le long de la courbe, d'apres ses echantillons precalcules
  const ech = geo.echantillons;
  const yA = (x) => {
    let bas = 0;
    let haut = ech.length - 1;
    while (haut - bas > 1) {
      const m = (bas + haut) >> 1;
      if (ech[m].x < x) bas = m;
      else haut = m;
    }
    const a = ech[bas];
    const b = ech[haut];
    const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * Math.max(0, Math.min(1, f));
  };

  tete.setAttribute("opacity", "1");
  const t0 = performance.now();
  const pas = (now) => {
    const p = Math.min((now - t0) / duree, 1);
    const hx = x0 + (x1 - x0) * easeInOutCubic(p);
    clip.setAttribute("width", hx);
    tete.setAttribute("transform", `translate(${hx} ${yA(hx)})`);
    scan.setAttribute("y1", -yA(hx) + 28);
    scan.setAttribute("y2", geo.baseY - yA(hx));
    points.forEach((pt, i) => pt.x <= hx + 1 && montre(i, true));
    if (p < 1) requestAnimationFrame(pas);
    else fin();
  };
  requestAnimationFrame(pas);
}

// Les barres des semaines : elles partent de zero, montent avec une petite
// inertie (elles depassent un peu et se posent), une lueur au sommet, et leur
// montant apparait au bon moment.
function scrollBarChartSVG(items, { highlightBest = false, animate = false, spacing = CHART_SPACING } = {}) {
  const H = CHART_H, padTop = 38, padBottom = 38;
  const plotH = H - padTop - padBottom;
  const baseY = H - padBottom;
  const barW = Math.min(spacing * 0.46, 34);
  const W = Math.max(CHART_PAD * 2 + (items.length - 1) * spacing, 320);
  const max = Math.max(...items.map((i) => i.value), 1);
  const bestIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);
  const uid = curveChartUid++;

  const bars = items.map((it, i) => ({
    x: CHART_PAD + i * spacing,
    h: Math.max((it.value / max) * plotH * 0.9, it.value > 0 ? 4 : 0),
    best: highlightBest && i === bestIndex && it.value > 0,
  }));

  const rects = bars
    .map((b, i) => {
      const h0 = animate ? 0 : Math.max(b.h, 1);
      return `<rect class="chart-bar" data-bar x="${b.x - barW / 2}" y="${baseY - h0}" width="${barW}" height="${h0}" rx="8"
        fill="url(#${b.best ? "barre-top" : "barre"}${uid})" ${b.best ? `filter="url(#lueur-barre${uid})"` : ""}>
      <title>${items[i].label} : ${euro(items[i].value)} (${pluriel(items[i].count, "colis", "colis")})</title>
    </rect>
    <rect class="chart-bar-cap" data-cap x="${b.x - barW / 2}" y="${baseY - h0 - 3}" width="${barW}" height="7" rx="3.5" filter="url(#flou-cap${uid})"/>`;
    })
    .join("");

  const labels = items
    .map((it, i) => {
      const b = bars[i];
      const h0 = animate ? 0 : Math.max(b.h, 1);
      const texte = it.value > 0 ? (animate ? euroGraphe(0) : euroGraphe(it.value)) : "—";
      return `
      <text class="chart-value-label${it.value > 0 ? "" : " is-zero"}${b.best ? " is-best" : ""}${animate ? " cache" : ""}" data-target="${it.value}" x="${b.x}" y="${baseY - h0 - 12}" text-anchor="middle">${texte}</text>
      <text class="chart-axis-label" x="${b.x}" y="${H - 12}" text-anchor="middle">${it.label}</text>`;
    })
    .join("");

  const html = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs>
        <linearGradient id="barre${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#aa84ff" stop-opacity="0.55"/>
          <stop offset="1" stop-color="#522cc4" stop-opacity="0.18"/>
        </linearGradient>
        <linearGradient id="barre-top${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ded0ff"/>
          <stop offset="0.5" stop-color="#9162ff"/>
          <stop offset="1" stop-color="#6e40f0"/>
        </linearGradient>
        <filter id="lueur-barre${uid}" x="-60%" y="-30%" width="220%" height="160%">
          <feGaussianBlur stdDeviation="6" result="flou"/>
          <feMerge><feMergeNode in="flou"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="flou-cap${uid}" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="3.5"/></filter>
      </defs>
      ${chartGrid(W, padTop, plotH)}
      ${rects}
      ${labels}
    </svg>`;
  return { html, bars, baseY };
}

function runBarReveal(track, geo, { duree = 1100, ecart = 75 } = {}) {
  const { bars, baseY } = geo;
  const barEls = track.querySelectorAll("[data-bar]");
  const caps = track.querySelectorAll("[data-cap]");
  const labelEls = track.querySelectorAll(".chart-value-label[data-target]");
  if (barEls.length === 0) return;

  const posee = new Array(bars.length).fill(false);
  const pose = (i, e, p) => {
    if (posee[i]) return;
    if (p >= 1) posee[i] = true;
    const h = Math.max(bars[i].h * e, 0);
    const y = baseY - h;
    barEls[i].setAttribute("height", h);
    barEls[i].setAttribute("y", y);
    caps[i].setAttribute("y", y - 3);
    caps[i].style.opacity = String(p < 1 ? Math.sin(p * Math.PI) * 0.95 : 0);
    labelEls[i].setAttribute("y", y - 12);
  };
  const etiquette = (i) => {
    const el = labelEls[i];
    if (!el.classList.contains("cache")) return;
    el.classList.remove("cache");
    el.classList.add("pop");
    const cible = Number(el.dataset.target);
    if (cible > 0) animateNumberText(el, cible, euroGraphe, 650);
  };

  if (prefersReducedMotion) {
    bars.forEach((_, i) => {
      pose(i, 1, 1);
      etiquette(i);
    });
    return;
  }

  // la cascade part de la premiere barre visible
  const conteneur = track.closest(".chart-scroll");
  const pasX = conteneur?._spacing || CHART_SPACING;
  const premiere = Math.max(0, Math.floor(((conteneur?.scrollLeft || 0) - CHART_PAD) / pasX));
  const t0 = performance.now();
  const pas = (now) => {
    let fini = true;
    bars.forEach((_, i) => {
      const local = now - (t0 + Math.max(0, i - premiere) * ecart);
      if (local < 0) {
        fini = false;
        return;
      }
      const p = Math.min(local / duree, 1);
      if (p < 1) fini = false;
      pose(i, p < 1 ? easeOutBack(p, 1.3) : 1, p);
      if (p > 0.45) etiquette(i);
    });
    if (!fini) requestAnimationFrame(pas);
  };
  requestAnimationFrame(pas);
}

// Ne declenche `run` que lorsque `el` entre reellement a l'ecran : les
// graphiques plus bas dans la page ne montent qu'une fois qu'on les voit.
// Une seule revelation en attente par element : revenir plusieurs fois sur
// l'onglet sans descendre jusqu'au graphique empilait les attentes, et elles
// partaient toutes ensemble a l'arrivee (l'anneau faisait plusieurs tours).
function revealOnVisible(el, run) {
  if (el?._revelation) {
    el._revelation.disconnect();
    clearTimeout(el._revelationMinuteur);
    el._revelation = null;
  }
  if (!el || prefersReducedMotion || !("IntersectionObserver" in window)) {
    run();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      el._revelation = null;
      el._revelationMinuteur = setTimeout(run, 120);
    },
    { threshold: 0.3 }
  );
  el._revelation = io;
  io.observe(el);
}

function frenchDateShort(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

// Peu de points sur un grand ecran : on les ecarte pour remplir la largeur
// plutot que de tasser le graphique a gauche. Beaucoup de points : l'ecart
// normal, et on fait defiler.
function espacement(container, n) {
  const largeur = container.clientWidth;
  if (!largeur || n < 2) return CHART_SPACING;
  return Math.min(Math.max(CHART_SPACING, (largeur - CHART_PAD * 2) / (n - 1)), CHART_SPACING * 2.2);
}

// Determine les points actuellement visibles dans la zone de scroll pour
// afficher un intitule de plage qui suit le glisser en temps reel.
function visibleRange(container, n) {
  const pas = container._spacing || CHART_SPACING;
  const first = Math.max(0, Math.round((container.scrollLeft - CHART_PAD) / pas));
  const last = Math.min(n - 1, Math.round((container.scrollLeft + container.clientWidth - CHART_PAD) / pas));
  return [first, Math.max(first, last)];
}

function attachRangeFollower(container, items, rangeEl, formatRange) {
  if (container.dataset.rangeBound) return;
  container.dataset.rangeBound = "1";
  let ticking = false;
  container.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const [first, last] = visibleRange(container, container._items.length);
        rangeEl.textContent = formatRange(container._items[first], container._items[last]);
        ticking = false;
      });
    },
    { passive: true }
  );
  // des que l'utilisateur touche au scroll lui-meme, on arrete de le recaler
  // automatiquement sur "aujourd'hui" a chaque rafraichissement
  const markUserScrolled = () => {
    container.dataset.userScrolled = "1";
  };
  container.addEventListener("pointerdown", markUserScrolled, { passive: true });
  container.addEventListener("wheel", markUserScrolled, { passive: true });

  attachHorizontalDrag(container, markUserScrolled);
}

// Glisser horizontal au toucher, sans jamais bloquer le scroll vertical de la
// page : le sens du geste est verrouille des les premiers pixels de
// mouvement (comme un carrousel natif).
function attachHorizontalDrag(container, onDragStart) {
  let state = null;
  let momentumRAF = null;

  const stopMomentum = () => {
    if (momentumRAF) cancelAnimationFrame(momentumRAF);
    momentumRAF = null;
  };

  const runMomentum = (velocity) => {
    const maxScroll = container.scrollWidth - container.clientWidth;
    let v = velocity;
    const step = () => {
      v *= 0.94; // friction : decroissance exponentielle, glisser naturel
      if (Math.abs(v) < 0.05 || container.scrollLeft <= 0 || container.scrollLeft >= maxScroll) {
        momentumRAF = null;
        return;
      }
      container.scrollLeft -= v;
      momentumRAF = requestAnimationFrame(step);
    };
    momentumRAF = requestAnimationFrame(step);
  };

  container.addEventListener(
    "touchstart",
    (e) => {
      stopMomentum();
      const t = e.touches[0];
      state = { startX: t.clientX, startY: t.clientY, scrollStart: container.scrollLeft, lock: null, lastX: t.clientX, lastT: performance.now(), velocity: 0 };
    },
    { passive: true }
  );

  container.addEventListener(
    "touchmove",
    (e) => {
      if (!state) return;
      const t = e.touches[0];
      const dx = t.clientX - state.startX;
      const dy = t.clientY - state.startY;

      if (state.lock === null) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        state.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (state.lock === "x") onDragStart();
      }

      if (state.lock === "x") {
        e.preventDefault();
        container.scrollLeft = state.scrollStart - dx;
        const now = performance.now();
        const dt = now - state.lastT;
        if (dt > 0) {
          const instVelocity = (t.clientX - state.lastX) / dt; // px/ms
          state.velocity = state.velocity * 0.7 + instVelocity * 0.3; // lissage
        }
        state.lastX = t.clientX;
        state.lastT = now;
      }
    },
    { passive: false }
  );

  const release = () => {
    if (state && state.lock === "x" && Math.abs(state.velocity) > 0.02) {
      runMomentum(state.velocity * 16.7); // px/ms -> px/image (~60 i/s)
    }
    state = null;
  };
  container.addEventListener("touchend", release, { passive: true });
  container.addEventListener("touchcancel", release, { passive: true });
}

async function loadDayScrollChart(animate, force, riche) {
  const r = await fetchJSON("/api/stats/revenue/daily-series");
  if (!hasChanged("dailySeries", r.days) && !force) return;

  const container = $("chart-week");
  const rangeEl = $("week-range");
  const averageEl = $("day-average");
  const averageSub = $("day-average-sub");
  if (!r.days || r.days.length === 0) {
    container.querySelector(".chart-track").innerHTML = `<div class="chart-empty">Pas encore de données</div>`;
    rangeEl.textContent = "—";
    averageEl.textContent = "—";
    averageSub.textContent = "Pas encore de données";
    return;
  }

  // moyenne sur tous les jours enregistres (dimanches exclus de la serie),
  // jours sans revenu compris : c'est le revenu moyen d'une journee type
  const total = r.days.reduce((sum, d) => sum + d.value, 0);
  const average = total / r.days.length;
  compte(averageEl, average, { format: euro, depuis: animate ? 0 : undefined, delai: animate ? 260 : 0 });
  averageSub.textContent = `sur ${pluriel(r.days.length, "jour", "jours")}`;

  const items = r.days.map((d) => ({
    label: DAY_LABELS[new Date(`${d.date}T12:00:00Z`).getUTCDay()],
    value: d.value,
    count: d.count,
    date: d.date,
  }));
  container._items = items;
  container._spacing = espacement(container, items.length);
  const track = container.querySelector(".chart-track");
  const geo = scrollChartSVG(items, { highlightBest: true, animate, spacing: container._spacing });
  track.innerHTML = geo.html;

  if (container.dataset.userScrolled !== "1") container.scrollLeft = container.scrollWidth;
  // en haut de la page Stats : on laisse la carte entrer, puis la courbe se trace
  if (animate) setTimeout(() => runCurveReveal(track, geo, { duree: riche ? 2000 : 1000 }), riche ? 420 : 160);

  const [first, last] = visibleRange(container, items.length);
  rangeEl.textContent = `${frenchDateShort(items[first].date)} – ${frenchDateShort(items[last].date)}`;
  attachRangeFollower(container, items, rangeEl, (a, b) => `${frenchDateShort(a.date)} – ${frenchDateShort(b.date)}`);
}

async function loadWeekScrollChart(animate, force, riche) {
  const r = await fetchJSON("/api/stats/revenue/weekly-series");
  if (!hasChanged("weeklySeries", r.weeks) && !force) return;

  const container = $("chart-month");
  const rangeEl = $("month-range");
  if (!r.weeks || r.weeks.length === 0) {
    container.querySelector(".chart-track").innerHTML = `<div class="chart-empty">Pas encore de données</div>`;
    rangeEl.textContent = "—";
    return;
  }

  const items = r.weeks.map((w) => ({
    label: frenchDateShort(w.start),
    value: w.value,
    count: w.count,
    start: w.start,
    end: w.end,
  }));
  renderSemaine(items, animate);
  container._items = items;
  container._spacing = espacement(container, items.length);
  const track = container.querySelector(".chart-track");
  const geo = scrollBarChartSVG(items, { highlightBest: true, animate, spacing: container._spacing });
  track.innerHTML = geo.html;
  if (container.dataset.userScrolled !== "1") container.scrollLeft = container.scrollWidth;
  // ce graphique est plus bas dans la page : on attend qu'il soit reellement
  // visible a l'ecran avant de faire monter les barres
  if (animate) revealOnVisible(container.closest(".card"), () => runBarReveal(track, geo, riche ? {} : { duree: 700, ecart: 40 }));

  const [first, last] = visibleRange(container, items.length);
  rangeEl.textContent = `${frenchDateShort(items[first].start)} – ${frenchDateShort(items[last].end)}`;
  attachRangeFollower(container, items, rangeEl, (a, b) => `${frenchDateShort(a.start)} – ${frenchDateShort(b.end)}`);
}

// "Cette semaine" : la semaine en cours, comparee a la precedente.
function renderSemaine(items, animate) {
  const en = items[items.length - 1];
  const avant = items[items.length - 2];
  compte($("stat-week-value"), en.value, { format: euro, depuis: animate ? 0 : undefined, delai: animate ? 340 : 0 });
  const sub = $("stat-week-sub");
  if (!avant) {
    sub.textContent = pluriel(en.count, "colis", "colis");
    return;
  }
  // la semaine en cours n'est pas finie : la comparer en pourcentage a une
  // semaine complete serait trompeur. On ne le fait qu'une fois depassee.
  const ecart = avant.value > 0 ? Math.round(((en.value - avant.value) / avant.value) * 100) : null;
  sub.innerHTML =
    `${pluriel(en.count, "colis", "colis")} · semaine passée ${escapeHtml(euroGraphe(avant.value))}` +
    (ecart !== null && ecart > 0 ? ` · <span class="up">+${ecart} %</span>` : "");
}

// Les revenus ne changent que quand des colis sont dropes (ou au changement
// de jour) : le rafraichissement de fond ne les relit que dans ce cas, ou au
// plus tard toutes les 60 s. Les revelations animees les relisent toujours.
let signatureRevenus = "";
let revenusCharges = { signature: null, le: 0 };
async function loadRevenueStats(animate, force, riche) {
  if (!animate && !force && revenusCharges.signature === signatureRevenus && Date.now() - revenusCharges.le < 60000) return;
  revenusCharges = { signature: signatureRevenus, le: Date.now() };
  await Promise.all([loadDayScrollChart(animate, force, riche), loadWeekScrollChart(animate, force, riche)]);

  const r = await fetchJSON("/api/stats/revenue");
  const bestDayEl = $("stat-bestday-value");
  const bestDaySub = $("stat-bestday-sub");
  if (r.bestDay) {
    compte(bestDayEl, r.bestDay.value, { format: euro, depuis: animate ? 0 : undefined, delai: animate ? 180 : 0 });
    const d = new Date(r.bestDay.date + "T12:00:00");
    const jour = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    bestDaySub.innerHTML = `${escapeHtml(jour.charAt(0).toUpperCase() + jour.slice(1))}<br>${pluriel(r.bestDay.count, "colis", "colis")}`;
  } else {
    bestDayEl.textContent = "—";
    bestDaySub.textContent = "Pas encore de données";
  }
}

