const euro = (n) => `${Number(n || 0).toFixed(2)} €`;
const DAY_LABELS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
const CATEGORICAL_COLORS = ["#38f7ff", "#ff3ecb", "#b6ff3e", "#ffb84d", "#b388ff", "#ff6b6b", "#5ad1ff", "#ff8ad1"];

function switchView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  // le panneau Stats est cache (display:none) tant qu'on n'y va pas : les
  // graphiques n'ont donc pas pu se caler sur "aujourd'hui" a leur premier
  // rendu (largeurs a zero). On les recale des que l'onglet devient visible.
  if (view === "stats") {
    requestAnimationFrame(() => {
      ["chart-week", "chart-month"].forEach((id) => {
        const c = document.getElementById(id);
        if (c && c.dataset.userScrolled !== "1") c.scrollLeft = c.scrollWidth;
      });
    });
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

document.getElementById("brand-home").addEventListener("click", () => switchView("dashboard"));

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Empeche de reconstruire le DOM (et donc de rejouer les animations) quand le
// rafraichissement periodique renvoie exactement les memes donnees.
const renderCache = new Map();
function hasChanged(key, data) {
  const signature = JSON.stringify(data);
  if (renderCache.get(key) === signature) return false;
  renderCache.set(key, signature);
  return true;
}

// Anime un nombre de sa valeur actuelle vers la nouvelle, en conservant le
// format (suffixe " €", decimales) du texte cible.
function animateValue(el, newText) {
  if (el.textContent === newText) return;

  const target = parseFloat(String(newText).replace(/[^\d.-]/g, ""));
  const start = parseFloat(String(el.textContent).replace(/[^\d.-]/g, ""));
  const suffix = String(newText).replace(/^[\d.,\s-]+/, "");
  const decimals = (String(newText).split(".")[1] || "").replace(/\D+$/, "").length;

  if (prefersReducedMotion || Number.isNaN(target) || Number.isNaN(start) || start === target) {
    el.textContent = newText;
    el.classList.remove("value-bump");
    void el.offsetWidth;
    el.classList.add("value-bump");
    return;
  }

  const duration = 550;
  const t0 = performance.now();
  if (el._countRAF) cancelAnimationFrame(el._countRAF);

  const step = (now) => {
    const p = Math.min((now - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    const current = start + (target - start) * eased;
    el.textContent = `${current.toFixed(decimals)}${suffix}`;
    if (p < 1) {
      el._countRAF = requestAnimationFrame(step);
    } else {
      el.textContent = newText;
      el._countRAF = null;
    }
  };
  el._countRAF = requestAnimationFrame(step);

  el.classList.remove("value-bump");
  void el.offsetWidth;
  el.classList.add("value-bump");
}

// Applique un delai croissant pour que les lignes apparaissent en cascade.
function staggerIn(container) {
  if (prefersReducedMotion) return;
  [...container.children].forEach((child, i) => {
    child.style.animationDelay = `${Math.min(i * 45, 360)}ms`;
    child.classList.add("row-enter");
  });
}

// La revelation animee de la page Stats (compteurs 0 -> valeur, courbes et
// barres qui montent, camembert qui se construit) ne doit jouer qu'une seule
// fois par vrai chargement de page. Variable en memoire : elle repart a
// false a chaque F5/rechargement, et reste true tant que l'utilisateur
// navigue dans l'app sans recharger (changement d'onglet, retour, etc.).
let statsRevealed = false;

// Anime le texte d'un element de 0 (ou de la valeur de depart) jusqu'a
// `target`, en repassant par `format` a chaque frame. Utilise uniquement
// lors de la revelation initiale : les mises a jour normales ecrivent le
// texte final directement (pas de recomptage a chaque rafraichissement).
function animateNumberText(el, target, format, duration = 1000, delay = 0) {
  if (!el) return;
  if (prefersReducedMotion) {
    el.textContent = format(target);
    return;
  }
  const start = () => {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min((now - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(target * eased);
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = format(target);
    };
    requestAnimationFrame(step);
  };
  if (delay > 0) setTimeout(start, delay);
  else start();
}

async function loadStats(animate) {
  const s = await fetchJSON("/api/stats");
  animateValue(document.getElementById("stat-earned"), euro(s.droppedValue));
  document.getElementById("stat-earned-count").textContent = `${s.droppedCount} colis dropés`;
  animateValue(document.getElementById("stat-pending"), String(s.pendingCount));
  document.getElementById("stat-pending-value").textContent = `≈ ${euro(s.pendingValue)}`;
  animateValue(document.getElementById("stat-today"), euro(s.todayValue));
  document.getElementById("stat-today-count").textContent = `${s.todayCount} colis dropés`;
  animateValue(document.getElementById("stat-bj"), String(s.bjPendingCount || 0));
  document.getElementById("stat-bj-value").textContent = `≈ ${euro(s.bjPendingValue)}`;

  if (!hasChanged("senders", s.bySender)) return;

  const container = document.getElementById("sender-rows");
  container.innerHTML = "";
  if (s.bySender.length === 0) {
    container.innerHTML = `<div class="empty-row">Aucun colis pour le moment</div>`;
  }
  for (const row of s.bySender) {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="row-main">
        <div class="row-title">${escapeHtml(row.sender_name)}</div>
        <div class="row-sub">
          ${row.dropped_count} dropés · <span class="sub-earned">${euro(row.dropped_value)}</span>${
            row.pending_count > 0
              ? ` · <span class="sub-pending">${row.pending_count} à drop</span>`
              : ""
          }
        </div>
      </div>
      <div class="row-actions">
        <button class="btn btn-round btn-ghost" data-quick-remove="${escapeAttr(row.sender_name)}" title="-1 colis">−</button>
        <button class="btn btn-round btn-primary" data-quick-add="${escapeAttr(row.sender_name)}" title="+1 colis">+</button>
        ${row.pending_count > 0 ? `<button class="btn btn-small btn-ghost" data-drop-sender="${escapeAttr(row.sender_name)}">Drop</button>` : ""}
      </div>
    `;
    container.appendChild(el);
  }
  staggerIn(container);

  renderDonut(s.bySender, animate);
}

function donutSVG(items, animate) {
  const total = items.reduce((sum, it) => sum + it.value, 0);
  if (total <= 0) return `<div class="chart-empty">Pas encore de données</div>`;

  const size = 220, cx = size / 2, cy = size / 2, r = 84, strokeWidth = 22;
  const circumference = 2 * Math.PI * r;
  // "paused" : le segment est pret a jouer son animation d'entree mais
  // attend d'etre visible a l'ecran (voir revealOnVisible) ; "instant" :
  // revelation deja faite cette session, on affiche l'etat final direct
  const revealClass = animate ? "paused" : "instant";
  let offset = 0;
  const segments = items.map((it, i) => {
    const frac = it.value / total;
    const len = frac * circumference;
    const gap = items.length > 1 ? 3 : 0;
    const dash = `${Math.max(len - gap, 0)} ${circumference - len + gap}`;
    const seg = `<circle class="donut-seg ${revealClass}" style="animation-delay:${i * 0.09}s" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]}"
      stroke-width="${strokeWidth}" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})">
      <title>${it.sender_name}: ${euro(it.value)} (${Math.round(frac * 100)}%)</title>
    </circle>`;
    offset += len;
    return seg;
  }).join("");

  return `
    <svg viewBox="0 0 ${size} ${size}" class="donut-svg">
      <circle class="donut-track" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${strokeWidth}"/>
      ${segments}
      <circle class="donut-center-ring" cx="${cx}" cy="${cy}" r="${r - strokeWidth / 2 - 8}" fill="none"/>
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" class="donut-total-value" id="donut-total-value">${animate ? euro(0) : euro(total)}</text>
      <text x="${cx}" y="${cy + 19}" text-anchor="middle" class="donut-total-label">total</text>
    </svg>
  `;
}

function donutLegend(items, animate) {
  const total = items.reduce((sum, it) => sum + it.value, 0) || 1;
  const revealClass = animate ? "paused" : "instant";
  return `<div class="donut-legend">${items.map((it, i) => {
    const pct = Math.round((it.value / total) * 100);
    const color = CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length];
    return `
    <div class="donut-legend-item">
      <span class="donut-swatch" style="background:${color}"></span>
      <div class="donut-legend-main">
        <div class="donut-legend-top">
          <span class="donut-legend-name">${escapeHtml(it.sender_name)}</span>
          <span class="donut-legend-value" data-legend-value="${it.value}">${animate ? euro(0) : euro(it.value)}</span>
        </div>
        <div class="donut-legend-bar"><div class="donut-legend-bar-fill ${revealClass}" style="width:${pct}%;background:${color};animation-delay:${i * 0.09}s"></div></div>
      </div>
      <span class="donut-legend-pct" data-legend-pct="${pct}">${animate ? "0%" : `${pct}%`}</span>
    </div>`;
  }).join("")}</div>`;
}

function renderDonut(bySender, animate) {
  const items = bySender
    .map((s) => ({ sender_name: s.sender_name, value: s.dropped_value }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  const el = document.getElementById("donut-sender");
  if (!el) return;
  if (items.length === 0) {
    el.innerHTML = `<div class="chart-empty">Pas encore de données</div>`;
    return;
  }
  const total = items.reduce((sum, it) => sum + it.value, 0);
  el.innerHTML = `<div class="donut-layout">${donutSVG(items, animate)}${donutLegend(items, animate)}</div>`;

  if (animate) {
    revealOnVisible(el.closest(".panel"), () => {
    el.querySelectorAll(".paused").forEach((n) => n.classList.remove("paused"));
    animateNumberText(document.getElementById("donut-total-value"), total, euro, 1000);
    el.querySelectorAll("[data-legend-value]").forEach((span, i) => {
      animateNumberText(span, Number(span.dataset.legendValue), euro, 900, i * 90);
    });
    el.querySelectorAll("[data-legend-pct]").forEach((span, i) => {
      const target = Number(span.dataset.legendPct);
      animateNumberText(span, target, (v) => `${Math.round(v)}%`, 900, i * 90);
    });
    });
  }
}

async function loadDebts() {
  const rows = await fetchJSON("/api/debts");
  if (!hasChanged("debts", rows)) return;

  const container = document.getElementById("debts-rows");
  container.innerHTML = "";
  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-row">Personne ne vous doit rien 🎉</div>`;
  }
  for (const d of rows) {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="row-main">
        <div class="row-title">${escapeHtml(d.sender_name)}</div>
        <div class="row-sub">${d.count} colis non payés</div>
      </div>
      <div class="row-actions">
        <span class="chip chip-owed">${euro(d.owed)}</span>
        <button class="btn btn-small btn-primary" data-mark-paid="${escapeAttr(d.sender_name)}">Payé</button>
      </div>
    `;
    container.appendChild(el);
  }
  staggerIn(container);
}

async function loadSenders() {
  const rows = await fetchJSON("/api/senders");
  if (!hasChanged("settings", rows)) return;

  const container = document.getElementById("settings-rows");
  container.innerHTML = "";
  for (const s of rows) {
    const el = document.createElement("div");
    el.className = "row row-inline";
    el.innerHTML = `
      <div class="row-main">
        <div class="row-title">${escapeHtml(s.name)}</div>
      </div>
      <div class="row-actions">
        <input class="price-input price-normal" type="number" step="0.5" min="0" value="${s.price}"
               data-sender-id="${s.id}" data-field="price" title="Prix normal (et BJ)" />
        <input class="price-input price-lit" type="number" step="0.5" min="0" value="${s.lit_price}"
               data-sender-id="${s.id}" data-field="litPrice" title="Prix LIT" />
        <button class="btn btn-small btn-ghost" data-delete-sender="${s.id}">Suppr.</button>
      </div>
    `;
    container.appendChild(el);
  }
  staggerIn(container);
}

async function loadMergeCandidates() {
  const rows = await fetchJSON("/api/senders/merge-candidates");
  if (!hasChanged("mergeCandidates", rows)) return;

  const container = document.getElementById("merge-rows");
  container.innerHTML = "";
  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-row">Aucun expéditeur pour le moment</div>`;
  }
  for (const s of rows) {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="row-main">
        <label class="merge-check-label">
          <input type="checkbox" class="merge-check" value="${s.id}" ${s.mergeable ? "" : "disabled"} />
          <span class="row-title">${escapeHtml(s.name)}</span>
        </label>
        <div class="row-sub">${s.colisCount} colis · ${Math.round(s.pct * 100)}% du CA${s.mergeable ? "" : " · protégé"}</div>
      </div>
    `;
    container.appendChild(el);
  }
  staggerIn(container);
  updateMergeButtonState();
}

function updateMergeButtonState() {
  const checked = document.querySelectorAll(".merge-check:checked").length;
  const btn = document.getElementById("merge-to-other-btn");
  btn.disabled = checked === 0;
  btn.textContent = checked > 0 ? `Fusionner ${checked} expéditeur${checked > 1 ? "s" : ""} en "Autre"` : `Fusionner la sélection en "Autre"`;
}

const LOW_STOCK_THRESHOLD = 5;

async function loadStock() {
  const { stock } = await fetchJSON("/api/stock");
  const el = document.getElementById("stock-value");
  animateValue(el, String(stock));
  el.classList.toggle("stock-low", stock <= LOW_STOCK_THRESHOLD);
}

async function adjustStock(delta) {
  await fetchJSON("/api/stock/adjust", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delta }),
  });
  refreshAll();
}


// Chemin lisse (Catmull-Rom -> Bezier cubique) passant par tous les points.
function smoothPath(points) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

let curveChartUid = 0;
const CHART_SPACING = 78; // distance en px entre deux points (echelle 1:1, pas de zoom SVG)
const CHART_PAD = 40;

// SVG en taille reelle (pas de mise a l'echelle par viewBox) : plus large que
// son conteneur, qui defile horizontalement en glisser libre.
const CHART_H = 260;

// Construit le trajet de reference (courbe ou aire) a partir d'une liste de
// points {x, y}.
function areaPathFrom(points, baseY) {
  return `${smoothPath(points)} L ${points[points.length - 1].x} ${baseY} L ${points[0].x} ${baseY} Z`;
}

function scrollChartSVG(items, { highlightBest = false, animate = false } = {}) {
  const H = CHART_H, padTop = 46, padBottom = 40;
  const plotH = H - padTop - padBottom;
  const baseY = H - padBottom;
  const W = Math.max(CHART_PAD * 2 + (items.length - 1) * CHART_SPACING, 320);
  const max = Math.max(...items.map((i) => i.value), 1);
  const bestIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);
  const uid = curveChartUid++;

  const points = items.map((it, i) => ({
    x: CHART_PAD + i * CHART_SPACING,
    y: baseY - (it.value / max) * plotH * 0.82,
  }));
  // au depart de la revelation, tout est aplati sur la ligne de base : la
  // courbe, les points et les valeurs monteront ensemble jusqu'a leur
  // position finale (voir runCurveReveal)
  const initial = animate ? points.map((p) => ({ x: p.x, y: baseY })) : points;

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = padTop + plotH * (1 - f) * 0.82 + plotH * 0.18;
    return `<line class="chart-grid-line" x1="0" y1="${y}" x2="${W}" y2="${y}" />`;
  }).join("");

  const circles = items.map((it, i) => {
    const isBest = highlightBest && i === bestIndex && it.value > 0;
    const p = initial[i];
    return `<circle class="chart-dot ${isBest ? "best" : ""}" cx="${p.x}" cy="${p.y}" r="${isBest ? 7 : 5}">
      <title>${it.label}: ${euro(it.value)} (${it.count} colis)</title>
    </circle>`;
  }).join("");

  const labels = items.map((it, i) => {
    const isBest = highlightBest && i === bestIndex && it.value > 0;
    const p = initial[i];
    const startText = it.value > 0 ? (animate ? euro(0) : euro(it.value)) : "—";
    return `
      <text class="chart-value-label ${it.value > 0 ? "" : "is-zero"} ${isBest ? "is-best" : ""}" data-target="${it.value}" x="${p.x}" y="${p.y - 16}" text-anchor="middle">${startText}</text>
      <text class="chart-axis-label" x="${p.x}" y="${H - 10}" text-anchor="middle">${it.label}</text>
    `;
  }).join("");

  const html = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs>
        <linearGradient id="curveFill${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38f7ff" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#38f7ff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path class="chart-area" data-area d="${areaPathFrom(initial, baseY)}" fill="url(#curveFill${uid})"/>
      <path class="chart-line" data-line d="${smoothPath(initial)}" fill="none" vector-effect="non-scaling-stroke"/>
      ${circles}
      ${labels}
    </svg>
  `;
  return { html, points, baseY };
}

// Fait monter la courbe, les points et leurs valeurs ensemble, image par
// image, de la ligne de base jusqu'a leur position/valeur reelle.
function runCurveReveal(track, geo, duration = 1900) {
  const { points, baseY } = geo;
  const lineEl = track.querySelector("[data-line]");
  const areaEl = track.querySelector("[data-area]");
  const dotEls = track.querySelectorAll(".chart-dot");
  const labelEls = track.querySelectorAll(".chart-value-label[data-target]");
  if (!lineEl) return;

  const apply = (eased) => {
    const current = points.map((p) => ({ x: p.x, y: baseY - (baseY - p.y) * eased }));
    lineEl.setAttribute("d", smoothPath(current));
    areaEl.setAttribute("d", areaPathFrom(current, baseY));
    dotEls.forEach((c, i) => c.setAttribute("cy", current[i].y));
    labelEls.forEach((el, i) => {
      const target = Number(el.dataset.target);
      el.setAttribute("y", current[i].y - 16);
      if (target > 0) el.textContent = euro(target * eased);
    });
  };

  if (prefersReducedMotion) { apply(1); return; }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min((now - t0) / duration, 1);
    apply(1 - Math.pow(1 - p, 3));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function scrollBarChartSVG(items, { highlightBest = false, animate = false } = {}) {
  const H = CHART_H, padTop = 46, padBottom = 40;
  const plotH = H - padTop - padBottom;
  const baseY = H - padBottom;
  const barW = Math.min(CHART_SPACING * 0.5, 40);
  const W = Math.max(CHART_PAD * 2 + (items.length - 1) * CHART_SPACING, 320);
  const max = Math.max(...items.map((i) => i.value), 1);
  const bestIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);
  const uid = curveChartUid++;

  const bars = items.map((it, i) => ({
    x: CHART_PAD + i * CHART_SPACING,
    h: Math.max((it.value / max) * plotH * 0.82, it.value > 0 ? 4 : 0),
  }));

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = padTop + plotH * (1 - f) * 0.82 + plotH * 0.18;
    return `<line class="chart-grid-line" x1="0" y1="${y}" x2="${W}" y2="${y}" />`;
  }).join("");

  const rects = items.map((it, i) => {
    const isBest = highlightBest && i === bestIndex && it.value > 0;
    const b = bars[i];
    const h0 = animate ? 1 : Math.max(b.h, 1);
    const y0 = baseY - h0;
    return `<rect class="chart-bar ${isBest ? "best" : ""}" data-bar x="${b.x - barW / 2}" y="${y0}" width="${barW}" height="${h0}" rx="${barW * 0.32}" fill="url(#barFill${uid})">
      <title>${it.label}: ${euro(it.value)} (${it.count} colis)</title>
    </rect>`;
  }).join("");

  const labels = items.map((it, i) => {
    const isBest = highlightBest && i === bestIndex && it.value > 0;
    const b = bars[i];
    const h0 = animate ? 1 : Math.max(b.h, 1);
    const y0 = baseY - h0;
    const startText = it.value > 0 ? (animate ? euro(0) : euro(it.value)) : "—";
    return `
      <text class="chart-value-label ${it.value > 0 ? "" : "is-zero"} ${isBest ? "is-best" : ""}" data-target="${it.value}" x="${b.x}" y="${y0 - 14}" text-anchor="middle">${startText}</text>
      <text class="chart-axis-label" x="${b.x}" y="${H - 10}" text-anchor="middle">${it.label}</text>
    `;
  }).join("");

  const html = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs>
        <linearGradient id="barFill${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38f7ff"/>
          <stop offset="100%" stop-color="#1b8fa0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      ${rects}
      ${labels}
    </svg>
  `;
  return { html, bars, baseY };
}

// Fait monter chaque barre depuis la base, avec un leger decalage en
// cascade, en synchronisant sa valeur affichee avec sa hauteur.
function runBarReveal(track, geo, duration = 950, stagger = 55) {
  const { bars, baseY } = geo;
  const barEls = track.querySelectorAll("[data-bar]");
  const labelEls = track.querySelectorAll(".chart-value-label[data-target]");
  if (barEls.length === 0) return;

  const applyOne = (i, eased) => {
    const b = bars[i];
    const h = Math.max(b.h * eased, 1);
    const y = baseY - h;
    barEls[i].setAttribute("height", h);
    barEls[i].setAttribute("y", y);
    const target = Number(labelEls[i].dataset.target);
    labelEls[i].setAttribute("y", y - 14);
    if (target > 0) labelEls[i].textContent = euro(target * eased);
  };

  if (prefersReducedMotion) {
    bars.forEach((_, i) => applyOne(i, 1));
    return;
  }

  const t0 = performance.now();
  const step = (now) => {
    let done = true;
    bars.forEach((_, i) => {
      const localT = now - (t0 + i * stagger);
      if (localT < 0) { done = false; return; }
      const p = Math.min(localT / duration, 1);
      if (p < 1) done = false;
      applyOne(i, 1 - Math.pow(1 - p, 3));
    });
    if (!done) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Ne declenche `run` que lorsque `el` entre reellement dans le viewport (les
// graphiques plus bas dans la page Stats ne montent pas tous en meme temps a
// l'ouverture de l'onglet, seulement quand on les fait defiler a l'ecran).
function revealOnVisible(el, run) {
  if (!el || prefersReducedMotion || !("IntersectionObserver" in window)) {
    run();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          io.disconnect();
          run();
        }
      }
    },
    { threshold: 0.2 }
  );
  io.observe(el);
}

function frenchDateShort(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

// Determine les points actuellement visibles dans la zone de scroll pour
// afficher un intitule de plage qui suit le glisser en temps reel.
function visibleRange(container, n) {
  const first = Math.max(0, Math.round((container.scrollLeft - CHART_PAD) / CHART_SPACING));
  const last = Math.min(
    n - 1,
    Math.round((container.scrollLeft + container.clientWidth - CHART_PAD) / CHART_SPACING)
  );
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
  const markUserScrolled = () => { container.dataset.userScrolled = "1"; };
  container.addEventListener("pointerdown", markUserScrolled, { passive: true });
  container.addEventListener("wheel", markUserScrolled, { passive: true });

  attachHorizontalDrag(container, markUserScrolled);
}

// Glisser horizontal au toucher, sans jamais bloquer le scroll vertical de la
// page : le sens du geste est verrouille des les premiers pixels de
// mouvement (comme un carrousel natif), un swipe vers le bas fait toujours
// defiler la page, jamais le graphique.
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
      state = {
        startX: t.clientX,
        startY: t.clientY,
        scrollStart: container.scrollLeft,
        lock: null,
        lastX: t.clientX,
        lastT: performance.now(),
        velocity: 0,
      };
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
      // lock === "y" : on ne touche a rien, la page defile normalement
    },
    { passive: false }
  );

  const release = () => {
    if (state && state.lock === "x" && Math.abs(state.velocity) > 0.02) {
      runMomentum(state.velocity * 16.7); // conversion px/ms -> px/frame (~60fps)
    }
    state = null;
  };
  container.addEventListener("touchend", release, { passive: true });
  container.addEventListener("touchcancel", release, { passive: true });
}

async function loadDayScrollChart(animate) {
  const r = await fetchJSON("/api/stats/revenue/daily-series");
  if (!hasChanged("dailySeries", r.days)) return;

  const container = document.getElementById("chart-week");
  const rangeEl = document.getElementById("week-range");
  if (!r.days || r.days.length === 0) {
    container.querySelector(".chart-track").innerHTML = `<div class="chart-empty">Pas encore de données</div>`;
    rangeEl.textContent = "—";
    return;
  }

  const items = r.days.map((d) => ({
    label: DAY_LABELS[new Date(`${d.date}T12:00:00Z`).getUTCDay()],
    value: d.value,
    count: d.count,
    date: d.date,
  }));
  container._items = items;
  const track = container.querySelector(".chart-track");
  const geo = scrollChartSVG(items, { highlightBest: true, animate });
  track.innerHTML = geo.html;
  // visible des l'ouverture de l'onglet Stats (tout en haut de la page) :
  // pas besoin d'attendre un scroll pour la reveler
  if (animate) runCurveReveal(track, geo);

  if (container.dataset.userScrolled !== "1") {
    requestAnimationFrame(() => { container.scrollLeft = container.scrollWidth; });
  }

  const [first, last] = visibleRange(container, items.length);
  rangeEl.textContent = `${frenchDateShort(items[first].date)} – ${frenchDateShort(items[last].date)}`;
  attachRangeFollower(container, items, rangeEl, (a, b) => `${frenchDateShort(a.date)} – ${frenchDateShort(b.date)}`);
}

async function loadWeekScrollChart(animate) {
  const r = await fetchJSON("/api/stats/revenue/weekly-series");
  if (!hasChanged("weeklySeries", r.weeks)) return;

  const container = document.getElementById("chart-month");
  const rangeEl = document.getElementById("month-range");
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
  container._items = items;
  const track = container.querySelector(".chart-track");
  const geo = scrollBarChartSVG(items, { highlightBest: true, animate });
  track.innerHTML = geo.html;
  // ce graphique est plus bas dans la page : on attend qu'il soit reellement
  // visible a l'ecran avant de faire monter les barres
  if (animate) revealOnVisible(container.closest(".panel"), () => runBarReveal(track, geo));

  if (container.dataset.userScrolled !== "1") {
    requestAnimationFrame(() => { container.scrollLeft = container.scrollWidth; });
  }

  const [first, last] = visibleRange(container, items.length);
  rangeEl.textContent = `${frenchDateShort(items[first].start)} – ${frenchDateShort(items[last].end)}`;
  attachRangeFollower(container, items, rangeEl, (a, b) => `${frenchDateShort(a.start)} – ${frenchDateShort(b.end)}`);
}

async function loadRevenueStats(animate) {
  await Promise.all([loadDayScrollChart(animate), loadWeekScrollChart(animate)]);

  const r = await fetchJSON("/api/stats/revenue");
  const bestDayEl = document.getElementById("stat-bestday-value");
  const bestDaySub = document.getElementById("stat-bestday-sub");
  if (r.bestDay) {
    if (animate) animateNumberText(bestDayEl, r.bestDay.value, euro, 1000);
    else bestDayEl.textContent = euro(r.bestDay.value);
    const d = new Date(r.bestDay.date + "T12:00:00");
    bestDaySub.textContent = `${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} · ${r.bestDay.count} colis`;
  } else {
    bestDayEl.textContent = "—";
    bestDaySub.textContent = "Pas encore de données";
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

async function refreshAll() {
  // la revelation animee des stats (compteurs, courbes, barres, camembert)
  // ne doit jouer qu'une fois par vrai chargement de page
  const animateStats = !statsRevealed;
  await Promise.all([
    loadStats(animateStats),
    loadDebts(),
    loadSenders(),
    loadMergeCandidates(),
    loadRevenueStats(animateStats),
    loadStock(),
  ]);
  if (animateStats) statsRevealed = true;
}

document.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-drop-sender], [data-delete-sender], [data-quick-add], [data-quick-remove], [data-mark-paid], .drop-all-btn");
  if (!target) return;

  const dropSender = target.dataset.dropSender;
  const deleteSender = target.dataset.deleteSender;
  const quickAdd = target.dataset.quickAdd;
  const quickRemove = target.dataset.quickRemove;
  const markPaid = target.dataset.markPaid;

  if (markPaid) {
    await fetchJSON(`/api/debts/${encodeURIComponent(markPaid)}/pay`, { method: "POST" });
    refreshAll();
  } else if (dropSender) {
    await fetchJSON(`/api/colis/drop-sender/${encodeURIComponent(dropSender)}`, { method: "POST" });
    refreshAll();
  } else if (deleteSender) {
    if (confirm("Supprimer cet expéditeur ?")) {
      await fetchJSON(`/api/senders/${deleteSender}`, { method: "DELETE" });
      refreshAll();
    }
  } else if (quickAdd) {
    await fetchJSON(`/api/colis/quick-add/${encodeURIComponent(quickAdd)}`, { method: "POST" });
    refreshAll();
  } else if (quickRemove) {
    try {
      await fetchJSON(`/api/colis/quick-remove/${encodeURIComponent(quickRemove)}`, { method: "POST" });
    } catch (err) { /* nothing pending to remove */ }
    refreshAll();
  } else if (target.classList.contains("drop-all-btn")) {
    if (confirm("Marquer TOUS les colis en attente comme dropés ?")) {
      await fetchJSON("/api/colis/drop-all", { method: "POST" });
      refreshAll();
    }
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.classList.contains("merge-check")) {
    updateMergeButtonState();
    return;
  }

  const senderId = e.target.dataset.senderId;
  if (!senderId) return;

  const field = e.target.dataset.field === "litPrice" ? "litPrice" : "price";
  await fetchJSON(`/api/senders/${senderId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: Number(e.target.value) }),
  });
  refreshAll();
});

document.getElementById("merge-to-other-btn").addEventListener("click", async () => {
  const senderIds = [...document.querySelectorAll(".merge-check:checked")].map((el) => Number(el.value));
  if (senderIds.length === 0) return;
  if (!confirm(`Fusionner ${senderIds.length} expéditeur(s) dans "Autre" ? Leur historique de colis sera regroupé, cette action est irréversible.`)) return;
  await fetchJSON("/api/senders/merge-to-other", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderIds }),
  });
  refreshAll();
});

document.getElementById("stock-custom-form").addEventListener("submit", (e) => e.preventDefault());
document.getElementById("stock-plus1").addEventListener("click", () => adjustStock(1));
document.getElementById("stock-minus1").addEventListener("click", () => adjustStock(-1));
document.getElementById("stock-custom-add").addEventListener("click", () => {
  const n = Number(document.getElementById("stock-custom-amount").value);
  if (!n) return;
  adjustStock(n);
  document.getElementById("stock-custom-amount").value = "";
});

document.getElementById("add-sender-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("new-sender-name").value.trim();
  const price = Number(document.getElementById("new-sender-price").value);
  const litPrice = Number(document.getElementById("new-sender-lit-price").value);
  try {
    await fetchJSON("/api/senders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, price, litPrice }),
    });
    e.target.reset();
    refreshAll();
  } catch (err) {
    alert(err.message);
  }
});

refreshAll();
setInterval(refreshAll, 5000);
