// --- Suivi des colis ------------------------------------------------------------
// Lecture des verifications faites par le bot de suivi. Rien n'est recalcule
// ici : ce qui s'affiche est ce que le bot a releve, tel quel.

const suiviState = { labels: [], label: null, rows: [], total: 0, timer: null };

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
const ms = (milestone) => `ms ms-${escapeAttr(milestone || "unknown")}`;

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
    $("suivi-total").textContent = "Base introuvable";
    $("suivi-summary").innerHTML = vide("alert", "Base du bot de suivi introuvable", "Indique son chemin dans la variable SUIVI_DB_PATH.");
    $("suivi-labels").innerHTML = "";
    $("suivi-labels-count").textContent = "";
    $("suivi-donut").innerHTML = "";
    return;
  }

  const total = data.totalChecked ?? data.db.numbers;
  $("suivi-total").textContent = pluriel(total, "numéro vérifié", "numéros vérifiés");
  $("suivi-link-count").textContent = pluriel(total, "numéro vérifié", "numéros vérifiés");

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
      const data = await fetchJSON("/api/suivi/live", {}, { essais: 1 });
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
  const box = $("suivi-summary");
  if (!summary || summary.length === 0) {
    box.innerHTML = vide("inbox", "Rien à afficher");
    return;
  }
  rendListe(box, summary, {
    cle: (m) => m.milestone,
    videHtml: "",
    html: (m) => {
      const relance = RECHECKABLE.has(m.milestone)
        ? `<button class="btn btn-icon btn-sm btn-ghost" data-recheck="${escapeAttr(m.milestone)}" type="button"
             aria-label="Revérifier ces ${entier(m.count)} numéros" title="Revérifier">${ico("refresh")}</button>`
        : `<span class="slot" aria-hidden="true"></span>`;
      return `<div class="lrow ${ms(m.milestone)}" data-key="${escapeAttr(m.milestone)}">
        <span class="ms-dot"></span>
        <div class="lrow-main"><div class="lrow-title">${escapeHtml(m.milestoneLabel)}</div></div>
        <div class="lrow-actions"><span class="ms-count">${entier(m.count)}</span>${relance}</div>
      </div>`;
    },
  });
}

$("suivi-summary").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-recheck]");
  if (!btn) return;
  agir(
    btn,
    async () => {
      await postJSON("/api/suivi/recheck", { milestones: [btn.dataset.recheck] });
      live.since = 0;
      live.shown = 0;
      startLiveWatch();
      $("suivi-check-panel").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
    },
    { succes: "Revérification lancée" }
  );
});

function renderSuiviLabels(labels) {
  suiviState.labels = labels;
  $("suivi-labels-count").textContent = pluriel(labels.length, "libellé", "libellés");

  const box = $("suivi-labels");
  if (labels.length === 0) {
    box.innerHTML = vide("inbox", "Aucune actualisation enregistrée");
    return;
  }

  rendListe(box, labels, {
    cle: (l) => l.label ?? "",
    videHtml: "",
    html: (l) => {
      const i = labels.indexOf(l);
      return `<div class="lrow lrow-pick ${ms(l.milestone)}" data-suivi-label="${i}" data-key="${escapeAttr(l.label ?? "")}" role="button" tabindex="0">
        <span class="ms-dot"></span>
        <div class="lrow-main">
          <div class="lrow-title">${escapeHtml(l.label || "(sans libellé)")}</div>
          <div class="lrow-sub">Dernière le ${suiviDate(l.last_event_at)}</div>
        </div>
        <div class="lrow-actions"><span class="ms-count">${entier(l.count)}</span>${ico("chevron-right", "lrow-chev")}</div>
      </div>`;
    },
  });
}

function ouvreLibelle(e) {
  const row = e.target.closest("[data-suivi-label]");
  if (!row) return;
  if (e.type === "keydown") {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
  }
  openSuiviLabel(suiviState.labels[Number(row.dataset.suiviLabel)]);
}
$("suivi-labels").addEventListener("click", ouvreLibelle);
$("suivi-labels").addEventListener("keydown", ouvreLibelle);

async function openSuiviLabel(label) {
  if (!label) return;
  suiviState.label = label;
  suiviState.rows = [];
  switchView("suivi-detail");

  $("suivi-detail-title").textContent = MILESTONE_FR[label.milestone] || "Détail";
  $("suivi-detail-label").textContent = label.label || "(sans libellé)";
  $("suivi-detail-count").textContent = "—";
  $("suivi-rows").innerHTML = squelettes(4);
  $("suivi-rows")._signatures = null;
  await loadSuiviRows(true);
}

async function loadSuiviRows(reset = false) {
  const offset = reset ? 0 : suiviState.rows.length;
  const params = new URLSearchParams({ label: suiviState.label.label ?? "", limit: 200, offset });
  const data = await fetchJSON(`/api/suivi/label?${params}`);

  suiviState.rows = reset ? data.rows : [...suiviState.rows, ...data.rows];
  suiviState.total = data.total;

  $("suivi-detail-count").textContent = `${entier(suiviState.rows.length)} sur ${pluriel(data.total, "numéro", "numéros")}`;
  $("suivi-more").hidden = suiviState.rows.length >= data.total;

  rendListe($("suivi-rows"), suiviState.rows, {
    cle: (r) => r.tracking_number,
    videHtml: vide("inbox", "Aucun numéro"),
    html: (r) => {
      const i = suiviState.rows.indexOf(r);
      return `<div class="lrow ${ms(r.milestone)}" data-key="${escapeAttr(r.tracking_number)}">
        <span class="ms-dot"></span>
        <div class="lrow-main">
          <div class="lrow-title suivi-row-num">${escapeHtml(r.tracking_number)}</div>
          <div class="lrow-sub">${suiviDate(r.last_event_at)}</div>
        </div>
        <button class="btn btn-icon btn-sm btn-ghost" data-suivi-copy="${i}" type="button" aria-label="Copier ${escapeAttr(r.tracking_number)}">${ico("copy")}</button>
      </div>`;
    },
  });
}

$("suivi-more").addEventListener("click", (e) => agir(e.currentTarget, () => loadSuiviRows(false)));

// Ce qu'on copie : le numero, la date de la derniere actualisation, et ce
// qu'elle dit. Les trois ensemble, c'est ce qui se colle dans un message.
function suiviLine(row) {
  return `${row.tracking_number} — ${suiviDate(row.last_event_at)} — ${row.last_label || ""}`.trim();
}

async function copyText(text, button, message = "Copié") {
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
  fait(button);
  haptique();
  toast(message);
}

$("suivi-rows").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-suivi-copy]");
  if (!btn) return;
  const row = suiviState.rows[Number(btn.dataset.suiviCopy)];
  copyText(suiviLine(row), btn, `${row.tracking_number} copié`);
});

$("suivi-copy-all").addEventListener("click", (e) => {
  copyText(suiviState.rows.map(suiviLine).join("\n"), e.currentTarget, pluriel(suiviState.rows.length, "ligne copiée", "lignes copiées"));
});

$("suivi-copy-numbers").addEventListener("click", (e) => {
  copyText(
    suiviState.rows.map((r) => r.tracking_number).join("\n"),
    e.currentTarget,
    pluriel(suiviState.rows.length, "numéro copié", "numéros copiés")
  );
});

$("settings-link").addEventListener("click", () => switchView("colis"));
$("settings-back").addEventListener("click", () => switchView("dashboard"));
$("suivi-link").addEventListener("click", () => switchView("suivi"));
$("suivi-back").addEventListener("click", () => switchView("dashboard"));
$("suivi-detail-back").addEventListener("click", () => switchView("suivi"));

// --- Ecran de passage -----------------------------------------------------------
// Le compteur ne saute pas de 10 en 10 : il monte numero par numero, quitte a
// courir derriere la realite. Un compteur qui bondit ne dit rien du rythme ;
// un compteur qui defile, si.

const live = { since: 0, timer: null, shown: 0, target: 0, raf: null, queue: [], popping: false };

function startLiveWatch() {
  $("suivi-live").hidden = false;
  $("suivi-idle").hidden = true;
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
  $("suivi-live").hidden = true;
  $("suivi-idle").hidden = false;
}

async function pollLive() {
  let data;
  try {
    data = await fetchJSON(`/api/suivi/live?since=${live.since}`, {}, { essais: 1 });
  } catch (err) {
    return;
  }
  if (!data.job) return stopLiveWatch();

  const job = data.job;
  live.target = job.checked;
  live.since = data.seq ?? live.since;

  $("suivi-live-source").textContent = job.source + (data.queued > 0 ? ` · ${data.queued} en attente` : "");
  $("suivi-counter-total").textContent = `/ ${entier(job.total)}`;
  const pct = job.percent;
  $("suivi-fill").style.width = `${pct.toFixed(1)}%`;
  $("suivi-head").style.left = `${pct.toFixed(1)}%`;
  $("suivi-pct").textContent = `${pct.toFixed(pct < 10 ? 1 : 0).replace(".", ",")} %`;

  // `running` est a la racine de la reponse, pas dans `job`
  const eta = job.eta !== null ? ` · reste ~${suiviDuration(job.eta)}` : "";
  $("suivi-live-sub").textContent = data.running
    ? `${job.rate} /s · ${suiviDuration(job.elapsed)} écoulées${eta}`
    : job.fatalError
      ? `Erreur : ${job.fatalError}`
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
      if (!job.fatalError && !job.cancelled) eclat($("suivi-counter"), { nombre: 18, force: 1.2 });
      stopLiveWatch();
      loadSuivi().catch(() => {});
    }, 2500);
  }
}

// Le compteur monte REGULIEREMENT, pas par a-coups : chaque paquet de l'API
// est etale sur l'intervalle qui vient, ce qui donne un defilement continu.
const POLL_MS = 700;

function tickCounter() {
  const el = $("suivi-counter");
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
        el.textContent = entier(live.shown);
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
    showFind(find);
    setTimeout(pop, delay);
  };
  pop();
}

function showFind(find) {
  const box = $("suivi-toasts");
  const el = document.createElement("div");
  const etape = find.found ? find.milestone : "not_found";
  el.className = `suivi-toast ${ms(etape)}`;
  el.innerHTML = `<span class="ms-dot"></span>
    <span class="suivi-toast-main">
      <span class="suivi-toast-num">${escapeHtml(find.number)}</span>
      <span class="suivi-toast-cat">${escapeHtml(MILESTONE_FR[find.milestone] || find.milestone)}</span>
    </span>`;
  box.prepend(el);
  while (box.children.length > 5) box.lastChild.remove();
  setTimeout(() => el.classList.add("out"), 2600);
  setTimeout(() => el.remove(), 3100);
}

function renderLiveCounts(counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  $("suivi-live-counts").innerHTML = entries
    .map(([key, n]) => `<span class="chip chip-tinted chip-sm ${ms(key)}"><b>${entier(n)}</b> ${escapeHtml(MILESTONE_FR[key] || key)}</span>`)
    .join("");
}

// --- Depot d'une liste --------------------------------------------------------------

async function acceptFile(file) {
  if (!file) return;
  const text = await file.text();
  $("suivi-add-text").value = text;
  $("suivi-drop-title").textContent = file.name;
  const lignes = text.split("\n").filter((l) => l.trim()).length;
  $("suivi-drop-sub").textContent = pluriel(lignes, "ligne lue", "lignes lues");
  $("suivi-drop").classList.add("loaded");
  haptique();
}

$("suivi-add-file").addEventListener("change", (e) => acceptFile(e.target.files[0]));

// glisser-deposer : le navigateur ouvrirait le fichier si on ne l'en empechait pas
const drop = $("suivi-drop");
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

$("suivi-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bouton = e.submitter || e.target.querySelector("[type=submit]");
  const zone = $("suivi-add-text");
  const text = zone.value.trim();
  if (!text) {
    rejoue(zone, "invalid", 1400);
    toast("Colle des numéros ou choisis un fichier.", "error");
    return;
  }
  const name = $("suivi-drop").classList.contains("loaded") ? $("suivi-drop-title").textContent : "liste collée";

  await agir(bouton, async () => {
    const res = await postJSON("/api/suivi/verifier", { text, name });
    if (res.invalid > 0 || res.duplicates > 0) {
      console.log(`[suivi] ${res.invalid} invalides, ${res.duplicates} doublons écartés`);
    }
    zone.value = "";
    resetDrop();
    if (res.queued > 0) toast(`Vérification en cours : cette liste passe en file d'attente (${res.queued}).`, "info");
    live.since = 0;
    live.shown = 0;
    startLiveWatch();
  });
});

function resetDrop() {
  $("suivi-drop-title").textContent = "Déposer un fichier .txt";
  $("suivi-drop-sub").textContent = "ou choisis-le dans tes fichiers";
  $("suivi-drop").classList.remove("loaded");
  $("suivi-add-file").value = "";
}

$("suivi-cancel").addEventListener("click", (e) =>
  agir(e.currentTarget, () => postJSON("/api/suivi/annuler").catch(() => {}), { succes: "Vérification arrêtée" })
);

// --- Anneau des actualisations ----------------------------------------------------

function renderSuiviDonut(labels) {
  const items = (labels || [])
    .filter((l) => l.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((l) => ({ name: l.label || "(sans libellé)", value: l.count }));
  const wrap = $("suivi-donut");
  const anime = !wrap._vu;
  wrap._vu = true;
  renderDonutInto(wrap, items, { animate: anime, label: "colis", format: entier });
}

