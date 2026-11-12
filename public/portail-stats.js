// ============================================================================
// L'espace expediteur : ses stats. Le nombre de colis postes -- jamais
// d'argent : par jour (une courbe qui se dessine), par semaine et par mois
// (des barres qui montent), les meilleures journees, les transporteurs.
//
// Les graphiques reprennent ceux des stats du dashboard (40-graphiques.js) :
// memes courbes, memes revelations, memes classes CSS (styles.css) -- mais
// des nombres de colis, et rien du dashboard n'est charge ici.
// ============================================================================
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const jeton = location.pathname.split("/").filter(Boolean).pop() || "";
  const reduit = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nf = new Intl.NumberFormat("fr-FR");
  const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
  const pluriel = (n, un, plusieurs) => `${nf.format(n)} ${n > 1 ? plusieurs : un}`;
  const RAFRAICHISSEMENT_MS = 60000;
  const CONNUS = new Set(["MR", "LP", "CHRONO", "UPS", "DPD", "GLS", "DHL"]);

  const etat = { donnees: null, etag: null, ouverte: false, visites: 0, minuteur: null, enCours: false };

  // --- Petits outils ---------------------------------------------------------------
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
  const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOutBack = (p, s = 1.5) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);
  const nombre = (v) => nf.format(Math.round(v));
  const jourDe = (d) => new Date(`${d}T12:00:00Z`);
  const jourCourt = (d) => jourDe(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
  const jourLong = (d) => {
    const t = jourDe(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const JOURS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const moisDe = (m) => new Date(`${m}-15T12:00:00Z`);
  const moisCourt = (m, avecAnnee) => {
    const d = moisDe(m);
    const t = d.toLocaleDateString("fr-FR", { month: "short", timeZone: "UTC" });
    return avecAnnee ? `${t} ${String(d.getUTCFullYear()).slice(2)}` : t;
  };
  const moisLong = (m) => moisDe(m).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });

  // Un compteur qui roule jusqu'a sa valeur (et s'allume pendant qu'il compte).
  function compte(el, cible, { delai = 0, format = nombre, duree = 1100 } = {}) {
    if (!el) return;
    cancelAnimationFrame(el._raf);
    clearTimeout(el._attente);
    if (reduit || !cible) {
      el.textContent = format(cible || 0);
      return;
    }
    el.textContent = format(0);
    el._attente = setTimeout(() => {
      el.classList.add("is-counting");
      const t0 = performance.now();
      const pas = (now) => {
        const p = Math.min((now - t0) / duree, 1);
        el.textContent = format(cible * easeOutCubic(p));
        if (p < 1) el._raf = requestAnimationFrame(pas);
        else {
          el.textContent = format(cible);
          el.classList.remove("is-counting");
        }
      };
      el._raf = requestAnimationFrame(pas);
    }, delai);
  }

  function compteTexte(el, cible, duree = 700) {
    if (reduit) {
      el.textContent = nombre(cible);
      return;
    }
    const t0 = performance.now();
    const pas = (now) => {
      const p = Math.min((now - t0) / duree, 1);
      el.textContent = nombre(cible * easeOutCubic(p));
      if (p < 1) requestAnimationFrame(pas);
    };
    requestAnimationFrame(pas);
  }

  // --- La courbe (comme celle des revenus du dashboard) -------------------------------
  let uidGraphe = 0;
  const ESPACEMENT = 72;
  const MARGE = 36;
  const HAUTEUR = 230;

  function echantillons(points, plancher, parSegment = 18) {
    if (!points.length) return [];
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

  function cheminLisse(points, plancher) {
    if (!points.length) return "";
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

  function grille(W, haut, plotH) {
    return [0.25, 0.5, 0.75, 1]
      .map((f) => `<line class="chart-grid-line" x1="0" y1="${haut + plotH * (1 - f) * 0.9 + plotH * 0.1}" x2="${W}" y2="${haut + plotH * (1 - f) * 0.9 + plotH * 0.1}" />`)
      .join("");
  }

  const echappe = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function courbeSVG(items, { anime, ecart }) {
    const H = HAUTEUR, haut = 38, bas = 38;
    const plotH = H - haut - bas;
    const baseY = H - bas;
    const W = Math.max(MARGE * 2 + (items.length - 1) * ecart, 320);
    const max = Math.max(...items.map((i) => i.value), 1);
    const record = items.reduce((m, it, i) => (it.value > items[m].value ? i : m), 0);
    const uid = uidGraphe++;
    const points = items.map((it, i) => ({ x: MARGE + i * ecart, y: baseY - (it.value / max) * plotH * 0.9 }));
    const cache = anime ? " cache" : "";
    const ronds = items
      .map((it, i) => {
        const best = i === record && it.value > 0;
        return `<circle class="chart-dot${best ? " best" : ""}${cache}" cx="${points[i].x}" cy="${points[i].y}" r="${best ? 6 : 4}"><title>${echappe(it.titre)} : ${pluriel(it.value, "colis", "colis")}</title></circle>`;
      })
      .join("");
    const etiquettes = items
      .map((it, i) => {
        const best = i === record && it.value > 0;
        const p = points[i];
        return `<text class="chart-value-label${it.value > 0 ? "" : " is-zero"}${best ? " is-best" : ""}${cache}" data-target="${it.value}" x="${p.x}" y="${p.y - 14}" text-anchor="middle">${it.value > 0 ? (anime ? "0" : nombre(it.value)) : "—"}</text>
        <text class="chart-axis-label" x="${p.x}" y="${H - 12}" text-anchor="middle">${echappe(it.label)}</text>`;
      })
      .join("");
    const dernier = points[points.length - 1];
    const html = `
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <defs>
          <linearGradient id="pl${uid}" x1="0" y1="0" x2="${W}" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#6e40f0"/><stop offset="0.6" stop-color="#9162ff"/><stop offset="1" stop-color="#ded0ff"/>
          </linearGradient>
          <linearGradient id="pa${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#9162ff" stop-opacity="0.48"/><stop offset="1" stop-color="#9162ff" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="ps${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#c4aaff" stop-opacity="0"/><stop offset="0.55" stop-color="#c4aaff" stop-opacity="0.75"/><stop offset="1" stop-color="#c4aaff" stop-opacity="0"/>
          </linearGradient>
          <radialGradient id="ph${uid}"><stop offset="0" stop-color="#ded0ff" stop-opacity="0.9"/><stop offset="1" stop-color="#9162ff" stop-opacity="0"/></radialGradient>
          <filter id="pf${uid}" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}">
            <feGaussianBlur stdDeviation="4" result="flou"/><feMerge><feMergeNode in="flou"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <clipPath id="pc${uid}"><rect data-clip x="0" y="-20" width="${anime ? 0 : W}" height="${H + 40}"/></clipPath>
        </defs>
        ${grille(W, haut, plotH)}
        <g clip-path="url(#pc${uid})">
          <path d="${cheminLisse(points, baseY)} L ${dernier.x} ${baseY} L ${points[0].x} ${baseY} Z" fill="url(#pa${uid})"/>
          <path class="chart-line" d="${cheminLisse(points, baseY)}" fill="none" stroke="url(#pl${uid})" filter="url(#pf${uid})"/>
        </g>
        ${anime ? "" : `<circle class="chart-pulse" cx="${dernier.x}" cy="${dernier.y}" r="6"/>`}
        ${ronds}
        ${etiquettes}
        <g data-tete opacity="0">
          <line data-scan x1="0" x2="0" y1="${haut - 10}" y2="${baseY}" stroke="url(#ps${uid})" stroke-width="1.5"/>
          <circle r="20" fill="url(#ph${uid})"/>
          <circle class="chart-head" r="4.5"/>
        </g>
      </svg>`;
    return { html, points, baseY, W, ech: echantillons(points, baseY) };
  }

  // la tete lumineuse court sur la courbe, les points eclosent a son passage
  function revelationCourbe(piste, geo, { duree = 1900 } = {}) {
    const svg = piste.querySelector("svg");
    if (!svg) return;
    const clip = svg.querySelector("[data-clip]");
    const tete = svg.querySelector("[data-tete]");
    const scan = svg.querySelector("[data-scan]");
    const ronds = [...svg.querySelectorAll(".chart-dot")];
    const etiquettes = [...svg.querySelectorAll(".chart-value-label[data-target]")];
    const { points, W } = geo;
    const montre = (i, anime) => {
      if (!ronds[i].classList.contains("cache")) return;
      ronds[i].classList.remove("cache");
      etiquettes[i].classList.remove("cache");
      const cible = Number(etiquettes[i].dataset.target);
      if (!anime) {
        if (cible > 0) etiquettes[i].textContent = nombre(cible);
        return;
      }
      ronds[i].classList.add("pop");
      etiquettes[i].classList.add("pop");
      if (cible > 0) compteTexte(etiquettes[i], cible);
    };
    const fin = () => {
      clip.setAttribute("width", W);
      points.forEach((_, i) => montre(i, false));
      const d = points[points.length - 1];
      const pouls = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      pouls.setAttribute("class", "chart-pulse");
      pouls.setAttribute("cx", d.x);
      pouls.setAttribute("cy", d.y);
      pouls.setAttribute("r", 6);
      svg.insertBefore(pouls, ronds[0]);
      tete.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: "forwards" });
    };
    if (reduit) return fin();
    const x0 = Math.max(0, (piste.closest(".chart-scroll")?.scrollLeft || 0) - 12);
    points.forEach((p, i) => p.x < x0 && montre(i, false));
    const ech = geo.ech;
    const yA = (x) => {
      let b = 0;
      let h = ech.length - 1;
      while (h - b > 1) {
        const m = (b + h) >> 1;
        if (ech[m].x < x) b = m;
        else h = m;
      }
      const f = ech[h].x === ech[b].x ? 0 : (x - ech[b].x) / (ech[h].x - ech[b].x);
      return ech[b].y + (ech[h].y - ech[b].y) * Math.max(0, Math.min(1, f));
    };
    tete.setAttribute("opacity", "1");
    const t0 = performance.now();
    const pas = (now) => {
      const p = Math.min((now - t0) / duree, 1);
      const hx = x0 + (W - x0) * easeInOutCubic(p);
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

  // --- Les barres (semaines, mois) -------------------------------------------------------
  function barresSVG(items, { anime, ecart }) {
    const H = HAUTEUR, haut = 38, bas = 38;
    const plotH = H - haut - bas;
    const baseY = H - bas;
    const largeurBarre = Math.min(ecart * 0.46, 34);
    const W = Math.max(MARGE * 2 + (items.length - 1) * ecart, 320);
    const max = Math.max(...items.map((i) => i.value), 1);
    const record = items.reduce((m, it, i) => (it.value > items[m].value ? i : m), 0);
    const uid = uidGraphe++;
    const barres = items.map((it, i) => ({
      x: MARGE + i * ecart,
      h: Math.max((it.value / max) * plotH * 0.9, it.value > 0 ? 4 : 0),
      best: i === record && it.value > 0,
    }));
    const rects = barres
      .map((b, i) => {
        const h0 = anime ? 0 : Math.max(b.h, 1);
        return `<rect class="chart-bar" data-bar x="${b.x - largeurBarre / 2}" y="${baseY - h0}" width="${largeurBarre}" height="${h0}" rx="8"
          fill="url(#${b.best ? "pbt" : "pb"}${uid})" ${b.best ? `filter="url(#pbl${uid})"` : ""}><title>${echappe(items[i].titre)} : ${pluriel(items[i].value, "colis", "colis")}</title></rect>
          <rect class="chart-bar-cap" data-cap x="${b.x - largeurBarre / 2}" y="${baseY - h0 - 3}" width="${largeurBarre}" height="7" rx="3.5" filter="url(#pbc${uid})"/>`;
      })
      .join("");
    const etiquettes = items
      .map((it, i) => {
        const b = barres[i];
        const h0 = anime ? 0 : Math.max(b.h, 1);
        return `<text class="chart-value-label${it.value > 0 ? "" : " is-zero"}${b.best ? " is-best" : ""}${anime ? " cache" : ""}" data-target="${it.value}" x="${b.x}" y="${baseY - h0 - 12}" text-anchor="middle">${it.value > 0 ? (anime ? "0" : nombre(it.value)) : "—"}</text>
        <text class="chart-axis-label" x="${b.x}" y="${H - 12}" text-anchor="middle">${echappe(it.label)}</text>`;
      })
      .join("");
    const html = `
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <defs>
          <linearGradient id="pb${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#aa84ff" stop-opacity="0.55"/><stop offset="1" stop-color="#522cc4" stop-opacity="0.18"/></linearGradient>
          <linearGradient id="pbt${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ded0ff"/><stop offset="0.5" stop-color="#9162ff"/><stop offset="1" stop-color="#6e40f0"/></linearGradient>
          <filter id="pbl${uid}" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}">
            <feGaussianBlur stdDeviation="6" result="flou"/><feMerge><feMergeNode in="flou"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="pbc${uid}" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}"><feGaussianBlur stdDeviation="3.5"/></filter>
        </defs>
        ${grille(W, haut, plotH)}
        ${rects}
        ${etiquettes}
      </svg>`;
    return { html, barres, baseY };
  }

  // les barres montent l'une apres l'autre, depassent un peu et se posent
  function revelationBarres(piste, geo, { duree = 1100, ecart = 75 } = {}) {
    const { barres, baseY } = geo;
    const rects = piste.querySelectorAll("[data-bar]");
    const caps = piste.querySelectorAll("[data-cap]");
    const etiquettes = piste.querySelectorAll(".chart-value-label[data-target]");
    if (!rects.length) return;
    const posees = new Array(barres.length).fill(false);
    const pose = (i, e, p) => {
      if (posees[i]) return;
      if (p >= 1) posees[i] = true;
      const h = Math.max(barres[i].h * e, 0);
      rects[i].setAttribute("height", h);
      rects[i].setAttribute("y", baseY - h);
      caps[i].setAttribute("y", baseY - h - 3);
      caps[i].style.opacity = String(p < 1 ? Math.sin(p * Math.PI) * 0.95 : 0);
      etiquettes[i].setAttribute("y", baseY - h - 12);
    };
    const etiquette = (i) => {
      const e = etiquettes[i];
      if (!e.classList.contains("cache")) return;
      e.classList.remove("cache");
      e.classList.add("pop");
      const cible = Number(e.dataset.target);
      if (cible > 0) compteTexte(e, cible, 650);
    };
    if (reduit) {
      barres.forEach((_, i) => {
        pose(i, 1, 1);
        etiquette(i);
      });
      return;
    }
    const conteneur = piste.closest(".chart-scroll");
    const premiere = Math.max(0, Math.floor(((conteneur?.scrollLeft || 0) - MARGE) / (conteneur?._ecart || ESPACEMENT)));
    const t0 = performance.now();
    const pas = (now) => {
      let fini = true;
      barres.forEach((_, i) => {
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

  // --- Defilement des graphiques ------------------------------------------------------------
  // peu de points sur un grand ecran : on les ecarte ; beaucoup : on defile
  function ecartPour(conteneur, n) {
    const largeur = conteneur.clientWidth;
    if (!largeur || n < 2) return ESPACEMENT;
    return Math.min(Math.max(ESPACEMENT, (largeur - MARGE * 2) / (n - 1)), ESPACEMENT * 2.2);
  }

  function visibles(conteneur, n) {
    const pas = conteneur._ecart || ESPACEMENT;
    const a = Math.min(n - 1, Math.max(0, Math.ceil((conteneur.scrollLeft - MARGE) / pas - 0.001)));
    const b = Math.min(n - 1, Math.floor((conteneur.scrollLeft + conteneur.clientWidth - MARGE) / pas + 0.001));
    return [a, Math.max(a, b)];
  }

  // la plage affichee suit le glisser ; le toucher horizontal ne bloque
  // jamais le defilement vertical de la page
  function suisPlage(conteneur, plageEl, texte) {
    if (conteneur._suivi) return;
    conteneur._suivi = true;
    let attente = false;
    conteneur.addEventListener(
      "scroll",
      () => {
        if (attente) return;
        attente = true;
        requestAnimationFrame(() => {
          const [a, b] = visibles(conteneur, conteneur._items.length);
          plageEl.textContent = texte(conteneur._items[a], conteneur._items[b]);
          attente = false;
        });
      },
      { passive: true }
    );
    const touche = () => (conteneur.dataset.touche = "1");
    conteneur.addEventListener("pointerdown", touche, { passive: true });
    conteneur.addEventListener("wheel", touche, { passive: true });
    let e = null;
    conteneur.addEventListener(
      "touchstart",
      (ev) => {
        const t = ev.touches[0];
        e = { x: t.clientX, y: t.clientY, depart: conteneur.scrollLeft, sens: null };
      },
      { passive: true }
    );
    conteneur.addEventListener(
      "touchmove",
      (ev) => {
        if (!e) return;
        const t = ev.touches[0];
        const dx = t.clientX - e.x;
        const dy = t.clientY - e.y;
        if (!e.sens) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          e.sens = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
          if (e.sens === "x") touche();
        }
        if (e.sens === "x") {
          ev.preventDefault();
          conteneur.scrollLeft = e.depart - dx;
        }
      },
      { passive: false }
    );
    conteneur.addEventListener("touchend", () => (e = null), { passive: true });
  }

  // ne se revele qu'une fois vraiment a l'ecran
  function quandVisible(el, lance) {
    el._observe?.disconnect();
    if (!el || reduit || !("IntersectionObserver" in window)) return lance();
    const io = new IntersectionObserver(
      (entrees) => {
        if (!entrees.some((x) => x.isIntersecting)) return;
        io.disconnect();
        el._observe = null;
        setTimeout(lance, 120);
      },
      { threshold: 0.3 }
    );
    el._observe = io;
    io.observe(el);
  }

  function graphe(id, plageId, items, { type, anime, riche, plage }) {
    const conteneur = $(id);
    const piste = conteneur.querySelector(".chart-track");
    const plageEl = $(plageId);
    if (!items.length || items.every((i) => !i.value)) {
      piste.innerHTML = `<div class="chart-empty">Pas encore de colis posté</div>`;
      plageEl.textContent = "—";
      return;
    }
    conteneur._items = items;
    conteneur._ecart = ecartPour(conteneur, items.length);
    const geo = type === "courbe" ? courbeSVG(items, { anime, ecart: conteneur._ecart }) : barresSVG(items, { anime, ecart: conteneur._ecart });
    piste.innerHTML = geo.html;
    if (conteneur.dataset.touche !== "1") conteneur.scrollLeft = conteneur.scrollWidth;
    if (anime) {
      if (type === "courbe") setTimeout(() => revelationCourbe(piste, geo, { duree: riche ? 2000 : 1100 }), riche ? 420 : 160);
      else quandVisible(conteneur.closest(".card"), () => revelationBarres(piste, geo, riche ? {} : { duree: 700, ecart: 40 }));
    }
    const [a, b] = visibles(conteneur, items.length);
    plageEl.textContent = plage(items[a], items[b]);
    suisPlage(conteneur, plageEl, plage);
  }

  // --- Le rendu -------------------------------------------------------------------------------
  function rend({ anime, riche }) {
    const d = etat.donnees;
    if (!d) return;
    $("st-resume").textContent = d.total
      ? `${pluriel(d.total, "colis posté", "colis postés")} depuis le ${jourCourt(d.premierJour)} · ${pluriel(d.joursActifs, "journée de dépôt", "journées de dépôt")}`
      : "Aucun colis posté pour l'instant : tes stats arrivent avec ton premier dépôt.";

    const record = d.meilleursJours[0];
    compte($("st-record"), record?.colis || 0, { delai: anime ? 200 : 0, format: (v) => (record ? pluriel(Math.round(v), "colis", "colis") : "—") });
    $("st-record-sub").textContent = record ? jourLong(record.date) : "Pas encore de colis posté";
    compte($("st-total"), d.total, { delai: anime ? 260 : 0 });
    $("st-total-sub").textContent = `${pluriel(d.ceMois, "colis", "colis")} ce mois-ci`;
    compte($("st-semaine"), d.cetteSemaine, { delai: anime ? 320 : 0 });
    const sub = $("st-semaine-sub");
    sub.replaceChildren();
    if (d.semainePassee == null) sub.textContent = `${pluriel(d.aujourdhui, "colis", "colis")} aujourd'hui`;
    else {
      sub.append(document.createTextNode(`semaine passée ${nf.format(d.semainePassee)}`));
      // la semaine en cours n'est pas finie : le pourcentage seulement une fois depassee
      if (d.semainePassee > 0 && d.cetteSemaine > d.semainePassee) {
        const up = document.createElement("span");
        up.className = "up";
        up.textContent = ` · +${Math.round(((d.cetteSemaine - d.semainePassee) / d.semainePassee) * 100)} %`;
        sub.append(up);
      }
    }
    compte($("st-moyenne"), d.moyenneParJour, { delai: anime ? 380 : 0, format: (v) => nf1.format(Math.round(v * 10) / 10) });
    $("st-moyenne-sub").textContent = d.meilleureSemaine?.colis ? `record : ${pluriel(d.meilleureSemaine.colis, "colis", "colis")} en une semaine` : "par jour de dépôt";

    graphe(
      "st-jours",
      "st-jours-plage",
      d.jours.map((j) => ({ value: j.colis, label: JOURS[jourDe(j.date).getUTCDay()], titre: jourLong(j.date), date: j.date })),
      { type: "courbe", anime, riche, plage: (a, b) => `${jourCourt(a.date)} – ${jourCourt(b.date)}` }
    );
    graphe(
      "st-semaines",
      "st-semaines-plage",
      d.semaines.map((s) => ({ value: s.colis, label: jourCourt(s.debut), titre: `Semaine du ${jourCourt(s.debut)}`, debut: s.debut, fin: s.fin })),
      { type: "barres", anime, riche, plage: (a, b) => `${jourCourt(a.debut)} – ${jourCourt(b.fin)}` }
    );
    graphe(
      "st-mois",
      "st-mois-plage",
      d.mois.map((m, i) => ({ value: m.colis, label: moisCourt(m.mois, i === 0 || m.mois.endsWith("-01")), titre: moisLong(m.mois), mois: m.mois })),
      { type: "barres", anime, riche, plage: (a, b) => (a.mois === b.mois ? moisLong(a.mois) : `${moisLong(a.mois)} – ${moisLong(b.mois)}`) }
    );
    rendPodium(d, anime);
    rendTransporteurs(d, anime);
  }

  // La page refuse les attributs style (sa politique de securite) : les
  // longueurs et les rangs passent par le DOM.
  function poseParts(racine) {
    racine.querySelectorAll("[data-part]").forEach((i) => i.style.setProperty("--part", i.dataset.part));
    racine.querySelectorAll("[data-i]").forEach((l) => l.style.setProperty("--i", l.dataset.i));
  }

  // Les meilleures journees : un podium, des barres qui se remplissent.
  function rendPodium(d, anime) {
    const liste = $("st-top");
    if (!d.meilleursJours.length) {
      liste.innerHTML = `<li class="p-podium-vide">Tes meilleures journées apparaîtront ici.</li>`;
      return;
    }
    const max = d.meilleursJours[0].colis || 1;
    liste.innerHTML = d.meilleursJours
      .map(
        (j, i) => `
      <li class="p-podium-ligne${i === 0 ? " is-premier" : ""}" data-i="${i}">
        <span class="p-podium-rang">${i + 1}</span>
        <span class="p-podium-texte">
          <span class="p-podium-jour">${echappe(jourLong(j.date))}</span>
          <span class="p-podium-barre"><i data-part="${(j.colis / max).toFixed(3)}"></i></span>
        </span>
        <b class="p-podium-n" data-n="${j.colis}">${anime ? "0" : nombre(j.colis)}</b>
      </li>`
      )
      .join("");
    poseParts(liste);
    liste.classList.remove("anime");
    if (anime && !reduit) {
      void liste.offsetWidth;
      quandVisible(liste.closest(".card"), () => {
        liste.classList.add("anime");
        liste.querySelectorAll(".p-podium-n").forEach((b, i) => setTimeout(() => compteTexte(b, Number(b.dataset.n), 800), 120 + i * 90));
      });
    } else liste.classList.add("anime");
  }

  function rendTransporteurs(d, anime) {
    const zone = $("st-transporteurs");
    if (!d.transporteurs.length) {
      zone.innerHTML = `<p class="p-podium-vide">Aucun colis posté pour l'instant.</p>`;
      return;
    }
    const total = d.transporteurs.reduce((s, t) => s + t.colis, 0) || 1;
    zone.innerHTML = d.transporteurs
      .slice(0, 8)
      .map(
        (t, i) => `
      <div class="p-part carrier" data-carrier="${CONNUS.has(t.code) ? t.code : "autre"}" data-i="${i}">
        <span class="p-part-nom"><i class="carrier-dot"></i>${echappe(t.nom)}</span>
        <span class="p-part-n"><b>${nombre(t.colis)}</b> · ${Math.round((t.colis / total) * 100)} %</span>
        <span class="p-part-barre"><i data-part="${(t.colis / total).toFixed(3)}"></i></span>
      </div>`
      )
      .join("");
    poseParts(zone);
    zone.classList.remove("anime");
    if (anime && !reduit) {
      void zone.offsetWidth;
      quandVisible(zone.closest(".card"), () => zone.classList.add("anime"));
    } else zone.classList.add("anime");
  }

  // --- Chargement ------------------------------------------------------------------------------
  async function charge({ anime = false, riche = false } = {}) {
    if (etat.enCours) return;
    etat.enCours = true;
    try {
      const res = await fetch(`/api/portail/${encodeURIComponent(jeton)}/stats`, {
        cache: "no-store",
        credentials: "omit",
        headers: etat.etag && !anime ? { "If-None-Match": etat.etag } : {},
      });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(String(res.status));
      etat.donnees = await res.json();
      etat.etag = res.headers.get("ETag");
      rend({ anime, riche });
    } catch (err) {
      if (!etat.donnees) $("st-resume").textContent = "Stats indisponibles pour l'instant : nouvel essai dans un instant.";
    } finally {
      etat.enCours = false;
      clearTimeout(etat.minuteur);
      if (etat.ouverte && !document.hidden) etat.minuteur = setTimeout(() => charge(), RAFRAICHISSEMENT_MS);
    }
  }

  // --- Les onglets « Colis » / « Stats » ------------------------------------------------------
  const onglets = $("onglets");
  function montre(vue, { depuisHistorique = false } = {}) {
    const stats = vue === "stats";
    if (stats === etat.ouverte && etat.visites) return;
    etat.ouverte = stats;
    onglets.dataset.actif = vue;
    for (const b of onglets.querySelectorAll(".p-onglet")) b.setAttribute("aria-pressed", String(b.dataset.onglet === vue));
    document.body.classList.toggle("vue-stats", stats);
    $("contenu").hidden = stats;
    $("stats").hidden = !stats;
    if (!depuisHistorique) history.replaceState(null, "", stats ? "#stats" : location.pathname);
    window.scrollTo({ top: 0, behavior: "auto" });
    if (!stats) {
      clearTimeout(etat.minuteur);
      return;
    }
    // chaque arrivee rejoue la revelation (la premiere, plus riche)
    const riche = etat.visites === 0;
    etat.visites += 1;
    const section = $("stats");
    section.classList.remove("entree");
    void section.offsetWidth;
    if (!reduit) section.classList.add("entree");
    if (etat.donnees) rend({ anime: true, riche });
    charge({ anime: !etat.donnees, riche });
  }

  onglets.addEventListener("click", (e) => {
    const b = e.target.closest(".p-onglet");
    if (b) montre(b.dataset.onglet);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && etat.ouverte) charge();
  });
  // un lien partage avec #stats ouvre les stats
  if (location.hash === "#stats") montre("stats", { depuisHistorique: true });
  else onglets.dataset.actif = "colis";
})();
