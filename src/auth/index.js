const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { getSetting, setSetting } = require("../db");
const motDePasse = require("./motDePasse");
const sessions = require("./sessions");
const limiteur = require("./limiteur");
const { CSP_DASHBOARD } = require("../securite");

// L'acces au dashboard : un mot de passe, puis une session par appareil.
//
//   site  : cookie de session HttpOnly + Secure + SameSite=Lax (jamais lisible
//           par le JavaScript de la page, jamais dans localStorage), et un
//           second cookie, lisible celui-la, qui porte le jeton anti-CSRF a
//           renvoyer en en-tete (X-CSRF-Token) sur toute ecriture ;
//   app   : jeton dans l'en-tete Authorization (Bearer), garde dans le
//           trousseau de l'iPhone ou du Mac. Pas de cookie, donc pas de CSRF.
//
// Dans les deux cas, la session est verifiee ICI, a chaque requete privee :
// existe-t-elle, n'est-elle pas revoquee, a-t-elle moins de 72 h (expiration
// absolue, voir sessions.js), le mot de passe n'a-t-il pas change ?

const SURS = new Set(["GET", "HEAD", "OPTIONS"]);
const PUBLIC = path.join(__dirname, "..", "..", "public");

const enProduction = () => Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === "production";

// En HTTPS, le prefixe __Host- interdit au cookie tout autre domaine ou chemin
// (et impose Secure) : il ne peut pas etre pose par un sous-domaine voisin.
const nomSession = (secure) => (secure ? "__Host-feurdrop_session" : "feurdrop_session");
const nomCsrf = (secure) => (secure ? "__Host-feurdrop_csrf" : "feurdrop_csrf");

function lisCookies(req) {
  const cookies = {};
  for (const morceau of String(req.headers.cookie || "").split(";")) {
    const i = morceau.indexOf("=");
    if (i < 0) continue;
    const nom = morceau.slice(0, i).trim();
    if (nom && !(nom in cookies)) cookies[nom] = morceau.slice(i + 1).trim();
  }
  return cookies;
}

/** Le jeton presente : l'en-tete de l'app, sinon le cookie du site. */
function jetonDe(req) {
  const entete = String(req.get("authorization") || "");
  if (/^Bearer\s+/i.test(entete)) return { jeton: entete.replace(/^Bearer\s+/i, "").trim(), via: "bearer" };
  const c = lisCookies(req);
  const jeton = c[nomSession(true)] || c[nomSession(false)];
  return jeton ? { jeton, via: "cookie" } : { jeton: null, via: null };
}

// --- Anti-CSRF ----------------------------------------------------------------
// Le jeton anti-CSRF est une signature de la session (HMAC, cle gardee en
// base et jamais exportee) : un autre site ne peut ni le lire ni le deviner.

let secret = null;
function secretCsrf() {
  if (!secret) {
    secret = getSetting("session_secret", null);
    if (!secret) {
      secret = crypto.randomBytes(32).toString("hex");
      setSetting("session_secret", secret);
    }
  }
  return secret;
}
const csrfDe = (session) => crypto.createHmac("sha256", secretCsrf()).update(session.id).digest("base64url");

function egal(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// La requete vient-elle bien de la page du dashboard elle-meme ?
function memeOrigine(req) {
  const origine = req.get("origin");
  if (origine) return origine === `${req.protocol}://${req.get("host")}`;
  const site = req.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

// --- Cookies ----------------------------------------------------------------------

function poseCookies(req, res, session) {
  const secure = Boolean(req.secure);
  // la duree de vie du cookie = ce qu'il reste de la session (jamais plus) ;
  // la vraie limite reste celle du serveur
  const maxAge = Math.max(0, Math.floor((session.expireLe - sessions.horloge.maintenant()) / 1000));
  const commun = `Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  res.append("Set-Cookie", `${nomSession(secure)}=${session.jeton}; ${commun}; HttpOnly; SameSite=Lax`);
  res.append("Set-Cookie", `${nomCsrf(secure)}=${csrfDe(session)}; ${commun}; SameSite=Strict`);
}

function effaceCookies(req, res) {
  for (const secure of [true, false]) {
    if (secure && !req.secure) continue;
    const fin = `Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
    res.append("Set-Cookie", `${nomSession(secure)}=; ${fin}; HttpOnly; SameSite=Lax`);
    res.append("Set-Cookie", `${nomCsrf(secure)}=; ${fin}; SameSite=Strict`);
  }
}

// --- Gardiens ------------------------------------------------------------------------

/**
 * Toute requete privee de l'API passe ici : sans session valable, 401 et
 * rien d'autre. Une ecriture faite avec le cookie du site doit en plus venir
 * de la page (meme origine + jeton anti-CSRF), sinon 403.
 */
function exigeSession(req, res, next) {
  res.set("Cache-Control", "no-store");
  const { jeton, via } = jetonDe(req);
  const session = jeton ? sessions.lis(jeton) : null;
  if (!session) {
    if (via === "cookie") effaceCookies(req, res);
    res.set("WWW-Authenticate", 'Bearer realm="FeurDrop"');
    return res.status(401).json({ error: "Connexion requise", connexion: "/connexion" });
  }
  if (via === "cookie" && !SURS.has(req.method)) {
    if (!memeOrigine(req) || !egal(req.get("x-csrf-token"), csrfDe(session))) {
      return res.status(403).json({ error: "Requête refusée : recharge la page et réessaie." });
    }
  }
  req.session = session;
  next();
}

/** Les pages et fichiers du dashboard : sans session, direction la connexion. */
function exigeSessionPage(req, res, next) {
  const { jeton, via } = jetonDe(req);
  if (jeton && sessions.lis(jeton)) {
    // la page ne reste dans aucun cache ; les fichiers sont revalides
    res.set("Cache-Control", req.path === "/" || /\.html?$/i.test(req.path) ? "no-store" : "private, no-cache");
    return next();
  }
  if (via === "cookie") effaceCookies(req, res);
  if (SURS.has(req.method) && (req.path === "/" || /\.html?$/i.test(req.path) || !path.extname(req.path))) {
    return res.redirect(302, "/connexion");
  }
  res.status(401).type("text/plain").send("Connexion requise");
}

/** En production : HTTPS partout (sauf le reseau prive de Railway). */
function httpsObligatoire(req, res, next) {
  if (!enProduction() || req.secure) return next();
  // le service du portail demande les colis par le reseau prive de Railway, en http
  if (/\.railway\.internal(:\d+)?$/i.test(req.get("host") || "")) return next();
  if (SURS.has(req.method)) {
    const hote = process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host");
    return res.redirect(301, `https://${hote}${req.originalUrl}`);
  }
  res.status(403).json({ error: "HTTPS obligatoire" });
}

// --- Connexion ------------------------------------------------------------------------

// un echec attend un peu (de 300 a 700 ms) : de quoi ralentir un robot, et ne
// rien laisser deviner a la duree de la reponse
const pause = () => new Promise((r) => setTimeout(r, 300 + crypto.randomInt(400)));

function dureeLisible(s) {
  if (s < 60) return `${s} s`;
  const min = Math.ceil(s / 60);
  return `${min} min`;
}

// « Safari · iPhone » : de quoi reconnaitre ses appareils dans la liste
function nomAppareil(propose, agent, mode) {
  const propre = String(propose || "")
    // eslint-disable-next-line no-control-regex -- on retire justement les caracteres de controle
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 60);
  if (propre) return propre;
  const ua = String(agent || "");
  const systeme = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : null;
  const navigateur = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : null;
  if (mode === "app") return systeme ? `App ${systeme}` : "App";
  return [navigateur, systeme].filter(Boolean).join(" · ") || "Navigateur";
}

async function connexion(req, res) {
  res.set("Cache-Control", "no-store");
  const corps = req.body && typeof req.body === "object" ? req.body : {};
  const mode = corps.mode === "app" ? "app" : "web";
  const ip = req.ip || "inconnue";

  if (!motDePasse.estConfigure()) {
    return res.status(503).json({ error: "Connexion impossible : le mot de passe du dashboard n'est pas encore configuré sur le serveur (voir SECURITE.md)." });
  }
  // un formulaire du site ne peut pas etre poste depuis un autre site
  if (mode === "web" && !memeOrigine(req)) return res.status(403).json({ error: "Requête refusée" });

  const attente = limiteur.attente(ip);
  if (attente > 0) {
    res.set("Retry-After", String(attente));
    return res.status(429).json({ error: `Trop d'essais. Réessaie dans ${dureeLisible(attente)}.`, attente });
  }

  const ok = typeof corps.motDePasse === "string" && corps.motDePasse.length <= motDePasse.LONGUEUR_MAX && (await motDePasse.verifie(corps.motDePasse));
  if (!ok) {
    limiteur.echec(ip);
    console.warn(`[auth] connexion refusée (${mode}) depuis ${ip}`);
    await pause();
    return res.status(401).json({ error: "Mot de passe incorrect" });
  }
  limiteur.reussite(ip);

  // toujours une session NEUVE (pas de fixation de session) : celle que
  // l'appareil presentait, s'il en avait une, est fermee
  const ancien = jetonDe(req).jeton;
  if (ancien) sessions.revoque(ancien);
  const appareil = nomAppareil(corps.appareil, req.get("user-agent"), mode);
  const session = sessions.cree({ type: mode, appareil });
  console.log(`[auth] connexion ouverte (${mode} · ${appareil})`);

  const expireLe = new Date(session.expireLe).toISOString();
  if (mode === "app") return res.json({ ok: true, jeton: session.jeton, expireLe });
  poseCookies(req, res, session);
  res.json({ ok: true, expireLe });
}

// Se deconnecter : la session est fermee cote serveur (l'ancien cookie ou
// l'ancien jeton ne vaut plus rien), et les cookies sont effaces.
function deconnexion(req, res) {
  res.set("Cache-Control", "no-store");
  const { jeton } = jetonDe(req);
  if (jeton) sessions.revoque(jeton);
  effaceCookies(req, res);
  res.set("Clear-Site-Data", '"cache"');
  res.json({ ok: true });
}

const resumeSession = (s, courante = null) => ({
  courante: courante ? s.id === courante.id : undefined,
  type: s.type,
  appareil: s.appareil,
  creeLe: new Date(s.cree_le).toISOString(),
  expireLe: new Date(s.expire_le).toISOString(),
  vuLe: s.vu_le ? new Date(s.vu_le).toISOString() : null,
});

// Routes ouvertes : se connecter, se deconnecter.
const routesPubliques = express.Router();
routesPubliques.post("/connexion", (req, res, next) => connexion(req, res).catch(next));
routesPubliques.post("/deconnexion", deconnexion);

// Routes privees (montees derriere exigeSession).
const routesPrivees = express.Router();
routesPrivees.get("/session", (req, res) => {
  res.json({ ...resumeSession(req.session), appareils: sessions.actives().length });
});
routesPrivees.get("/sessions", (req, res) => {
  res.json({ sessions: sessions.actives().map((s) => resumeSession(s, req.session)) });
});
// « Déconnecter tous les appareils » (celui-ci compris)
routesPrivees.post("/deconnexion-partout", (req, res) => {
  const fermees = sessions.revoqueTout();
  console.log(`[auth] toutes les sessions fermées (${fermees})`);
  effaceCookies(req, res);
  res.json({ ok: true, fermees });
});

// La page de connexion. Deja connecte : direction le dashboard.
function pageConnexion(req, res) {
  const { jeton } = jetonDe(req);
  if (jeton && sessions.lis(jeton)) return res.redirect(302, "/");
  res.set({ "Content-Security-Policy": CSP_DASHBOARD, "Cache-Control": "no-store" });
  res.sendFile(path.join(PUBLIC, "connexion.html"));
}

// Le message de demarrage : jamais l'empreinte, seulement si elle est la.
function annonce() {
  if (motDePasse.estConfigure()) console.log("[auth] dashboard protégé par mot de passe (sessions de 72 h)");
  else console.warn("[auth] DASHBOARD_PASSWORD_HASH absente ou invalide : le dashboard reste FERMÉ (voir SECURITE.md)");
}

module.exports = {
  exigeSession,
  exigeSessionPage,
  httpsObligatoire,
  routesPubliques,
  routesPrivees,
  pageConnexion,
  annonce,
  jetonDe,
  enProduction,
};
