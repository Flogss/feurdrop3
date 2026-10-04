// ============================================================================
// DROP.ctrl -- le dashboard
// Le site doit sembler vivant : chaque geste a un retour (onde au toucher,
// roue pendant l'appel, coche et etincelles a la fin), les chiffres montent
// pour de vrai, les pages se croisent au lieu de se remplacer, et rien ne
// s'anime pour rien -- seul ce qui vient de changer bouge.
// ============================================================================

const $ = (id) => document.getElementById(id);
const attends = (ms) => new Promise((r) => setTimeout(r, ms));

const nf2 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const euro = (n) => `${nf2.format(Number(n) || 0)} €`;
// Les cartes du dashboard sont etroites : au-dela de 1000 € on laisse tomber
// les centimes pour que le montant tienne en entier.
const euroCompact = (n) =>
  Math.abs(Number(n) || 0) >= 1000 ? `${nf0.format(Math.round(Number(n) || 0))} €` : euro(n);
const entier = (n) => nf0.format(Math.round(Number(n) || 0));
const pluriel = (n, mot, motPluriel = `${mot}s`) => `${entier(n)} ${Number(n) > 1 ? motPluriel : mot}`;
// sans centimes quand ils n'apportent rien : graphiques serres, cumuls
const euroGraphe = (v) => (v >= 100 || Number.isInteger(Math.round(v * 100) / 100) ? `${entier(v)} €` : euro(v));

const DAY_LABELS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
// Le violet d'abord, puis des teintes qui se distinguent bien de lui.
const CATEGORICAL_COLORS = ["#9162ff", "#40d0d6", "#ff7ac6", "#c4aaff", "#78b0ff", "#ffb048", "#6e40f0", "#5ee6b0"];
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
  Inconnu: "Non reconnu",
};

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const avecSouris = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

const ico = (nom, classe = "") =>
  `<svg class="icon${classe ? ` ${classe}` : ""}" aria-hidden="true"><use href="#i-${nom}"/></svg>`;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// Courbes de temps, partagees par tout ce qui s'anime en JS.
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
const easeOutQuart = (p) => 1 - Math.pow(1 - p, 4);
const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeOutBack = (p, s = 1.5) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);

// --- Reseau -------------------------------------------------------------------
// Un appel qui traine finit en erreur au lieu de pendre ; une lecture qui
// echoue sur le reseau est retentee une fois avant d'abandonner.

class ErreurReseau extends Error {}

async function fetchJSON(url, opts = {}, { delai = 12000, essais } = {}) {
  const lecture = !opts.method || opts.method === "GET";
  const maxEssais = essais ?? (lecture ? 2 : 1);
  for (let essai = 1; ; essai++) {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), delai);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(minuteur);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      return res.json();
    } catch (err) {
      clearTimeout(minuteur);
      const reseau = err.name === "AbortError" || err instanceof TypeError;
      if (!reseau) throw err;
      if (essai < maxEssais) {
        await attends(700 * essai);
        continue;
      }
      throw new ErreurReseau(err.name === "AbortError" ? "Le serveur met trop de temps à répondre" : "Connexion impossible");
    }
  }
}

const postJSON = (url, corps, options) =>
  fetchJSON(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps || {}) },
    { delai: 30000, ...options }
  );

// --- Retour haptique -----------------------------------------------------------
// Android sait vibrer. L'iPhone non, mais basculer un interrupteur natif le
// fait tressaillir : on en garde un, invisible, juste pour ca.
const surIPhone = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
function haptique() {
  if (navigator.vibrate) {
    navigator.vibrate(8);
    return;
  }
  if (!surIPhone) return;
  const avant = document.activeElement;
  document.querySelector("label.haptique")?.click();
  // l'interrupteur ne doit pas voler le focus d'un champ en cours de saisie
  if (document.activeElement?.id === "haptique" && avant?.focus) avant.focus({ preventScroll: true });
}

// --- Son des nouveaux colis ----------------------------------------------------
// Le "cha-ching" de Shopify, version maison : il sonne des que des colis
// arrivent, quelle que soit la page ouverte. Les navigateurs ne laissent
// jouer un son qu'apres un geste : le premier appui sur la page ouvre le canal
// audio (et charge le son), les suivants le reveillent s'il s'est endormi.
const son = { ctx: null, buffer: null, chargement: null };
const sonActif = () => localStorage.getItem("drop.son") !== "0";

function preparerSon() {
  if (!son.ctx) {
    const Contexte = window.AudioContext || window.webkitAudioContext;
    if (!Contexte) return;
    son.ctx = new Contexte();
  }
  if (son.ctx.state !== "running") son.ctx.resume().catch(() => {});
  if (!son.buffer && !son.chargement) {
    son.chargement = fetch("/cha-ching.m4a")
      .then((r) => r.arrayBuffer())
      .then((octets) => son.ctx.decodeAudioData(octets))
      .then((tampon) => (son.buffer = tampon))
      .catch(() => (son.chargement = null));
  }
}
for (const geste of ["pointerdown", "keydown"]) document.addEventListener(geste, preparerSon, { passive: true, capture: true });

async function chaChing({ force = false } = {}) {
  if ((!force && !sonActif()) || !son.ctx) return;
  try {
    if (son.ctx.state !== "running") await son.ctx.resume();
    if (!son.buffer) await son.chargement;
  } catch {
    return;
  }
  if (!son.buffer || son.ctx.state !== "running") return;
  const source = son.ctx.createBufferSource();
  source.buffer = son.buffer;
  const volume = son.ctx.createGain();
  volume.gain.value = 0.9;
  source.connect(volume).connect(son.ctx.destination);
  source.start();
}

// Le dernier nombre de colis en attente connu : toute hausse fait cha-ching.
let dernierEnAttente = null;
function noteEnAttente(n) {
  const hausse = dernierEnAttente !== null && n > dernierEnAttente;
  dernierEnAttente = n;
  if (hausse) chaChing();
  return hausse;
}

// --- Retours d'action ---------------------------------------------------------

const TOAST_ICONES = { success: "check", error: "alert", info: "info" };

// `lien` : le message devient un lien (un PDF a ouvrir d'un appui)
function toast(message, type = "success", duree = type === "error" ? 5200 : 3400, { lien } = {}) {
  const pile = $("toasts");
  const el = document.createElement(lien ? "a" : "div");
  if (lien) {
    el.href = lien;
    el.target = "_blank";
    el.rel = "noopener";
    el.classList.add("toast-lien");
  }
  el.className = `toast toast-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML = `<span class="toast-icon">${ico(TOAST_ICONES[type] || "info")}</span><span></span><span class="toast-temps"></span>`;
  el.children[1].textContent = message;
  el.lastChild.style.animationDuration = `${duree}ms`;
  pile.appendChild(el);
  // trois messages au plus : le plus ancien laisse sa place
  while (pile.children.length > 3) pile.firstElementChild.remove();

  const ferme = () => {
    if (el.classList.contains("out")) return;
    el.classList.add("out");
    setTimeout(() => el.remove(), 260);
  };
  el.addEventListener("click", ferme);
  setTimeout(ferme, duree);
}

function occupe(bouton, oui) {
  if (!bouton) return;
  if (oui) {
    bouton.setAttribute("aria-busy", "true");
    bouton.disabled = true;
  } else {
    bouton.removeAttribute("aria-busy");
    bouton.disabled = false;
  }
}

// relance une animation CSS portee par une classe
function rejoue(el, classe, duree) {
  if (!el?.isConnected) return;
  el.classList.remove(classe);
  void el.offsetWidth;
  el.classList.add(classe);
  clearTimeout(el[`_t_${classe}`]);
  el[`_t_${classe}`] = setTimeout(() => el.classList.remove(classe), duree);
}
const fait = (bouton) => rejoue(bouton, "is-done", 900);
const secoue = (el) => rejoue(el, "is-shake", 400);

// Etincelles : quelques eclats violets qui partent d'un element et
// retombent. Le succes se voit, sans feu d'artifice.
// `source` : un element, ou sa position deja relevee (un bouton redessine
// par le rafraichissement n'est plus dans la page quand le succes arrive).
function eclat(source, { nombre = 12, force = 1 } = {}) {
  if (prefersReducedMotion || !source) return;
  const r = source instanceof Element ? (source.isConnected ? source.getBoundingClientRect() : null) : source;
  if (!r || !r.width) return;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const scene = $("eclats");
  for (let i = 0; i < nombre; i++) {
    const p = document.createElement("span");
    p.className = `eclat${i % 3 === 0 ? " etoile" : ""}`;
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    scene.appendChild(p);
    const angle = (Math.PI * 2 * i) / nombre + Math.random() * 0.6;
    const portee = (36 + Math.random() * 46) * force;
    const dx = Math.cos(angle) * portee;
    const dy = Math.sin(angle) * portee - 14 * force;
    const anim = p.animate(
      [
        { transform: "translate3d(0,0,0) scale(0.4) rotate(0deg)", opacity: 1 },
        { transform: `translate3d(${dx * 0.7}px, ${dy * 0.7}px, 0) scale(1.1) rotate(90deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate3d(${dx}px, ${dy + 22 * force}px, 0) scale(0) rotate(160deg)`, opacity: 0 },
      ],
      { duration: 780 + Math.random() * 380, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );
    anim.onfinish = () => p.remove();
  }
}

// Le geste type : le bouton tourne, l'action part, puis une coche (ou une
// secousse), et un message dit ce qui s'est passe.
async function agir(bouton, action, { succes, eclats = false } = {}) {
  if (bouton?.getAttribute("aria-busy") === "true") return undefined;
  const position = bouton?.getBoundingClientRect();
  occupe(bouton, true);
  try {
    const resultat = await action();
    occupe(bouton, false);
    fait(bouton);
    haptique();
    if (eclats) eclat(bouton?.isConnected ? bouton : position, typeof eclats === "object" ? eclats : {});
    const texte = typeof succes === "function" ? succes(resultat) : succes;
    if (texte) toast(texte);
    return resultat;
  } catch (err) {
    occupe(bouton, false);
    secoue(bouton);
    toast(err.message || "Action impossible", "error");
    return undefined;
  }
}

// --- Feuille de confirmation ---------------------------------------------------
// Remplace confirm(), qui bloque tout et jure avec le reste sur iPhone.
// Renvoie une promesse : true si on confirme. Au telephone, on peut aussi la
// tirer vers le bas pour annuler.
let sheetResolve = null;

function confirmer({ titre, message = "", action = "Confirmer", retour = "Annuler", danger = false }) {
  const couche = $("sheet");
  if (sheetResolve) sheetResolve(false);

  $("sheet-title").textContent = titre;
  $("sheet-message").textContent = message;
  const ok = $("sheet-confirm");
  ok.textContent = action;
  ok.className = `btn btn-lg ${danger ? "btn-danger-solid" : "btn-primary"}`;
  couche.querySelector(".sheet-actions [data-sheet-cancel]").textContent = retour;
  const feuille = couche.querySelector(".sheet");
  feuille.removeAttribute("style");
  feuille.classList.remove("is-dragging", "is-releasing");

  const avant = document.activeElement;
  couche.classList.remove("closing");
  couche.hidden = false;
  haptique();
  requestAnimationFrame(() => ok.focus({ preventScroll: true }));

  return new Promise((resolve) => {
    sheetResolve = (valeur, { dejaPartie = false } = {}) => {
      sheetResolve = null;
      couche.classList.add("closing");
      if (dejaPartie) feuille.style.animation = "none";
      setTimeout(() => {
        couche.hidden = true;
        couche.classList.remove("closing");
        feuille.removeAttribute("style");
      }, prefersReducedMotion ? 0 : 260);
      if (avant?.isConnected) avant.focus?.({ preventScroll: true });
      resolve(valeur);
    };
  });
}

$("sheet").addEventListener("click", (e) => {
  if (!sheetResolve) return;
  if (e.target.closest("#sheet-confirm")) sheetResolve(true);
  else if (e.target.closest("[data-sheet-cancel]")) sheetResolve(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sheetResolve) sheetResolve(false);
});

// tirer la feuille vers le bas : elle suit le doigt, et part au-dela d'un seuil
{
  const feuille = document.querySelector("#sheet .sheet");
  let depart = null;
  feuille.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.target.closest("button")) return;
    depart = { y: e.clientY, t: performance.now(), dy: 0 };
    feuille.classList.add("is-dragging");
    try {
      feuille.setPointerCapture(e.pointerId);
    } catch {
      /* pointeur deja relache : on suit quand meme les mouvements */
    }
  });
  feuille.addEventListener("pointermove", (e) => {
    if (!depart) return;
    const dy = e.clientY - depart.y;
    // vers le haut, ca resiste ; vers le bas, ca suit
    depart.dy = dy > 0 ? dy : dy / 6;
    feuille.style.transform = `translate3d(0, ${depart.dy}px, 0)`;
  });
  const lache = () => {
    if (!depart) return;
    const vitesse = depart.dy / Math.max(1, performance.now() - depart.t);
    const part = depart.dy > 110 || (depart.dy > 30 && vitesse > 0.5);
    feuille.classList.remove("is-dragging");
    feuille.classList.add("is-releasing");
    feuille.style.transform = part ? "translate3d(0, 110%, 0)" : "";
    depart = null;
    if (part && sheetResolve) setTimeout(() => sheetResolve?.(false, { dejaPartie: true }), 180);
  };
  feuille.addEventListener("pointerup", lache);
  feuille.addEventListener("pointercancel", lache);
}

// Fait disparaitre un element en douceur avant de le cacher.
async function masque(el) {
  if (!el || el.hidden) return;
  if (!prefersReducedMotion && el.animate) {
    await el
      .animate(
        [
          { opacity: 1, transform: "none", filter: "blur(0)" },
          { opacity: 0, transform: "translateY(-8px) scale(0.97)", filter: "blur(6px)" },
        ],
        { duration: 260, easing: "cubic-bezier(0.55, 0, 0.75, 0.2)" }
      )
      .finished.catch(() => {});
  }
  el.hidden = true;
}

function montre(el) {
  if (!el || !el.hidden) return false;
  el.hidden = false;
  rejoue(el, "revele", 900);
  return true;
}

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

  note.textContent =
    `Parti à ${formatTourTime(tourStartedAt)}. ` +
    (tour.arrivedCount > 0
      ? `${pluriel(tour.arrivedCount, "colis reçu", "colis reçus")} depuis (${euro(tour.arrivedValue)}) attendront la prochaine tournée.`
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

  const sac = bagSummary.count;
  await agir(
    bouton,
    async () => {
      await postJSON("/api/tour/start");
      renderCache.clear();
      await refreshAll();
    },
    { succes: `Bonne tournée ! ${pluriel(sac, "colis", "colis")} dans le sac.`, eclats: { nombre: 14 } }
  );
});

// drop = true : le sac est drope. false : on referme sans rien dropper.
async function endTour(drop, bouton) {
  const { count, value } = bagSummary;
  await agir(
    bouton,
    async () => {
      await postJSON(drop ? "/api/tour/finish" : "/api/tour/end");
      renderCache.clear();
      await refreshAll();
    },
    {
      succes: drop ? `${pluriel(count, "colis dropé", "colis dropés")} · ${euro(value)}` : "Tournée annulée",
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

// --- Reglages : dettes, prix, fusions -------------------------------------------

async function loadDebts() {
  const rows = await fetchJSON("/api/debts");
  if (!hasChanged("debts", rows)) return;

  const total = rows.reduce((sum, d) => sum + d.owed, 0);
  $("debts-total").textContent = total > 0 ? euro(total) : "";
  rendListe($("debts-rows"), rows, {
    cle: (d) => d.sender_name,
    videHtml: vide("check", "Personne ne vous doit rien", "", true),
    html: (d) => `
      <div class="lrow" data-key="${escapeAttr(d.sender_name)}">
        ${avatar(d.sender_name)}
        <div class="lrow-main">
          <div class="lrow-title">${escapeHtml(d.sender_name)}</div>
          <div class="lrow-sub"><span class="debt">${euro(d.owed)}</span> · ${pluriel(d.count, "colis", "colis")}</div>
        </div>
        <button class="btn btn-sm btn-tinted" data-mark-paid="${escapeAttr(d.sender_name)}" data-owed="${d.owed}" type="button">Payé</button>
      </div>`,
  });
}

function champPrix(s, colonne, champ, libelle, classe) {
  return `
    <label class="price-field">
      <span class="price-tag"><i class="dot dot-${classe}"></i>${libelle}</span>
      <input class="field price-input" type="number" inputmode="decimal" step="0.5" min="0" value="${s[colonne]}"
             data-sender-id="${s.id}" data-field="${champ}" aria-label="Prix ${libelle} de ${escapeAttr(s.name)}" />
    </label>`;
}

async function loadSenders() {
  const rows = await fetchJSON("/api/senders");
  const box = $("settings-rows");
  // une saisie en cours ne doit pas disparaitre sous le doigt
  if (box.contains(document.activeElement)) return;
  if (!hasChanged("settings", rows)) return;

  rendListe(box, rows, {
    cle: (s) => s.id,
    videHtml: vide("tag", "Aucun expéditeur", "Ajoute le premier ci-dessous."),
    // le nom occupe sa propre ligne : avec trois tarifs editables, tout mettre
    // sur une seule ligne rognait completement le nom de l'expediteur
    html: (s) => `
      <div class="lrow sender-price" data-key="${s.id}">
        <div class="sender-price-head">
          ${avatar(s.name)}
          <div class="lrow-title" title="${escapeAttr(s.name)}">${escapeHtml(s.name)}</div>
          <button class="btn btn-icon btn-sm btn-ghost" data-delete-sender="${s.id}" data-name="${escapeAttr(s.name)}" type="button" aria-label="Supprimer ${escapeAttr(s.name)}">${ico("trash")}</button>
        </div>
        <div class="sender-price-fields">
          ${champPrix(s, "price", "price", "Normal", "normal")}
          ${champPrix(s, "lit_price", "litPrice", "LIT", "lit")}
          ${champPrix(s, "bj_price", "bjPrice", "BJ", "bj")}
        </div>
      </div>`,
  });
  renderMergePairSelects(rows);
}

// Remplit les deux listes deroulantes de fusion en conservant la selection
// courante si les noms existent toujours.
function renderMergePairSelects(rows) {
  for (const id of ["merge-source", "merge-target"]) {
    const select = $(id);
    if (!select) continue;
    const previous = select.value;
    select.innerHTML = rows.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
    if (rows.some((s) => String(s.id) === previous)) select.value = previous;
  }
  // deux fois le meme expediteur ne fusionne rien : la cible part sur un autre
  const source = $("merge-source");
  const cible = $("merge-target");
  if (rows.length > 1 && source.value === cible.value) cible.selectedIndex = source.selectedIndex === 0 ? 1 : 0;
}

async function loadMergeCandidates() {
  const rows = await fetchJSON("/api/senders/merge-candidates");
  if (!hasChanged("mergeCandidates", rows)) return;

  rendListe($("merge-rows"), rows, {
    cle: (s) => s.id,
    videHtml: vide("layers", "Aucun expéditeur pour le moment"),
    html: (s) => `
      <label class="lrow merge-row${s.mergeable ? "" : " is-protected"}" data-key="${s.id}">
        <input type="checkbox" class="check merge-check" value="${s.id}" ${s.mergeable ? "" : "disabled"} aria-label="${escapeAttr(s.name)}" />
        <div class="lrow-main">
          <div class="lrow-title">${escapeHtml(s.name)}</div>
          <div class="lrow-sub">${pluriel(s.colisCount, "colis", "colis")} · ${Math.round(s.pct * 100)} % du CA${s.mergeable ? "" : " · protégé"}</div>
        </div>
      </label>`,
  });
  updateMergeButtonState();
}

function updateMergeButtonState() {
  const checked = document.querySelectorAll(".merge-check:checked").length;
  const btn = $("merge-to-other-btn");
  btn.disabled = checked === 0;
  btn.textContent =
    checked > 0
      ? `Fusionner ${pluriel(checked, "expéditeur", "expéditeurs")} en « Autre »`
      : "Fusionner la sélection en « Autre »";
}

// --- Stock ------------------------------------------------------------------------

const LOW_STOCK_THRESHOLD = 5;
const STOCKS = {
  normal: { valeur: "stock-value", boite: "stock-normal", nom: "normal" },
  bj: { valeur: "stock-bj-value", boite: "stock-bj", nom: "BJ" },
};
// un appui en cours d'envoi : le rafraichissement de fond ne doit pas ecraser
// la valeur deja affichee par une valeur serveur en retard
const stockEnVol = { normal: 0, bj: 0 };
let stockCharge = false;

async function loadStock() {
  rendStock(await fetchJSON("/api/stock"));
}

function rendStock(stocks) {
  const premier = !stockCharge;
  stockCharge = true;
  for (const [kind, s] of Object.entries(STOCKS)) {
    if (stockEnVol[kind]) continue;
    const el = $(s.valeur);
    const value = stocks[kind] || 0;
    const avant = el._valeur;
    if (value === avant) {
      // deja affiche (souvent par l'appui lui-meme) : on ne touche a rien
    } else if (typeof avant === "number" && Math.abs(value - avant) <= 2) {
      el._valeur = value;
      roule(el, entier(value), value - avant);
    } else {
      el._texte = entier(value);
      compte(el, value, { depuis: premier && nouvelleSession ? 0 : undefined, delai: premier ? 520 : 0 });
    }
    $(s.boite).classList.toggle("is-low", value <= LOW_STOCK_THRESHOLD);
  }
}

// Les deux stocks sont independants : dropper un BJ retire du stock BJ, un
// colis normal du stock normal. L'affichage suit le doigt tout de suite, le
// serveur confirme derriere ; en cas d'echec, la valeur revient.
async function adjustStock(delta, kind = "normal") {
  const s = STOCKS[kind];
  const el = $(s.valeur);
  const precedent = typeof el._valeur === "number" ? el._valeur : 0;
  const local = precedent + delta;
  el._valeur = local;
  if (Math.abs(delta) <= 2) roule(el, entier(local), delta);
  else {
    el._valeur = precedent;
    compte(el, local);
  }
  $(s.boite).classList.toggle("is-low", local <= LOW_STOCK_THRESHOLD);

  stockEnVol[kind]++;
  try {
    const stocks = await postJSON("/api/stock/adjust", { delta, kind });
    stockEnVol[kind]--;
    rendStock(stocks);
    return true;
  } catch (err) {
    stockEnVol[kind]--;
    // l'action optimiste a echoue : on revient a ce qu'on avait
    el._valeur = local;
    roule(el, entier(precedent), -delta);
    el._valeur = precedent;
    $(s.boite).classList.toggle("is-low", precedent <= LOW_STOCK_THRESHOLD);
    secoue($(s.boite));
    toast(err.message, "error");
    return false;
  }
}

document.querySelectorAll("[data-stock]").forEach((btn) => {
  btn.addEventListener("click", () => {
    haptique();
    adjustStock(Number(btn.dataset.delta), btn.dataset.stock);
  });
});

document.querySelectorAll("[data-stock-form]").forEach((form) => {
  const input = form.querySelector("input");
  input.addEventListener("input", () => input.classList.remove("invalid"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = Number(input.value);
    if (!n) {
      rejoue(input, "invalid", 1400);
      return;
    }
    const kind = form.dataset.stockForm;
    input.value = "";
    input.blur();
    if (await adjustStock(n, kind)) {
      if (n > 0) eclat($(STOCKS[kind].valeur), { nombre: 10, force: 0.8 });
      toast(`${n > 0 ? "+" : "−"}${entier(Math.abs(n))} au stock ${STOCKS[kind].nom}`);
    }
  });
});

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

// --- Rafraichissement ----------------------------------------------------------

// Tant que le dashboard est ouvert et visible, on previent le serveur : le
// "+N" des notifications compte les colis arrives depuis la derniere fois
// qu'on l'a regarde. Une fois toutes les 30 s suffit pour le "+N".
let dernierVu = 0;
function markSeen(force = false) {
  if (document.visibilityState !== "visible") return;
  // "revenir sur l'app" arrive souvent deux fois (visibilite + focus) : une
  // seule requete suffit
  if (Date.now() - dernierVu < (force ? 2000 : 30000)) return;
  dernierVu = Date.now();
  // le "vu" est celui de CET appareil : les autres gardent leur "+N"
  monAbonnement()
    .then((endpoint) => {
      if (!endpoint) return;
      fetch("/api/push/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      }).catch(() => {});
      // la notification "+N" deja affichee sur cet appareil n'a plus lieu d'etre
      swRegistration?.getNotifications?.({ tag: "colis" }).then((l) => l.forEach((n) => n.close())).catch(() => {});
    })
    .catch(() => {});
}

// Rafraichissement de fond (le tour de 5 s, le retour sur l'app) : deux
// declencheurs qui tombent ensemble ne font qu'un seul rafraichissement.
let dernierRafraichissement = 0;
function rafraichitEnFond() {
  if (Date.now() - dernierRafraichissement < 1500) return;
  dernierRafraichissement = Date.now();
  refreshAll().catch(() => {});
}

// Revenir sur l'app : on previent, et on rafraichit tout de suite plutot que
// d'attendre le prochain tour de 5 s. Les chiffres qui ont bouge pendant
// l'absence montent alors avec leur bulle "+N".
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  markSeen(true);
  rafraichitEnFond();
});
window.addEventListener("focus", () => markSeen(true));

// Ce que chaque ecran relit. Le rafraichissement ne recharge que l'ecran
// affiche. Les rafraichissements de fond n'animent jamais les graphiques : la
// revelation des Stats ne se joue qu'en arrivant sur l'onglet.
const CHARGEMENTS_PAR_VUE = {
  dashboard: () => [loadStats(false), loadStock(), loadSpecialCount()],
  // les chiffres d'abord : ils disent si les revenus ont pu changer
  stats: () => [loadStats(false).then(() => loadRevenueStats(false))],
  colis: () => [loadStats(false), loadDebts(), loadSenders(), loadMergeCandidates()],
  // ailleurs, on guette seulement les nouveaux colis (et la pastille)
  imprime: () => [verifieCommandes()],
  special: () => [verifieCommandes()],
  suivi: () => [verifieCommandes()],
  "suivi-detail": () => [verifieCommandes()],
};

async function verifieCommandes() {
  const s = await fetchJSON("/api/stats", {}, { essais: 1 });
  majPastilleImprime(s.aImprimer);
  // de nouvelles etiquettes : l'onglet Imprime les montre tout de suite
  if (noteEnAttente(s.pendingCount) && currentView === "imprime") loadImprime().catch(() => {});
}

async function refreshAll() {
  // app en arriere-plan : rien a afficher, rien a recharger
  if (document.visibilityState !== "visible") return;
  markSeen();
  const charge = CHARGEMENTS_PAR_VUE[currentView];
  if (!charge) return;
  try {
    await Promise.all(charge());
    enLigne(true);
  } catch (err) {
    // une erreur reseau, c'est le serveur injoignable ; une erreur HTTP, c'est
    // une requete refusee : le site reste en ligne
    enLigne(!(err instanceof ErreurReseau));
    throw err;
  }
}

// Rejoue la revelation animee de la page Stats, avec des donnees fraiches.
async function playStatsReveal(riche = true) {
  await Promise.all([loadStats(true, true, riche), loadRevenueStats(true, true, riche)]).catch(() => {});
}

// --- Gestes du dashboard et des reglages -----------------------------------------

document.addEventListener("click", async (e) => {
  const goto = e.target.closest("[data-goto]");
  if (goto) return switchView(goto.dataset.goto);

  const cible = e.target.closest(
    "[data-drop-sender], [data-drop-carrier], [data-delete-sender], [data-quick-add], [data-quick-remove], [data-mark-paid], .drop-all-btn, .drop-except-lit-btn"
  );
  if (!cible) return;
  const d = cible.dataset;

  if (d.markPaid) {
    const ok = await confirmer({
      titre: `${d.markPaid} a payé ?`,
      message: `${euro(d.owed)} seront marqués comme payés.`,
      action: "Marquer payé",
    });
    if (!ok) return;
    return agir(
      cible,
      async () => {
        await postJSON(`/api/debts/${encodeURIComponent(d.markPaid)}/pay`);
        await refreshAll();
      },
      { succes: `Paiement de ${d.markPaid} enregistré`, eclats: true }
    );
  }

  if (d.dropSender) {
    return agir(
      cible,
      async () => {
        const r = await postJSON(`/api/colis/drop-sender/${encodeURIComponent(d.dropSender)}`);
        await refreshAll();
        return r;
      },
      { succes: (r) => `${pluriel(r.count, "colis dropé", "colis dropés")} pour ${d.dropSender}`, eclats: true }
    );
  }

  if (d.dropCarrier) {
    const nom = CARRIER_LABELS[d.dropCarrier] || d.dropCarrier;
    return agir(
      cible,
      async () => {
        const r = await postJSON(`/api/colis/drop-carrier/${encodeURIComponent(d.dropCarrier)}`);
        await refreshAll();
        return r;
      },
      { succes: (r) => `${pluriel(r.count, "colis dropé", "colis dropés")} · ${nom}`, eclats: true }
    );
  }

  if (d.deleteSender) {
    const ok = await confirmer({
      titre: `Supprimer ${d.name} ?`,
      message: "Ses tarifs personnalisés seront perdus. Ses colis restent dans l'historique.",
      action: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    return agir(
      cible,
      async () => {
        await sortLigne(cible.closest(".lrow"));
        await fetchJSON(`/api/senders/${d.deleteSender}`, { method: "DELETE" });
        await refreshAll();
      },
      { succes: `${d.name} supprimé` }
    );
  }

  if (d.quickAdd || d.quickRemove) {
    // un double appui ne doit pas ajouter deux colis
    if (cible.dataset.verrou) return;
    cible.dataset.verrou = "1";
    const nom = d.quickAdd || d.quickRemove;
    const ajout = Boolean(d.quickAdd);
    haptique();
    try {
      await postJSON(`/api/colis/${ajout ? "quick-add" : "quick-remove"}/${encodeURIComponent(nom)}`);
      toast(`${ajout ? "+1" : "−1"} colis · ${nom}`);
    } catch (err) {
      secoue(cible);
      if (!ajout) toast(`Aucun colis en attente pour ${nom}`, "info");
      else toast(err.message, "error");
    } finally {
      delete cible.dataset.verrou;
    }
    return refreshAll().catch(() => {});
  }

  if (cible.classList.contains("drop-except-lit-btn")) {
    // les LIT partent sur une autre imprimante, souvent un autre jour
    const ok = await confirmer({
      titre: "Tout dropper sauf les LIT ?",
      message: "Tous les colis en attente seront marqués dropés, sauf les LIT.",
      action: "Dropper",
    });
    if (!ok) return;
    return agir(
      cible,
      async () => {
        const r = await postJSON("/api/colis/drop-all-except-lit");
        await refreshAll();
        return r;
      },
      {
        succes: (r) => {
          if (r.count === 0) {
            toast("Aucun colis à dropper en dehors des LIT.", "info");
            return null;
          }
          return pluriel(r.count, "colis dropé", "colis dropés");
        },
        eclats: { nombre: 16 },
      }
    );
  }

  if (cible.classList.contains("drop-all-btn")) {
    const { count, value } = bagSummary;
    const ok = await confirmer({
      titre: "Tout marquer comme dropé ?",
      message: `${pluriel(count, "colis en attente", "colis en attente")} · ${euro(value)}.`,
      action: "Tout dropper",
    });
    if (!ok) return;
    return agir(
      cible,
      async () => {
        const r = await postJSON("/api/colis/drop-all");
        await refreshAll();
        return r;
      },
      { succes: (r) => pluriel(r.count, "colis dropé", "colis dropés"), eclats: { nombre: 20, force: 1.3 } }
    );
  }
});

// Prix d'un expediteur : enregistre a la sortie du champ, avec un eclair
// violet pour dire que c'est fait.
document.addEventListener("change", async (e) => {
  if (e.target.classList.contains("merge-check")) {
    if (e.target.checked) haptique();
    updateMergeButtonState();
    return;
  }

  const input = e.target;
  const senderId = input.dataset.senderId;
  if (!senderId) return;

  const allowedFields = ["price", "litPrice", "bjPrice"];
  const field = allowedFields.includes(input.dataset.field) ? input.dataset.field : "price";
  const valeur = Number(String(input.value).replace(",", "."));
  if (input.value === "" || !Number.isFinite(valeur) || valeur < 0) {
    rejoue(input, "invalid", 1400);
    return;
  }
  try {
    await fetchJSON(`/api/senders/${senderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: valeur }),
    });
    rejoue(input, "is-saved", 1100);
    haptique();
    refreshAll().catch(() => {});
  } catch (err) {
    rejoue(input, "invalid", 1400);
    toast(err.message, "error");
  }
});

$("merge-pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bouton = e.submitter || e.target.querySelector("[type=submit]");
  const source = $("merge-source");
  const target = $("merge-target");
  const sourceId = Number(source.value);
  const targetId = Number(target.value);
  if (!sourceId || !targetId) return;
  if (sourceId === targetId) {
    secoue(bouton);
    toast("Choisis deux expéditeurs différents.", "error");
    return;
  }
  const sourceName = source.options[source.selectedIndex].textContent;
  const targetName = target.options[target.selectedIndex].textContent;
  const ok = await confirmer({
    titre: `Fusionner « ${sourceName} » dans « ${targetName} » ?`,
    message: `Tous ses colis et gains seront transférés, et « ${sourceName} » sera supprimé.`,
    action: "Fusionner",
    danger: true,
  });
  if (!ok) return;
  await agir(
    bouton,
    async () => {
      const r = await postJSON("/api/senders/merge", { sourceId, targetId });
      renderCache.clear();
      await refreshAll();
      return r;
    },
    { succes: (r) => `${pluriel(r.moved, "colis transféré", "colis transférés")} vers « ${r.target} »`, eclats: true }
  );
});

$("merge-to-other-btn").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  const senderIds = [...document.querySelectorAll(".merge-check:checked")].map((el) => Number(el.value));
  if (senderIds.length === 0) return;
  const ok = await confirmer({
    titre: `Regrouper ${pluriel(senderIds.length, "expéditeur", "expéditeurs")} en « Autre » ?`,
    message: "Leur historique de colis sera regroupé. Cette action est irréversible.",
    action: "Regrouper",
    danger: true,
  });
  if (!ok) return;
  await agir(
    bouton,
    async () => {
      await postJSON("/api/senders/merge-to-other", { senderIds });
      await refreshAll();
    },
    { succes: "Expéditeurs regroupés en « Autre »" }
  );
});

$("add-sender-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = $("new-sender-name").value.trim();
  const price = Number($("new-sender-price").value);
  const litPrice = Number($("new-sender-lit-price").value);
  const bjPrice = Number($("new-sender-bj-price").value);
  await agir(
    e.submitter || form.querySelector("[type=submit]"),
    async () => {
      await postJSON("/api/senders", { name, price, litPrice, bjPrice });
      form.reset();
      await refreshAll();
    },
    { succes: `${name} ajouté`, eclats: true }
  );
});

// --- Reglage du son ----------------------------------------------------------------
function afficheReglageSon() {
  const actif = sonActif();
  $("son-switch").setAttribute("aria-checked", String(actif));
  const etat = $("son-state");
  etat.textContent = actif ? "Activé" : "Désactivé";
  etat.classList.toggle("is-on", actif);
}
afficheReglageSon();
$("son-switch").addEventListener("click", () => {
  const actif = !sonActif();
  localStorage.setItem("drop.son", actif ? "1" : "0");
  afficheReglageSon();
  haptique();
  if (actif) chaChing({ force: true });
});
$("son-test").addEventListener("click", (e) => {
  fait(e.currentTarget);
  chaChing({ force: true });
});

// --- Notifications push -----------------------------------------------------------
// Sur iOS, le push web n'existe QUE dans une PWA installee sur l'ecran
// d'accueil (Safari 16.4+). Dans un onglet Safari classique, PushManager
// n'existe simplement pas : on affiche alors la marche a suivre.
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
let swRegistration = null;
let pushError = null;

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

// l'adresse d'abonnement de cet appareil : c'est elle qui l'identifie
async function monAbonnement() {
  if (!pushSupported) return null;
  const sub = await currentSubscription();
  return sub ? sub.endpoint : null;
}

async function currentSubscription() {
  if (!swRegistration) return null;
  return swRegistration.pushManager.getSubscription();
}

async function updatePushUI() {
  const panel = $("push-panel");
  if (!panel) return;
  const etat = $("push-state");
  const hint = $("push-hint");
  const sw = $("push-switch");
  const extra = $("push-extra");
  const dis = (texte) => {
    hint.textContent = texte;
    hint.hidden = !texte;
  };

  panel.hidden = false;

  const indisponible = (texte) => {
    etat.textContent = "Indisponible";
    etat.classList.remove("is-on");
    sw.disabled = true;
    sw.setAttribute("aria-checked", "false");
    extra.hidden = true;
    dis(texte);
  };

  if (!pushSupported) {
    return indisponible(
      isIOS
        ? "Sur iPhone, les notifications ne marchent que si le site est ajouté à l'écran d'accueil : bouton Partager → « Sur l'écran d'accueil », puis rouvre l'app depuis cette icône."
        : "Ce navigateur ne gère pas les notifications push."
    );
  }
  if (pushError) return indisponible(`Les notifications n'ont pas pu démarrer sur cet appareil (${pushError}).`);

  const sub = await currentSubscription();
  const granted = Notification.permission === "granted" && Boolean(sub);
  const bloquees = Notification.permission === "denied";

  etat.textContent = granted ? "Activées sur cet appareil" : bloquees ? "Bloquées" : "Désactivées";
  etat.classList.toggle("is-on", granted);
  sw.disabled = bloquees;
  sw.setAttribute("aria-checked", String(granted));
  extra.hidden = !granted;

  dis(
    bloquees
      ? isIOS
        ? "Notifications refusées. Réglages iOS → Notifications → DROP pour les réautoriser."
        : "Notifications refusées. Réautorise-les dans les réglages du navigateur pour ce site."
      : ""
  );
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
  await postJSON("/api/push/subscribe", {
    endpoint: json.endpoint,
    keys: json.keys,
    label: `${isIOS ? "iOS" : "web"}${isStandalone ? " (app)" : ""}`,
  });
}

async function initPush() {
  if (!pushSupported) return updatePushUI();
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    // iOS revoque parfois l'abonnement en silence : on se reabonne a chaque
    // ouverture tant que la permission est accordee.
    if (Notification.permission === "granted") await subscribePush();
    // l'appareil est identifie : on peut dire au serveur qu'il a regarde
    markSeen(true);
  } catch (err) {
    console.error("[push] init", err);
    pushError = err.message || String(err);
  }
  updatePushUI();
}

$("push-switch").addEventListener("click", async (e) => {
  const sw = e.currentTarget;
  const actif = sw.getAttribute("aria-checked") === "true";
  sw.setAttribute("aria-checked", String(!actif));
  sw.setAttribute("aria-busy", "true");
  haptique();
  try {
    if (actif) {
      const sub = await currentSubscription();
      if (sub) {
        await postJSON("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      toast("Notifications désactivées");
    } else {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        await subscribePush();
        eclat(sw, { nombre: 8, force: 0.7 });
        toast("Notifications activées");
      }
    }
  } catch (err) {
    toast(`Impossible d'activer les notifications : ${err.message}`, "error");
  } finally {
    sw.removeAttribute("aria-busy");
    await updatePushUI();
  }
});

$("push-test").addEventListener("click", (e) =>
  agir(
    e.currentTarget,
    async () => {
      const r = await postJSON("/api/push/test");
      if (r.sent === 0) throw new Error("Aucun appareil abonné n'a pu être joint.");
    },
    { succes: "Notification de test envoyée" }
  )
);

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

// --- Onglet Imprime ---------------------------------------------------------------
// Meme chaine que /imprime sur Telegram : memes etiquettes, meme mise en page,
// meme marquage. Seule la sortie change -- le PDF s'ouvre dans un onglet, et
// c'est le navigateur qui imprime.

const impColis = new Map(); // id -> colis tel que charge, pour pre-remplir
let impTransporteurs = [];
// le dernier contenu de chaque categorie depliee : il s'affiche aussitot au
// rafraichissement, sans repli ni squelette, puis se met a jour
const impMemoire = new Map();

async function loadImprime() {
  let aFaire;
  let deja;
  try {
    [aFaire, deja] = await Promise.all([fetchJSON("/api/print/resume?scope=new"), fetchJSON("/api/print/resume?scope=printed")]);
  } catch (err) {
    // un onglet muet ne dit pas s'il est vide ou casse : on le dit (sans
    // effacer une liste deja affichee pour une coupure passagere)
    if ($("imp-categories").dataset.etat !== "liste") {
      $("imp-total").textContent = "Erreur de chargement";
      $("imp-categories").dataset.etat = "erreur";
      $("imp-categories").innerHTML = vide("alert", "Liste indisponible", escapeHtml(err.message));
    }
    return;
  }

  impTransporteurs = aFaire.transporteurs || [];
  $("imp-total").textContent =
    aFaire.total > 0
      ? `${pluriel(aFaire.total, "étiquette", "étiquettes")} à imprimer${aFaire.noted > 0 ? ` · ${pluriel(aFaire.noted, "annotée", "annotées")}` : ""}`
      : "Rien en attente";
  majPastilleImprime(aFaire.total);

  // "Tout" ne couvre que le thermique 4x6 : les LIT sortent sur le rouleau
  // 210 mm, dans un PDF qui ne se melange pas au reste.
  const thermiques = aFaire.categories.filter((c) => !c.roll).reduce((sum, c) => sum + c.count, 0);
  $("imp-all").disabled = thermiques === 0;
  const compteur = $("imp-all-count");
  if (compteur.textContent !== (thermiques > 0 ? entier(thermiques) : "")) {
    compteur.textContent = thermiques > 0 ? entier(thermiques) : "";
    rejoue(compteur, "is-bump", 600);
  }

  renderCategories("imp-categories", aFaire.categories, "new");
  $("imp-printed-count").textContent = deja.total > 0 ? pluriel(deja.total, "étiquette", "étiquettes") : "Aucune";
  renderCategories("imp-printed", deja.categories, "printed");
  prechargeCategories([aFaire, deja]).catch(() => {});
}

// Les categories deja affichees sont mises a jour en place (compte, notes) :
// rien n'est reconstruit, donc une categorie depliee reste depliee, un appui
// en cours n'est jamais perdu, et seules les vraies nouveautes bougent.
const impOuvertes = new Set(); // "scope:code" des categories depliees

function renderCategories(cible, categories, scope) {
  const box = $(cible);

  if (!categories || categories.length === 0) {
    if (box.dataset.etat !== "vide") {
      box.dataset.etat = "vide";
      box.innerHTML =
        scope === "new"
          ? vide("check", "Tout est imprimé", "Les nouvelles étiquettes apparaîtront ici.", true)
          : vide("printer", "Aucune étiquette imprimée en attente");
    }
    return;
  }
  if (box.dataset.etat !== "liste") {
    box.dataset.etat = "liste";
    box.innerHTML = "";
  }

  const existantes = new Map(
    [...box.querySelectorAll(":scope > .imp-cat:not(.is-leaving)")].map((el) => [el.dataset.cat, el])
  );
  const ordre = categories.map((c, i) => {
    let el = existantes.get(c.code);
    if (el) existantes.delete(c.code);
    else el = creeCategorie(c, scope, i);
    majCategorie(el, c);
    return el;
  });
  // une categorie videe s'en va en se repliant
  for (const el of existantes.values()) sortCategorie(el);
  let precedent = null;
  for (const el of ordre) {
    const attendu = precedent ? precedent.nextElementSibling : box.firstElementChild;
    if (el !== attendu) box.insertBefore(el, attendu);
    precedent = el;
    // une categorie deja depliee se remet a jour derriere, sans se refermer
    if (el.classList.contains("open") && !el.classList.contains("is-new")) fillCategory(el);
  }
}

function creeCategorie(c, scope, rang) {
  const cle = `${scope}:${c.code}`;
  const ouverte = impOuvertes.has(cle);
  const modele = document.createElement("template");
  modele.innerHTML = `<div class="imp-cat carrier is-new${ouverte ? " open" : ""}" style="--n:${Math.min(rang, 8)}" data-carrier="${escapeAttr(c.code)}" data-cat="${escapeAttr(c.code)}" data-scope="${scope}">
      <div class="imp-cat-head" role="button" tabindex="0" aria-expanded="${ouverte}">
        <span class="carrier-dot"></span>
        <span class="imp-cat-name"></span>
        <span class="imp-cat-noted" hidden>${ico("note")}<b></b></span>
        <span class="imp-cat-count"></span>
        <button class="btn btn-icon btn-sm btn-ghost" data-print-cat="${escapeAttr(c.code)}" data-scope="${scope}" type="button" title="Imprimer">${ico("printer")}</button>
        ${ico("chevron-down", "imp-chevron")}
      </div>
      <div class="imp-body"><div class="imp-list">${impMemoire.get(cle)?.html || ""}</div></div>
    </div>`;
  const el = modele.content.firstElementChild;
  el.addEventListener("animationend", () => el.classList.remove("is-new"), { once: true });
  if (ouverte) fillCategory(el);
  return el;
}

function majCategorie(el, c) {
  const nom = el.querySelector(".imp-cat-name");
  if (nom.textContent !== c.label) nom.textContent = c.label;
  el.querySelector("[data-print-cat]").setAttribute("aria-label", `Imprimer ${c.label}`);
  el.classList.toggle("noted", c.noted > 0);
  const note = el.querySelector(".imp-cat-noted");
  note.hidden = !c.noted;
  note.title = pluriel(c.noted, "colis annoté", "colis annotés");
  note.querySelector("b").textContent = c.noted || "";
  const compte = el.querySelector(".imp-cat-count");
  const texte = entier(c.count);
  if (compte.textContent !== texte) {
    const avant = compte.textContent;
    compte.textContent = texte;
    if (avant) rejoue(compte, "is-bump", 560);
  }
  // le nombre a change : la liste memorisee n'est plus a jour
  const memoire = impMemoire.get(`${el.dataset.scope}:${c.code}`);
  if (memoire && memoire.ids.length !== c.count) memoire.perime = true;
}

function sortCategorie(el) {
  el.classList.add("is-leaving");
  impOuvertes.delete(`${el.dataset.scope}:${el.dataset.cat}`);
  sortLigne(el).then(() => el.remove());
}

function basculeCategorie(cat) {
  const cle = `${cat.dataset.scope}:${cat.dataset.cat}`;
  const ouverte = cat.classList.toggle("open");
  cat.querySelector(".imp-cat-head").setAttribute("aria-expanded", String(ouverte));
  if (ouverte) impOuvertes.add(cle);
  else impOuvertes.delete(cle);
  haptique();
  if (ouverte) fillCategory(cat);
}

// Une ligne qui s'en va glisse de cote, puis l'espace qu'elle laissait se
// referme : on voit ce qui part, et la liste se resserre sans sauter.
async function sortLigne(ligne) {
  if (!ligne || prefersReducedMotion || !ligne.animate) return;
  const h = ligne.offsetHeight;
  await ligne
    .animate(
      [
        { opacity: 1, transform: "none", filter: "blur(0)" },
        { opacity: 0, transform: "translateX(40px) scale(0.96)", filter: "blur(4px)" },
      ],
      { duration: 240, easing: "cubic-bezier(0.55, 0, 0.75, 0.2)", fill: "forwards" }
    )
    .finished.catch(() => {});
  await ligne
    .animate(
      [
        { height: `${h}px`, marginTop: getComputedStyle(ligne).marginTop, paddingTop: getComputedStyle(ligne).paddingTop, paddingBottom: getComputedStyle(ligne).paddingBottom },
        { height: "0px", marginTop: "-6px", paddingTop: "0px", paddingBottom: "0px" },
      ],
      { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }
    )
    .finished.catch(() => {});
}

// Deplier une categorie charge sa liste : inutile de tout descendre d'avance.
document.addEventListener("click", async (e) => {
  const head = e.target.closest(".imp-cat-head");
  if (head && !e.target.closest("[data-print-cat]")) return basculeCategorie(head.parentElement);

  const printCat = e.target.closest("[data-print-cat]");
  if (printCat) return lancerImpression(printCat, { categorie: printCat.dataset.printCat, scope: printCat.dataset.scope });

  const printOne = e.target.closest("[data-print-one]");
  if (printOne) return lancerImpression(printOne, { ids: [Number(printOne.dataset.printOne)], scope: printOne.dataset.scope });

  const edite = e.target.closest("[data-edit-colis]");
  if (edite) return ouvreEdition(Number(edite.dataset.editColis));

  if (e.target.closest("[data-edit-cancel]")) return fermeEdition(e.target.closest(".imp-edit"));

  const drope = e.target.closest("[data-drop-colis]");
  if (drope) {
    const c = impColis.get(Number(drope.dataset.dropColis));
    return agir(
      drope,
      async () => {
        await postJSON(`/api/print/colis/${drope.dataset.dropColis}/drop`);
        eclat(drope, { nombre: 12 });
        await sortLigne(drope.closest(".imp-row"));
        await loadImprime();
      },
      { succes: `Colis dropé${c ? ` · ${euro(c.price)}` : ""}` }
    );
  }

  const supprime = e.target.closest("[data-del-colis]");
  if (supprime) {
    const ok = await confirmer({
      titre: "Retirer ce colis ?",
      message: "Son fichier sera aussi effacé sur Telegram.",
      action: "Retirer",
      danger: true,
    });
    if (!ok) return;
    return agir(
      supprime,
      async () => {
        await fetchJSON(`/api/print/colis/${supprime.dataset.delColis}`, { method: "DELETE" });
        await sortLigne(supprime.closest(".imp-row"));
        await loadImprime();
      },
      { succes: "Colis retiré" }
    );
  }
});

document.addEventListener("keydown", (e) => {
  const head = e.target.closest?.(".imp-cat-head");
  if (!head || e.target !== head || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  basculeCategorie(head.parentElement);
});

// Charge les colis d'une categorie et prepare leur HTML, sans toucher a la
// page. Une seule requete a la fois par categorie.
const impEnCours = new Map();
function chargeColis(code, scope) {
  const cle = `${scope}:${code}`;
  if (impEnCours.has(cle)) return impEnCours.get(cle);
  const promesse = fetchJSON(`/api/print/colis?categorie=${encodeURIComponent(code)}&scope=${scope}`)
    .then(({ colis }) => {
      for (const c of colis) impColis.set(c.id, c);
      const precedente = impMemoire.get(cle);
      const memoire = { html: colis.length ? lignesColis(colis, scope) : "", ids: colis.map((c) => c.id), connues: precedente?.ids || [] };
      impMemoire.set(cle, memoire);
      return memoire;
    })
    .finally(() => impEnCours.delete(cle));
  impEnCours.set(cle, promesse);
  return promesse;
}

// Deplier une categorie montre aussitot sa liste memorisee (prechargee a
// l'ouverture de l'onglet) : le depliage part avec la vraie hauteur, sans
// squelette ni saut. La liste se met a jour derriere si elle a change.
async function fillCategory(cat) {
  const liste = cat.querySelector(".imp-list");
  const { cat: code, scope } = cat.dataset;
  const cle = `${scope}:${code}`;
  const deja = impMemoire.get(cle);
  if (deja && liste.dataset.html !== deja.html && !liste.querySelector(".imp-edit")) poseListe(liste, deja, false);
  if (!deja && !liste.children.length) liste.innerHTML = squelettes(2);
  if (deja && !deja.perime && liste.dataset.html === deja.html) {
    // a jour : on verifie quand meme en fond, sans rien bloquer
    chargeColis(code, scope).then((m) => cat.isConnected && poseListe(liste, m, true)).catch(() => {});
    return;
  }
  try {
    poseListe(liste, await chargeColis(code, scope), true);
  } catch (err) {
    if (!deja) liste.innerHTML = vide("alert", "Liste indisponible", escapeHtml(err.message));
  }
}

function poseListe(liste, memoire, anime) {
  // rien de neuf : pas une ecriture dans la page
  if (liste.dataset.html === memoire.html) return;
  // un formulaire d'edition ouvert ne doit pas sauter
  if (liste.querySelector(".imp-edit")) return;
  liste.dataset.html = memoire.html;
  liste.innerHTML = memoire.html || vide("inbox", "Vide");
  if (!anime) return;
  const connues = new Set(memoire.connues);
  let n = 0;
  for (const ligne of liste.querySelectorAll(".imp-row")) {
    if (connues.has(Number(ligne.dataset.row))) continue;
    ligne.classList.add("arrive");
    ligne.style.setProperty("--n", Math.min(n++, 10));
  }
}

// Une etiquette deja imprimee n'a plus besoin d'etre supprimee d'ici : elle
// a besoin d'etre dropee quand on l'a postee, colis par colis.
function lignesColis(colis, scope) {
  const imprimee = scope === "printed";
  return colis
    .map(
      (c) => `<div class="imp-row${c.note ? " noted" : ""}" data-row="${c.id}">
        <div class="imp-row-main">
          <div class="imp-row-name">${
            c.special
              ? `<span class="imp-num${c.special.code ? "" : " sans-code"}" title="${
                  c.special.code ? "Code-barre lié" : "Code-barre pas encore arrivé"
                }">#${c.special.numero}${ico("key")}${c.special.code ? "" : "?"}</span>`
              : ""
          }${escapeHtml(c.fileName || `colis #${c.id}`)}</div>
          <div class="imp-row-sub">${escapeHtml(c.sender)} · ${euro(c.price)}${c.kind === "image" ? " · photo" : ""}</div>
          ${c.note ? `<div class="imp-row-note">${ico("note")}<span>${escapeHtml(c.note)}</span></div>` : ""}
        </div>
        <div class="imp-row-actions">
          <button class="btn btn-icon btn-sm btn-ghost" data-edit-colis="${c.id}" type="button" aria-label="Modifier" title="Modifier">${ico("edit")}</button>
          <button class="btn btn-icon btn-sm btn-ghost" data-print-one="${c.id}" data-scope="${scope}" type="button" aria-label="Imprimer" title="Imprimer">${ico("printer")}</button>
          ${
            imprimee
              ? `<button class="btn btn-sm btn-tinted imp-drop" data-drop-colis="${c.id}" type="button">${ico("send")}<span>Drop</span></button>`
              : `<button class="btn btn-icon btn-sm btn-ghost" data-del-colis="${c.id}" type="button" aria-label="Retirer" title="Retirer">${ico("trash")}</button>`
          }
        </div>
      </div>`
    )
    .join("");
}

// A l'ouverture de l'onglet, les listes se chargent en fond, quelques-unes a
// la fois : deplier une categorie est ensuite instantane.
async function prechargeCategories(resumes) {
  const aCharger = resumes.flatMap(({ scope, categories }) =>
    (categories || []).filter((c) => {
      const m = impMemoire.get(`${scope}:${c.code}`);
      return !m || m.perime || m.ids.length !== c.count;
    }).map((c) => [c.code, scope])
  );
  const travail = async () => {
    while (aCharger.length) {
      const [code, scope] = aCharger.shift();
      await chargeColis(code, scope).catch(() => {});
    }
  };
  await Promise.all([travail(), travail(), travail()]);
}

// --- Edition d'un colis ------------------------------------------------------------
// Prix, transporteur, note : les trois choses qu'on corrige a la main. Le
// formulaire se deplie sous la ligne, sans quitter la liste.

function fermeEdition(form) {
  if (!form) return;
  if (prefersReducedMotion) return form.remove();
  form.classList.add("is-leaving");
  setTimeout(() => form.remove(), 200);
}

function ouvreEdition(id) {
  const ligne = document.querySelector(`.imp-row[data-row="${id}"]`);
  if (!ligne) return;
  // un deuxieme appui referme
  const deja = ligne.nextElementSibling;
  if (deja && deja.classList.contains("imp-edit")) return fermeEdition(deja);
  document.querySelectorAll(".imp-edit").forEach(fermeEdition);
  haptique();

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
        <label class="field-label">
          <span>Prix €</span>
          <input class="field" name="price" type="text" inputmode="decimal" value="${escapeAttr(String(c.price).replace(".", ","))}" />
        </label>
        <label class="field-label">
          <span>Transporteur</span>
          <select class="field" name="carrier">${options}</select>
        </label>
      </div>
      <label class="field-label">
        <span>Note</span>
        <textarea class="field" name="note" rows="2" placeholder="fragile, avant 14h…">${escapeHtml(c.note || "")}</textarea>
      </label>
      <div class="imp-edit-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-edit-cancel>Annuler</button>
        <button type="submit" class="btn btn-sm btn-primary">Enregistrer</button>
      </div>
    </form>`
  );
  const champ = ligne.nextElementSibling.querySelector("input");
  champ.addEventListener("input", () => champ.classList.remove("invalid"));
  champ.focus({ preventScroll: true });
  ligne.nextElementSibling.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion ? "auto" : "smooth" });
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
    rejoue(form.querySelector("input[name=price]"), "invalid", 1400);
    return;
  }
  if (Number(prix) !== c.price) corps.price = Number(prix);

  const transporteur = champs.get("carrier") || null;
  if (transporteur !== (c.carrier || null)) corps.carrier = transporteur;

  const note = String(champs.get("note")).trim();
  if (note !== (c.note || "")) corps.note = note;

  if (Object.keys(corps).length === 0) return fermeEdition(form);

  await agir(
    form.querySelector("[type=submit]"),
    async () => {
      const res = await fetchJSON(`/api/print/colis/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      });
      // corriger un transporteur apprend au bot, comme /transporteur : autant
      // dire ce qu'il a retenu, et s'il a reclasse d'autres colis au passage
      if (res.appris) signaleImprime(res.appris);
      fermeEdition(form);
      await attends(200);
      await loadImprime();
    },
    { succes: "Colis modifié" }
  );
}

function signaleImprime(texte) {
  const box = $("imp-notice");
  box.innerHTML = `${ico("bolt")}<span></span>`;
  box.lastChild.textContent = texte;
  box.hidden = false;
  rejoue(box, "revele", 900);
  clearTimeout(signaleImprime.minuteur);
  signaleImprime.minuteur = setTimeout(() => masque(box), 7000);
}

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-edit-form]");
  if (!form) return;
  e.preventDefault();
  enregistreEdition(form);
});

// Sur ordinateur, l'onglet s'ouvre AVANT la construction du PDF : un
// navigateur ne laisse ouvrir une fenetre que pendant le clic, pas apres un
// aller-retour reseau. Sur iPhone, cet onglet vide recouvrait toute l'app
// pendant la construction (l'app semblait bloquee) : on construit d'abord,
// puis un message "PDF pret" ouvre le PDF d'un appui.
async function lancerImpression(bouton, corps) {
  if (bouton.getAttribute("aria-busy") === "true") return;
  const onglet = surIPhone ? null : window.open("", "_blank");
  occupe(bouton, true);
  haptique();

  let res = null;
  try {
    res = await postJSON("/api/print/build", corps, { delai: 120000 });
  } catch (err) {
    if (onglet) onglet.close();
    occupe(bouton, false);
    secoue(bouton);
    toast(`Impression impossible : ${err.message}`, "error");
    return;
  }

  // rendre son etat au bouton AVANT le rafraichissement : dans l'autre ordre,
  // le compte revient alors qu'il ne reste plus rien
  occupe(bouton, false);
  fait(bouton);
  eclat(bouton, { nombre: 10, force: 0.9 });

  if (onglet) onglet.location = res.url;
  else if (!surIPhone) window.location = res.url; // fenetre bloquee : on y va quand meme

  // Un bloqueur de fenetres avale parfois l'onglet sans rien dire. Le lien
  // reste affiche : il y a toujours quelque chose a toucher pour ouvrir le
  // PDF, et il sert aussi a le rouvrir sans le reconstruire.
  const detail = res.roll
    ? `${pluriel(res.count, "étiquette", "étiquettes")} · ${res.lengthMm} mm de rouleau`
    : `${pluriel(res.count, "étiquette", "étiquettes")} · ${pluriel(res.pages, "page", "pages")}`;
  const lien = $("imp-last");
  lien.href = res.url;
  lien.innerHTML = `${ico("file")}<span>Rouvrir le PDF · ${escapeHtml(detail)}</span>${ico("external")}`;
  montre(lien);
  if (surIPhone) toast(`PDF prêt · ${detail} · Ouvrir`, "success", 9000, { lien: res.url });
  else toast(`PDF prêt · ${detail}`);

  await loadImprime();
}

$("imp-all").addEventListener("click", (e) => lancerImpression(e.currentTarget, { categorie: "*", scope: "new" }));

// --- Mode locker ------------------------------------------------------------------
// Devant le locker : on prend un colis, on lit le "#3" imprime dans la bande de
// son etiquette, le telephone montre le code-barre #3. La visionneuse suit
// l'ordre des numeros, donc l'ordre de la liasse imprimee.

let lockerPaires = [];
let lockerIndex = 0;
let lockerVerrou = null;

async function loadSpecialCount() {
  try {
    const { paires } = await fetchJSON("/api/special/paires");
    const badge = $("special-link-count");
    const texte = paires.length ? String(paires.length) : "";
    if (badge.textContent !== texte) {
      badge.textContent = texte;
      if (texte) rejoue(badge, "is-bump", 600);
    }
  } catch {
    // le compteur est un confort : une erreur ici ne doit rien casser
  }
}

async function loadSpecial() {
  const liste = $("special-list");
  if (!liste.children.length) liste.innerHTML = squelettes(2);
  let paires;
  try {
    ({ paires } = await fetchJSON("/api/special/paires"));
  } catch (err) {
    liste.innerHTML = vide("alert", "Liste indisponible", escapeHtml(err.message));
    return;
  }

  lockerPaires = paires;
  const avecCode = paires.filter((p) => p.code).length;
  $("special-count").textContent = paires.length
    ? `${pluriel(paires.length, "paire", "paires")} · ${pluriel(avecCode, "code arrivé", "codes arrivés")}`
    : "Aucun code en attente";
  $("special-link-count").textContent = paires.length ? String(paires.length) : "";
  const depart = $("special-start");
  depart.disabled = paires.length === 0;
  depart.lastElementChild.textContent = paires.length ? `Commencer au #${paires[0].numero}` : "Commencer";

  if (paires.length === 0) {
    liste.innerHTML = vide("key", "Aucun code en attente", "Les codes postés dans le topic spécial arriveront ici.");
    return;
  }

  // une paire incomplete se voit tout de suite : c'est avant de partir qu'il
  // faut s'en rendre compte, pas devant le locker
  liste.innerHTML = paires
    .map((p, i) => {
      // un code seul n'attend aucun PDF : il n'est pas incomplet
      const manque = !p.code ? "Code manquant" : !p.colis && !p.seul ? "PDF manquant" : "";
      const etat = manque
        ? `<span class="sp-state ko">${manque}</span>`
        : p.seul
          ? `<span class="sp-state">Code seul</span>`
          : p.colis?.printed
            ? `<span class="sp-state ok">Imprimé</span>`
            : `<span class="sp-state">À imprimer</span>`;
      return `<button class="sp-card${manque ? " incomplete" : ""} is-new" style="--n:${Math.min(i, 10)}" data-locker="${i}" type="button">
        <span class="sp-top"><span class="sp-num">#${p.numero}</span>${etat}</span>
        ${
          p.code
            ? `<img class="sp-thumb" loading="lazy" src="/api/special/code/${p.id}" alt="Code #${p.numero}" />`
            : `<span class="sp-thumb sp-thumb-vide">${ico("key")}</span>`
        }
        <span class="sp-name">${escapeHtml(p.colis?.fileName || (p.seul ? "Sans colis" : "PDF pas encore arrivé"))}</span>
        <span class="sp-sub">${escapeHtml(p.sender || "")}</span>
      </button>`;
    })
    .join("");
}

function ouvreLocker(index) {
  if (lockerPaires.length === 0) return;
  lockerIndex = Math.max(0, Math.min(index, lockerPaires.length - 1));
  $("locker").hidden = false;
  document.body.classList.add("locker-ouvert");
  haptique();
  // Plein ecran quand le navigateur le permet (Android) : la barre d'adresse
  // et celle du systeme laissent leur place au code. Sur iPhone, l'app
  // ajoutee a l'ecran d'accueil est deja en plein ecran.
  document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch(() => {});
  afficheLocker(0);
  garderEcranAllume();
}

function fermeLocker() {
  $("locker").hidden = true;
  document.body.classList.remove("locker-ouvert");
  if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
  if (lockerVerrou) lockerVerrou.release().catch(() => {});
  lockerVerrou = null;
  loadSpecial();
}

// Le code occupe toute la zone libre. Un code-barre, plus large que haut, est
// tourne d'un quart de tour quand le telephone est tenu droit : il court alors
// sur toute la hauteur de l'ecran au lieu d'une bande de la largeur -- a peu
// pres deux fois plus grand, et c'est la taille des barres qui compte pour le
// lecteur. Un QR code, carre, reste droit.
function ajusteCode() {
  const img = $("locker-img");
  const zone = $("locker-code");
  if (img.hidden || !img.naturalWidth) return;

  const largeur = zone.clientWidth;
  const hauteur = zone.clientHeight;
  const ratio = img.naturalWidth / img.naturalHeight;
  const tourner = ratio > 1.15 && hauteur > largeur;

  // dimensions de l'image AVANT rotation : tournee, sa largeur court le long
  // de la hauteur de la zone
  const longueurDispo = tourner ? hauteur : largeur;
  const epaisseurDispo = tourner ? largeur : hauteur;
  let w = longueurDispo;
  let h = w / ratio;
  if (h > epaisseurDispo) {
    h = epaisseurDispo;
    w = h * ratio;
  }
  img.style.width = `${Math.floor(w)}px`;
  img.style.height = `${Math.floor(h)}px`;
  img.classList.toggle("tourne", tourner);
}

$("locker-img").addEventListener("load", ajusteCode);
window.addEventListener("resize", () => {
  if (!$("locker").hidden) ajusteCode();
});

// `sens` : d'ou arrive le code (1 = de la droite quand on avance)
function afficheLocker(sens = 0) {
  const p = lockerPaires[lockerIndex];
  const num = $("locker-num");
  num.textContent = `#${p.numero}`;
  if (sens) rejoue(num, "swap", 450);
  $("locker-pos").textContent = `${lockerIndex + 1} / ${lockerPaires.length}`;

  const img = $("locker-img");
  img.hidden = !p.code;
  $("locker-missing").hidden = Boolean(p.code);
  if (p.code) {
    const src = `/api/special/code/${p.id}`;
    if (img.getAttribute("src") !== src) {
      img.classList.remove("vient-droite", "vient-gauche");
      void img.offsetWidth;
      if (sens) img.classList.add(sens > 0 ? "vient-droite" : "vient-gauche");
      img.src = src;
    }
    // deja en cache : "load" ne repassera pas, on ajuste tout de suite
    if (img.complete) ajusteCode();
  }

  $("locker-file").textContent = p.colis?.fileName || (p.seul ? "Code seul — aucun colis" : "PDF pas encore arrivé");
  $("locker-sub").textContent = [p.sender, p.colis?.note ? `Note : ${p.colis.note}` : ""].filter(Boolean).join(" · ");

  const bouton = $("locker-drop");
  // un code seul n'a pas de colis a droper : "Fait" le retire une fois utilise
  bouton.disabled = !p.colis && !p.seul;
  desarmeDrop();
  $("locker-prev").disabled = lockerIndex === 0;
  $("locker-next").disabled = lockerIndex === lockerPaires.length - 1;

  // le suivant est deja charge quand on balaie
  const suivant = lockerPaires[lockerIndex + 1];
  if (suivant?.code) new Image().src = `/api/special/code/${suivant.id}`;
}

function bougeLocker(pas) {
  const cible = lockerIndex + pas;
  if (cible < 0 || cible >= lockerPaires.length) return;
  lockerIndex = cible;
  haptique();
  afficheLocker(pas);
}

// L'ecran qui s'eteint au moment de scanner, c'est ce qui arrive toujours.
async function garderEcranAllume() {
  try {
    if ("wakeLock" in navigator) lockerVerrou = await navigator.wakeLock.request("screen");
  } catch {
    // refuse (batterie faible, navigateur) : on fait sans
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("locker").hidden) garderEcranAllume();
});

// "Depose" en deux appuis : un drop ne s'annule pas, et devant un locker on a
// vite fait de toucher le mauvais bouton.
let dropArme = null;

function desarmeDrop() {
  clearTimeout(dropArme);
  dropArme = null;
  const bouton = $("locker-drop");
  bouton.classList.remove("arme");
  const p = lockerPaires[lockerIndex];
  bouton.textContent = p?.seul && !p?.colis ? "Fait" : "Déposé";
}

$("locker-drop").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  const p = lockerPaires[lockerIndex];
  if (!p?.colis && !p?.seul) return;

  if (!dropArme) {
    bouton.classList.add("arme");
    bouton.textContent = "Confirmer ?";
    haptique();
    dropArme = setTimeout(desarmeDrop, 3000);
    return;
  }

  desarmeDrop();
  bouton.disabled = true;
  try {
    await postJSON(p.colis ? `/api/print/colis/${p.colis.id}/drop` : `/api/special/paires/${p.id}/fini`);
    haptique();
    rejoue($("locker"), "flash", 650);
    // le colis quitte la liste : on reste a la meme place, qui montre le suivant
    lockerPaires.splice(lockerIndex, 1);
    if (lockerPaires.length === 0) {
      fermeLocker();
      toast("Locker terminé, tout est déposé");
      return;
    }
    lockerIndex = Math.min(lockerIndex, lockerPaires.length - 1);
    afficheLocker(1);
  } catch (err) {
    bouton.disabled = false;
    toast(err.message, "error");
  }
});

$("locker-prev").addEventListener("click", () => bougeLocker(-1));
$("locker-next").addEventListener("click", () => bougeLocker(1));
$("locker-close").addEventListener("click", fermeLocker);
$("special-start").addEventListener("click", () => ouvreLocker(0));
$("special-link").addEventListener("click", () => switchView("special"));
$("special-back").addEventListener("click", () => switchView("dashboard"));

$("special-list").addEventListener("click", (e) => {
  const carte = e.target.closest("[data-locker]");
  if (carte) ouvreLocker(Number(carte.dataset.locker));
});

document.addEventListener("keydown", (e) => {
  if ($("locker").hidden) return;
  if (e.key === "ArrowLeft") bougeLocker(-1);
  if (e.key === "ArrowRight") bougeLocker(1);
  if (e.key === "Escape") fermeLocker();
});

// balayage : a une main, le colis dans l'autre
{
  let departX = null;
  const zone = $("locker-code");
  zone.addEventListener("touchstart", (e) => (departX = e.touches[0].clientX), { passive: true });
  zone.addEventListener("touchend", (e) => {
    if (departX === null) return;
    const ecart = e.changedTouches[0].clientX - departX;
    departX = null;
    if (Math.abs(ecart) > 50) bougeLocker(ecart < 0 ? 1 : -1);
  });
}

// Pas de zoom par pincement non plus. Safari sur iPhone ignore
// "user-scalable=no" : ses gestes de zoom se bloquent a la main.
for (const geste of ["gesturestart", "gesturechange"]) {
  document.addEventListener(geste, (e) => e.preventDefault(), { passive: false });
}

// --- Demarrage --------------------------------------------------------------------
// La sequence d'entree : le fond se leve, les barres arrivent (CSS), puis des
// que les premiers chiffres sont la -- ou au plus tard apres un court instant
// -- le contenu entre en cascade et les compteurs se mettent a monter.

document.querySelectorAll("[data-skeleton], .stock-value").forEach((el) => el.classList.add("is-loading"));
$("carrier-rows").innerHTML = squelettes(3);
$("sender-rows").innerHTML = squelettes(3);

async function demarre() {
  // la page demandee dans l'adresse (#imprime, #stats...) s'ouvre directement :
  // c'est ce qui fait marcher les raccourcis de l'app installee
  const demandee = location.hash.slice(1);
  const initiale = VUES.includes(demandee) ? demandee : "dashboard";
  const page = $(`view-${initiale}`);
  if (initiale !== "dashboard") {
    const dash = $("view-dashboard");
    dash.classList.remove("active", "attente");
    page.classList.add("active", "attente");
    currentView = initiale;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === (VUE_PARENT[initiale] || initiale)));
  }
  requestAnimationFrame(() => placeIndicateur(VUE_PARENT[initiale] || initiale, { instantane: true }));
  vuesVisitees.add(initiale);

  // la sequence de lancement (lancement.js) : la meteorite file pendant que
  // les premiers chiffres arrivent ; son onde ouvre l'interface
  const lancement = window.lancementDrop;
  const chargement =
    initiale === "stats"
      ? (lancement?.revelation ?? Promise.resolve()).then(() => Promise.all([loadStats(true, true, true), loadRevenueStats(true, true, true)]))
      : initiale === "imprime"
        ? loadImprime()
        : initiale === "special"
          ? loadSpecial()
          : initiale === "suivi"
            ? loadSuivi()
            : refreshAll();
  if (initiale === "imprime" || initiale === "special" || initiale === "suivi") refreshAll().catch(() => {});

  if (lancement) {
    await lancement.revelation;
  } else {
    // on n'attend jamais plus d'un instant : au-dela, la cascade part avec les
    // squelettes et les chiffres suivront
    await Promise.race([chargement.catch(() => {}), attends(1100)]);
    await attends(140);
  }
  // les barres arrivent (CSS body.boot), le contenu entre en cascade
  document.body.classList.add("boot");
  page.classList.remove("attente");
  entreePage(page, true);
  setTimeout(() => document.body.classList.remove("boot"), 2200);
}

initPush();
demarre();
setInterval(rafraichitEnFond, 5000);
