const euro = (n) => `${Number(n || 0).toFixed(2)} €`;
const DAY_LABELS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
const CATEGORICAL_COLORS = ["#38f7ff", "#ff3ecb", "#b6ff3e", "#ffb84d", "#b388ff", "#ff6b6b", "#5ad1ff", "#ff8ad1"];

function switchView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
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

async function loadStats() {
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

  renderDonut(s.bySender);
}

function donutSVG(items) {
  const total = items.reduce((sum, it) => sum + it.value, 0);
  if (total <= 0) return `<div class="chart-empty">Pas encore de données</div>`;

  const size = 200, cx = size / 2, cy = size / 2, r = 78, strokeWidth = 26;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const segments = items.map((it, i) => {
    const frac = it.value / total;
    const len = frac * circumference;
    const gap = items.length > 1 ? 2 : 0;
    const dash = `${Math.max(len - gap, 0)} ${circumference - len + gap}`;
    const seg = `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]}"
      stroke-width="${strokeWidth}" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})">
      <title>${it.sender_name}: ${euro(it.value)} (${Math.round(frac * 100)}%)</title>
    </circle>`;
    offset += len;
    return seg;
  }).join("");

  return `
    <svg viewBox="0 0 ${size} ${size}" class="donut-svg">
      ${segments}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-total-value">${euro(total)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="donut-total-label">total</text>
    </svg>
  `;
}

function donutLegend(items) {
  const total = items.reduce((sum, it) => sum + it.value, 0) || 1;
  return `<div class="donut-legend">${items.map((it, i) => `
    <div class="donut-legend-item">
      <span class="donut-swatch" style="background:${CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]}"></span>
      <span class="donut-legend-name">${escapeHtml(it.sender_name)}</span>
      <span class="donut-legend-value">${euro(it.value)} · ${Math.round((it.value / total) * 100)}%</span>
    </div>
  `).join("")}</div>`;
}

function renderDonut(bySender) {
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
  el.innerHTML = `<div class="donut-layout">${donutSVG(items)}${donutLegend(items)}</div>`;
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
  if (points.length < 2) return "";
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

function curveChartSVG(items, { highlightBest = false } = {}) {
  const W = 700, H = 260, padTop = 40, padBottom = 40, padSide = 30;
  const plotH = H - padTop - padBottom;
  const baseY = H - padBottom;
  const max = Math.max(...items.map((i) => i.value), 1);
  const stepX = items.length > 1 ? (W - padSide * 2) / (items.length - 1) : 0;
  const bestIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);
  const uid = curveChartUid++;

  const points = items.map((it, i) => ({
    x: padSide + i * stepX,
    y: baseY - (it.value / max) * plotH * 0.86,
  }));

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = padTop + plotH * (1 - f) * 0.86 + plotH * 0.14;
    return `<line class="chart-grid-line" x1="${padSide}" y1="${y}" x2="${W - padSide}" y2="${y}" />`;
  }).join("");

  const linePath = smoothPath(points);
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${baseY} L ${points[0].x} ${baseY} Z`;

  const dots = items.map((it, i) => {
    const isBest = highlightBest && i === bestIndex && it.value > 0;
    const p = points[i];
    const label = `<text class="chart-value-label ${it.value > 0 ? "" : "is-zero"} ${isBest ? "is-best" : ""}" x="${p.x}" y="${p.y - 16}" text-anchor="middle">${it.value > 0 ? euro(it.value) : "—"}</text>`;
    return `
      <circle class="chart-dot ${isBest ? "best" : ""}" cx="${p.x}" cy="${p.y}" r="${isBest ? 6 : 4}">
        <title>${it.label}: ${euro(it.value)} (${it.count} colis)</title>
      </circle>
      ${label}
      <text class="chart-axis-label" x="${p.x}" y="${H - 12}" text-anchor="middle">${it.label}</text>
    `;
  }).join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="curveFill${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38f7ff" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#38f7ff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path class="chart-area" d="${areaPath}" fill="url(#curveFill${uid})"/>
      <path class="chart-line" d="${linePath}" fill="none"/>
      ${dots}
    </svg>
  `;
}

const chartState = {
  week: { offset: 0 },
  month: { offset: 0 },
};

function frenchDateShort(dateStr) {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

async function loadWeekChart() {
  const offset = chartState.week.offset;
  const r = await fetchJSON(`/api/stats/revenue/week?offset=${offset}`);
  const items = r.days.map((d) => ({
    label: DAY_LABELS[new Date(`${d.date}T12:00:00`).getDay()],
    value: d.value,
    count: d.count,
  }));
  document.getElementById("chart-week").innerHTML = curveChartSVG(items, { highlightBest: true });
  document.getElementById("week-range").textContent = r.isCurrent
    ? `Cette semaine · ${frenchDateShort(r.startDate)} - ${frenchDateShort(r.endDate)}`
    : `${frenchDateShort(r.startDate)} - ${frenchDateShort(r.endDate)}`;
  document.querySelector('.chart-nav-btn[data-nav="week"][data-dir="-1"]').disabled = r.isCurrent;
}

async function loadMonthChart() {
  const offset = chartState.month.offset;
  const r = await fetchJSON(`/api/stats/revenue/month?offset=${offset}`);
  const items = r.weeks.map((w) => ({ label: w.label, value: w.value, count: w.count }));
  document.getElementById("chart-month").innerHTML = curveChartSVG(items, { highlightBest: true });
  const [y, m] = r.monthKey.split("-").map(Number);
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  document.getElementById("month-range").textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
  document.querySelector('.chart-nav-btn[data-nav="month"][data-dir="-1"]').disabled = r.isCurrent;
}

async function loadRevenueStats() {
  await Promise.all([loadWeekChart(), loadMonthChart()]);

  const r = await fetchJSON("/api/stats/revenue");
  const bestDayEl = document.getElementById("stat-bestday-value");
  const bestDaySub = document.getElementById("stat-bestday-sub");
  if (r.bestDay) {
    bestDayEl.textContent = euro(r.bestDay.value);
    const d = new Date(r.bestDay.date + "T12:00:00");
    bestDaySub.textContent = `${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} · ${r.bestDay.count} colis`;
  } else {
    bestDayEl.textContent = "—";
    bestDaySub.textContent = "Pas encore de données";
  }
}

function navigateChart(kind, dir) {
  const state = chartState[kind];
  const next = state.offset + dir;
  if (next < 0) return;
  state.offset = next;
  if (kind === "week") loadWeekChart();
  else loadMonthChart();
}

document.querySelectorAll(".chart-nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => navigateChart(btn.dataset.nav, Number(btn.dataset.dir)));
});

// swipe gauche/droite sur les graphiques pour naviguer dans l'historique
document.querySelectorAll(".chart-swipe").forEach((el) => {
  const kind = el.id === "chart-week" ? "week" : "month";
  let startX = null, dragging = false;

  const onStart = (x) => { startX = x; dragging = true; };
  const onEnd = (x) => {
    if (!dragging || startX === null) return;
    dragging = false;
    const dx = x - startX;
    if (Math.abs(dx) > 40) navigateChart(kind, dx < 0 ? 1 : -1);
    startX = null;
  };

  el.addEventListener("pointerdown", (e) => onStart(e.clientX));
  el.addEventListener("pointerup", (e) => onEnd(e.clientX));
  el.addEventListener("pointerleave", () => { dragging = false; startX = null; });
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

async function refreshAll() {
  await Promise.all([loadStats(), loadDebts(), loadSenders(), loadRevenueStats(), loadStock()]);
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
