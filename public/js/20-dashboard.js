// --- Dashboard ------------------------------------------------------------------

let statsChargees = false;

async function loadStats(animate, force, riche) {
  const s = await fetchJSON("/api/stats");
  const premier = !statsChargees;
  statsChargees = true;

  // Point de depart des compteurs. Au premier chargement : la memoire de cet
  // appareil -- avec sa bulle "+N" s'il y a vraiment du nouveau depuis la
  // derniere visite -- ou zero pour la grande entree d'une nouvelle session
  // (sans bulle : ce n'est pas du nouveau). Ensuite : ce qui est affiche, et
  // toute hausse a sa bulle.
  const souvenir = premier ? memoire() : null;
  const depart = (cle, valeur, memeJour = false) => {
    if (!premier) return { depuis: undefined, nouveau: true };
    const m = souvenir?.[cle];
    const valable = typeof m === "number" && (!memeJour || souvenir.jour === aujourdhui());
    if (valable && m !== valeur) return { depuis: m, nouveau: true };
    return { depuis: nouvelleSession ? 0 : valable ? m : undefined, nouveau: false };
  };
  // au lancement, on attend que la carte ait fini d'entrer pour compter (et,
  // pendant la meteorite, que son onde ait ouvert l'interface)
  const delai = premier ? 780 + (window.lancementDrop?.reste() ?? 0) : 0;
  const colis = depart("pending", s.pendingCount);
  const jour = depart("today", s.todayValue, true);
  const gagne = depart("earned", s.droppedValue);

  compte($("stat-pending"), s.pendingCount, {
    depuis: colis.depuis,
    delai,
    bulle: colis.nouveau ? (d) => `+${pluriel(d, "colis", "colis")}` : undefined,
  });
  compte($("stat-pending-value"), s.pendingValue, { format: (v) => `≈ ${euro(v)}`, depuis: premier && nouvelleSession ? 0 : undefined, delai });
  compte($("stat-bj"), s.bjPendingCount || 0, { delai });
  $("stat-bj-value").textContent = euroCompact(s.bjPendingValue);
  $("stat-lit").textContent = entier(s.litPendingCount || 0);
  $("chip-lit").hidden = !s.litPendingCount;
  $("chip-bj").hidden = !s.bjPendingCount;

  const today = $("stat-today");
  fitStatValue(today, euroCompact(s.todayValue));
  compte(today, s.todayValue, {
    format: euroCompact,
    depuis: jour.depuis,
    delai: delai + 140,
    bulle: jour.nouveau ? (d) => `+${euroCompact(d)}` : undefined,
  });
  $("stat-today-count").textContent = pluriel(s.todayCount, "colis dropé", "colis dropés");

  const earned = $("stat-earned");
  fitStatValue(earned, euroCompact(s.droppedValue));
  compte(earned, s.droppedValue, {
    format: euroCompact,
    depuis: gagne.depuis,
    delai: delai + 220,
    bulle: gagne.nouveau ? (d) => `+${euroCompact(d)}` : undefined,
  });
  $("stat-earned-count").textContent = pluriel(s.droppedCount, "colis dropé", "colis dropés");

  retiens({ pending: s.pendingCount, today: s.todayValue, earned: s.droppedValue });
  signatureRevenus = `${s.droppedCount}|${s.droppedValue}|${aujourdhui()}`;
  // du nouveau depuis la derniere visite : le son part avec la bulle "+N"
  if (premier && colis.nouveau && colis.depuis < s.pendingCount) {
    dernierEnAttente = s.pendingCount;
    setTimeout(chaChing, delai + 300);
  } else {
    noteEnAttente(s.pendingCount);
  }

  majPastilleImprime(s.aImprimer);
  bagSummary = { count: s.pendingCount, value: s.pendingValue };
  renderTour(s.tour || {});
  renderAutoPrint(s.autoPrint || {});

  if (hasChanged("carriers", s.byCarrier) || force) {
    renderCarriers(s.byCarrier || []);
    renderMix(s.byCarrier || [], premier);
  }
  if (!hasChanged("senders", s.bySender) && !force) return;
  renderSenders(s.bySender);
  renderDonut(s.bySender, animate, riche);
}

function majPastilleImprime(n) {
  if (n === undefined) return;
  const pastille = $("tab-badge-imprime");
  const avant = Number(pastille.dataset.n || 0);
  pastille.dataset.n = n;
  pastille.textContent = n > 0 ? (n > 99 ? "99+" : String(n)) : "";
  if (n > avant && avant > 0) rejoue(pastille, "is-bump", 650);
}

function renderSenders(rows) {
  rendListe($("sender-rows"), rows, {
    cle: (r) => r.sender_name,
    videHtml: vide("package", "Aucun colis pour le moment", "Les fichiers envoyés au bot apparaîtront ici."),
    html: (r) => `
      <div class="lrow sender" data-key="${escapeAttr(r.sender_name)}">
        ${avatar(r.sender_name)}
        <div class="lrow-main">
          <div class="lrow-title">${escapeHtml(r.sender_name)}</div>
          <div class="lrow-sub">${pluriel(r.dropped_count, "dropé", "dropés")} · ${euroGraphe(r.dropped_value)}</div>
        </div>
        <div class="lrow-actions">
          ${
            r.pending_count > 0
              ? `<button class="btn btn-sm btn-tinted btn-drop" data-drop-sender="${escapeAttr(r.sender_name)}" type="button">
                   <span>Drop</span><span class="btn-count">${entier(r.pending_count)}</span>
                 </button>`
              : ""
          }
          <div class="mini-stepper">
            <button class="step" data-quick-remove="${escapeAttr(r.sender_name)}" type="button" aria-label="Retirer un colis à ${escapeAttr(r.sender_name)}">${ico("minus")}</button>
            <button class="step" data-quick-add="${escapeAttr(r.sender_name)}" type="button" aria-label="Ajouter un colis à ${escapeAttr(r.sender_name)}">${ico("plus")}</button>
          </div>
        </div>
      </div>`,
  });
}

function renderCarriers(byCarrier) {
  const box = $("carrier-rows");
  const pending = byCarrier.filter((c) => c.pending_count > 0);
  const total = pending.reduce((sum, c) => sum + c.pending_count, 0);
  $("carrier-meta").textContent = total ? pluriel(total, "colis", "colis") : "";

  // chaque barre repart de sa largeur precedente : elle glisse, elle ne
  // repousse pas de zero a chaque changement
  const avant = new Map(
    [...box.querySelectorAll("[data-key] .share > span")].map((el) => [el.closest("[data-key]").dataset.key, el.dataset.w])
  );

  rendListe(box, pending, {
    cle: (c) => c.carrier,
    videHtml: vide("party", "Rien à poster", "Tout est dropé, beau travail.", true),
    html: (c) => {
      const part = total ? c.pending_count / total : 0;
      return `
      <div class="lrow carrier" data-carrier="${escapeAttr(c.carrier)}" data-key="${escapeAttr(c.carrier)}">
        <span class="carrier-dot"></span>
        <div class="lrow-main">
          <div class="lrow-title">${escapeHtml(CARRIER_LABELS[c.carrier] || c.carrier)}</div>
          <div class="lrow-sub">${pluriel(c.pending_count, "colis", "colis")} · ${euro(c.pending_value)}</div>
          <div class="share"><span style="--w:${avant.get(c.carrier) || 0}" data-w="${part.toFixed(3)}"></span></div>
        </div>
        <button class="btn btn-sm btn-tinted" data-drop-carrier="${escapeAttr(c.carrier)}" type="button">Dropper</button>
      </div>`;
    },
  });

  // les barres poussent apres l'entree de la page, pas pendant qu'elle est
  // encore invisible
  setTimeout(() => box.querySelectorAll(".share > span").forEach((el) => el.style.setProperty("--w", el.dataset.w)), 420);
}

// La composition du sac d'un coup d'oeil : une barre segmentee aux couleurs
// des transporteurs, dans la carte principale.
function renderMix(byCarrier, premier) {
  const pending = byCarrier.filter((c) => c.pending_count > 0);
  const boite = $("hero-mix");
  boite.hidden = pending.length === 0;
  if (!pending.length) return;
  const nom = (code) => (code === "BJ" ? "BJ" : CARRIER_LABELS[code] || code);
  const bar = $("mix-bar");
  const existants = new Map([...bar.children].map((s) => [s.dataset.key, s]));
  // les segments deja la changent de largeur en douceur ; les nouveaux poussent
  const segments = pending.map((c, i) => {
    let seg = existants.get(c.carrier);
    if (!seg) {
      seg = document.createElement("span");
      seg.className = "carrier";
      seg.dataset.carrier = c.carrier;
      seg.dataset.key = c.carrier;
      seg.style.flexGrow = "0";
    }
    seg.style.setProperty("--n", i);
    seg.title = `${nom(c.carrier)} : ${pluriel(c.pending_count, "colis", "colis")}`;
    return [seg, c.pending_count];
  });
  bar.replaceChildren(...segments.map(([seg]) => seg));
  if (premier) rejoue(bar, "pousse", 1800);
  requestAnimationFrame(() => segments.forEach(([seg, n]) => (seg.style.flexGrow = String(n))));

  $("mix-legend").innerHTML = pending
    .map(
      (c) =>
        `<span class="mix-item carrier" data-carrier="${escapeAttr(c.carrier)}"><i></i>${escapeHtml(nom(c.carrier))} <b>${entier(
          c.pending_count
        )}</b></span>`
    )
    .join("");
}

// --- Impression automatique ----------------------------------------------------
// L'interrupteur est cote serveur, donc pilotable depuis le telephone meme si
// le Mac est ferme.

let autoPrintEnabled = false;

function renderAutoPrint(state) {
  const sw = $("autoprint-toggle");
  if (!sw || sw.getAttribute("aria-busy") === "true") return;

  autoPrintEnabled = Boolean(state.enabled);
  sw.setAttribute("aria-checked", String(autoPrintEnabled));
  const etat = $("autoprint-state");
  etat.textContent = autoPrintEnabled ? "Activée" : "Désactivée";
  etat.classList.toggle("is-on", autoPrintEnabled);
  // la ligne ne sert que quand elle dit quelque chose qu'on ne voit pas
  // ailleurs : le nombre en attente. Eteinte, elle disparait.
  const hint = $("autoprint-hint");
  const enAttente = state.pending || 0;
  hint.hidden = !autoPrintEnabled;
  hint.textContent = autoPrintEnabled
    ? `${pluriel(enAttente, "étiquette", "étiquettes")} en attente · les LIT restent à la main`
    : "";
}

$("autoprint-toggle").addEventListener("click", async (e) => {
  const sw = e.currentTarget;
  const next = !autoPrintEnabled;
  // activer ne doit pas vider un stock entier d'un coup : le serveur considere
  // tout ce qui est deja en attente comme deja imprime
  if (
    next &&
    !(await confirmer({
      titre: "Activer l'impression auto ?",
      message: "Les colis déjà en attente ne seront pas imprimés, seulement les prochains.",
      action: "Activer",
    }))
  )
    return;

  sw.setAttribute("aria-checked", String(next));
  sw.setAttribute("aria-busy", "true");
  haptique();
  try {
    await postJSON("/api/print/auto", { enabled: next });
    sw.removeAttribute("aria-busy");
    if (next) eclat(sw, { nombre: 8, force: 0.7 });
    renderCache.clear();
    await refreshAll();
    toast(next ? "Impression auto activée" : "Impression auto désactivée");
  } catch (err) {
    sw.removeAttribute("aria-busy");
    sw.setAttribute("aria-checked", String(!next));
    secoue(sw);
    toast(err.message, "error");
  }
});

// --- Tournee --------------------------------------------------------------------
// Une fois parti poster, tout ce qui est "a dropper" ne concerne plus que le
// sac. Les colis recus entre-temps attendent la prochaine sortie.

let tourStartedAt = null;
let bagSummary = { count: 0, value: 0 };
// le resume deja la au lancement ne refait pas la fete : seul un retour de
// tournee pendant qu'on regarde la declenche
let toursVus = false;
let serverClockOffset = 0;

function renderTour(tour) {
  tourStartedAt = tour.startedAt || null;
  // decalage entre l'horloge du serveur et celle du telephone, pour que le
  // chrono parte de la bonne valeur
  if (tour.now) serverClockOffset = sqlDateToMs(tour.now) - Date.now();

  const enTournee = Boolean(tourStartedAt);
  $("hero").classList.toggle("is-touring", enTournee);
  $("hero-eyebrow").textContent = enTournee ? "Dans le sac" : "À dropper";
  $("tour-btn-text").textContent = enTournee ? "Je suis rentré" : "Je pars poster";
  $("tour-btn-icon").firstElementChild.setAttribute("href", enTournee ? "#i-check" : "#i-truck");
  $("tour-banner").hidden = !enTournee;
  $("tour-cancel").hidden = !enTournee;

  renderTourSummary(enTournee ? null : tour.last);
  toursVus = true;

  const note = $("tour-banner-sub");
  note.hidden = !enTournee;
  if (!enTournee) {
    stopChrono();
    return;
  }

  // ce qu'on a emporte, et ce qui attend (arrive depuis, ou laisse a la maison)
  const sel = tour.selection || [];
  const avec = sel.length ? ` avec ${sel.slice(0, 4).join(", ")}${sel.length > 4 ? ` +${sel.length - 4}` : ""}` : "";
  const horsSac = tour.horsSacCount ?? tour.arrivedCount;
  note.textContent =
    `Parti à ${formatTourTime(tourStartedAt)}${avec}. ` +
    (horsSac > 0
      ? `${pluriel(horsSac, "autre colis attendra", "autres colis attendront")} la prochaine tournée (${euro(tour.horsSacValue ?? tour.arrivedValue)}).`
      : "Seuls les colis présents au départ peuvent être dropés.");

  startChrono(tourStartedAt);
}

// Resume de la derniere tournee, garde jusqu'a ce qu'on le ferme. Quand il
// apparait (on rentre de tournee), c'est la fete : etincelles et taux qui monte.
function renderTourSummary(last) {
  const box = $("tour-summary");
  if (!last) {
    box.hidden = true;
    return;
  }

  const seconds =
    last.seconds != null
      ? last.seconds
      : Math.max(0, Math.round((sqlDateToMs(last.endedAt) - sqlDateToMs(last.startedAt)) / 1000));

  $("tour-summary-title").textContent = `Tournée terminée en ${formatDuration(seconds)}`;
  $("tour-summary-sub").textContent =
    `${formatTourTime(last.startedAt)} → ${formatTourTime(last.endedAt)} · ` +
    `${pluriel(last.count, "colis dropé", "colis dropés")} · ${euro(last.value)}`;

  const smic = last.smicHourly || 9.4;
  const signature = `${last.endedAt}|${last.value}`;
  if (box.dataset.signature !== signature) {
    box.dataset.signature = signature;
    $("tour-rate").innerHTML = rateHtml(last.value, seconds, smic);
  }

  // deuxieme sortie du jour : on montre aussi le cumul, tournees additionnees
  const day = last.day;
  const dayEl = $("tour-day");
  const showDay = day && day.sessions > 1;
  dayEl.hidden = !showDay;
  if (showDay) {
    dayEl.textContent =
      `Aujourd'hui : ${day.sessions} sessions · ${formatDuration(day.seconds)} · ${euro(day.value)} · ` +
      `${euro(hourlyRate(day.value, day.seconds))}/h · ${formatSmic(hourlyRate(day.value, day.seconds) / smic)} le SMIC`;
  }
  if (montre(box) && toursVus) {
    const taux = box.querySelector(".tour-rate-hour [data-taux]");
    if (taux) compte(taux, hourlyRate(last.value, seconds), { format: euro, depuis: 0, delai: 300 });
    setTimeout(() => eclat(box.querySelector(".summary-icon"), { nombre: 18, force: 1.3 }), 250);
  }
}

function hourlyRate(value, seconds) {
  return seconds > 0 ? (value * 3600) / seconds : 0;
}

// "3,2×" : on garde une decimale sauf pour les tres gros multiples
function formatSmic(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1).replace(".", ",")}×`;
}

function rateHtml(value, seconds, smic) {
  const rate = hourlyRate(value, seconds);
  const ratio = smic > 0 ? rate / smic : 0;
  const under = ratio < 1;
  return (
    `<span class="tour-rate-hour"><span data-taux>${euro(rate)}</span><small>/h</small></span>` +
    `<span class="tour-rate-smic${under ? " under" : ""}">${formatSmic(ratio)} le SMIC</span>` +
    `<span class="tour-rate-ref">SMIC net ${euro(smic)}/h</span>`
  );
}

$("tour-summary-close").addEventListener("click", async () => {
  await masque($("tour-summary"));
  await fetch("/api/tour/dismiss-summary", { method: "POST" }).catch(() => {});
  renderCache.clear();
});

// --- Chrono de tournee ------------------------------------------------------------
let chronoTimer = null;

function startChrono(startedAt) {
  const el = $("tour-chrono");
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

$("tour-btn").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  // au retour, ce qu'on avait emporte est poste : on le marque drope et la
  // tournee se referme
  if (tourStartedAt) {
    const { count, value } = bagSummary;
    if (count === 0) return endTour(false, bouton);
    const ok = await confirmer({
      titre: "Tout est posté ?",
      message: `${pluriel(count, "colis sera marqué dropé", "colis seront marqués dropés")} · ${euro(value)}.`,
      action: "Oui, tout est dropé",
    });
    if (ok) endTour(true, bouton);
    return;
  }

  // au depart : on choisit ce qu'on emporte
  await choisirTournee(bouton);
});

// --- Choix de la tournee ---------------------------------------------------------
// Au depart, on coche les transporteurs qu'on va poster ; les speciaux et les
// LIT ont leur propre categorie : la toucher prend (ou laisse) tous ses
// transporteurs, chacun restant decochable. Seul ce qui est coche part dans
// le sac : compteurs, retour de tournee et suivi des expediteurs.
const choixTournee = { groupes: [], selection: new Set(), bouton: null };

async function choisirTournee(bouton) {
  let choix;
  try {
    occupe(bouton, true);
    choix = await fetchJSON("/api/tour/choix");
  } catch (err) {
    secoue(bouton);
    toast(err.message || "Connexion impossible", "error");
    return;
  } finally {
    occupe(bouton, false);
  }
  // rien en attente : on part quand meme, comme avant
  if (!choix.groupes.length) return partirEnTournee(bouton, null);

  choixTournee.groupes = choix.groupes;
  choixTournee.selection = new Set(choix.groupes.flatMap((g) => g.transporteurs.map((t) => t.cle)));
  choixTournee.bouton = bouton;
  rendChoixTournee({ premier: true });
  const couche = $("tour-sheet");
  couche.classList.remove("closing");
  couche.hidden = false;
  haptique();
  requestAnimationFrame(() => $("tour-partir").focus({ preventScroll: true }));
}

function fermeChoixTournee() {
  const couche = $("tour-sheet");
  if (couche.hidden) return;
  couche.classList.add("closing");
  setTimeout(() => {
    couche.hidden = true;
    couche.classList.remove("closing");
  }, prefersReducedMotion ? 0 : 260);
}

function rendChoixTournee({ premier = false } = {}) {
  const sel = choixTournee.selection;
  const puce = (t) => `
    <button class="tour-puce carrier" type="button" data-cle="${escapeAttr(t.cle)}" data-carrier="${escapeAttr(t.code)}" aria-pressed="${sel.has(t.cle)}">
      <i class="carrier-dot"></i><span>${escapeHtml(t.nom)}</span><b>${entier(t.count)}</b>
    </button>`;
  $("tour-groupes").innerHTML = choixTournee.groupes
    .map((g) => {
      const cles = g.transporteurs.map((t) => t.cle);
      const pris = cles.filter((c) => sel.has(c)).length;
      const etat = pris === 0 ? "false" : pris === cles.length ? "true" : "mixed";
      const total = g.transporteurs.reduce((n, t) => n + t.count, 0);
      const tete =
        g.id === "normal"
          ? `<div class="tour-groupe-nom">${escapeHtml(g.nom)}</div>`
          : `<button class="tour-categorie tour-categorie-${g.id}" type="button" data-groupe="${g.id}" aria-pressed="${etat}">
               <span class="tour-coche" aria-hidden="true">${ico(etat === "mixed" ? "minus" : "check")}</span>
               <span>${escapeHtml(g.nom)}</span><b>${entier(total)}</b>
             </button>`;
      return `<section class="tour-groupe${premier ? " is-new" : ""}">${tete}<div class="tour-choix">${g.transporteurs.map(puce).join("")}</div></section>`;
    })
    .join("");

  const tous = choixTournee.groupes.flatMap((g) => g.transporteurs);
  const pris = tous.filter((t) => sel.has(t.cle));
  const count = pris.reduce((n, t) => n + t.count, 0);
  const prets = pris.reduce((n, t) => n + t.prets, 0);
  const value = pris.reduce((n, t) => n + t.value, 0);
  $("tour-tout").textContent = pris.length === tous.length ? "Aucun" : "Tout";
  $("tour-resume").innerHTML = pris.length
    ? `<b>${pluriel(count, "colis", "colis")}</b> dans le sac · ${euro(value)}` +
      (count > prets ? `<span class="tour-resume-note">${pluriel(count - prets, "pas encore imprimé restera", "pas encore imprimés resteront")} en attente</span>` : "")
    : "Choisis au moins un transporteur.";
  $("tour-partir").disabled = pris.length === 0;
}

$("tour-groupes").addEventListener("click", (e) => {
  const puce = e.target.closest(".tour-puce");
  const categorie = e.target.closest(".tour-categorie");
  const sel = choixTournee.selection;
  if (puce) {
    const cle = puce.dataset.cle;
    if (sel.has(cle)) sel.delete(cle);
    else sel.add(cle);
  } else if (categorie) {
    const groupe = choixTournee.groupes.find((g) => g.id === categorie.dataset.groupe);
    const cles = groupe.transporteurs.map((t) => t.cle);
    const tousPris = cles.every((c) => sel.has(c));
    for (const c of cles) tousPris ? sel.delete(c) : sel.add(c);
  } else {
    return;
  }
  haptique();
  rendChoixTournee();
});

$("tour-tout").addEventListener("click", () => {
  const tous = choixTournee.groupes.flatMap((g) => g.transporteurs.map((t) => t.cle));
  choixTournee.selection = new Set(choixTournee.selection.size === tous.length ? [] : tous);
  haptique();
  rendChoixTournee();
});

$("tour-sheet").addEventListener("click", (e) => {
  if (e.target.closest("[data-tour-fermer]")) fermeChoixTournee();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") fermeChoixTournee();
});

$("tour-partir").addEventListener("click", async () => {
  const selection = [...choixTournee.selection];
  if (!selection.length) return;
  fermeChoixTournee();
  await partirEnTournee(choixTournee.bouton, selection);
});

// `selection` : les cles cochees (null : tout)
async function partirEnTournee(bouton, selection) {
  await agir(
    bouton,
    async () => {
      const r = await postJSON("/api/tour/start", selection ? { selection } : {});
      renderCache.clear();
      await refreshAll();
      return r;
    },
    {
      succes: (r) => `Bonne tournée ! ${pluriel(r?.count ?? bagSummary.count, "colis", "colis")} dans le sac.`,
      eclats: { nombre: 14 },
    }
  );
}

// drop = true : le sac est drope. false : on referme sans rien dropper.
// La demande dit QUELLE tournee cet ecran montre : si elle est deja terminee
// (un autre appareil, ou refermee toute seule apres le dernier drop), le
// serveur refuse au lieu de dropper autre chose. L'ecran se remet a jour dans
// tous les cas.
async function endTour(drop, bouton) {
  await agir(
    bouton,
    async () => {
      try {
        return await postJSON(drop ? "/api/tour/finish" : "/api/tour/end", { startedAt: tourStartedAt });
      } finally {
        renderCache.clear();
        await refreshAll().catch(() => {});
      }
    },
    {
      // seuls les colis imprimes partent : le reste attend la prochaine fois
      succes: drop ? (r) => messageDrop(r, ` · ${euro(r.value)}`) : "Tournée annulée",
      eclats: drop ? { nombre: 22, force: 1.4 } : false,
    }
  );
}

$("tour-cancel").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  const ok = await confirmer({
    titre: "Annuler la tournée ?",
    message: "Rien ne sera dropé : les colis restent en attente.",
    action: "Annuler la tournée",
    retour: "Continuer",
    danger: true,
  });
  if (ok) endTour(false, bouton);
});

// --- Anneau ---------------------------------------------------------------------
// Les parts se dessinent l'une apres l'autre, comme un trait qui fait le tour,
// pendant que l'anneau finit de tourner. Toucher une part (ou sa ligne de
// legende) la fait ressortir, et le centre affiche son montant.

const DONUT = { taille: 220, rayon: 86, epaisseur: 20 };

function donutSVG(items, { animate, total, label, format, uid }) {
  const { taille, rayon, epaisseur } = DONUT;
  const cx = taille / 2;
  const cy = taille / 2;
  const circonference = 2 * Math.PI * rayon;
  let offset = 0;
  const segments = items
    .map((it, i) => {
      const frac = it.value / total;
      const len = frac * circonference;
      const gap = items.length > 1 ? 3 : 0;
      const plein = Math.max(len - gap, 0.01);
      const couleur = CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length];
      const seg = `<circle class="donut-seg" data-i="${i}" data-plein="${plein}" data-debut="${offset / circonference}" data-frac="${frac}"
        style="--seg:${couleur}" cx="${cx}" cy="${cy}" r="${rayon}" fill="none" stroke="${couleur}"
        stroke-width="${epaisseur}" stroke-dasharray="${animate ? `0 ${circonference}` : `${plein} ${circonference}`}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 ${cx} ${cy})"><title>${escapeHtml(it.name)} : ${format(it.value)} (${Math.round(frac * 100)} %)</title></circle>`;
      offset += len;
      return seg;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${taille} ${taille}" class="donut-svg" role="img" aria-label="${escapeAttr(label)} : ${escapeAttr(format(total))}">
      <defs>
        <radialGradient id="creux${uid}">
          <stop offset="0.6" stop-color="#9162ff" stop-opacity="0.12"/>
          <stop offset="1" stop-color="#9162ff" stop-opacity="0"/>
        </radialGradient>
        <filter id="lueur-anneau${uid}" filterUnits="userSpaceOnUse" x="-60" y="-60" width="${taille + 120}" height="${taille + 120}">
          <feGaussianBlur stdDeviation="5" result="flou"/>
          <feMerge><feMergeNode in="flou"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="${rayon - epaisseur}" fill="url(#creux${uid})"/>
      <g class="donut-anneau" filter="url(#lueur-anneau${uid})">
        <circle class="donut-track" cx="${cx}" cy="${cy}" r="${rayon}" fill="none" stroke-width="${epaisseur}"/>
        ${segments}
      </g>
      <text x="${cx}" y="${cy + 2}" text-anchor="middle" class="donut-total-value" data-donut-total>${animate ? format(0) : format(total)}</text>
      <text x="${cx}" y="${cy + 24}" text-anchor="middle" class="donut-total-label" data-donut-label>${escapeHtml(label)}</text>
    </svg>`;
}

function donutLegend(items, { animate, total, format }) {
  return `<div class="donut-legend">${items
    .map((it, i) => {
      const frac = total ? it.value / total : 0;
      const pct = Math.round(frac * 100);
      const color = CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length];
      return `
      <div class="donut-legend-item${animate ? " cache" : ""}" data-i="${i}">
        <span class="donut-swatch" style="background:${color};box-shadow:0 0 10px ${color}"></span>
        <div class="donut-legend-main">
          <div class="donut-legend-top">
            <span class="donut-legend-name">${escapeHtml(it.name)}</span>
            <span class="donut-legend-value" data-legend-value="${it.value}">${animate ? format(0) : format(it.value)}</span>
          </div>
          <div class="donut-legend-bar"><div class="donut-legend-bar-fill${animate ? " paused" : ""}" style="--w:${frac.toFixed(4)};background:${color}"></div></div>
        </div>
        <span class="donut-legend-pct" data-legend-pct="${pct}">${animate ? "0 %" : `${pct} %`}</span>
      </div>`;
    })
    .join("")}</div>`;
}

let donutUid = 0;

function renderDonutInto(el, items, { animate, label, format, riche = true }) {
  const total = items.reduce((sum, it) => sum + it.value, 0);
  if (!el) return;
  if (items.length === 0 || total <= 0) {
    el.innerHTML = `<div class="chart-empty">Pas encore de données</div>`;
    return;
  }
  const uid = donutUid++;
  el._donut = { items, total, label, format };
  el.innerHTML = `<div class="donut-layout">${donutSVG(items, { animate, total, label, format, uid })}${donutLegend(items, {
    animate,
    total,
    format,
  })}</div>`;
  if (animate && !prefersReducedMotion) revealOnVisible(el.closest(".card"), () => balayeDonut(el, riche ? 1500 : 800));
}

// Les parts se tracent une fois, dans le sens des aiguilles d'une montre,
// depuis midi. L'anneau ne tourne plus sur lui-meme : avec le trace, ca
// donnait l'impression d'une petite boucle.
function balayeDonut(el, duree) {
  const { total, format } = el._donut;
  const segs = [...el.querySelectorAll(".donut-seg")];
  const legendes = [...el.querySelectorAll(".donut-legend-item")];
  const anneau = el.querySelector(".donut-anneau");
  const circonference = 2 * Math.PI * DONUT.rayon;
  // un seul balayage a la fois : le precedent s'arrete net
  const jeton = (el._balayage = (el._balayage || 0) + 1);
  anneau.getAnimations().forEach((a) => a.cancel());
  anneau.animate(
    [
      { transform: "scale(0.9)", opacity: 0.35 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: duree, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
  );
  animateNumberText(el.querySelector("[data-donut-total]"), total, format, duree + 200);
  const montrees = new Set();
  const t0 = performance.now();
  const pas = (now) => {
    if (el._balayage !== jeton) return;
    const p = easeInOutCubic(Math.min((now - t0) / duree, 1));
    segs.forEach((seg, i) => {
      const debut = Number(seg.dataset.debut);
      const frac = Number(seg.dataset.frac);
      const local = Math.max(0, Math.min(1, (p - debut) / frac));
      seg.setAttribute("stroke-dasharray", `${Number(seg.dataset.plein) * local} ${circonference}`);
      if (local > 0 && !montrees.has(i)) {
        montrees.add(i);
        const ligne = legendes[i];
        if (!ligne) return;
        ligne.classList.remove("cache");
        const barre = ligne.querySelector(".donut-legend-bar-fill");
        barre.classList.add("reveal");
        void barre.offsetWidth;
        barre.classList.remove("paused");
        animateNumberText(ligne.querySelector("[data-legend-value]"), Number(ligne.querySelector("[data-legend-value]").dataset.legendValue), format, 900);
        animateNumberText(ligne.querySelector("[data-legend-pct]"), Number(ligne.querySelector("[data-legend-pct]").dataset.legendPct), (v) => `${Math.round(v)} %`, 900);
      }
    });
    if (p < 1 && el._balayage === jeton) requestAnimationFrame(pas);
  };
  requestAnimationFrame(pas);
}

// une part mise en avant : les autres s'effacent, le centre dit son montant
function focusDonut(wrap, i) {
  const layout = wrap.querySelector(".donut-layout");
  const d = wrap._donut;
  if (!layout || !d) return;
  const actuel = layout.dataset.focus;
  const nouveau = i === null || String(i) === actuel ? null : String(i);
  layout.classList.toggle("has-focus", nouveau !== null);
  layout.dataset.focus = nouveau ?? "";
  layout.querySelectorAll(".donut-seg, .donut-legend-item").forEach((n) => n.classList.toggle("is-focus", n.dataset.i === nouveau));
  const valeur = wrap.querySelector("[data-donut-total]");
  const libelle = wrap.querySelector("[data-donut-label]");
  if (nouveau === null) {
    valeur.textContent = d.format(d.total);
    libelle.textContent = d.label;
  } else {
    const it = d.items[Number(nouveau)];
    valeur.textContent = d.format(it.value);
    libelle.textContent = it.name.length > 14 ? `${it.name.slice(0, 13)}…` : it.name;
    haptique();
  }
}

for (const id of ["donut-sender", "suivi-donut"]) {
  const wrap = $(id);
  wrap.addEventListener("click", (e) => {
    const cible = e.target.closest("[data-i]");
    focusDonut(wrap, cible ? Number(cible.dataset.i) : null);
  });
  if (avecSouris) {
    wrap.addEventListener("pointerover", (e) => {
      const cible = e.target.closest("[data-i]");
      if (!cible) return;
      const layout = wrap.querySelector(".donut-layout");
      if (layout?.dataset.focus !== cible.dataset.i) focusDonut(wrap, Number(cible.dataset.i));
    });
    wrap.addEventListener("pointerleave", () => {
      const layout = wrap.querySelector(".donut-layout");
      if (layout?.dataset.focus) focusDonut(wrap, null);
    });
  }
}

function renderDonut(bySender, animate, riche) {
  const items = bySender
    .map((s) => ({ name: s.sender_name, value: s.dropped_value }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  renderDonutInto($("donut-sender"), items, { animate, label: "total", format: euroCompact, riche });
}

// --- Historique ------------------------------------------------------------------
// Tout en bas du dashboard : ce qui est arrive aux colis (recus, dropes,
// imprimes, retires, modifies), du plus recent au plus ancien, groupe par jour.
// Rafraichi avec le reste du dashboard ; une nouvelle ligne arrive animee.
const journalEtat = { filtre: "", entrees: [], suite: false, dernierId: 0, charge: false };

const ICONES_JOURNAL = {
  recu: "i-logo",
  ajout: "i-plus",
  drop: "i-send",
  impression: "i-printer",
  retrait: "i-trash",
  modif: "i-edit",
  note: "i-note",
  stock: "i-package",
  tournee: "i-truck",
  paiement: "i-check",
  expediteur: "i-star",
  reglage: "i-settings",
  fusion: "i-copy",
};
const SOURCES_JOURNAL = { telegram: "Telegram", site: "Site", app: "App", imprimante: "Impression auto" };

const dateServeur = (s) => new Date(`${String(s).replace(" ", "T")}Z`);
const jourCle = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function libelleJour(d) {
  const aujourdhuiD = new Date();
  const hier = new Date(aujourdhuiD);
  hier.setDate(hier.getDate() - 1);
  if (jourCle(d) === jourCle(aujourdhuiD)) return "Aujourd'hui";
  if (jourCle(d) === jourCle(hier)) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

function ligneJournal(e, nouvelle) {
  const d = dateServeur(e.at);
  const annule = e.kind === "drop" && /^Drop annulé/.test(e.texte);
  const icone = annule ? "i-refresh" : ICONES_JOURNAL[e.kind] || "i-info";
  const valeur = e.valeur != null && e.valeur !== 0 ? `<span class="journal-valeur">${euro(e.valeur)}</span>` : "";
  const heure = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `
    <div class="journal-ligne k-${escapeAttr(e.kind)}${annule ? " annule" : ""}${nouvelle ? " is-new" : ""}" data-id="${e.id}">
      <span class="journal-icone"><svg class="icon"><use href="#${icone}"/></svg></span>
      <div class="journal-texte">
        <span class="journal-titre">${escapeHtml(e.texte)}</span>
        ${e.detail ? `<span class="journal-detail">${escapeHtml(e.detail)}</span>` : ""}
      </div>
      <div class="journal-droite">
        ${valeur}
        <span class="journal-meta">${heure}${e.source ? ` · ${escapeHtml(SOURCES_JOURNAL[e.source] || e.source)}` : ""}</span>
      </div>
    </div>`;
}

function rendJournal(nouveaux = new Set()) {
  const liste = $("journal-liste");
  if (!liste) return;
  if (journalEtat.entrees.length === 0) {
    liste.innerHTML = `<div class="journal-vide">${journalEtat.charge ? "Rien pour l'instant." : "Chargement…"}</div>`;
  } else {
    let jour = null;
    let html = "";
    for (const e of journalEtat.entrees) {
      const d = dateServeur(e.at);
      if (jourCle(d) !== jour) {
        jour = jourCle(d);
        html += `<div class="journal-jour">${escapeHtml(libelleJour(d))}</div>`;
      }
      html += ligneJournal(e, nouveaux.has(e.id));
    }
    liste.innerHTML = html;
  }
  $("journal-plus").hidden = !journalEtat.suite;
}

// La premiere page, ou ce qui est arrive depuis : rien n'est reecrit tant que
// le journal n'a pas bouge.
async function loadJournal() {
  const filtre = journalEtat.filtre;
  const r = await fetchJSON(`/api/journal?limite=30${filtre ? `&filtre=${filtre}` : ""}`);
  if (filtre !== journalEtat.filtre) return; // un autre filtre a ete choisi entre-temps
  const premier = r.entrees[0]?.id || 0;
  if (journalEtat.charge && premier === journalEtat.dernierId && journalEtat.entrees.length >= r.entrees.length) return;
  const connus = new Set(journalEtat.entrees.map((e) => e.id));
  const nouveaux = journalEtat.charge ? new Set(r.entrees.filter((e) => !connus.has(e.id)).map((e) => e.id)) : new Set();
  // les lignes deja chargees au-dela de la premiere page restent
  const suiteChargee = journalEtat.entrees.filter((e) => !r.entrees.some((n) => n.id === e.id) && e.id < (r.entrees.at(-1)?.id || 0));
  journalEtat.entrees = [...r.entrees, ...suiteChargee];
  journalEtat.suite = suiteChargee.length ? journalEtat.suite : r.suite;
  journalEtat.dernierId = premier;
  journalEtat.charge = true;
  rendJournal(nouveaux);
}

$("journal-plus").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  const avant = journalEtat.entrees.at(-1)?.id;
  if (!avant) return;
  await agir(bouton, async () => {
    const filtre = journalEtat.filtre;
    const r = await fetchJSON(`/api/journal?limite=40&avant=${avant}${filtre ? `&filtre=${filtre}` : ""}`);
    journalEtat.entrees = [...journalEtat.entrees, ...r.entrees];
    journalEtat.suite = r.suite;
    rendJournal(new Set(r.entrees.map((x) => x.id)));
  });
});

// Sur le dashboard, l'historique n'est plus qu'un bouton : il dit le dernier
// evenement ("3 colis reçus · il y a 5 min") et ouvre la page entiere.
let dernierEvenementCharge = 0;
async function loadDernierEvenement() {
  if (Date.now() - dernierEvenementCharge < 10000) return;
  dernierEvenementCharge = Date.now();
  try {
    const r = await fetchJSON("/api/journal?limite=1", {}, { essais: 1 });
    const e = r.entrees[0];
    const sous = $("historique-link-sub");
    if (!e) {
      sous.textContent = "Rien pour l'instant";
      return;
    }
    const d = dateServeur(e.at);
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    const quand =
      min < 1 ? "à l'instant" : min < 60 ? `il y a ${min} min` : jourCle(d) === jourCle(new Date()) ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : libelleJour(d);
    sous.textContent = `${e.texte} · ${quand}`;
  } catch {
    /* le bouton garde son texte */
  }
}

$("historique-link").addEventListener("click", () => switchView("historique"));
$("historique-back").addEventListener("click", () => switchView("dashboard"));

// les filtres de CETTE carte seulement (d'autres pages ont les memes boutons)
$("journal").querySelector(".journal-filtres").addEventListener("click", (e) => {
  const bouton = e.target.closest(".journal-filtre");
  if (!bouton || bouton.classList.contains("active")) return;
  $("journal").querySelectorAll(".journal-filtre").forEach((b) => {
    const actif = b === bouton;
    b.classList.toggle("active", actif);
    b.setAttribute("aria-selected", String(actif));
  });
  haptique();
  Object.assign(journalEtat, { filtre: bouton.dataset.filtre, entrees: [], suite: false, dernierId: 0, charge: false });
  rendJournal();
  loadJournal().catch(() => {});
});

