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

function animateValue(el, newText) {
  if (el.textContent === newText) return;
  el.style.opacity = "0.3";
  setTimeout(() => {
    el.textContent = newText;
    el.style.opacity = "1";
  }, 120);
}

async function loadStats() {
  const s = await fetchJSON("/api/stats");
  animateValue(document.getElementById("stat-earned"), euro(s.droppedValue));
  document.getElementById("stat-earned-count").textContent = `${s.droppedCount} colis dropés`;
  animateValue(document.getElementById("stat-pending"), String(s.pendingCount));
  document.getElementById("stat-pending-value").textContent = `≈ ${euro(s.pendingValue)} potentiels`;
  animateValue(document.getElementById("stat-today"), euro(s.todayValue));
  document.getElementById("stat-today-count").textContent = `${s.todayCount} colis dropés`;

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
        <div class="row-sub">${row.dropped_count} dropés · ${euro(row.dropped_value)} gagné</div>
      </div>
      <div class="row-right">
        <div class="row-stats">
          <div class="row-stat"><div class="n">${row.pending_count}</div><div class="l">en attente</div></div>
          <div class="row-stat"><div class="n">${euro(row.pending_value)}</div><div class="l">valeur</div></div>
        </div>
        <div class="row-actions">
          <button class="btn btn-round btn-ghost" data-quick-remove="${escapeAttr(row.sender_name)}" title="-1 colis">−</button>
          <button class="btn btn-round btn-primary" data-quick-add="${escapeAttr(row.sender_name)}" title="+1 colis">+</button>
          ${row.pending_count > 0 ? `<button class="btn btn-small btn-ghost" data-drop-sender="${escapeAttr(row.sender_name)}">Dropper</button>` : ""}
        </div>
      </div>
    `;
    container.appendChild(el);
  }

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
        <div class="row-sub">${d.count} colis dropés non payés</div>
      </div>
      <div class="row-right">
        <div class="row-stats">
          <div class="row-stat"><div class="n">${euro(d.owed)}</div><div class="l">doit</div></div>
        </div>
        <div class="row-actions">
          <button class="btn btn-small btn-primary" data-mark-paid="${escapeAttr(d.sender_name)}">Payé</button>
        </div>
      </div>
    `;
    container.appendChild(el);
  }
}

async function loadSenders() {
  const rows = await fetchJSON("/api/senders");
  const container = document.getElementById("settings-rows");
  container.innerHTML = "";
  for (const s of rows) {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="row-main">
        <div class="row-title">${escapeHtml(s.name)}</div>
      </div>
      <div class="row-actions">
        <input class="price-input" type="number" step="0.5" min="0" value="${s.price}" data-sender-id="${s.id}" />
        <button class="btn btn-small btn-ghost" data-delete-sender="${s.id}">Suppr.</button>
      </div>
    `;
    container.appendChild(el);
  }
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

async function loadConfig() {
  const cfg = await fetchJSON("/api/config");
  const input = document.getElementById("lit-price-input");
  if (document.activeElement !== input) input.value = cfg.litPrice;
}

function barChartSVG(items, { highlightBest = false } = {}) {
  if (items.every((i) => i.value === 0)) {
    return `<div class="chart-empty">Pas encore de données</div>`;
  }
  const W = 700, H = 220, padTop = 30, padBottom = 28, padSide = 14;
  const plotH = H - padTop - padBottom;
  const max = Math.max(...items.map((i) => i.value), 1);
  const gap = 14;
  const barW = (W - padSide * 2 - gap * (items.length - 1)) / items.length;
  const bestIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = padTop + plotH * (1 - f);
    return `<line class="chart-grid-line" x1="${padSide}" y1="${y}" x2="${W - padSide}" y2="${y}" />`;
  }).join("");

  const bars = items.map((it, i) => {
    const x = padSide + i * (barW + gap);
    const h = max > 0 ? (it.value / max) * plotH : 0;
    const y = padTop + plotH - h;
    const isBest = highlightBest && i === bestIndex && it.value > 0;
    const label = isBest ? `<text class="chart-value-label" x="${x + barW / 2}" y="${y - 8}" text-anchor="middle">${euro(it.value)}</text>` : "";
    return `
      <rect class="chart-bar ${isBest ? "best" : ""}" x="${x}" y="${y}" width="${barW}" height="${Math.max(h, 2)}" rx="4">
        <title>${it.label}: ${euro(it.value)} (${it.count} colis)</title>
      </rect>
      ${label}
      <text class="chart-axis-label" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${it.label}</text>
    `;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${gridLines}${bars}</svg>`;
}

async function loadRevenueStats() {
  const r = await fetchJSON("/api/stats/revenue");

  const week = r.last7Days.map((d) => ({
    label: DAY_LABELS[new Date(d.date + "T12:00:00").getDay()],
    value: d.value,
    count: d.count,
  }));
  document.getElementById("chart-week").innerHTML = barChartSVG(week, { highlightBest: true });

  const month = r.weeksThisMonth.map((w) => ({ label: w.label.replace("Semaine ", "S"), value: w.value, count: w.count }));
  document.getElementById("chart-month").innerHTML = barChartSVG(month, { highlightBest: true });

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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

async function refreshAll() {
  await Promise.all([loadStats(), loadDebts(), loadSenders(), loadConfig(), loadRevenueStats(), loadStock()]);
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
  if (senderId) {
    await fetchJSON(`/api/senders/${senderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price: Number(e.target.value) }),
    });
    refreshAll();
  } else if (e.target.id === "lit-price-input") {
    await fetchJSON("/api/config/lit-price", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price: Number(e.target.value) }),
    });
    refreshAll();
  }
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
  try {
    await fetchJSON("/api/senders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, price }),
    });
    e.target.reset();
    refreshAll();
  } catch (err) {
    alert(err.message);
  }
});

refreshAll();
setInterval(refreshAll, 5000);
