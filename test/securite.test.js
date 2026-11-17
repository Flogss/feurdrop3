// La securite du dashboard, cote serveur, cas par cas : sans session valable,
// rien ne sort et rien ne change ; une session vit 72 h au plus, quoi qu'il
// arrive ; la deconnexion tue l'ancien cookie ; l'agent d'impression, le
// portail et l'app gardent leur propre acces.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { environnementDeTest, demarreApp, videBase, MOT_DE_PASSE_TEST } = require("./aide");

environnementDeTest();
const db = require("../src/db");
const sessions = require("../src/auth/sessions");
const limiteur = require("../src/auth/limiteur");

const H = 3600 * 1000;
let app;
let base;
const horlogeReelle = sessions.horloge.maintenant;

before(async () => {
  app = await demarreApp({ connecte: false });
  base = app.base;
});
after(() => app.ferme());
beforeEach(() => {
  videBase();
  db.db.prepare("DELETE FROM sessions").run();
  limiteur.remiseAZero();
  sessions.horloge.maintenant = horlogeReelle;
});

// --- outils : un « navigateur » qui garde ses cookies ------------------------------

function navigateur() {
  const cookies = new Map();
  const garde = (r) => {
    for (const c of r.headers.getSetCookie()) {
      const [paire] = c.split(";");
      const i = paire.indexOf("=");
      const nom = paire.slice(0, i);
      const valeur = paire.slice(i + 1);
      if (!valeur || /Max-Age=0/i.test(c)) cookies.delete(nom);
      else cookies.set(nom, valeur);
    }
  };
  const csrf = () => cookies.get("feurdrop_csrf") || "";
  return {
    cookies,
    csrf,
    async va(chemin, { methode = "GET", corps, entetes = {}, sansCsrf = false } = {}) {
      const r = await fetch(base + chemin, {
        method: methode,
        redirect: "manual",
        headers: {
          ...(corps !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookies.size ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
          ...(methode !== "GET" && !sansCsrf && csrf() ? { "X-CSRF-Token": csrf() } : {}),
          ...entetes,
        },
        body: corps === undefined ? undefined : JSON.stringify(corps),
      });
      garde(r);
      const texte = await r.text();
      let json = null;
      try {
        json = JSON.parse(texte);
      } catch {
        json = null;
      }
      return { status: r.status, json, texte, entetes: r.headers, setCookie: r.headers.getSetCookie() };
    },
    async connecte(motDePasse = MOT_DE_PASSE_TEST) {
      return this.va("/api/auth/connexion", { methode: "POST", corps: { motDePasse, mode: "web" } });
    },
  };
}

const anonyme = (chemin, options = {}) => navigateur().va(chemin, options);

async function jetonApp() {
  const r = await anonyme("/api/auth/connexion", { methode: "POST", corps: { motDePasse: MOT_DE_PASSE_TEST, mode: "app", appareil: "iPhone de test" } });
  assert.equal(r.status, 200);
  return r.json.jeton;
}

// Toutes les routes declarees dans le code (methode + chemin), routeur par routeur,
// avec leur prefixe de montage -- celles qu'on ajoutera demain aussi.
function toutesLesRoutes() {
  const montages = [
    ["/api", require("../src/routes/api")],
    ["/api/print", require("../src/routes/print")],
    ["/api/special", require("../src/routes/special")],
    ["/api/suivi", require("../src/routes/suivi")],
    ["/api/depots", require("../src/routes/depots").router],
    ["/api/auth", require("../src/auth").routesPrivees],
  ];
  const routes = [];
  for (const [prefixe, routeur] of montages) {
    for (const couche of routeur.stack) {
      if (!couche.route) continue;
      const chemin = (prefixe + couche.route.path).replace(/:(\w+)\.pdf/, "x.pdf").replace(/:\w+/g, "1");
      for (const methode of Object.keys(couche.route.methods)) routes.push([methode.toUpperCase(), chemin]);
    }
  }
  return routes;
}

// --- 1. le site sans connexion ---------------------------------------------------------

test("1. le site sans connexion : la page de connexion, et rien du dashboard", async () => {
  const accueil = await anonyme("/");
  assert.equal(accueil.status, 302);
  assert.equal(accueil.entetes.get("location"), "/connexion");
  assert.equal((await anonyme("/index.html")).status, 302);

  const page = await anonyme("/connexion");
  assert.equal(page.status, 200);
  assert.match(page.texte, /type="password"/);
  assert.match(page.entetes.get("content-security-policy"), /script-src 'self'/);
  assert.ok(!/<script>(?!\s*<\/script>)/.test(page.texte), "pas de script en ligne");

  // le code du dashboard ne sort pas non plus
  for (const fichier of ["/app.js", "/js/00-base.js", "/lancement.js", "/cha-ching.m4a"]) {
    assert.equal((await anonyme(fichier)).status, 401, fichier);
  }
  // ce dont la page de connexion a besoin, oui (aucune donnee)
  for (const fichier of ["/styles.css", "/connexion.js", "/favicon.svg", "/manifest.json", "/sw.js", "/particules.js"]) {
    assert.equal((await anonyme(fichier)).status, 200, fichier);
  }
});

// --- 2. l'API sans session, route par route --------------------------------------------

test("2. chaque route privee de l'API repond 401 sans session (avec ou sans faux jeton)", async () => {
  const routes = toutesLesRoutes();
  assert.ok(routes.length > 60, `${routes.length} routes trouvees`);
  const faux = navigateur();
  faux.cookies.set("feurdrop_session", "A".repeat(43));
  for (const [methode, chemin] of routes) {
    const corps = methode === "GET" ? undefined : {};
    const sans = await anonyme(chemin, { methode, corps });
    assert.equal(sans.status, 401, `${methode} ${chemin} sans session : ${sans.status}`);
    assert.deepEqual(Object.keys(sans.json), ["error", "connexion"], `${methode} ${chemin} : pas de donnee dans la reponse`);
    const bearer = await anonyme(chemin, { methode, corps, entetes: { Authorization: "Bearer n-importe-quoi" } });
    assert.equal(bearer.status, 401, `${methode} ${chemin} avec un faux jeton`);
    const cookie = await faux.va(chemin, { methode, corps });
    assert.equal(cookie.status, 401, `${methode} ${chemin} avec un faux cookie`);
  }
  // une adresse inconnue de l'API ne dit rien non plus
  assert.equal((await anonyme("/api/nexiste-pas")).status, 401);
});

// --- 3. la session survit a la fermeture du navigateur -----------------------------------

test("3. la session est memorisee sur l'appareil (cookie persistant, HttpOnly, SameSite)", async () => {
  const iphone = navigateur();
  const r = await iphone.connecte();
  assert.equal(r.status, 200);
  assert.equal(r.json.jeton, undefined, "le site ne recoit jamais le jeton dans la reponse");
  const session = r.setCookie.find((c) => c.startsWith("feurdrop_session="));
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /Path=\//);
  // 72 h, arrondies a la seconde inferieure (jamais au-dela de la fin de la
  // session) : 259200, ou 259199 si une milliseconde s'est ecoulee
  const maxAge = Number(session.match(/Max-Age=(\d+)/)?.[1]);
  assert.ok(maxAge >= 259198 && maxAge <= 259200, `72 h, persistant : survit a la fermeture du navigateur (Max-Age=${maxAge})`);
  // et la meme echeance en date absolue (Expires), pour les navigateurs et
  // l'app ecran d'accueil qui ne liraient que celle-la
  const expires = Date.parse(session.match(/Expires=([^;]+)/)?.[1]);
  assert.ok(Math.abs(expires - Date.parse(r.json.expireLe)) < 1000, "Expires = la fin de la session, a la seconde");
  assert.ok(expires - Date.now() > 71.9 * 3600 * 1000);
  const csrf = r.setCookie.find((c) => c.startsWith("feurdrop_csrf="));
  assert.ok(!/HttpOnly/.test(csrf), "le jeton anti-CSRF est lisible par la page");

  // « je ferme Safari et je reviens » : un nouveau chargement avec le seul cookie
  const reouvert = navigateur();
  for (const [k, v] of iphone.cookies) reouvert.cookies.set(k, v);
  assert.equal((await reouvert.va("/")).status, 200);
  assert.equal((await reouvert.va("/api/stats")).status, 200);
  assert.equal((await reouvert.va("/connexion")).status, 302, "deja connecte : la connexion renvoie au dashboard");
});

// --- 4. un autre appareil ----------------------------------------------------------------

test("4. chaque appareil a sa propre session, independante des autres", async () => {
  const iphone = navigateur();
  await iphone.connecte();
  const mac = navigateur();
  assert.equal((await mac.va("/api/stats")).status, 401, "le Mac n'est pas connecte parce que l'iPhone l'est");
  await mac.connecte();
  assert.notEqual(mac.cookies.get("feurdrop_session"), iphone.cookies.get("feurdrop_session"));
  assert.equal((await mac.va("/api/auth/deconnexion", { methode: "POST" })).status, 200);
  assert.equal((await mac.va("/api/stats")).status, 401);
  assert.equal((await iphone.va("/api/stats")).status, 200, "deconnecter le Mac ne touche pas l'iPhone");
});

test("4 bis. Safari, l'app ecran d'accueil et Chrome sur iPhone : des connexions distinctes, bien nommees", async () => {
  const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
  const CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1";
  const ouvre = async (ua, contexte) => {
    const nav = navigateur();
    const r = await nav.va("/api/auth/connexion", { methode: "POST", corps: { motDePasse: MOT_DE_PASSE_TEST, mode: "web", contexte }, entetes: { "User-Agent": ua } });
    assert.equal(r.status, 200);
    return nav;
  };
  const safari = await ouvre(SAFARI, null);
  await ouvre(SAFARI, "ecran-accueil");
  await ouvre(CHROME, null);
  await ouvre(SAFARI, "<script>"); // un contexte inconnu est ignore
  const noms = (await safari.va("/api/auth/sessions")).json.sessions.map((x) => x.appareil);
  assert.ok(noms.includes("Safari · iPhone"));
  assert.ok(noms.includes("Safari · iPhone · écran d'accueil"));
  assert.ok(noms.includes("Chrome · iPhone"));
  assert.ok(!noms.some((n) => n.includes("<")));
});

test("4 ter. la fenetre integree de l'app : un code a usage unique, 60 s, pages de bordereaux seulement, jamais plus longue que l'app", async () => {
  const t0 = Date.now();
  sessions.horloge.maintenant = () => t0;
  const jeton = await jetonApp();
  const avecJeton = { Authorization: `Bearer ${jeton}` };
  const demande = (chemin, entetes = avecJeton) => anonyme("/api/auth/pont", { methode: "POST", corps: { chemin }, entetes });

  const r = await demande("/bordereaux/editeur?colis=12");
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^\/connexion\/pont\?code=[A-Za-z0-9_-]{43}$/);

  const fenetre = navigateur();
  const ouvre = await fenetre.va(r.json.url);
  assert.equal(ouvre.status, 302);
  assert.equal(ouvre.entetes.get("location"), "/bordereaux/editeur?colis=12");
  assert.ok(fenetre.cookies.get("feurdrop_session"), "la fenetre a sa session");
  assert.equal((await fenetre.va("/bordereaux")).status, 200);
  assert.equal((await fenetre.va("/api/bordereaux/etat")).status, 200);

  // une seule fois
  assert.equal((await navigateur().va(r.json.url)).entetes.get("location"), "/connexion");
  // 60 secondes, pas plus
  const vieux = (await demande("/bordereaux")).json.url;
  sessions.horloge.maintenant = () => t0 + 61 * 1000;
  assert.equal((await navigateur().va(vieux)).entetes.get("location"), "/connexion");
  // seulement les pages de bordereaux, jamais une adresse exterieure
  for (const mauvais of ["https://exemple.test/", "//exemple.test", "/api/colis", "/", "/bordereaux/../api", "/bordereaux\\x"]) {
    assert.equal((await demande(mauvais)).status, 400, mauvais);
  }
  // seulement l'app (Bearer) : pas une page du site
  assert.equal((await fenetre.va("/api/auth/pont", { methode: "POST", corps: { chemin: "/bordereaux" } })).status, 403);
  assert.equal((await anonyme("/api/auth/pont", { methode: "POST", corps: { chemin: "/bordereaux" } })).status, 401);

  // la session de la fenetre finit au plus tard avec celle de l'app
  const lignes = db.db.prepare("SELECT type, appareil, expire_le FROM sessions ORDER BY cree_le").all();
  const app = lignes.find((l) => l.type === "app");
  const web = lignes.find((l) => l.appareil?.includes("fenêtre intégrée"));
  assert.ok(web.expire_le <= app.expire_le);
  // l'app deconnectee : un code deja donne ne sert plus a rien
  sessions.horloge.maintenant = () => t0;
  const encore = (await demande("/bordereaux")).json.url;
  await anonyme("/api/auth/deconnexion", { methode: "POST", entetes: avecJeton });
  assert.equal((await navigateur().va(encore)).entetes.get("location"), "/connexion");
  sessions.horloge.maintenant = () => Date.now();
});

// --- 5 et 6. 72 h, pas une minute de plus -------------------------------------------------

test("5. 72 h apres la connexion, la session expire meme si le site sert tous les jours", async () => {
  const t0 = Date.parse("2026-10-11T08:00:00Z");
  sessions.horloge.maintenant = () => t0;
  const nav = navigateur();
  await nav.connecte();
  const jeton = await jetonApp();
  const ligne = () => db.db.prepare("SELECT cree_le, expire_le FROM sessions ORDER BY cree_le LIMIT 1").get();
  assert.equal(ligne().expire_le - ligne().cree_le, 72 * H);

  // utilise chaque jour (et toutes les heures, a la fin)
  for (const h of [1, 12, 24, 36, 48, 60, 70, 71, 71.99]) {
    sessions.horloge.maintenant = () => t0 + h * H;
    const r = await nav.va("/api/stats");
    assert.equal(r.status, 200, `${h} h apres : encore valable`);
    assert.equal(r.setCookie.length, 0, "l'activite ne repousse rien (aucun nouveau cookie)");
    assert.equal((await anonyme("/api/stats", { entetes: { Authorization: `Bearer ${jeton}` } })).status, 200);
  }
  assert.equal(ligne().expire_le, t0 + 72 * H, "l'echeance n'a pas bouge");

  sessions.horloge.maintenant = () => t0 + 72 * H;
  assert.equal((await nav.va("/api/stats")).status, 401, "72 h pile : fini");
  assert.equal((await anonyme("/api/stats", { entetes: { Authorization: `Bearer ${jeton}` } })).status, 401, "l'app aussi");
});

test("6. un ancien cookie apres l'expiration : 401 pour l'API, la connexion pour le site ; une connexion plus recente n'est jamais effacee", async () => {
  const t0 = Date.now();
  sessions.horloge.maintenant = () => t0;
  const nav = navigateur();
  await nav.connecte();
  const ancien = new Map(nav.cookies);
  sessions.horloge.maintenant = () => t0 + 72 * H + 1;

  const api = await nav.va("/api/colis");
  assert.equal(api.status, 401);
  // la reponse d'une requete partie avec l'ancien cookie ne touche a aucun
  // cookie : arrivee juste apres une nouvelle connexion, elle effacait le
  // cookie tout neuf (et le mot de passe etait redemande a la reouverture)
  assert.equal(api.setCookie.length, 0, "un refus n'efface aucun cookie");
  assert.equal((await nav.va("/")).setCookie.length, 0);

  const rejoue = navigateur();
  for (const [k, v] of ancien) rejoue.cookies.set(k, v);
  const page = await rejoue.va("/");
  assert.equal(page.status, 302);
  assert.equal(page.entetes.get("location"), "/connexion");
  // et revenir en arriere dans le temps ne ressuscite pas une session effacee de la base
  assert.equal((await rejoue.va("/api/stats")).status, 401);
});

// --- 7. les etiquettes PDF -------------------------------------------------------------

test("7. etiquettes PDF et codes-barres : rien sans session (pas meme « introuvable »)", async () => {
  for (const chemin of ["/api/print/job/abcdefghijklmnopqrstuv.pdf", "/api/print/job/x.pdf?marquer=0", "/api/special/code/1", "/api/print/colis?categorie=MR"]) {
    const r = await anonyme(chemin);
    assert.equal(r.status, 401, chemin);
    assert.ok(!r.entetes.get("content-type")?.includes("pdf"));
  }
  const build = await anonyme("/api/print/build", { methode: "POST", corps: { categorie: "*" } });
  assert.equal(build.status, 401);
});

// --- 8. modifier ou supprimer sans session ---------------------------------------------------

test("8. modifier, supprimer, fusionner, dropper sans session : 401 et la base ne bouge pas", async () => {
  const alice = db.getOrCreateSender("Alice");
  const bob = db.getOrCreateSender("Bob");
  const colis = db.addColis("Alice", { fileId: "F1", fileKind: "pdf", carrier: "MR" });
  db.adjustStock(10, "normal");
  const photo = () =>
    JSON.stringify([
      db.db.prepare("SELECT * FROM colis ORDER BY id").all(),
      db.db.prepare("SELECT * FROM senders ORDER BY id").all(),
      db.getStock("normal"),
    ]);
  const avant = photo();
  const essais = [
    ["DELETE", `/api/senders/${bob.id}`],
    ["PUT", `/api/senders/${alice.id}`, { price: 99 }],
    ["POST", "/api/senders/merge", { sourceId: bob.id, targetId: alice.id }],
    ["POST", "/api/senders/merge-to-other", { senderIds: [bob.id] }],
    ["POST", `/api/senders/${alice.id}/portail`],
    ["POST", "/api/colis/drop-all"],
    ["POST", `/api/colis/${colis.id}/drop`],
    ["DELETE", `/api/print/colis/${colis.id}`],
    ["PATCH", `/api/print/colis/${colis.id}`, { price: 0 }],
    ["POST", "/api/stock/adjust", { delta: -10, kind: "normal" }],
    ["POST", "/api/debts/Alice/pay"],
    ["POST", "/api/tour/start"],
    ["POST", "/api/print/auto", { enabled: true }],
    ["POST", `/api/depots/${colis.id}/constat`, { resultat: "pris" }],
  ];
  for (const [methode, chemin, corps] of essais) {
    assert.equal((await anonyme(chemin, { methode, corps: corps || {} })).status, 401, `${methode} ${chemin}`);
  }
  assert.equal(photo(), avant);
});

test("8 bis. CSRF : une ecriture avec le cookie mais sans le jeton de la page, ou d'une autre origine, est refusee", async () => {
  db.adjustStock(10, "normal");
  const nav = navigateur();
  await nav.connecte();
  const sansJeton = await nav.va("/api/stock/adjust", { methode: "POST", corps: { delta: 5, kind: "normal" }, sansCsrf: true });
  assert.equal(sansJeton.status, 403);
  const fauxJeton = await nav.va("/api/stock/adjust", { methode: "POST", corps: { delta: 5, kind: "normal" }, entetes: { "X-CSRF-Token": "faux" } });
  assert.equal(fauxJeton.status, 403);
  const autreSite = await nav.va("/api/stock/adjust", { methode: "POST", corps: { delta: 5, kind: "normal" }, entetes: { Origin: "https://pirate.example" } });
  assert.equal(autreSite.status, 403);
  const autreSiteFetch = await nav.va("/api/stock/adjust", { methode: "POST", corps: { delta: 5, kind: "normal" }, entetes: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(autreSiteFetch.status, 403);
  assert.equal(db.getStock("normal"), 10, "rien n'a ete applique");
  const page = await nav.va("/api/stock/adjust", { methode: "POST", corps: { delta: 5, kind: "normal" }, entetes: { Origin: base } });
  assert.equal(page.status, 200);
  assert.equal(db.getStock("normal"), 15);
  // un formulaire de connexion poste depuis un autre site non plus
  assert.equal((await anonyme("/api/auth/connexion", { methode: "POST", corps: { motDePasse: MOT_DE_PASSE_TEST }, entetes: { Origin: "https://pirate.example" } })).status, 403);
});

// --- 9. deconnexion et revocation ------------------------------------------------------

test("9. deconnexion : l'ancien cookie ne vaut plus rien, meme rejoue a la main", async () => {
  const nav = navigateur();
  await nav.connecte();
  const ancien = new Map(nav.cookies);
  const r = await nav.va("/api/auth/deconnexion", { methode: "POST" });
  assert.equal(r.status, 200);
  assert.ok(r.setCookie.some((c) => /^feurdrop_session=;/.test(c) && /Max-Age=0/.test(c)), "cookie supprime");
  assert.equal(nav.cookies.size, 0);

  const rejoue = navigateur();
  for (const [k, v] of ancien) rejoue.cookies.set(k, v);
  assert.equal((await rejoue.va("/api/stats")).status, 401);
  assert.equal((await rejoue.va("/")).status, 302);
});

test("9 bis. « déconnecter tous les appareils » et changement de mot de passe : tout tombe", async () => {
  const a = navigateur();
  const b = navigateur();
  await a.connecte();
  await b.connecte();
  const jeton = await jetonApp();
  const r = await a.va("/api/auth/deconnexion-partout", { methode: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.json.fermees, 3);
  assert.equal((await a.va("/api/stats")).status, 401);
  assert.equal((await b.va("/api/stats")).status, 401);
  assert.equal((await anonyme("/api/stats", { entetes: { Authorization: `Bearer ${jeton}` } })).status, 401);

  // un nouveau mot de passe (nouvelle empreinte) ferme les sessions ouvertes avec l'ancien
  const c = navigateur();
  await c.connecte();
  assert.equal((await c.va("/api/stats")).status, 200);
  const ancienne = process.env.DASHBOARD_PASSWORD_HASH;
  try {
    process.env.DASHBOARD_PASSWORD_HASH = await require("argon2").hash("un-tout-autre-mot-de-passe", { type: 2, memoryCost: 8192, timeCost: 2, parallelism: 1 });
    assert.equal((await c.va("/api/stats")).status, 401, "l'ancienne session est morte");
    assert.equal((await c.connecte()).status, 401, "l'ancien mot de passe ne marche plus");
  } finally {
    process.env.DASHBOARD_PASSWORD_HASH = ancienne;
  }
});

// --- 10. les autres services gardent leur acces ------------------------------------------------

test("10. agent d'impression : son jeton, et seulement lui", async () => {
  const jeton = db.getPrintToken();
  assert.equal((await anonyme("/api/print/queue", { entetes: { "X-Print-Token": jeton } })).status, 200, "l'agent n'a pas besoin de session");
  assert.equal((await anonyme("/api/print/next", { entetes: { "X-Print-Token": jeton } })).status, 409, "(impression auto desactivee)");
  assert.equal((await anonyme("/api/print/done", { methode: "POST", corps: { ids: [] }, entetes: { "X-Print-Token": jeton } })).status, 200);
  assert.equal((await anonyme("/api/print/queue")).status, 401);
  assert.equal((await anonyme("/api/print/queue", { entetes: { "X-Print-Token": "faux" } })).status, 401);
  // une session du dashboard n'ouvre pas les routes de l'agent...
  assert.equal((await anonyme("/api/print/queue", { entetes: { Authorization: `Bearer ${await jetonApp()}` } })).status, 401);
  // ...et le jeton de l'agent n'ouvre rien d'autre
  for (const chemin of ["/api/print/resume", "/api/stats", "/api/colis"]) {
    assert.equal((await anonyme(chemin, { entetes: { "X-Print-Token": jeton } })).status, 401, chemin);
  }
});

test("10 bis. portail expediteur : son jeton donne ses colis, sans session, et rien du dashboard", async () => {
  const { creePortail } = require("../src/portail");
  const alice = db.getOrCreateSender("Alice");
  db.getOrCreateSender("Bob");
  db.addColis("Alice", { fileId: "FA", fileKind: "pdf", carrier: "MR", fileName: "alice.pdf" });
  db.addColis("Bob", { fileId: "FB", fileKind: "pdf", carrier: "LP", fileName: "bob-secret.pdf" });
  const jeton = creePortail(alice.id).sender.portail_jeton;
  const r = await anonyme(`/api/portail/${jeton}`);
  assert.equal(r.status, 200);
  assert.ok(!r.texte.includes("bob-secret"), "jamais les colis d'un autre");
  assert.equal((await anonyme("/api/portail/faux-jeton-qui-n-existe-pas")).status, 404);
  for (const chemin of ["/api/stats", "/api/senders", `/api/print/colis?categorie=MR`]) {
    assert.equal((await anonyme(chemin, { entetes: { Authorization: `Bearer ${jeton}` } })).status, 401, `${chemin} avec le jeton du portail`);
  }
});

test("10 ter. l'app iOS/Mac : jeton Bearer, lectures et ecritures, sans cookie ni CSRF", async () => {
  db.adjustStock(3, "normal");
  const jeton = await jetonApp();
  const app = { Authorization: `Bearer ${jeton}` };
  assert.equal((await anonyme("/api/stats", { entetes: app })).status, 200);
  const r = await anonyme("/api/stock/adjust", { methode: "POST", corps: { delta: 2, kind: "normal" }, entetes: app });
  assert.equal(r.status, 200);
  assert.equal(db.getStock("normal"), 5);
  const s = await anonyme("/api/auth/session", { entetes: app });
  assert.equal(s.json.type, "app");
  assert.equal(s.json.appareil, "iPhone de test");
  // (le bot Telegram n'a aucune route : il interroge Telegram lui-meme, en polling)
  assert.ok(!toutesLesRoutes().some(([, chemin]) => /telegram|webhook/i.test(chemin)));
});

// --- Connexion : essais, messages, journaux ----------------------------------------------------

test("connexion : mauvais mot de passe, puis delai progressif par adresse, sans rien reveler", async () => {
  let t = Date.now();
  sessions.horloge.maintenant = () => t;
  const nav = navigateur();
  for (let i = 1; i <= 3; i++) {
    const r = await nav.connecte("pas-le-bon-mot-de-passe");
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: "Mot de passe incorrect" });
    assert.equal(r.setCookie.length, 0);
  }
  const bloque = await nav.connecte(MOT_DE_PASSE_TEST);
  assert.equal(bloque.status, 429, "meme le bon mot de passe doit attendre");
  assert.equal(bloque.entetes.get("retry-after"), "2");
  t += 2000;
  assert.equal((await nav.connecte("encore-faux-encore")).status, 401);
  assert.equal((await nav.connecte("encore-faux-encore")).entetes.get("retry-after"), "4", "le delai double");
  t += 4000;
  assert.equal((await nav.connecte(MOT_DE_PASSE_TEST)).status, 200, "apres l'attente, le bon mot de passe passe");
  // corps absurdes : refus propre, sans plantage
  for (const corps of [{ motDePasse: 12 }, { motDePasse: "x".repeat(300) }, {}]) {
    limiteur.remiseAZero();
    assert.equal((await anonyme("/api/auth/connexion", { methode: "POST", corps })).status, 401);
  }
});

test("connexion : regeneree a chaque fois (pas de fixation), jetons jamais gardes en clair, jamais journalises", async () => {
  const lignes = [];
  const originaux = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(originaux)) console[k] = (...a) => lignes.push(a.join(" "));
  try {
    const nav = navigateur();
    await nav.connecte();
    const premier = nav.cookies.get("feurdrop_session");
    await nav.connecte();
    const second = nav.cookies.get("feurdrop_session");
    assert.notEqual(premier, second, "une session neuve a chaque connexion");
    const vieux = navigateur();
    vieux.cookies.set("feurdrop_session", premier);
    assert.equal((await vieux.va("/api/stats")).status, 401, "l'ancienne est fermee");
    await nav.connecte("mauvais-mot-de-passe");

    const base_ = JSON.stringify(db.db.prepare("SELECT * FROM sessions").all());
    assert.ok(!base_.includes(second), "la base ne contient que l'empreinte du jeton");
    for (const l of lignes) {
      assert.ok(!l.includes(MOT_DE_PASSE_TEST) && !l.includes("mauvais-mot-de-passe"), `mot de passe journalise : ${l}`);
      assert.ok(!l.includes(premier) && !l.includes(second), `jeton journalise : ${l}`);
      assert.ok(!l.includes(process.env.DASHBOARD_PASSWORD_HASH), "empreinte journalisee");
    }
  } finally {
    Object.assign(console, originaux);
  }
});

test("mot de passe non configure : le dashboard reste ferme (jamais ouvert par defaut)", async () => {
  const ancienne = process.env.DASHBOARD_PASSWORD_HASH;
  try {
    for (const valeur of ["", "monmotdepasse-en-clair", "$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyzABCDE"]) {
      process.env.DASHBOARD_PASSWORD_HASH = valeur;
      const r = await anonyme("/api/auth/connexion", { methode: "POST", corps: { motDePasse: valeur || "x" } });
      assert.equal(r.status, 503, `empreinte « ${valeur} »`);
      assert.equal((await anonyme("/api/stats")).status, 401);
    }
  } finally {
    process.env.DASHBOARD_PASSWORD_HASH = ancienne;
  }
});

test("production : HTTPS obligatoire, cookies Secure et __Host-, sauf le reseau prive du portail", async () => {
  process.env.RAILWAY_ENVIRONMENT = "production";
  try {
    const http = await anonyme("/connexion", { entetes: { "X-Forwarded-Proto": "http" } });
    assert.equal(http.status, 301);
    assert.match(http.entetes.get("location"), /^https:\/\//);
    assert.equal((await anonyme("/api/auth/connexion", { methode: "POST", corps: {}, entetes: { "X-Forwarded-Proto": "http" } })).status, 403);
    // le service du portail passe par le reseau prive de Railway, en http
    // (fetch ne laisse pas choisir l'en-tete Host : http.request, si)
    const interne = await new Promise((resolve, reject) => {
      const u = new URL(`${base}/api/portail/x`);
      require("http")
        .request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: "feurdrop3.railway.internal:8080", "X-Forwarded-Proto": "http" } }, (rep) => {
          rep.resume();
          resolve(rep.statusCode);
        })
        .on("error", reject)
        .end();
    });
    assert.equal(interne, 404, "pas de redirection : le portail recoit sa reponse");

    const r = await anonyme("/api/auth/connexion", { methode: "POST", corps: { motDePasse: MOT_DE_PASSE_TEST, mode: "web" }, entetes: { "X-Forwarded-Proto": "https" } });
    assert.equal(r.status, 200);
    const session = r.setCookie.find((c) => c.startsWith("__Host-feurdrop_session="));
    assert.ok(session, "prefixe __Host- en HTTPS");
    assert.match(session, /; Secure/);
    assert.match(session, /HttpOnly/);
    assert.ok(r.entetes.get("strict-transport-security"));
  } finally {
    delete process.env.RAILWAY_ENVIRONMENT;
  }
});

test("en-tetes : rien de prive dans les caches", async () => {
  const jeton = await jetonApp();
  const r = await anonyme("/api/stats", { entetes: { Authorization: `Bearer ${jeton}` } });
  assert.equal(r.entetes.get("cache-control"), "no-store");
  assert.equal((await anonyme("/api/stats")).entetes.get("cache-control"), "no-store");
  const page = await anonyme("/", { entetes: { Authorization: `Bearer ${jeton}` } });
  assert.equal(page.status, 200);
  assert.equal(page.entetes.get("cache-control"), "no-store");
});
