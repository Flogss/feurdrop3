// --- Onde au toucher ----------------------------------------------------------
// Tout ce qui se touche reagit au point exact du doigt.
const TOUCHABLES = ".btn, .step, .tool, .metric, .sp-card, .imp-cat-head, .lrow-pick, .icon-btn, .back, .locker-btn";

document.addEventListener(
  "pointerdown",
  (e) => {
    if (prefersReducedMotion) return;
    const cible = e.target.closest(TOUCHABLES);
    if (!cible || cible.disabled) return;
    const r = cible.getBoundingClientRect();
    const taille = Math.max(r.width, r.height) * 2.2;
    const onde = document.createElement("span");
    onde.className = "ripple";
    onde.style.width = onde.style.height = `${taille}px`;
    onde.style.left = `${e.clientX - r.left - taille / 2}px`;
    onde.style.top = `${e.clientY - r.top - taille / 2}px`;
    cible.appendChild(onde);
    setTimeout(() => onde.remove(), 650);
  },
  { passive: true }
);

// Au bureau, la lumiere des cartes suit la souris.
if (avecSouris && !prefersReducedMotion) {
  let carte = null;
  document.addEventListener(
    "pointermove",
    (e) => {
      const c = e.target.closest?.(".card, .tool");
      carte = c;
      if (!c) return;
      const r = c.getBoundingClientRect();
      c.style.setProperty("--mx", `${e.clientX - r.left}px`);
      c.style.setProperty("--my", `${e.clientY - r.top}px`);
    },
    { passive: true }
  );
}

// --- Fond vivant ----------------------------------------------------------------
// Des particules tres discretes qui montent lentement et scintillent, et des
// halos qui glissent un peu avec le defilement et la souris.

// Les particules : dans un worker quand le navigateur sait transferer une
// toile (Chrome, Safari 16.4+), sinon sur le fil principal comme avant.
function lanceParticules(toile) {
  const nombre = innerWidth < 700 ? 34 : 64;
  const dpr = () => Math.min(devicePixelRatio || 1, 2);
  let envoie = null;
  if (toile.transferControlToOffscreen && window.Worker) {
    try {
      const hors = toile.transferControlToOffscreen();
      const travailleur = new Worker("/particules.js");
      travailleur.postMessage({ type: "init", toile: hors, L: innerWidth, H: innerHeight, dpr: dpr(), nombre }, [hors]);
      envoie = (message) => travailleur.postMessage(message);
    } catch {
      envoie = null;
    }
  }
  if (!envoie) envoie = particulesSurFilPrincipal(toile, nombre);
  window.addEventListener("resize", () => envoie({ type: "taille", L: innerWidth, H: innerHeight, dpr: dpr() }));
  // en pause quand la page est cachee ou que le locker est ouvert
  const majPause = () => envoie({ type: "pause", pause: document.hidden || document.body.classList.contains("locker-ouvert") });
  document.addEventListener("visibilitychange", majPause);
  new MutationObserver(majPause).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return { defilement: (y) => envoie({ type: "defilement", y }) };
}

// Secours sans worker : le meme dessin, avec le defilement memorise (au lieu
// de relire window.scrollY a chaque image, ce qui forcait un recalcul).
function particulesSurFilPrincipal(toile, nombre) {
  const ctx = toile.getContext("2d");
  let L = 0;
  let H = 0;
  let decalage = 0;
  let pause = false;
  const dimensionne = (largeur, hauteur, dpr) => {
    L = largeur;
    H = hauteur;
    toile.width = L * dpr;
    toile.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  dimensionne(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 2));
  const points = Array.from({ length: nombre }, () => ({
    x: Math.random() * L,
    y: Math.random() * H,
    r: 0.5 + Math.random() * 1.5,
    vx: (Math.random() - 0.5) * 0.08,
    vy: -(0.04 + Math.random() * 0.16),
    a: 0.18 + Math.random() * 0.5,
    phase: Math.random() * Math.PI * 2,
    profondeur: 0.3 + Math.random() * 0.7,
    blanc: Math.random() < 0.3,
  }));
  const dessine = (t) => {
    requestAnimationFrame(dessine);
    if (pause) return;
    ctx.clearRect(0, 0, L, H);
    for (const p of points) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -12) {
        p.y = H + 12;
        p.x = Math.random() * L;
      }
      if (p.x < -12) p.x = L + 12;
      if (p.x > L + 12) p.x = -12;
      const y = (((p.y - decalage * p.profondeur) % (H + 24)) + H + 24) % (H + 24) - 12;
      const alpha = p.a * (0.55 + 0.45 * Math.sin(t / 900 + p.phase));
      ctx.globalAlpha = alpha * (p.blanc ? 0.25 : 0.22);
      ctx.fillStyle = p.blanc ? "#ffffff" : "#aa84ff";
      ctx.beginPath();
      ctx.arc(p.x, y, p.r * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.blanc ? "#ffffff" : "#cebaff";
      ctx.beginPath();
      ctx.arc(p.x, y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  requestAnimationFrame(dessine);
  return (message) => {
    if (message.type === "taille") dimensionne(message.L, message.H, message.dpr);
    else if (message.type === "defilement") decalage = message.y * 0.06;
    else if (message.type === "pause") pause = message.pause;
  };
}

{
  const fond = document.querySelector(".ambient");
  const toile = $("particules");
  // le dessin tourne dans un worker (toile transferee) : le fil principal ne
  // fait plus que lui envoyer le defilement et l'etat de pause
  let particules = null;
  if (!prefersReducedMotion && toile) particules = lanceParticules(toile);

  // parallaxe : le defilement et la souris deplacent un peu les halos
  let attente = false;
  const majDefilement = () => {
    if (attente) return;
    attente = true;
    requestAnimationFrame(() => {
      attente = false;
      particules?.defilement(window.scrollY);
      fond.style.setProperty("--py", `${window.scrollY}px`);
      document.body.classList.toggle("is-scrolled", window.scrollY > 8);
    });
  };
  window.addEventListener("scroll", majDefilement, { passive: true });
  if (avecSouris && !prefersReducedMotion) {
    window.addEventListener(
      "pointermove",
      (e) => {
        fond.style.setProperty("--mx", `${(e.clientX / innerWidth - 0.5) * 50}px`);
        fond.style.setProperty("--my", `${(e.clientY / innerHeight - 0.5) * 40}px`);
      },
      { passive: true }
    );
  }
}

// --- Etat de synchronisation --------------------------------------------------
// "En direct" ne ment pas : il dit si le dernier rafraichissement a joint le
// serveur. Une coupure se signale une fois, et son retour aussi.
let connexionPerdue = false;

function enLigne(ok) {
  $("live-status").classList.toggle("is-off", !ok);
  $("live-text").textContent = ok ? "En direct" : "Hors ligne";
  if (!ok && !connexionPerdue) {
    connexionPerdue = true;
    toast("Connexion perdue · nouvel essai automatique", "error");
  } else if (ok && connexionPerdue) {
    connexionPerdue = false;
    toast("Connexion rétablie", "info");
  }
}

// --- Barre d'onglets : la goutte de verre --------------------------------------
// L'indicateur actif est pose par un ressort : il part, depasse un peu sa
// cible et se pose. Pendant le trajet il s'etire dans le sens du mouvement et
// s'aplatit un peu, comme une goutte. Le reflet de la barre le suit.

const barre = { x: 0, w: 0, vx: 0, vw: 0, cx: 0, cw: 0, raf: null, pret: false, t: 0, loupe: 0, loupeCible: 0 };
const tabbar = $("tabbar");
const indicateur = $("tab-indicator");

let largeurBarre = 0;
const mesureBarre = () => (largeurBarre = tabbar.clientWidth || 1);
let largeurEcrite = -1;
function dessineIndicateur() {
  const etire = Math.min(Math.abs(barre.vx) / 1700, 0.3);
  // tenue sous le doigt, la goutte gonfle comme une loupe de verre
  const sx = 1 + etire + 0.12 * barre.loupe;
  const sy = 1 - etire * 0.5 + 0.18 * barre.loupe;
  if (Math.abs(barre.w - largeurEcrite) > 0.05) {
    largeurEcrite = barre.w;
    indicateur.style.width = `${barre.w}px`;
  }
  indicateur.style.transform = `translate3d(${barre.x}px, 0, 0) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
  if (!tabbar.classList.contains("has-hover")) {
    tabbar.style.setProperty("--hx", `${((barre.x + barre.w / 2) / (largeurBarre || mesureBarre())) * 100}%`);
  }
}

function pasRessort(maintenant) {
  // deux sous-pas par image : plus stable quand une image saute
  let dt = Math.min(40, maintenant - barre.t) / 1000;
  barre.t = maintenant;
  dt /= 2;
  for (let i = 0; i < 2; i++) {
    const ax = -420 * (barre.x - barre.cx) - 27 * barre.vx;
    barre.vx += ax * dt;
    barre.x += barre.vx * dt;
    const aw = -520 * (barre.w - barre.cw) - 34 * barre.vw;
    barre.vw += aw * dt;
    barre.w += barre.vw * dt;
    barre.loupe += (barre.loupeCible - barre.loupe) * Math.min(1, dt * 16);
  }
  dessineIndicateur();
  const pose =
    Math.abs(barre.x - barre.cx) < 0.25 && Math.abs(barre.vx) < 3 && Math.abs(barre.w - barre.cw) < 0.25 && Math.abs(barre.vw) < 3 &&
    Math.abs(barre.loupe - barre.loupeCible) < 0.005;
  if (pose) {
    barre.x = barre.cx;
    barre.w = barre.cw;
    barre.vx = barre.vw = 0;
    barre.loupe = barre.loupeCible;
    dessineIndicateur();
    barre.raf = null;
    return;
  }
  barre.raf = requestAnimationFrame(pasRessort);
}

function placeIndicateur(onglet, { instantane = false } = {}) {
  const tab = tabbar.querySelector(`.tab[data-view="${onglet}"]`);
  if (!tab || !tab.offsetWidth) return;
  barre.cx = tab.offsetLeft;
  barre.cw = tab.offsetWidth;
  if (!barre.pret || instantane || prefersReducedMotion) {
    barre.x = barre.cx;
    barre.w = barre.cw;
    barre.vx = barre.vw = 0;
    barre.pret = true;
    dessineIndicateur();
    return;
  }
  lanceRessort();
}

function lanceRessort() {
  if (barre.raf) return;
  barre.t = performance.now();
  barre.raf = requestAnimationFrame(pasRessort);
}

// Glisser d'un onglet a l'autre, comme la barre Liquid Glass d'iOS : on pose
// le doigt sur la barre et on glisse. La goutte quitte son onglet et suit le
// doigt en se deformant (elle gonfle en loupe, s'etire avec la vitesse),
// l'onglet survole s'allume, et au lacher on arrive sur celui sous le doigt.
// Un simple appui reste un appui.
const glisse = { id: null, actif: false, x0: 0, cible: null, finA: 0 };

function ongletSous(x) {
  const tabs = [...tabbar.querySelectorAll(".tab")];
  const r = tabbar.getBoundingClientRect();
  const local = x - r.left;
  return tabs.reduce((proche, t) =>
    Math.abs(t.offsetLeft + t.offsetWidth / 2 - local) < Math.abs(proche.offsetLeft + proche.offsetWidth / 2 - local) ? t : proche
  );
}

function suisDoigt(x) {
  const r = tabbar.getBoundingClientRect();
  const premier = tabbar.querySelector(".tab");
  const marge = premier.offsetLeft;
  const largeur = premier.offsetWidth;
  barre.cw = largeur;
  // au bord, la goutte resiste un peu au lieu de s'arreter net
  let cx = x - r.left - largeur / 2;
  const min = marge;
  const max = tabbar.clientWidth - marge - largeur;
  if (cx < min) cx = min - (min - cx) * 0.25;
  if (cx > max) cx = max + (cx - max) * 0.25;
  barre.cx = cx;
  lanceRessort();
}

function marqueCible(tab) {
  tabbar.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-cible", t === tab));
}

tabbar.addEventListener("pointermove", (e) => {
  if (glisse.id !== e.pointerId || prefersReducedMotion) return;
  if (!glisse.actif) {
    if (Math.abs(e.clientX - glisse.x0) < 8) return;
    glisse.actif = true;
    try {
      tabbar.setPointerCapture(e.pointerId);
    } catch {
      /* pointeur deja relache */
    }
    relache();
    tabbar.classList.add("is-dragging");
    indicateur.classList.add("is-lens");
    barre.loupeCible = 1;
  }
  suisDoigt(e.clientX);
  const sous = ongletSous(e.clientX);
  if (sous !== glisse.cible) {
    glisse.cible = sous;
    marqueCible(sous);
    haptique();
  }
});

function finGlisse(e) {
  if (glisse.id !== e.pointerId) return;
  const glissait = glisse.actif;
  glisse.id = null;
  glisse.actif = false;
  if (!glissait) return;
  glisse.finA = performance.now();
  tabbar.classList.remove("is-dragging");
  indicateur.classList.remove("is-lens");
  marqueCible(null);
  barre.loupeCible = 0;
  const vue = glisse.cible?.dataset.view;
  if (vue && vue !== (VUE_PARENT[currentView] || currentView)) switchView(vue);
  else placeIndicateur(VUE_PARENT[currentView] || currentView);
}
tabbar.addEventListener("pointerup", finGlisse);
tabbar.addEventListener("pointercancel", finGlisse);

// au toucher : l'onglet se comprime, une onde passe dans le verre
tabbar.addEventListener("pointerdown", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  if (e.button === 0) {
    glisse.id = e.pointerId;
    glisse.actif = false;
    glisse.x0 = e.clientX;
    glisse.cible = tab;
  }
  tab.classList.add("is-pressed");
  if (tab.classList.contains("active")) indicateur.classList.add("is-pressed");
  if (!prefersReducedMotion) {
    const r = tabbar.getBoundingClientRect();
    const onde = document.createElement("span");
    onde.className = "onde";
    onde.style.left = `${e.clientX - r.left}px`;
    onde.style.top = `${e.clientY - r.top}px`;
    tabbar.querySelector(".tab-glass").appendChild(onde);
    setTimeout(() => onde.remove(), 720);
  }
});
const relache = () => {
  tabbar.querySelectorAll(".tab.is-pressed").forEach((t) => t.classList.remove("is-pressed"));
  indicateur.classList.remove("is-pressed");
};
tabbar.addEventListener("pointerup", relache);
tabbar.addEventListener("pointercancel", relache);
tabbar.addEventListener("pointerleave", relache);

// au bureau : une pastille de survol glisse sous la souris, le reflet suit
if (avecSouris) {
  const survol = tabbar.querySelector(".tab-hover");
  tabbar.addEventListener("pointerover", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    const premier = !tabbar.classList.contains("has-hover");
    if (premier) survol.style.transition = "none";
    survol.style.width = `${tab.offsetWidth}px`;
    survol.style.transform = `translate3d(${tab.offsetLeft}px, 0, 0)`;
    if (premier) {
      void survol.offsetWidth;
      survol.style.transition = "";
    }
    tabbar.classList.add("has-hover");
  });
  tabbar.addEventListener("pointermove", (e) => {
    const r = tabbar.getBoundingClientRect();
    tabbar.style.setProperty("--hx", `${((e.clientX - r.left) / r.width) * 100}%`);
  });
  tabbar.addEventListener("pointerleave", () => {
    tabbar.classList.remove("has-hover");
    dessineIndicateur();
  });
}

window.addEventListener("resize", () => {
  mesureBarre();
  placeIndicateur(VUE_PARENT[currentView] || currentView, { instantane: true });
});

// --- Navigation -----------------------------------------------------------------

let currentView = "dashboard";

const ONGLETS = ["dashboard", "imprime", "stats"];
const VUES = ["dashboard", "imprime", "stats", "colis", "special", "suivi"];
// les pages ouvertes depuis le dashboard gardent son onglet allume
const VUE_PARENT = { colis: "dashboard", special: "dashboard", suivi: "dashboard", "suivi-detail": "dashboard" };
const PROFONDEUR = { colis: 1, special: 1, suivi: 1, "suivi-detail": 2 };
const defilement = {};
// premiere visite d'une page dans la session : grande entree ; ensuite, legere
const vuesVisitees = new Set();

// La page qui part reste figee a sa place et s'efface pendant que la
// nouvelle entre : les deux se croisent.
// `r` : la position de la page, relevee AVANT toute modification (la lire
// apres forcait le navigateur a tout recalculer pendant le clic)
function quittePage(page, sens, r) {
  if (!page || prefersReducedMotion) return;
  r = r || page.getBoundingClientRect();
  page.classList.add("is-leaving", sens === "from-left" ? "vers-droite" : sens === "from-right" ? "vers-gauche" : "sur-place");
  page.style.top = `${r.top}px`;
  page.style.left = `${r.left}px`;
  page.style.width = `${r.width}px`;
  clearTimeout(page._depart);
  page._depart = setTimeout(() => liberePage(page), 320);
}

function liberePage(page) {
  clearTimeout(page._depart);
  page.classList.remove("is-leaving", "vers-droite", "vers-gauche", "sur-place");
  page.style.top = page.style.left = page.style.width = "";
}

// Entree en cascade, puis revelation au defilement des blocs encore hors de
// l'ecran : on les decouvre en descendant au lieu de les voir finir trop tot.
let observateur = null;
const BLOCS = ".dash > *, :scope > .card, .stats-top > *, .stats-duo > *, .imp-columns > *, .special-list > *, .settings-col > *, .suivi-grid > *";

// `affichee` : la page etait deja a l'ecran (il faut alors relancer ses
// animations d'un recalcul) ; sinon elle apparait et ses animations partent
// d'elles-memes, sans recalcul force.
function entreePage(page, riche, affichee = true) {
  page.classList.remove("entree-riche", "entree-legere");
  page.querySelectorAll(".a-reveler, .revele").forEach((el) => el.classList.remove("a-reveler", "revele"));
  if (prefersReducedMotion) return;
  if (affichee) void page.offsetWidth;
  page.classList.add(riche ? "entree-riche" : "entree-legere");
  clearTimeout(page._entree);
  page._entree = setTimeout(() => page.classList.remove("entree-riche", "entree-legere"), 1500);

  if (!riche || !("IntersectionObserver" in window)) return;
  observateur?.disconnect();
  observateur = new IntersectionObserver(
    (entrees) => {
      for (const entree of entrees) {
        if (!entree.isIntersecting) continue;
        observateur.unobserve(entree.target);
        entree.target.classList.remove("a-reveler");
        entree.target.classList.add("revele");
      }
    },
    { rootMargin: "0px 0px -8% 0px" }
  );
  // les positions des blocs se lisent a l'image suivante, une fois la page
  // mise en page par le navigateur (les lire tout de suite forcait un
  // recalcul complet dans le clic). Les blocs concernes sont hors de l'ecran :
  // rien ne se voit de ce petit decalage.
  const obs = observateur;
  // deux images plus tard : la premiere affiche la page (et calcule sa mise
  // en page), la seconde lit des positions deja a jour, sans rien forcer
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (obs !== observateur) return;
    const bas = window.innerHeight * 0.96;
    const hors = [...page.querySelectorAll(BLOCS)].filter((bloc) => bloc.getBoundingClientRect().top >= bas);
    for (const bloc of hors) {
      bloc.classList.add("a-reveler");
      obs.observe(bloc);
    }
  }));
}

function switchView(view) {
  const precedente = currentView;
  const arrivee = view !== precedente;
  const onglet = VUE_PARENT[view] || view;

  // Toutes les lectures d'abord, sur une mise en page encore propre : lire
  // une position apres avoir change des classes forcait le navigateur a tout
  // recalculer dans le clic (jusqu'a 100 ms sur telephone).
  placeIndicateur(onglet);
  const quittee = arrivee ? $(`view-${precedente}`) : null;
  const rectQuittee = quittee && !prefersReducedMotion ? quittee.getBoundingClientRect() : null;
  const yQuittee = window.scrollY;
  const nouvelleAvant = $(`view-${view}`);
  const dejaAffichee = nouvelleAvant.classList.contains("active") || nouvelleAvant.classList.contains("is-leaving");

  document.querySelectorAll(".tab").forEach((t) => {
    const actif = t.dataset.view === onglet;
    if (actif && !t.classList.contains("active")) rejoue(t, "is-arriving", 700);
    t.classList.toggle("active", actif);
  });

  // le sens du glissement suit la navigation : on entre vers la droite, on
  // revient vers la gauche, et les onglets suivent leur ordre
  let sens = "from-none";
  if (arrivee) {
    const p1 = PROFONDEUR[view] || 0;
    const p0 = PROFONDEUR[precedente] || 0;
    if (p1 !== p0) sens = p1 > p0 ? "from-right" : "from-left";
    else {
      const a = ONGLETS.indexOf(view);
      const b = ONGLETS.indexOf(precedente);
      if (a >= 0 && b >= 0) sens = a > b ? "from-right" : "from-left";
    }
    defilement[precedente] = yQuittee;
  }

  const nouvelle = nouvelleAvant;
  if (arrivee) {
    quittePage(quittee, sens, rectQuittee);
    liberePage(nouvelle);
  }
  document.querySelectorAll(".view").forEach((v) => {
    if (v === nouvelle) return;
    v.classList.remove("active", "from-right", "from-left", "from-none");
  });
  if (arrivee) {
    nouvelle.classList.remove("from-right", "from-left", "from-none");
    // une page cachee qui reapparait relance ses animations d'elle-meme ;
    // seule une page deja a l'ecran a besoin d'un recalcul pour les rejouer
    if (dejaAffichee) void nouvelle.offsetWidth;
    nouvelle.classList.add(sens);
  }
  nouvelle.classList.add("active");

  // chaque page reprend la ou on l'avait laissee ; une page plus profonde
  // s'ouvre toujours en haut
  const riche = !vuesVisitees.has(view);
  if (arrivee) {
    const y = sens === "from-right" && PROFONDEUR[view] ? 0 : defilement[view] || 0;
    window.scrollTo(0, y);
    vuesVisitees.add(view);
    entreePage(nouvelle, riche, dejaAffichee);
    haptique();
    history.replaceState(null, "", view === "dashboard" ? location.pathname : `#${view}`);
  }

  // la revelation animee (compteurs, courbes, barres, anneau) se rejoue a
  // chaque arrivee sur l'onglet Stats -- plus courte quand on y revient
  if (view === "stats" && arrivee) playStatsReveal(riche);
  if (view === "imprime" && arrivee) loadImprime();
  if (view === "special" && arrivee) loadSpecial();
  // le suivi lit une base a part : on ne la sollicite qu'en arrivant dessus
  if (view === "suivi" && arrivee) loadSuivi().catch(() => {});
  currentView = view;
  // un ecran qui n'etait pas rafraichi en fond se met a jour en arrivant (les
  // Stats ont deja leur propre chargement anime)
  if (arrivee && view !== "stats" && CHARGEMENTS_PAR_VUE[view]) refreshAll().catch(() => {});
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    // le clic qui suit un glisser est deja traite au lacher
    if (performance.now() - glisse.finA < 400) return;
    // retoucher l'onglet ou l'on est deja remonte en haut, comme partout
    if (tab.dataset.view === currentView && window.scrollY > 0) {
      window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
      return;
    }
    switchView(tab.dataset.view);
  });
});

$("brand-home").addEventListener("click", () => switchView("dashboard"));
$("topbar-settings").addEventListener("click", () => switchView("colis"));

// --- Rendu ------------------------------------------------------------------------

// Empeche de reconstruire le DOM (et donc de rejouer les animations) quand le
// rafraichissement periodique renvoie exactement les memes donnees.
const renderCache = new Map();
function hasChanged(key, data) {
  const signature = JSON.stringify(data);
  if (renderCache.get(key) === signature) return false;
  renderCache.set(key, signature);
  return true;
}

const vide = (icone, titre, sous = "", bon = false) =>
  `<div class="empty${bon ? " empty-good" : ""}"><span class="empty-icon">${ico(icone)}</span>` +
  `<span class="empty-title">${titre}</span>${sous ? `<span class="empty-sub">${sous}</span>` : ""}</div>`;

const squelettes = (n) => `<div class="skeleton"></div>`.repeat(n);

// Une liste a cles : on la reconstruit, mais seules les lignes nouvelles
// arrivent en glissant, et celles dont les chiffres ont change s'eclairent.
// Les autres ne bougent pas d'un pixel.
function rendListe(box, items, { cle, html, videHtml }) {
  const avant = box._signatures || new Map();
  const premier = !box._signatures;
  const apres = new Map(items.map((it) => [String(cle(it)), JSON.stringify(it)]));
  box._signatures = apres;
  if (items.length === 0) {
    box.innerHTML = videHtml;
    return;
  }
  box.innerHTML = items.map(html).join("");
  if (prefersReducedMotion) return;
  let n = 0;
  for (const el of box.children) {
    const k = el.dataset.key;
    if (!k) continue;
    if (!avant.has(k)) {
      el.classList.add("is-new");
      el.style.setProperty("--n", Math.min(n++, 8));
    } else if (!premier && avant.get(k) !== apres.get(k)) {
      el.classList.add("is-changed");
    }
  }
}

// --- Chiffres vivants ----------------------------------------------------------
// Un montant qui change prend le temps de monter : la duree croit avec
// l'ecart (+5 va vite, +1000 prend son temps), sans jamais faire attendre.
function dureeComptage(ecart) {
  const d = Math.abs(ecart);
  if (!d) return 0;
  return Math.min(2600, 520 + Math.log10(d + 1) * 640);
}

function compte(el, valeur, { format = entier, depuis, delai = 0, bulle, duree, onFin } = {}) {
  if (!el) return;
  const cible = Number(valeur) || 0;
  const precedent = typeof el._valeur === "number" ? el._valeur : null;
  const avant = depuis !== undefined ? depuis : precedent ?? cible;
  el._valeur = cible;
  el._texte = format(cible);
  el.classList.remove("is-loading");
  cancelAnimationFrame(el._raf);
  clearTimeout(el._attente);

  if (prefersReducedMotion || avant === cible) {
    el.textContent = format(cible);
    el.classList.remove("is-counting");
    onFin?.();
    return;
  }
  el.textContent = format(avant);
  const total = duree ?? dureeComptage(cible - avant);
  const courbe = format === entier ? easeOutCubic : easeOutQuart;
  if (bulle && cible > avant) afficheDelta(el, bulle(cible - avant), delai);

  const lance = () => {
    el.classList.add("is-counting");
    const t0 = performance.now();
    let affiche = el.textContent;
    const pas = (now) => {
      const p = Math.min((now - t0) / total, 1);
      // un texte identique a l'image precedente n'est pas reecrit : chaque
      // ecriture relance la mise en page de la carte
      const texte = format(avant + (cible - avant) * courbe(p));
      if (texte !== affiche) el.textContent = affiche = texte;
      if (p < 1) el._raf = requestAnimationFrame(pas);
      else {
        el.textContent = format(cible);
        el.classList.remove("is-counting");
        onFin?.();
      }
    };
    el._raf = requestAnimationFrame(pas);
  };
  if (delai) el._attente = setTimeout(lance, delai);
  else lance();
}

// La bulle "+10 colis" pres du compteur, puis une onde qui part du chiffre
// au moment ou il se met a compter.
function afficheDelta(el, texte, delai = 0) {
  if (prefersReducedMotion) return;
  const hote = el.closest(".hero-figure, .metric") || el.parentElement;
  setTimeout(() => {
    if (!hote.isConnected) return;
    hote.querySelectorAll(".delta").forEach((d) => d.remove());
    const bulle = document.createElement("span");
    bulle.className = "delta";
    bulle.textContent = texte;
    hote.appendChild(bulle);
    setTimeout(() => bulle.remove(), 2700);

    const onde = document.createElement("span");
    onde.className = "onde-chiffre";
    const taille = Math.max(el.offsetWidth, el.offsetHeight) * 1.3;
    onde.style.width = onde.style.height = `${taille}px`;
    onde.style.left = `${el.offsetLeft + el.offsetWidth / 2 - taille / 2}px`;
    onde.style.top = `${el.offsetTop + el.offsetHeight / 2 - taille / 2}px`;
    setTimeout(() => {
      if (!hote.isConnected) return;
      hote.appendChild(onde);
      setTimeout(() => onde.remove(), 950);
    }, 260);
  }, Math.max(0, delai - 280));
}

// Chiffre qui roule : pour les petits pas (+1, -1), l'ancien sort par le
// haut et le nouveau arrive du bas -- ou l'inverse quand ca descend.
function roule(el, texte, sens) {
  cancelAnimationFrame(el._raf);
  clearTimeout(el._attente);
  el.classList.remove("is-loading", "is-counting");
  const ancien = el._texte ?? el.textContent;
  el._texte = texte;
  if (ancien === texte) return;
  if (prefersReducedMotion) {
    el.textContent = texte;
    return;
  }
  const r = document.createElement("span");
  r.className = `roll${sens < 0 ? " vers-bas" : ""}`;
  r.innerHTML = `<span class="roll-out"></span><span class="roll-in"></span>`;
  r.firstChild.textContent = ancien;
  r.lastChild.textContent = texte;
  el.replaceChildren(r);
  clearTimeout(el._roule);
  el._roule = setTimeout(() => (el.textContent = texte), 560);
}

// Compte de 0 a `target` : pour les revelations des graphiques.
function animateNumberText(el, target, format, duration = 900, delay = 0) {
  if (!el) return;
  if (prefersReducedMotion) {
    el.textContent = format(target);
    return;
  }
  const start = () => {
    const t0 = performance.now();
    let affiche = el.textContent;
    const step = (now) => {
      const p = Math.min((now - t0) / duration, 1);
      const texte = format(target * easeOutCubic(p));
      if (texte !== affiche) el.textContent = affiche = texte;
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = format(target);
    };
    requestAnimationFrame(step);
  };
  if (delay > 0) setTimeout(start, delay);
  else start();
}

// Un montant long retrecit d'un cran pour tenir dans sa carte.
function fitStatValue(el, text) {
  if (el) el.classList.toggle("is-long", String(text).length >= 8);
}

// Pastille de couleur stable par expediteur : la meme teinte d'une visite a
// l'autre, pour reconnaitre quelqu'un sans lire son nom.
function avatar(nom) {
  const propre = String(nom).replace(/^[@\s_.-]+/, "");
  const teinte = [...String(nom)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);
  return `<span class="avatar" style="--h:${teinte}" aria-hidden="true">${escapeHtml((propre[0] || "?").toUpperCase())}</span>`;
}

// --- Memoire de cet appareil -----------------------------------------------------
// Le dernier etat vu SUR CET APPAREIL : c'est lui qui permet de dire "+10
// colis depuis ta derniere visite". Rien ne part au serveur, donc un autre
// telephone a sa propre memoire et ne voit jamais les nouveautes des autres.
// Premiere visite : pas de memoire, donc pas de "+35" absurde.
const CLE_MEMOIRE = "drop.dernier-etat";
const aujourdhui = () => new Date().toLocaleDateString("fr-CA");

function memoire() {
  try {
    return JSON.parse(localStorage.getItem(CLE_MEMOIRE)) || null;
  } catch {
    return null;
  }
}
function retiens(etat) {
  try {
    localStorage.setItem(CLE_MEMOIRE, JSON.stringify({ ...etat, jour: aujourdhui(), at: Date.now() }));
  } catch {
    /* navigation privee : on fait sans */
  }
}

// Une nouvelle session (app relancee) a droit a la grande entree ; un simple
// rechargement dans la meme session, non.
const nouvelleSession = !sessionStorage.getItem("drop.session");
sessionStorage.setItem("drop.session", "1");

