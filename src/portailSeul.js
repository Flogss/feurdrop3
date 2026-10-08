const path = require("path");
const express = require("express");
const compression = require("compression");
const { FORME_JETON, PUBLIC, pageHtml, ENTETES, ENTETES_PAGE, limiteur } = require("./portailCommun");

// Le portail des expediteurs, sur son propre domaine : un service Railway a
// part (DROP_ROLE=portail), pour que l'adresse du dashboard n'apparaisse
// jamais chez un expediteur -- ni dans son lien, ni dans la page, ni dans ses
// requetes.
//
// Ce serveur n'a ni base, ni bot, ni dashboard. Il sert la page
// (https://<domaine>/<jeton>) et transmet la demande de colis au dashboard
// par le reseau prive de Railway (DROP_INTERNE), qui verifie le jeton et ne
// renvoie que les colis de cet expediteur.

const DASHBOARD = (process.env.DROP_INTERNE || "http://feurdrop3.railway.internal:8080").replace(/\/+$/, "");
// les seuls fichiers que la page utilise : le systeme de design du
// dashboard (styles.css, et les particules du fond), et ceux du portail
const FICHIERS = ["styles.css", "particules.js", "portail.css", "portail.js", "favicon.svg", "icon-192.png"];

const app = express();
// derriere le proxy de Railway : l'adresse du visiteur vient de ses en-tetes
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(compression());

// revalides a chaque chargement (304 s'ils n'ont pas change) : la page les
// appelle de toute facon par leur empreinte
for (const fichier of FICHIERS) {
  app.get(`/${fichier}`, (req, res) => res.sendFile(path.join(PUBLIC, fichier), { cacheControl: false, headers: { "Cache-Control": "no-cache" } }));
}

const essais = limiteur({ fenetreMs: 15 * 60 * 1000, max: 30 });

// Les colis : la demande part telle quelle au dashboard, avec l'adresse du
// visiteur (son propre limiteur d'essais) et l'empreinte deja recue (304).
app.get("/api/portail/:jeton", async (req, res) => {
  res.set(ENTETES);
  const jeton = req.params.jeton;
  if (essais.bloque(req.ip)) return res.status(429).json({ error: "Trop d'essais. Réessaie dans un quart d'heure." });
  if (!FORME_JETON.test(jeton)) {
    essais.echec(req.ip);
    return res.status(404).json({ error: "Ce lien n'est pas valide, ou n'est plus actif." });
  }
  const n = Math.max(0, Math.min(2000, Math.floor(Number(req.query.n)) || 0));
  try {
    const reponse = await fetch(`${DASHBOARD}/api/portail/${encodeURIComponent(jeton)}${n ? `?n=${n}` : ""}`, {
      headers: {
        "x-forwarded-for": req.ip,
        ...(req.get("if-none-match") ? { "if-none-match": req.get("if-none-match") } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (reponse.status === 404) essais.echec(req.ip);
    const etag = reponse.headers.get("etag");
    if (etag) res.set("ETag", etag);
    res.status(reponse.status);
    if (reponse.status === 304) return res.end();
    res.type("application/json").send(await reponse.text());
  } catch (err) {
    console.error("[portail] dashboard injoignable :", err.message);
    res.status(502).json({ error: "Service momentanément indisponible" });
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "Introuvable" }));

// La page : la meme pour tous les jetons (elle ne contient aucune donnee) ;
// un lien faux le decouvre a la premiere demande de colis.
app.get("/:jeton", (req, res) => {
  res.set(ENTETES_PAGE);
  res.status(FORME_JETON.test(req.params.jeton) ? 200 : 404).type("html").send(pageHtml());
});
app.use((req, res) => {
  res.set(ENTETES_PAGE);
  res.status(404).type("html").send(pageHtml());
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[portail] http://localhost:${PORT} -> colis demandes a ${DASHBOARD}`);
});
