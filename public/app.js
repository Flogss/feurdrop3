const euro = (n) => `${Number(n || 0).toFixed(2)} €`;
// Les cartes du dashboard sont etroites (3 par ligne sur mobile) : au-dela
// de 1000 € on laisse tomber les centimes pour que le symbole € ne soit pas
// tronque sur le bord.
const euroCompact = (n) => (Math.abs(Number(n) || 0) >= 1000 ? `${Math.round(Number(n) || 0)} €` : euro(n));
const DAY_LABELS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
const CATEGORICAL_COLORS = ["#38f7ff", "#ff3ecb", "#b6ff3e", "#ffb84d", "#b388ff", "#ff6b6b", "#5ad1ff", "#ff8ad1"];
const CARRIER_LABELS = {
  MR: "Mondial Relay",
  LP: "La Poste",
  CHRONO: "Chronopost",
  UPS: "UPS",
  DPD: "DPD",
  GLS: "GLS",
  DHL: "DHL",
  FEDEX: "FedEx",
  BJ: "BJ (boîtes jaunes)",
  Inconnu: "⚠️ Non reconnu",
};

let currentView = "dashboard";

function switchView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  // la revelation animee (compteurs, courbes, barres, camembert) se rejoue a
  // chaque fois qu'on arrive reellement sur l'onglet Stats (pas seulement au
  // chargement du site, et pas si on est deja dessus)
  if (view === "stats" && currentView !== "stats") {
    playStatsReveal();
  }
  // l'onglet Plan interroge des services exterieurs : on ne charge qu'en y
  // arrivant, jamais dans le rafraichissement de fond
  if (view === "imprime" && currentView !== "imprime") loadImprime();
  // le suivi lit une base a part : on ne la sollicite qu'en arrivant dessus
  if (view === "suivi" && currentView !== "suivi") loadSuivi().catch(() => {});
  currentView = view;
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
  // on garde tout ce qui suit le dernier chiffre (ex: " €") pour ne pas
  // perdre l'espace insecable pendant l'animation
  const suffix = (String(newText).match(/[^\d]*$/) || [""])[0];
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

// Reduit la taille de police quand le montant est long (ex: "1234.50 €")
// pour que le symbole € ne deborde pas de la carte.
function fitStatValue(el, text) {
  if (!el) return;
  const len = String(text).length;
  el.classList.toggle("stat-value-long", len >= 8 && len < 10);
  el.classList.toggle("stat-value-xlong", len >= 10);
}

async function loadStats(animate, force) {
  const s = await fetchJSON("/api/stats");
  const earnedText = euroCompact(s.droppedValue);
  fitStatValue(document.getElementById("stat-earned"), earnedText);
  animateValue(document.getElementById("stat-earned"), earnedText);
  document.getElementById("stat-earned-count").textContent = `${s.droppedCount} colis dropés`;
  animateValue(document.getElementById("stat-pending"), String(s.pendingCount));
  document.getElementById("stat-pending-value").textContent = `≈ ${euroCompact(s.pendingValue)}`;
  const todayText = euroCompact(s.todayValue);
  fitStatValue(document.getElementById("stat-today"), todayText);
  animateValue(document.getElementById("stat-today"), todayText);
  document.getElementById("stat-today-count").textContent = `${s.todayCount} colis dropés`;
  animateValue(document.getElementById("stat-bj"), String(s.bjPendingCount || 0));
  document.getElementById("stat-bj-value").textContent = `≈ ${euroCompact(s.bjPendingValue)}`;
  bagSummary = { count: s.pendingCount, value: s.pendingValue };
  renderTour(s.tour || {});
  renderAutoPrint(s.autoPrint || {});

  if (!force && !hasChanged("senders", s.bySender)) return;

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

  renderCarriers(s.byCarrier || []);
  renderDonut(s.bySender, animate);
}

// Impression automatique : l'interrupteur est cote serveur, donc pilotable
// depuis le telephone meme si le Mac est ferme.
let autoPrintEnabled = false;

function renderAutoPrint(state) {
  const badge = document.getElementById("autoprint-state");
  const btn = document.getElementById("autoprint-toggle");
  const hint = document.getElementById("autoprint-hint");
  if (!badge || !btn) return;

  autoPrintEnabled = Boolean(state.enabled);
  badge.textContent = autoPrintEnabled ? "activée" : "désactivée";
  badge.className = `push-state ${autoPrintEnabled ? "push-on" : "push-off"}`;
  btn.textContent = autoPrintEnabled ? "Désactiver" : "Activer";
  btn.className = autoPrintEnabled ? "btn btn-ghost" : "btn btn-primary";
  // la ligne ne sert que quand elle dit quelque chose qu'on ne voit pas
  // ailleurs : le nombre en attente. Eteinte, elle disparait.
  const enAttente = state.pending || 0;
  hint.hidden = !autoPrintEnabled;
  hint.textContent = autoPrintEnabled
    ? `${enAttente} étiquette${enAttente > 1 ? "s" : ""} en attente · LIT à la main`
    : "";
}

document.getElementById("autoprint-toggle").addEventListener("click", async () => {
  const next = !autoPrintEnabled;
  // activer ne doit pas vider un stock entier d'un coup : le serveur considere
  // tout ce qui est deja en attente comme deja imprime
  if (next && !confirm("Activer l'impression automatique ?\nLes colis déjà en attente ne seront pas imprimés, seulement les prochains.")) return;
  try {
    await fetchJSON("/api/print/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    renderCache.clear();
    await refreshAll();
  } catch (err) {
    alert(err.message);
  }
});

// Tournee : une fois parti poster, tout ce qui est "a dropper" ne concerne
// plus que le sac. Les colis recus entre-temps attendent la prochaine sortie.
let tourStartedAt = null;
let bagSummary = { count: 0, value: 0 };
let serverClockOffset = 0;

function renderTour(tour) {
  tourStartedAt = tour.startedAt || null;
  // decalage entre l'horloge du serveur et celle du telephone, pour que le
  // chrono parte de la bonne valeur
  if (tour.now) serverClockOffset = sqlDateToMs(tour.now) - Date.now();

  const btn = document.getElementById("tour-btn");
  const text = document.getElementById("tour-btn-text");
  const banner = document.getElementById("tour-banner");
  if (!btn) return;

  btn.classList.toggle("tour-active", Boolean(tourStartedAt));
  text.textContent = tourStartedAt ? "Je suis rentré" : "Je pars poster";
  banner.hidden = !tourStartedAt;

  renderTourSummary(tourStartedAt ? null : tour.last);

  if (!tourStartedAt) {
    stopChrono();
    return;
  }

  document.getElementById("tour-banner-sub").textContent =
    `Depuis ${formatTourTime(tourStartedAt)}` +
    (tour.arrivedCount > 0
      ? ` · ${tour.arrivedCount} colis reçus depuis (${euro(tour.arrivedValue)}), gardés pour la prochaine fois`
      : " · seuls les colis présents au départ peuvent être dropés");

  startChrono(tourStartedAt);
}

// Resume de la derniere tournee, garde jusqu'a ce qu'on le ferme.
function renderTourSummary(last) {
  const box = document.getElementById("tour-summary");
  if (!box) return;
  box.hidden = !last;
  if (!last) return;

  const seconds =
    last.seconds != null
      ? last.seconds
      : Math.max(0, Math.round((sqlDateToMs(last.endedAt) - sqlDateToMs(last.startedAt)) / 1000));

  document.getElementById("tour-summary-title").textContent = `Tournée terminée en ${formatDuration(seconds)}`;
  document.getElementById("tour-summary-sub").textContent =
    `${formatTourTime(last.startedAt)} → ${formatTourTime(last.endedAt)} · ${last.count} colis dropé${
      last.count > 1 ? "s" : ""
    } · ${euro(last.value)}`;

  const smic = last.smicHourly || 9.4;
  document.getElementById("tour-rate").innerHTML = rateHtml(last.value, seconds, smic);

  // deuxieme sortie du jour : on montre aussi le cumul, tournees additionnees
  const day = last.day;
  const dayEl = document.getElementById("tour-day");
  const showDay = day && day.sessions > 1;
  dayEl.hidden = !showDay;
  if (showDay) {
    dayEl.textContent =
      `Aujourd'hui : ${day.sessions} sessions · ${formatDuration(day.seconds)} · ${euro(day.value)} · ` +
      `${euro(hourlyRate(day.value, day.seconds))}/h · ${formatSmic(hourlyRate(day.value, day.seconds) / smic)} le SMIC`;
  }
}

function hourlyRate(value, seconds) {
  return seconds > 0 ? (value * 3600) / seconds : 0;
}

// "3,2×" — on garde une decimale sauf pour les tres gros multiples
function formatSmic(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1).replace(".", ",")}×`;
}

function rateHtml(value, seconds, smic) {
  const rate = hourlyRate(value, seconds);
  const ratio = smic > 0 ? rate / smic : 0;
  const under = ratio < 1;
  return (
    `<span class="tour-rate-hour">${euro(rate)}/h</span>` +
    `<span class="tour-rate-smic${under ? " under" : ""}">${formatSmic(ratio)} le SMIC</span>` +
    `<span class="tour-rate-ref">SMIC net ${euro(smic)}/h</span>`
  );
}

document.getElementById("tour-summary-close").addEventListener("click", async () => {
  document.getElementById("tour-summary").hidden = true;
  await fetch("/api/tour/dismiss-summary", { method: "POST" }).catch(() => {});
  renderCache.clear();
});

// --- Chrono de tournee ------------------------------------------------------
let chronoTimer = null;

function startChrono(startedAt) {
  const el = document.getElementById("tour-chrono");
  const start = sqlDateToMs(startedAt);
  const tick = () => {
    const now = Date.now() + serverClockOffset;
    el.textContent = formatChrono(Math.max(0, Math.round((now - start) / 1000)));
  };
  tick();
  if (chronoTimer) return; // deja lance : on ne double pas l'intervalle
  chronoTimer = setInterval(tick, 1000);
}

function stopChrono() {
  if (!chronoTimer) return;
  clearInterval(chronoTimer);
  chronoTimer = null;
}

// mm:ss, ou h:mm:ss au-dela d'une heure
function formatChrono(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// duree lisible : "1 h 12 min", "34 min", "48 s"
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return `${m} min`;
  return `${totalSeconds} s`;
}

function sqlDateToMs(sqlDate) {
  return new Date(`${String(sqlDate).replace(" ", "T")}Z`).getTime();
}

// les dates SQLite sont en UTC ("2026-09-09 14:32:10")
function formatTourTime(sqlDate) {
  const ms = sqlDateToMs(sqlDate);
  if (Number.isNaN(ms)) return sqlDate;
  return new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

document.getElementById("tour-btn").addEventListener("click", async () => {
  // au retour, ce qu'on avait emporte est poste : on le marque drope et la
  // tournee se referme
  if (tourStartedAt) {
    const { count, value } = bagSummary;
    if (count === 0) return endTour(false);
    if (!confirm(`Marquer ${count} colis comme dropés (${euro(value)}) ?`)) return;
    return endTour(true);
  }
  try {
    await fetchJSON("/api/tour/start", { method: "POST" });
    renderCache.clear();
    await refreshAll();
  } catch (err) {
    alert(err.message);
  }
});

// drop = true : le sac est drope. false : on referme sans rien dropper.
async function endTour(drop) {
  try {
    await fetchJSON(drop ? "/api/tour/finish" : "/api/tour/end", { method: "POST" });
    renderCache.clear();
    await refreshAll();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById("tour-cancel").addEventListener("click", () => {
  if (confirm("Annuler la tournée sans rien dropper ?")) endTour(false);
});

function renderCarriers(byCarrier) {
  const container = document.getElementById("carrier-rows");
  if (!container) return;
  const pending = byCarrier.filter((c) => c.pending_count > 0);
  container.innerHTML = "";
  if (pending.length === 0) {
    container.innerHTML = `<div class="empty-row">Rien à poster 🎉</div>`;
  }
  for (const c of pending) {
    const el = document.createElement("div");
    el.className = "row row-inline carrier-row";
    el.dataset.carrier = c.carrier;
    el.innerHTML = `
      <div class="row-main">
        <div class="row-title">${escapeHtml(CARRIER_LABELS[c.carrier] || c.carrier)}</div>
      </div>
      <div class="row-actions">
        <span class="chip chip-carrier">${c.pending_count} · ${euro(c.pending_value)}</span>
        <button class="btn btn-small btn-carrier" data-drop-carrier="${escapeAttr(c.carrier)}">Dropper</button>
      </div>
    `;
    container.appendChild(el);
  }
  staggerIn(container);
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
    animateNumberText(document.getElementById("donut-total-value"), total, euro, 1800);
    el.querySelectorAll("[data-legend-value]").forEach((span, i) => {
      animateNumberText(span, Number(span.dataset.legendValue), euro, 1500, i * 140);
    });
    el.querySelectorAll("[data-legend-pct]").forEach((span, i) => {
      const target = Number(span.dataset.legendPct);
      animateNumberText(span, target, (v) => `${Math.round(v)}%`, 1500, i * 140);
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
    // le nom occupe sa propre ligne : avec trois tarifs editables, tout mettre
    // sur une seule ligne rognait completement le nom de l'expediteur
    el.className = "row sender-price-row";
    el.innerHTML = `
      <div class="sender-price-head">
        <div class="row-title" title="${escapeAttr(s.name)}">${escapeHtml(s.name)}</div>
        <button class="btn btn-small btn-ghost" data-delete-sender="${s.id}">Suppr.</button>
      </div>
      <div class="sender-price-fields">
        <label class="price-field">
          <span class="price-tag legend-normal">Normal</span>
          <input class="price-input price-normal" type="number" step="0.5" min="0" value="${s.price}"
                 data-sender-id="${s.id}" data-field="price" title="Prix normal" />
        </label>
        <label class="price-field">
          <span class="price-tag legend-lit">LIT</span>
          <input class="price-input price-lit" type="number" step="0.5" min="0" value="${s.lit_price}"
                 data-sender-id="${s.id}" data-field="litPrice" title="Prix LIT" />
        </label>
        <label class="price-field">
          <span class="price-tag legend-bj">BJ</span>
          <input class="price-input price-bj" type="number" step="0.5" min="0" value="${s.bj_price}"
                 data-sender-id="${s.id}" data-field="bjPrice" title="Prix BJ" />
        </label>
      </div>
    `;
    container.appendChild(el);
  }
  staggerIn(container);
  renderMergePairSelects(rows);
}

// Remplit les deux listes deroulantes de fusion en conservant la selection
// courante si les noms existent toujours.
function renderMergePairSelects(rows) {
  for (const id of ["merge-source", "merge-target"]) {
    const select = document.getElementById(id);
    if (!select) continue;
    const previous = select.value;
    select.innerHTML = rows
      .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
      .join("");
    if (rows.some((s) => String(s.id) === previous)) select.value = previous;
  }
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
  const stocks = await fetchJSON("/api/stock");
  for (const [kind, id] of [["normal", "stock-value"], ["bj", "stock-bj-value"]]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const value = stocks[kind] || 0;
    animateValue(el, String(value));
    el.classList.toggle("stock-low", value <= LOW_STOCK_THRESHOLD);
  }
}

// Les deux stocks sont independants : dropper un BJ retire du stock BJ, un
// colis normal du stock normal.
async function adjustStock(delta, kind = "normal") {
  await fetchJSON("/api/stock/adjust", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delta, kind }),
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
const CHART_H = 215;

// Construit le trajet de reference (courbe ou aire) a partir d'une liste de
// points {x, y}.
function areaPathFrom(points, baseY) {
  return `${smoothPath(points)} L ${points[points.length - 1].x} ${baseY} L ${points[0].x} ${baseY} Z`;
}

function scrollChartSVG(items, { highlightBest = false, animate = false } = {}) {
  const H = CHART_H, padTop = 34, padBottom = 38;
  const plotH = H - padTop - padBottom;
  const baseY = H - padBottom;
  const W = Math.max(CHART_PAD * 2 + (items.length - 1) * CHART_SPACING, 320);
  const max = Math.max(...items.map((i) => i.value), 1);
  const bestIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);
  const uid = curveChartUid++;

  const points = items.map((it, i) => ({
    x: CHART_PAD + i * CHART_SPACING,
    y: baseY - (it.value / max) * plotH * 0.9,
  }));
  // au depart de la revelation, tout est aplati sur la ligne de base : la
  // courbe, les points et les valeurs monteront ensemble jusqu'a leur
  // position finale (voir runCurveReveal)
  const initial = animate ? points.map((p) => ({ x: p.x, y: baseY })) : points;

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = padTop + plotH * (1 - f) * 0.9 + plotH * 0.1;
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
function runCurveReveal(track, geo, duration = 3200) {
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
  const H = CHART_H, padTop = 34, padBottom = 38;
  const plotH = H - padTop - padBottom;
  const baseY = H - padBottom;
  const barW = Math.min(CHART_SPACING * 0.5, 40);
  const W = Math.max(CHART_PAD * 2 + (items.length - 1) * CHART_SPACING, 320);
  const max = Math.max(...items.map((i) => i.value), 1);
  const bestIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);
  const uid = curveChartUid++;

  const bars = items.map((it, i) => ({
    x: CHART_PAD + i * CHART_SPACING,
    h: Math.max((it.value / max) * plotH * 0.9, it.value > 0 ? 4 : 0),
  }));

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = padTop + plotH * (1 - f) * 0.9 + plotH * 0.1;
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
function runBarReveal(track, geo, duration = 1600, stagger = 90) {
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

async function loadDayScrollChart(animate, force) {
  const r = await fetchJSON("/api/stats/revenue/daily-series");
  if (!force && !hasChanged("dailySeries", r.days)) return;

  const container = document.getElementById("chart-week");
  const rangeEl = document.getElementById("week-range");
  const averageEl = document.getElementById("day-average");
  if (!r.days || r.days.length === 0) {
    container.querySelector(".chart-track").innerHTML = `<div class="chart-empty">Pas encore de données</div>`;
    rangeEl.textContent = "—";
    if (averageEl) averageEl.textContent = "—";
    return;
  }

  // moyenne sur tous les jours enregistres (dimanches exclus de la serie),
  // jours sans revenu compris : c'est le revenu moyen d'une journee type
  const total = r.days.reduce((sum, d) => sum + d.value, 0);
  const average = total / r.days.length;
  if (averageEl) {
    if (animate) {
      averageEl.innerHTML = `Moyenne <span id="day-average-value">${euro(0)}</span> / jour · sur ${r.days.length} jours`;
      animateNumberText(document.getElementById("day-average-value"), average, euro, 1600);
    } else {
      averageEl.innerHTML = `Moyenne <span id="day-average-value">${euro(average)}</span> / jour · sur ${r.days.length} jours`;
    }
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

async function loadWeekScrollChart(animate, force) {
  const r = await fetchJSON("/api/stats/revenue/weekly-series");
  if (!force && !hasChanged("weeklySeries", r.weeks)) return;

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

async function loadRevenueStats(animate, force) {
  await Promise.all([loadDayScrollChart(animate, force), loadWeekScrollChart(animate, force)]);

  const r = await fetchJSON("/api/stats/revenue");
  const bestDayEl = document.getElementById("stat-bestday-value");
  const bestDaySub = document.getElementById("stat-bestday-sub");
  if (r.bestDay) {
    if (animate) animateNumberText(bestDayEl, r.bestDay.value, euro, 1600);
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

// Tant que le dashboard est ouvert et visible, on previent le serveur : le
// "+N" des notifications compte les colis arrives depuis la derniere fois
// qu'on l'a regarde. Fermer l'app (ou la mettre en fond) fait donc cumuler
// +1, +2, +3... au lieu d'envoyer trois fois "+1".
function markSeen() {
  if (document.visibilityState !== "visible") return;
  fetch("/api/push/seen", { method: "POST" }).catch(() => {});
}

document.addEventListener("visibilitychange", markSeen);
window.addEventListener("focus", markSeen);

async function refreshAll() {
  markSeen();
  // les rafraichissements de fond (toutes les 5s) n'animent jamais : la
  // revelation (compteurs, courbes, barres, camembert) ne se joue que
  // lorsqu'on arrive reellement sur l'onglet Stats, voir playStatsReveal()
  await Promise.all([
    loadStats(false),
    loadDebts(),
    loadSenders(),
    loadMergeCandidates(),
    loadRevenueStats(false),
    loadStock(),
  ]);
}

// Rejoue la revelation animee de la page Stats. Appelee a chaque fois qu'on
// arrive reellement sur cet onglet (et pas seulement au premier chargement
// du site), avec des donnees fraiches et en forcant le recalcul meme si
// elles n'ont pas change depuis le dernier passage.
async function playStatsReveal() {
  await Promise.all([loadStats(true, true), loadRevenueStats(true, true)]);
}

document.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-drop-sender], [data-drop-carrier], [data-delete-sender], [data-quick-add], [data-quick-remove], [data-mark-paid], .drop-all-btn, .drop-except-lit-btn");
  if (!target) return;

  const dropSender = target.dataset.dropSender;
  const dropCarrier = target.dataset.dropCarrier;
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
  } else if (dropCarrier) {
    await fetchJSON(`/api/colis/drop-carrier/${encodeURIComponent(dropCarrier)}`, { method: "POST" });
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
  } else if (target.classList.contains("drop-except-lit-btn")) {
    // les LIT partent sur une autre imprimante, souvent un autre jour
    if (confirm("Marquer comme dropés tous les colis en attente SAUF les LIT ?")) {
      const r = await fetchJSON("/api/colis/drop-all-except-lit", { method: "POST" });
      if (r.count === 0) alert("Aucun colis à dropper en dehors des LIT.");
      refreshAll();
    }
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

  const allowedFields = ["price", "litPrice", "bjPrice"];
  const field = allowedFields.includes(e.target.dataset.field) ? e.target.dataset.field : "price";
  await fetchJSON(`/api/senders/${senderId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: Number(e.target.value) }),
  });
  refreshAll();
});

document.getElementById("merge-pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const source = document.getElementById("merge-source");
  const target = document.getElementById("merge-target");
  const sourceId = Number(source.value);
  const targetId = Number(target.value);
  if (!sourceId || !targetId) return;
  if (sourceId === targetId) return alert("Choisis deux expéditeurs différents.");
  const sourceName = source.options[source.selectedIndex].textContent;
  const targetName = target.options[target.selectedIndex].textContent;
  if (!confirm(`Fusionner « ${sourceName} » dans « ${targetName} » ?\nTous ses colis et gains seront transférés et « ${sourceName} » sera supprimé.`)) return;
  try {
    const r = await fetchJSON("/api/senders/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, targetId }),
    });
    renderCache.clear();
    await refreshAll();
    alert(`${r.moved} colis transférés vers « ${r.target} ».`);
  } catch (err) {
    alert(err.message);
  }
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

document.querySelectorAll("[data-stock]").forEach((btn) => {
  btn.addEventListener("click", () => adjustStock(Number(btn.dataset.delta), btn.dataset.stock));
});

document.querySelectorAll("[data-stock-form]").forEach((form) => {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.querySelector("input");
    const n = Number(input.value);
    if (!n) return;
    adjustStock(n, form.dataset.stockForm);
    input.value = "";
  });
});

document.getElementById("add-sender-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("new-sender-name").value.trim();
  const price = Number(document.getElementById("new-sender-price").value);
  const litPrice = Number(document.getElementById("new-sender-lit-price").value);
  const bjPrice = Number(document.getElementById("new-sender-bj-price").value);
  try {
    await fetchJSON("/api/senders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, price, litPrice, bjPrice }),
    });
    e.target.reset();
    refreshAll();
  } catch (err) {
    alert(err.message);
  }
});

// --- Notifications push -----------------------------------------------------
// Sur iOS, le push web n'existe QUE dans une PWA installee sur l'ecran
// d'accueil (Safari 16.4+). Dans un onglet Safari classique, PushManager
// n'existe simplement pas : on affiche alors la marche a suivre.
const pushSupported =
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isStandalone =
  window.navigator.standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
let swRegistration = null;
let pushError = null;

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

async function currentSubscription() {
  if (!swRegistration) return null;
  return swRegistration.pushManager.getSubscription();
}

async function updatePushUI() {
  const panel = document.getElementById("push-panel");
  const state = document.getElementById("push-state");
  const hint = document.getElementById("push-hint");
  const dis = (texte) => {
    hint.textContent = texte;
    hint.hidden = !texte;
  };
  const enable = document.getElementById("push-enable");
  const test = document.getElementById("push-test");
  const disable = document.getElementById("push-disable");
  if (!panel) return;

  panel.hidden = false;

  if (!pushSupported) {
    state.textContent = "indisponible";
    state.className = "push-state push-off";
    dis(isIOS
      ? "Sur iPhone, les notifications ne marchent que si le site est ajouté à l'écran d'accueil : bouton Partager → « Sur l'écran d'accueil », puis rouvre l'app depuis cette icône."
      : "Ce navigateur ne gère pas les notifications push.");
    enable.hidden = true;
    test.hidden = true;
    disable.hidden = true;
    return;
  }

  if (pushError) {
    state.textContent = "indisponible";
    state.className = "push-state push-off";
    dis(`Les notifications n'ont pas pu démarrer sur cet appareil (${pushError}).`);
    enable.hidden = true;
    test.hidden = true;
    disable.hidden = true;
    return;
  }

  const sub = await currentSubscription();
  const granted = Notification.permission === "granted" && sub;

  state.textContent = granted ? "activées" : Notification.permission === "denied" ? "bloquées" : "désactivées";
  state.className = `push-state ${granted ? "push-on" : "push-off"}`;
  enable.hidden = granted;
  test.hidden = !granted;
  disable.hidden = !granted;

  if (Notification.permission === "denied") {
    dis(isIOS
      ? "Notifications refusées. Réglages iOS → Notifications → DROP pour les réautoriser."
      : "Notifications refusées. Réautorise-les dans les réglages du navigateur pour ce site.");
    enable.hidden = true;
  } else {
    dis("");
  }
}

async function subscribePush() {
  const { publicKey } = await fetchJSON("/api/push/key");
  let sub = await currentSubscription();
  if (!sub) {
    sub = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON();
  await fetchJSON("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      label: `${isIOS ? "iOS" : "web"}${isStandalone ? " (app)" : ""}`,
    }),
  });
}

async function initPush() {
  if (!pushSupported) return updatePushUI();
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    // iOS revoque parfois l'abonnement en silence : on se reabonne a chaque
    // ouverture tant que la permission est accordee.
    if (Notification.permission === "granted") await subscribePush();
  } catch (err) {
    console.error("[push] init", err);
    pushError = err.message || String(err);
  }
  updatePushUI();
}

document.getElementById("push-enable").addEventListener("click", async () => {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return updatePushUI();
    await subscribePush();
    await updatePushUI();
  } catch (err) {
    alert(`Impossible d'activer les notifications : ${err.message}`);
  }
});

document.getElementById("push-test").addEventListener("click", async () => {
  try {
    const r = await fetchJSON("/api/push/test", { method: "POST" });
    if (r.sent === 0) alert("Aucun appareil abonné n'a pu être joint.");
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("push-disable").addEventListener("click", async () => {
  const sub = await currentSubscription();
  if (sub) {
    await fetchJSON("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  }
  updatePushUI();
});

initPush();

refreshAll();
setInterval(refreshAll, 5000);

// --- Suivi des colis ---------------------------------------------------------
// Lecture des verifications faites par le bot de suivi. Rien n'est recalcule
// ici : ce qui s'affiche est ce que le bot a releve, tel quel.

const suiviState = { labels: [], label: null, rows: [], total: 0, timer: null };

function suiviDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16).replace("T", " ");
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function suiviDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

async function loadSuivi() {
  const data = await fetchJSON("/api/suivi/overview");

  if (!data.ready) {
    document.getElementById("suivi-total").textContent = "base introuvable";
    document.getElementById("suivi-recheck").innerHTML =
      `<div class="empty-row">Base du bot de suivi introuvable.<br />
       Indique son chemin dans la variable <code>SUIVI_DB_PATH</code>.</div>`;
    document.getElementById("suivi-labels").innerHTML = "";
    document.getElementById("suivi-summary").innerHTML = "";
    return;
  }

  const total = data.totalChecked ?? data.db.numbers;
  document.getElementById("suivi-total").textContent =
    `${total.toLocaleString("fr-FR")} numéros vérifiés`;
  document.getElementById("suivi-link-count").textContent = total.toLocaleString("fr-FR");

  renderSuiviSummary(data.summary);
  renderSuiviLabels(data.labels);
  renderSuiviDonut(data.labels);

  // Une verification peut partir d'ailleurs : un .txt envoye au bot Telegram.
  // Tant qu'on est sur cet onglet, on guette, et l'ecran s'allume tout seul.
  watchForExternal();
}

// Veille legere : une interrogation toutes les 3 s, uniquement au repos et
// uniquement sur cet onglet.
function watchForExternal() {
  clearInterval(suiviState.timer);
  suiviState.timer = setInterval(async () => {
    if (currentView !== "suivi") return clearInterval(suiviState.timer);
    if (live.timer) return; // un ecran de passage tourne deja
    try {
      const data = await fetchJSON("/api/suivi/live");
      if (data.running) {
        live.since = 0;
        live.shown = 0;
        startLiveWatch();
      }
    } catch (err) {
      /* le serveur redemarre peut-etre : on retentera */
    }
  }, 3000);
}

// Un colis livre ou cloture ne bougera plus : seules ces categories meritent
// d'etre reinterrogees, et le bouton n'apparait que sur celles-la.
const RECHECKABLE = new Set(["pending", "info_received", "in_transit", "out_for_delivery"]);

function renderSuiviSummary(summary) {
  const box = document.getElementById("suivi-summary");
  if (!summary || summary.length === 0) {
    box.innerHTML = `<div class="empty-row">Rien à afficher.</div>`;
    return;
  }
  box.innerHTML = summary
    .map((m) => {
      const relance = RECHECKABLE.has(m.milestone)
        ? `<button class="btn btn-ghost btn-small suivi-recheck-btn"
             data-recheck="${escapeAttr(m.milestone)}"
             title="Revérifier ces ${m.count} numéros">↻</button>`
        : "";
      return `<div class="row row-inline">
        <div class="row-main"><div class="row-title">${m.icon} ${escapeHtml(m.milestoneLabel)}</div></div>
        <div class="row-actions">
          <span class="chip chip-owed">${m.count.toLocaleString("fr-FR")}</span>${relance}
        </div>
      </div>`;
    })
    .join("");
}

document.getElementById("suivi-summary").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-recheck]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await fetchJSON("/api/suivi/recheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milestones: [btn.dataset.recheck] }),
    });
    live.since = 0;
    live.shown = 0;
    startLiveWatch();
    document.getElementById("suivi-check-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "↻";
  }
});

function renderSuiviLabels(labels) {
  suiviState.labels = labels;
  document.getElementById("suivi-labels-count").textContent =
    `${labels.length} libellé${labels.length > 1 ? "s" : ""}`;

  const box = document.getElementById("suivi-labels");
  if (labels.length === 0) {
    box.innerHTML = `<div class="empty-row">Aucune actualisation enregistrée.</div>`;
    return;
  }

  box.innerHTML = labels
    .map(
      (l, i) => `<div class="row row-pick" data-suivi-label="${i}">
        <div class="row-main">
          <div class="row-title">${l.icon} ${escapeHtml(l.label || "(sans libellé)")}</div>
          <div class="row-sub">dernière le ${suiviDate(l.last_event_at)}</div>
        </div>
        <div class="row-actions"><span class="chip chip-pending">${l.count.toLocaleString("fr-FR")}</span></div>
      </div>`
    )
    .join("");
}

document.getElementById("suivi-labels").addEventListener("click", (e) => {
  const row = e.target.closest("[data-suivi-label]");
  if (!row) return;
  openSuiviLabel(suiviState.labels[Number(row.dataset.suiviLabel)]);
});

async function openSuiviLabel(label) {
  if (!label) return;
  suiviState.label = label;
  suiviState.rows = [];
  switchView("suivi-detail");

  document.getElementById("suivi-detail-label").textContent = label.label || "(sans libellé)";
  document.getElementById("suivi-rows").innerHTML = `<div class="empty-row">Chargement…</div>`;
  await loadSuiviRows(true);
}

async function loadSuiviRows(reset = false) {
  const offset = reset ? 0 : suiviState.rows.length;
  const params = new URLSearchParams({ label: suiviState.label.label ?? "", limit: 200, offset });
  const data = await fetchJSON(`/api/suivi/label?${params}`);

  suiviState.rows = reset ? data.rows : [...suiviState.rows, ...data.rows];
  suiviState.total = data.total;

  document.getElementById("suivi-detail-count").textContent =
    `${suiviState.rows.length} / ${data.total.toLocaleString("fr-FR")}`;
  document.getElementById("suivi-more").hidden = suiviState.rows.length >= data.total;

  document.getElementById("suivi-rows").innerHTML = suiviState.rows
    .map(
      (r, i) => `<div class="suivi-row">
        <div class="suivi-row-main">
          <div class="suivi-number">${escapeHtml(r.tracking_number)}</div>
          <div class="suivi-when">${r.icon} ${suiviDate(r.last_event_at)}</div>
        </div>
        <button class="btn btn-ghost btn-small" data-suivi-copy="${i}">📋</button>
      </div>`
    )
    .join("");
}

document.getElementById("suivi-more").addEventListener("click", () => loadSuiviRows(false));

// Ce qu'on copie : le numero, la date de la derniere actualisation, et ce
// qu'elle dit. Les trois ensemble, c'est ce qui se colle dans un message.
function suiviLine(row) {
  return `${row.tracking_number} — ${suiviDate(row.last_event_at)} — ${row.last_label || ""}`.trim();
}

async function copyText(text, button) {
  const previous = button ? button.textContent : null;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // clipboard refuse hors HTTPS : on retombe sur la vieille methode
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (button) {
    button.textContent = "✅";
    setTimeout(() => (button.textContent = previous), 1200);
  }
}

document.getElementById("suivi-rows").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-suivi-copy]");
  if (!btn) return;
  copyText(suiviLine(suiviState.rows[Number(btn.dataset.suiviCopy)]), btn);
});

document.getElementById("suivi-copy-all").addEventListener("click", (e) => {
  copyText(suiviState.rows.map(suiviLine).join("\n"), e.currentTarget);
});

document.getElementById("suivi-copy-numbers").addEventListener("click", (e) => {
  copyText(suiviState.rows.map((r) => r.tracking_number).join("\n"), e.currentTarget);
});

document.getElementById("settings-link").addEventListener("click", () => switchView("colis"));
document.getElementById("settings-back").addEventListener("click", () => switchView("dashboard"));

document.getElementById("suivi-link").addEventListener("click", () => switchView("suivi"));
document.getElementById("suivi-back").addEventListener("click", () => switchView("dashboard"));
document.getElementById("suivi-detail-back").addEventListener("click", () => switchView("suivi"));

// --- Ecran de passage --------------------------------------------------------
// Le compteur ne saute pas de 10 en 10 : il monte numero par numero, quitte a
// courir derriere la realite. Un compteur qui bondit ne dit rien du rythme ;
// un compteur qui defile, si.

const live = { since: 0, timer: null, shown: 0, target: 0, raf: null, queue: [], popping: false };

const MILESTONE_ICON = {
  delivered: "✅",
  out_for_delivery: "🚚",
  in_transit: "📦",
  info_received: "📥",
  pending: "🕓",
  final_other: "↩️",
  expired: "⌛",
  not_found: "❓",
  unknown: "❔",
};
const MILESTONE_FR = {
  delivered: "Livré",
  out_for_delivery: "En cours de livraison",
  in_transit: "En transit",
  info_received: "Pris en charge",
  pending: "En attente",
  final_other: "Clôturé",
  expired: "Expiré",
  not_found: "Introuvable",
  unknown: "Inconnu",
};

function startLiveWatch() {
  document.getElementById("suivi-live").hidden = false;
  document.getElementById("suivi-idle").hidden = true;
  clearInterval(live.timer);
  live.timer = setInterval(pollLive, 700);
  pollLive();
  tickCounter();
}

function stopLiveWatch() {
  clearInterval(live.timer);
  live.timer = null;
  cancelAnimationFrame(live.raf);
  live.raf = null;
  document.getElementById("suivi-live").hidden = true;
  document.getElementById("suivi-idle").hidden = false;
}

async function pollLive() {
  let data;
  try {
    data = await fetchJSON(`/api/suivi/live?since=${live.since}`);
  } catch (err) {
    return;
  }
  if (!data.job) return stopLiveWatch();

  const job = data.job;
  live.target = job.checked;
  live.since = data.seq ?? live.since;

  document.getElementById("suivi-live-source").textContent =
    job.source + (data.queued > 0 ? ` · ${data.queued} en attente` : "");
  document.getElementById("suivi-counter-total").textContent = `/ ${job.total.toLocaleString("fr-FR")}`;
  const pct = job.percent;
  document.getElementById("suivi-fill").style.width = `${pct.toFixed(1)}%`;
  document.getElementById("suivi-reflect").style.width = `${pct.toFixed(1)}%`;
  document.getElementById("suivi-head").style.left = `${pct.toFixed(1)}%`;
  document.getElementById("suivi-pct").textContent = `${pct.toFixed(pct < 10 ? 1 : 0)} %`;

  // `running` est a la racine de la reponse, pas dans `job`
  const eta = job.eta !== null ? ` · reste ~${suiviDuration(job.eta)}` : "";
  document.getElementById("suivi-live-sub").textContent = data.running
    ? `${job.rate} /s · ${suiviDuration(job.elapsed)} écoulées${eta}`
    : job.fatalError
      ? `⚠️ ${job.fatalError}`
      : job.cancelled
        ? `Arrêté après ${suiviDuration(job.elapsed)}`
        : `Terminé en ${suiviDuration(job.elapsed)}`;

  renderLiveCounts(job.counts);
  // Les introuvables sont de loin les plus nombreux (9 sur 10 sur un gros
  // fichier) : les afficher noierait les vraies trouvailles. Ils restent
  // comptes dans les pastilles, mais ne defilent pas.
  for (const find of data.finds || []) {
    if (find.found && find.milestone !== "not_found") live.queue.push(find);
  }
  drainToasts();

  if (!data.running) {
    // on laisse l'animation finir sa course avant de rendre la main
    setTimeout(() => {
      stopLiveWatch();
      loadSuivi().catch(() => {});
    }, 2500);
  }
}

// Le compteur monte REGULIEREMENT, pas par a-coups. L'API repond par paquets
// toutes les 700 ms : rattraper aussi vite que possible donnait un sprint puis
// un temps mort, soit exactement l'effet de saut qu'on veut eviter. On etale
// donc chaque paquet sur l'intervalle qui vient, ce qui donne un defilement
// continu et un rythme qui se lit.
const POLL_MS = 700;

function tickCounter() {
  const el = document.getElementById("suivi-counter");
  let last = performance.now();

  const step = (now) => {
    const dt = now - last;
    last = now;

    const gap = live.target - live.shown;
    if (gap > 0) {
      // vitesse calee pour absorber le retard d'ici la prochaine reponse,
      // avec un plancher pour que les tout petits lots avancent quand meme
      const perMs = Math.max(gap / POLL_MS, 0.004);
      live.progress = (live.progress || 0) + perMs * dt;
      const pas = Math.floor(live.progress);
      if (pas >= 1) {
        live.progress -= pas;
        live.shown = Math.min(live.shown + pas, live.target);
        el.textContent = live.shown.toLocaleString("fr-FR");
        el.classList.remove("bump");
        void el.offsetWidth;
        el.classList.add("bump");
      }
    }
    live.raf = requestAnimationFrame(step);
  };
  cancelAnimationFrame(live.raf);
  live.raf = requestAnimationFrame(step);
}

// Les trouvailles apparaissent une par une : en rafale elles seraient
// illisibles, et c'est justement le defile qui rend le passage vivant.
function drainToasts() {
  if (live.popping || live.queue.length === 0) return;
  live.popping = true;

  const pop = () => {
    const find = live.queue.shift();
    if (!find) {
      live.popping = false;
      return;
    }
    // en cas d'embouteillage on accelere plutot que de prendre du retard
    const delay = live.queue.length > 12 ? 90 : live.queue.length > 5 ? 180 : 320;
    showToast(find);
    setTimeout(pop, delay);
  };
  pop();
}

function showToast(find) {
  const box = document.getElementById("suivi-toasts");
  const el = document.createElement("div");
  el.className = `suivi-toast suivi-toast-${find.found ? find.milestone : "not_found"}`;
  el.innerHTML = `<span class="suivi-toast-icon">${MILESTONE_ICON[find.milestone] || "❔"}</span>
    <span class="suivi-toast-main">
      <span class="suivi-toast-num">${escapeHtml(find.number)}</span>
      <span class="suivi-toast-cat">${escapeHtml(MILESTONE_FR[find.milestone] || find.milestone)}</span>
    </span>`;
  box.prepend(el);
  while (box.children.length > 6) box.lastChild.remove();
  setTimeout(() => el.classList.add("out"), 2600);
  setTimeout(() => el.remove(), 3200);
}

function renderLiveCounts(counts) {
  const box = document.getElementById("suivi-live-counts");
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  box.innerHTML = entries
    .map(
      ([key, n]) =>
        `<span class="suivi-count-chip">${MILESTONE_ICON[key] || "❔"} ${n.toLocaleString("fr-FR")}</span>`
    )
    .join("");
}

// --- Relance et mise en attente ---------------------------------------------

async function acceptFile(file) {
  if (!file) return;
  const text = await file.text();
  document.getElementById("suivi-add-text").value = text;
  document.getElementById("suivi-drop-title").textContent = file.name;
  const lignes = text.split("\n").filter((l) => l.trim()).length;
  document.getElementById("suivi-drop-sub").textContent = `${lignes.toLocaleString("fr-FR")} ligne${lignes > 1 ? "s" : ""} lue${lignes > 1 ? "s" : ""}`;
  document.getElementById("suivi-drop").classList.add("loaded");
}

document.getElementById("suivi-add-file").addEventListener("change", (e) => acceptFile(e.target.files[0]));

// glisser-deposer : le navigateur ouvrirait le fichier si on ne l'en empechait pas
const drop = document.getElementById("suivi-drop");
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
}
drop.addEventListener("drop", (e) => acceptFile(e.dataTransfer?.files?.[0]));

document.getElementById("suivi-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = document.getElementById("suivi-add-text").value.trim();
  if (!text) return alert("Colle des numéros ou choisis un fichier.");
  const name = document.getElementById("suivi-drop").classList.contains("loaded")
    ? document.getElementById("suivi-drop-title").textContent
    : "liste collée";

  try {
    const res = await fetchJSON("/api/suivi/verifier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, name }),
    });
    if (res.invalid > 0 || res.duplicates > 0) {
      console.log(`[suivi] ${res.invalid} invalides, ${res.duplicates} doublons écartés`);
    }
    document.getElementById("suivi-add-text").value = "";
    resetDrop();
    if (res.queued > 0) alert(`Vérification en cours : cette liste passe en file d'attente (${res.queued}).`);
    live.since = 0;
    live.shown = 0;
    startLiveWatch();
  } catch (err) {
    alert(err.message);
  }
});

function resetDrop() {
  document.getElementById("suivi-drop-title").textContent = "Déposer un fichier .txt";
  document.getElementById("suivi-drop-sub").textContent = "ou clique pour le choisir";
  document.getElementById("suivi-drop").classList.remove("loaded");
  document.getElementById("suivi-add-file").value = "";
}

document.getElementById("suivi-cancel").addEventListener("click", async () => {
  await fetchJSON("/api/suivi/annuler", { method: "POST" }).catch(() => {});
});

// --- Camembert des actualisations -------------------------------------------

function renderSuiviDonut(labels) {
  const box = document.getElementById("suivi-donut");
  const items = (labels || []).filter((l) => l.count > 0).sort((a, b) => b.count - a.count);
  if (items.length === 0) {
    box.innerHTML = `<div class="chart-empty">Pas encore de données</div>`;
    return;
  }

  const total = items.reduce((sum, it) => sum + it.count, 0);
  const size = 220, cx = 110, cy = 110, r = 84, width = 22;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  const segments = items
    .map((it, i) => {
      const len = (it.count / total) * circumference;
      const gap = items.length > 1 ? 3 : 0;
      const color = CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length];
      const seg = `<circle class="donut-seg instant" cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${color}" stroke-width="${width}"
        stroke-dasharray="${Math.max(len - gap, 0)} ${circumference - len + gap}"
        stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})">
        <title>${escapeAttr(it.label || "")} : ${it.count}</title></circle>`;
      offset += len;
      return seg;
    })
    .join("");

  const legend = items
    .map((it, i) => {
      const pct = Math.round((it.count / total) * 100);
      const color = CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length];
      return `<div class="donut-legend-item">
        <span class="donut-swatch" style="background:${color}"></span>
        <div class="donut-legend-main">
          <div class="donut-legend-top">
            <span class="donut-legend-name">${it.icon} ${escapeHtml(it.label || "(sans libellé)")}</span>
            <span class="donut-legend-value">${it.count.toLocaleString("fr-FR")}</span>
          </div>
          <div class="donut-legend-bar"><div class="donut-legend-bar-fill instant" style="width:${pct}%;background:${color}"></div></div>
        </div>
      </div>`;
    })
    .join("");

  box.innerHTML = `<div class="donut-layout">
      <svg viewBox="0 0 ${size} ${size}" class="donut-svg">
        <circle class="donut-track" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${width}"/>
        ${segments}
        <circle class="donut-center-ring" cx="${cx}" cy="${cy}" r="${r - width / 2 - 8}" fill="none"/>
        <text x="${cx}" y="${cy - 3}" text-anchor="middle" class="donut-total-value">${total.toLocaleString("fr-FR")}</text>
        <text x="${cx}" y="${cy + 19}" text-anchor="middle" class="donut-total-label">colis</text>
      </svg>
      <div class="donut-legend">${legend}</div>
    </div>`;
}

// --- Onglet Imprimé ----------------------------------------------------------
// Même chaîne que /imprime sur Telegram : mêmes étiquettes, même mise en page,
// même marquage. Seule la sortie change — le PDF s'ouvre dans un onglet, et
// c'est le navigateur qui imprime.

const CARRIER_ICONS = {
  MR: "🩷", LP: "🟡", CHRONO: "🟢", UPS: "🟤", DPD: "🔴",
  GLS: "🔵", DHL: "🟠", FEDEX: "🟣", BJ: "🟨", LIT: "🧻", Inconnu: "⚠️",
};

async function loadImprime() {
  let aFaire;
  let deja;
  try {
    [aFaire, deja] = await Promise.all([
      fetchJSON("/api/print/resume?scope=new"),
      fetchJSON("/api/print/resume?scope=printed"),
    ]);
  } catch (err) {
    // un onglet muet ne dit pas s'il est vide ou casse : on le dit
    document.getElementById("imp-total").textContent = "erreur";
    document.getElementById(
      "imp-categories"
    ).innerHTML = `<div class="empty-row">Liste indisponible : ${escapeHtml(err.message)}</div>`;
    return;
  }

  impTransporteurs = aFaire.transporteurs || [];
  const annotes = aFaire.noted > 0 ? ` · ${aFaire.noted} 📝` : "";
  document.getElementById("imp-total").textContent =
    aFaire.total > 0 ? `${aFaire.total} étiquette${aFaire.total > 1 ? "s" : ""}${annotes}` : "rien en attente";

  // "Tout" ne couvre que le thermique 4x6 : les LIT sortent sur le rouleau
  // 210 mm, dans un PDF qui ne se mélange pas au reste.
  const thermiques = aFaire.categories
    .filter((c) => !c.roll)
    .reduce((sum, c) => sum + c.count, 0);
  const tout = document.getElementById("imp-all");
  tout.disabled = thermiques === 0;
  tout.textContent = thermiques > 0 ? `🖨 Tout imprimer · ${thermiques}` : "🖨 Tout imprimer";

  renderCategories("imp-categories", aFaire.categories, "new");
  document.getElementById("imp-printed-count").textContent =
    deja.total > 0 ? `${deja.total}` : "aucune";
  renderCategories("imp-printed", deja.categories, "printed");
}

function renderCategories(cible, categories, scope) {
  const box = document.getElementById(cible);
  // une catégorie dépliée le reste apres un rafraichissement : sinon la liste
  // se referme sous le doigt a chaque impression
  const ouvertes = [...box.querySelectorAll(".imp-cat.open")].map((el) => el.dataset.cat);

  if (!categories || categories.length === 0) {
    box.innerHTML = `<div class="empty-row">Rien ici.</div>`;
    return;
  }
  box.innerHTML = categories
    .map(
      (c) => `<div class="imp-cat${c.noted ? " noted" : ""}" data-cat="${escapeAttr(c.code)}" data-scope="${scope}">
        <div class="imp-cat-head">
          <span class="imp-chevron">▶</span>
          <span class="imp-cat-name">${CARRIER_ICONS[c.code] || "📦"} ${escapeHtml(c.label)}</span>
          ${c.noted ? `<span class="imp-cat-noted">📝 ${c.noted}</span>` : ""}
          <span class="imp-cat-count">${c.count}</span>
          <button class="btn btn-ghost btn-small" data-print-cat="${escapeAttr(c.code)}" data-scope="${scope}">🖨</button>
        </div>
        <div class="imp-list"></div>
      </div>`
    )
    .join("");

  for (const code of ouvertes) {
    const cat = box.querySelector(`.imp-cat[data-cat="${CSS.escape(code)}"]`);
    if (!cat) continue;
    cat.classList.add("open");
    fillCategory(cat);
  }
}

// Déplier une catégorie charge sa liste : inutile de tout descendre d'avance.
document.addEventListener("click", async (e) => {
  const head = e.target.closest(".imp-cat-head");
  if (head && !e.target.closest("[data-print-cat]")) {
    const cat = head.parentElement;
    cat.classList.toggle("open");
    if (cat.classList.contains("open")) await fillCategory(cat);
    return;
  }

  const printCat = e.target.closest("[data-print-cat]");
  if (printCat) {
    return lancerImpression(printCat, {
      categorie: printCat.dataset.printCat,
      scope: printCat.dataset.scope,
    });
  }

  const printOne = e.target.closest("[data-print-one]");
  if (printOne) {
    return lancerImpression(printOne, {
      ids: [Number(printOne.dataset.printOne)],
      scope: printOne.dataset.scope,
    });
  }

  const edite = e.target.closest("[data-edit-colis]");
  if (edite) return ouvreEdition(Number(edite.dataset.editColis));

  if (e.target.closest("[data-edit-cancel]")) {
    e.target.closest(".imp-edit").remove();
    return;
  }

  const drope = e.target.closest("[data-drop-colis]");
  if (drope) {
    drope.disabled = true;
    try {
      await fetchJSON(`/api/print/colis/${drope.dataset.dropColis}/drop`, { method: "POST" });
      await loadImprime();
    } catch (err) {
      drope.disabled = false;
      alert(err.message);
    }
    return;
  }

  const supprime = e.target.closest("[data-del-colis]");
  if (supprime) {
    if (!confirm("Retirer ce colis et effacer son fichier sur Telegram ?")) return;
    supprime.disabled = true;
    try {
      await fetchJSON(`/api/print/colis/${supprime.dataset.delColis}`, { method: "DELETE" });
      await loadImprime();
    } catch (err) {
      supprime.disabled = false;
      alert(err.message);
    }
  }
});

async function fillCategory(cat) {
  const liste = cat.querySelector(".imp-list");
  const { cat: code, scope } = cat.dataset;
  liste.innerHTML = `<div class="empty-row">Chargement…</div>`;

  let colis;
  try {
    ({ colis } = await fetchJSON(
      `/api/print/colis?categorie=${encodeURIComponent(code)}&scope=${scope}`
    ));
  } catch (err) {
    liste.innerHTML = `<div class="empty-row">${escapeHtml(err.message)}</div>`;
    return;
  }

  if (colis.length === 0) {
    liste.innerHTML = `<div class="empty-row">Vide.</div>`;
    return;
  }

  for (const c of colis) impColis.set(c.id, c);

  // Une etiquette deja imprimee n'a plus besoin d'etre supprimee d'ici : elle
  // a besoin d'etre dropee quand on l'a postee, colis par colis.
  const imprimee = scope === "printed";
  liste.innerHTML = colis
    .map(
      (c) => `<div class="imp-row${c.note ? " noted" : ""}" data-row="${c.id}">
        <div class="imp-row-main">
          <div class="imp-row-name">${escapeHtml(c.fileName || `colis #${c.id}`)}</div>
          <div class="imp-row-sub">${escapeHtml(c.sender)} · ${euro(c.price)}${c.kind === "image" ? " · photo" : ""}</div>
          ${c.note ? `<div class="imp-row-note">📝 ${escapeHtml(c.note)}</div>` : ""}
        </div>
        <button class="btn btn-ghost btn-small" data-edit-colis="${c.id}" title="Modifier">✎</button>
        <button class="btn btn-ghost btn-small" data-print-one="${c.id}" data-scope="${scope}" title="Imprimer">🖨</button>
        ${
          imprimee
            ? `<button class="btn btn-ghost btn-small imp-drop" data-drop-colis="${c.id}" title="Drop">📮</button>`
            : `<button class="btn btn-ghost btn-small" data-del-colis="${c.id}" title="Supprimer">✕</button>`
        }
      </div>`
    )
    .join("");
}

// --- Edition d'un colis ------------------------------------------------------
// Prix, transporteur, note : les trois choses qu'on corrige a la main. Le
// formulaire se deplie sous la ligne, sans quitter la liste.
const impColis = new Map(); // id -> colis tel que charge, pour pre-remplir
let impTransporteurs = [];

function ouvreEdition(id) {
  const ligne = document.querySelector(`.imp-row[data-row="${id}"]`);
  if (!ligne) return;
  // un deuxieme appui referme
  const deja = ligne.nextElementSibling;
  if (deja && deja.classList.contains("imp-edit")) {
    deja.remove();
    return;
  }
  document.querySelectorAll(".imp-edit").forEach((f) => f.remove());

  const c = impColis.get(id);
  const options = [`<option value="">— non reconnu —</option>`]
    .concat(
      impTransporteurs.map(
        (t) => `<option value="${escapeAttr(t.code)}"${t.code === c.carrier ? " selected" : ""}>${escapeHtml(t.label)}</option>`
      )
    )
    .join("");

  ligne.insertAdjacentHTML(
    "afterend",
    `<form class="imp-edit" data-edit-form="${id}">
      <div class="imp-edit-grid">
        <label class="imp-edit-field">
          <span class="price-tag">Prix €</span>
          <input name="price" type="text" inputmode="decimal" value="${escapeAttr(String(c.price))}" />
        </label>
        <label class="imp-edit-field">
          <span class="price-tag">Transporteur</span>
          <select name="carrier">${options}</select>
        </label>
      </div>
      <label class="imp-edit-field">
        <span class="price-tag">Note</span>
        <textarea name="note" rows="2" placeholder="fragile, avant 14h…">${escapeHtml(c.note || "")}</textarea>
      </label>
      <div class="imp-edit-actions">
        <button type="button" class="btn btn-ghost btn-small" data-edit-cancel>Annuler</button>
        <button type="submit" class="btn btn-primary btn-small">Enregistrer</button>
      </div>
    </form>`
  );
  ligne.nextElementSibling.querySelector("input").focus();
}

// On n'envoie que ce qui a change : renvoyer le prix tel quel le figerait
// contre les futurs changements de tarif de l'expediteur.
async function enregistreEdition(form) {
  const id = Number(form.dataset.editForm);
  const c = impColis.get(id);
  const champs = new FormData(form);
  const corps = {};

  const prix = String(champs.get("price")).trim().replace(",", ".");
  if (prix === "" || !Number.isFinite(Number(prix)) || Number(prix) < 0) {
    form.querySelector("input[name=price]").classList.add("invalid");
    return;
  }
  if (Number(prix) !== c.price) corps.price = Number(prix);

  const transporteur = champs.get("carrier") || null;
  if (transporteur !== (c.carrier || null)) corps.carrier = transporteur;

  const note = String(champs.get("note")).trim();
  if (note !== (c.note || "")) corps.note = note;

  if (Object.keys(corps).length === 0) {
    form.remove();
    return;
  }

  const bouton = form.querySelector("[type=submit]");
  bouton.disabled = true;
  try {
    const res = await fetchJSON(`/api/print/colis/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    });
    // corriger un transporteur apprend au bot, comme /transporteur : autant
    // dire ce qu'il a retenu, et s'il a reclasse d'autres colis au passage
    if (res.appris) signaleImprime(res.appris);
    await loadImprime();
  } catch (err) {
    bouton.disabled = false;
    alert(err.message);
  }
}

function signaleImprime(texte) {
  const box = document.getElementById("imp-notice");
  box.textContent = texte;
  box.hidden = false;
  clearTimeout(signaleImprime.minuteur);
  signaleImprime.minuteur = setTimeout(() => (box.hidden = true), 7000);
}

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-edit-form]");
  if (!form) return;
  e.preventDefault();
  enregistreEdition(form);
});

// L'onglet s'ouvre AVANT la construction du PDF : un navigateur ne laisse
// ouvrir une fenêtre que pendant le clic, pas après un aller-retour réseau.
async function lancerImpression(bouton, corps) {
  const onglet = window.open("", "_blank");
  const texte = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = "…";

  let res = null;
  try {
    res = await fetchJSON("/api/print/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    });
  } catch (err) {
    if (onglet) onglet.close();
    alert(`Impression impossible : ${err.message}`);
  }

  // rendre son libelle au bouton AVANT le rafraichissement : dans l'autre
  // ordre, "Tout imprimer · 3" revient alors qu'il ne reste plus rien
  bouton.disabled = false;
  bouton.textContent = texte;
  if (!res) return;

  if (onglet) onglet.location = res.url;
  else window.location = res.url; // fenêtre bloquée : on y va quand même

  // Un bloqueur de fenetres avale parfois l'onglet sans rien dire. Le lien
  // reste affiche : il y a toujours quelque chose a toucher pour ouvrir le
  // PDF, et il sert aussi a le rouvrir sans le reconstruire.
  const detail = res.roll
    ? `${res.count} étiquette${res.count > 1 ? "s" : ""} · ${res.lengthMm} mm de rouleau`
    : `${res.count} étiquette${res.count > 1 ? "s" : ""} · ${res.pages} page${res.pages > 1 ? "s" : ""}`;
  const lien = document.getElementById("imp-last");
  lien.href = res.url;
  lien.textContent = `📄 Ouvrir le PDF — ${detail}`;
  lien.hidden = false;

  await loadImprime();
}

document.getElementById("imp-all").addEventListener("click", (e) =>
  lancerImpression(e.currentTarget, { categorie: "*", scope: "new" })
);
