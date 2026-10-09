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

// Une operation qui compte (ajout de colis, stock) porte une cle unique : si le
// reseau coupe, on la renvoie (jusqu'a 3 fois) sans risque de la compter deux
// fois -- le serveur reconnait la cle et rejoue sa premiere reponse.
const cleOperation = () =>
  globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const postOperation = (url, corps) =>
  fetchJSON(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": cleOperation() },
      body: JSON.stringify(corps || {}),
    },
    { delai: 20000, essais: 3 }
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

// +1 / -1 colis a la main : CHAQUE appui compte. Avant, un appui fait pendant
// l'envoi du precedent etait ignore (verrou "anti double clic") : taper cinq
// fois vite pouvait n'ajouter qu'un ou deux colis. Les appuis d'un expediteur
// partent maintenant un envoi a la fois, ceux faits pendant un envoi sont
// cumules et partent ensemble juste apres (+3 en une operation).
const colisMain = new Map(); // nom -> { ajouts, retraits, boucle }

function colisALaMain(nom, sens, bouton) {
  let e = colisMain.get(nom);
  if (!e) colisMain.set(nom, (e = { ajouts: 0, retraits: 0, boucle: null }));
  if (sens > 0) e.ajouts += 1;
  else e.retraits += 1;
  if (!e.boucle) e.boucle = envoieColisMain(nom, e, bouton);
  return e.boucle;
}

async function envoieColisMain(nom, e, bouton) {
  const chemin = (sens) => `/api/colis/${sens > 0 ? "quick-add" : "quick-remove"}/${encodeURIComponent(nom)}`;
  while (e.ajouts || e.retraits) {
    if (e.ajouts) {
      const n = e.ajouts;
      e.ajouts = 0;
      try {
        await postOperation(chemin(1), { n });
        toast(`+${pluriel(n, "colis", "colis")} · ${nom}`);
      } catch (err) {
        if (bouton?.isConnected) secoue(bouton);
        toast(
          err instanceof ErreurReseau
            ? `Connexion instable pendant l'ajout pour ${nom} : compte revérifié`
            : `${pluriel(n, "colis non ajouté", "colis non ajoutés")} pour ${nom} : ${err.message}`,
          "error"
        );
      }
    }
    if (e.retraits) {
      const n = e.retraits;
      e.retraits = 0;
      try {
        const r = await postOperation(chemin(-1), { n });
        toast(`−${pluriel(r.removed ?? n, "colis", "colis")} · ${nom}`);
      } catch (err) {
        if (bouton?.isConnected) secoue(bouton);
        // rien a retirer a la main : les vraies etiquettes ne partent pas par
        // ce bouton, le serveur dit par ou passer
        toast(err.message, /Aucun colis/.test(err.message) ? "info" : "error");
      }
    }
    // le compte affiche vient du serveur, quoi qu'il arrive
    await loadStats(false, true).catch(() => {});
  }
  e.boucle = null;
}

// Un drop groupe ne solde que les colis deja imprimes : la reponse dit combien
// sont restes en attente faute d'impression.
function messageDrop(r, suffixe = "") {
  const reste = r.restants ? pluriel(r.restants, "colis pas encore imprimé reste", "colis pas encore imprimés restent") : "";
  if (!r.count) {
    toast(r.restants ? `Rien de dropé : ${reste}` : "Aucun colis à dropper", "info");
    return null;
  }
  return `${pluriel(r.count, "colis dropé", "colis dropés")}${suffixe}${reste ? ` · ${reste}` : ""}`;
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

