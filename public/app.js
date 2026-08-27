const euro = (n) => `${Number(n || 0).toFixed(2)} €`;
const DAY_LABELS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

function switchView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

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
      <div class="row-stats">
        <div class="row-stat"><div class="n">${row.pending_count}</div><div class="l">en attente</div></div>
        <div class="row-stat"><div class="n">${euro(row.pending_value)}</div><div class="l">valeur</div></div>
      </div>
      <div class="row-actions">
        <button class="btn btn-round btn-ghost" data-quick-remove="${escapeAttr(row.sender_name)}" title="-1 colis">−</button>
        <button class="btn btn-round btn-primary" data-quick-add="${escapeAttr(row.sender_name)}" title="+1 colis">+</button>
        ${row.pending_count > 0 ? `<button class="btn btn-small btn-ghost" data-drop-sender="${escapeAttr(row.sender_name)}">Dropper</button>` : ""}
      </div>
    `;
    container.appendChild(el);
  }
}

async function loadColis() {
  const rows = await fetchJSON("/api/colis?status=pending");
  const container = document.getElementById("colis-rows");
  container.innerHTML = "";
  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-row">Rien à dropper 🎉</div>`;
  }
  for (const c of rows) {
    const isLit = c.type === "lit";
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="row-main">
        <div class="row-title">#${c.id} · ${escapeHtml(c.sender_name)}</div>
        <div class="row-sub">${new Date(c.created_at + "Z").toLocaleString("fr-FR")}</div>
      </div>
      <div class="row-stats">
        <span class="badge ${isLit ? "badge-lit" : "badge-normal"}" data-toggle-type="${c.id}" data-current-type="${c.type}">${isLit ? "LIT" : "normal"}</span>
        <div class="row-stat"><div class="n">${euro(c.price)}</div></div>
      </div>
      <div class="row-actions">
        <button class="btn btn-small btn-primary" data-drop-id="${c.id}">Dropé</button>
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
  await Promise.all([loadStats(), loadColis(), loadSenders(), loadConfig(), loadRevenueStats()]);
}

document.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-drop-id], [data-drop-sender], [data-delete-sender], [data-quick-add], [data-quick-remove], [data-toggle-type], #drop-all-btn");
  if (!target) return;

  const dropId = target.dataset.dropId;
  const dropSender = target.dataset.dropSender;
  const deleteSender = target.dataset.deleteSender;
  const quickAdd = target.dataset.quickAdd;
  const quickRemove = target.dataset.quickRemove;
  const toggleType = target.dataset.toggleType;

  if (dropId) {
    await fetchJSON(`/api/colis/${dropId}/drop`, { method: "POST" });
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
  } else if (toggleType) {
    const nextType = target.dataset.currentType === "lit" ? "normal" : "lit";
    await fetchJSON(`/api/colis/${toggleType}/type`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: nextType }),
    });
    refreshAll();
  } else if (target.id === "drop-all-btn") {
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
