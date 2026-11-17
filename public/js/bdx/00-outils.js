// --- Bordereaux : les outils de la page ---------------------------------------------
// La page Bordereaux est a part du dashboard (sa propre adresse, /bordereaux,
// sa propre fenetre) : elle n'emporte que ce dont elle a besoin. Meme session
// que le dashboard (cookie HttpOnly), meme protection des ecritures (jeton
// anti-CSRF renvoye en en-tete), meme style (styles.css).

const $ = (id) => document.getElementById(id);
const attends = (ms) => new Promise((r) => setTimeout(r, ms));
const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const entier = (n) => nf0.format(Math.round(Number(n) || 0));
const pluriel = (n, mot, motPluriel = `${mot}s`) => `${entier(n)} ${Number(n) > 1 ? motPluriel : mot}`;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ico = (nom, classe = "") => `<svg class="icon${classe ? ` ${classe}` : ""}" aria-hidden="true"><use href="#i-${nom}"/></svg>`;

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const escapeAttr = escapeHtml;

// « 2026-11-17 14:32:05 » (UTC, comme en base) -> Date
const dateServeur = (s) => new Date(`${String(s).replace(" ", "T")}Z`);

// --- Reseau ------------------------------------------------------------------------------

class ErreurReseau extends Error {}
const jetonCsrf = () => (/(?:^|;\s*)(?:__Host-)?feurdrop_csrf=([^;]+)/.exec(document.cookie) || [])[1] || "";
let sessionPerdue = false;
{
  const fetchServeur = window.fetch.bind(window);
  window.fetch = async (ressource, opts = {}) => {
    const url = new URL(typeof ressource === "string" ? ressource : ressource.url, location.href);
    const ici = url.origin === location.origin;
    const methode = String(opts.method || ressource.method || "GET").toUpperCase();
    if (ici && methode !== "GET" && methode !== "HEAD") {
      const entetes = new Headers(opts.headers || {});
      entetes.set("X-CSRF-Token", jetonCsrf());
      opts = { ...opts, headers: entetes };
    }
    const reponse = await fetchServeur(ressource, opts);
    // session expiree ou revoquee : la connexion, puis retour ici
    if (ici && reponse.status === 401 && url.pathname.startsWith("/api/") && !sessionPerdue) {
      sessionPerdue = true;
      location.replace("/connexion");
    }
    return reponse;
  };
}

async function fetchJSON(url, opts = {}, { delai = 12000, essais } = {}) {
  const lecture = !opts.method || opts.method === "GET";
  const maxEssais = essais ?? (lecture ? 2 : 1);
  for (let essai = 1; ; essai++) {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), delai);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!res.ok) {
        const message = (await res.json().catch(() => ({}))).error || res.statusText;
        clearTimeout(minuteur);
        throw new Error(message);
      }
      const corps = await res.json();
      clearTimeout(minuteur);
      return corps;
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
  fetchJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps || {}) }, { delai: 30000, ...options });

// --- Retours d'action ------------------------------------------------------------------

const TOAST_ICONES = { success: "check", error: "alert", info: "info" };

function toast(message, type = "success", duree = type === "error" ? 5200 : 3400) {
  const pile = $("toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML = `<span class="toast-icon">${ico(TOAST_ICONES[type] || "info")}</span><span></span><span class="toast-temps"></span>`;
  el.children[1].textContent = message;
  el.lastChild.style.animationDuration = `${duree}ms`;
  pile.appendChild(el);
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

async function agir(bouton, action) {
  if (bouton?.getAttribute("aria-busy") === "true") return undefined;
  occupe(bouton, true);
  try {
    const resultat = await action();
    occupe(bouton, false);
    fait(bouton);
    return resultat;
  } catch (err) {
    occupe(bouton, false);
    secoue(bouton);
    toast(err.message || "Action impossible", "error");
    return undefined;
  }
}

async function copyText(text, bouton, message = "Copié") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // presse-papiers refuse (hors HTTPS) : l'ancienne methode
    const zone = document.createElement("textarea");
    zone.value = text;
    zone.style.position = "fixed";
    zone.style.opacity = "0";
    document.body.appendChild(zone);
    zone.select();
    document.execCommand("copy");
    zone.remove();
  }
  if (bouton) fait(bouton);
  toast(message);
}
