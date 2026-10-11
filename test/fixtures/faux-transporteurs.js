// De faux serveurs UPS (Track API v1, jeton OAuth) et DHL (Shipment Tracking
// - Unified), aux formats de leur documentation officielle. Ce sont des
// SIMULATIONS : aucun identifiant UPS ni cle DHL n'est pose sur ce projet.
const http = require("http");

function creeServeur(traite) {
  const appels = [];
  const serveur = http.createServer((req, res) => {
    const envoie = (status, corps, entetes = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...entetes });
      res.end(JSON.stringify(corps));
    };
    let corps = "";
    req.on("data", (d) => (corps += d));
    req.on("end", () => traite(req, corps, envoie, appels));
  });
  return {
    serveur,
    appels,
    demarre: () => new Promise((r) => serveur.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${serveur.address().port}`))),
    ferme: () =>
      new Promise((r) => {
        serveur.closeAllConnections();
        serveur.close(r);
      }),
  };
}

// UPS : activity[] du plus recent au plus ancien, { type, description, h (il y a h heures) }
function creeFauxUPS({ id = "client-ups-test", secret = "secret-ups-test" } = {}) {
  const suivis = new Map();
  const comportements = new Map();
  const jetons = new Set();
  const s = creeServeur((req, corps, envoie, appels) => {
    if (req.url.startsWith("/security/v1/oauth/token")) {
      const attendu = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
      if (req.headers.authorization !== attendu || !/grant_type=client_credentials/.test(corps)) return envoie(401, { response: { errors: [{ code: "250002", message: "Invalid Authentication Information." }] } });
      const jeton = `jeton-${jetons.size + 1}`;
      jetons.add(jeton);
      return envoie(200, { token_type: "Bearer", access_token: jeton, expires_in: "14399", status: "approved" });
    }
    const m = /^\/api\/track\/v1\/details\/([^/?]+)/.exec(req.url);
    const numero = m ? decodeURIComponent(m[1]) : null;
    appels.push({ numero, at: Date.now(), transId: req.headers.transid, src: req.headers.transactionsrc });
    if (!jetons.has(String(req.headers.authorization || "").replace(/^Bearer /, ""))) return envoie(401, { response: { errors: [{ code: "250002", message: "Invalid Authentication Information." }] } });
    const c = comportements.get(numero);
    if (c === "panne") return envoie(503, { response: { errors: [{ code: "10001", message: "Service unavailable" }] } });
    if (c === "invalide") return envoie(400, { response: { errors: [{ code: "TV0001", message: "Invalid tracking number" }] } });
    const suivi = suivis.get(numero);
    if (!suivi) return envoie(404, { response: { errors: [{ code: "TW0001", message: "Tracking Information Not Found" }] } });
    const date = (h) => new Date(Date.now() - h * 3600e3);
    const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const hms = (d) => d.toISOString().slice(11, 19).replace(/:/g, "");
    return envoie(200, {
      trackResponse: {
        shipment: [
          {
            inquiryNumber: numero,
            package: [
              {
                trackingNumber: numero,
                activity: suivi.map((a) => ({
                  location: { address: { city: a.ville || "PARIS", countryCode: "FR" } },
                  status: { type: a.type, description: a.description, code: a.code || a.type, statusCode: "003" },
                  date: ymd(date(a.h)),
                  time: hms(date(a.h)),
                  gmtOffset: "+00:00",
                })),
              },
            ],
          },
        ],
      },
    });
  });
  return {
    id,
    secret,
    ...s,
    suivi: (numero, activites) => suivis.set(numero, activites),
    comporte: (numero, c) => comportements.set(numero, c),
    vide: () => {
      suivis.clear();
      comportements.clear();
      s.appels.length = 0;
    },
  };
}

// DHL : events[] du plus recent au plus ancien, { statusCode, description, h }
function creeFauxDHL({ cle = "cle-dhl-test" } = {}) {
  const suivis = new Map();
  const comportements = new Map();
  const s = creeServeur((req, corps, envoie, appels) => {
    const u = new URL(req.url, "http://x");
    const numero = u.searchParams.get("trackingNumber");
    appels.push({ numero, at: Date.now(), langue: u.searchParams.get("language") });
    if (u.pathname !== "/track/shipments") return envoie(404, { title: "Not Found" });
    if (req.headers["dhl-api-key"] !== cle) return envoie(401, { status: 401, title: "Unauthorized", detail: "Invalid API key" });
    const c = comportements.get(numero);
    if (c === "panne") return envoie(503, { status: 503, title: "Service Unavailable" });
    if (c === "limite") return envoie(429, { status: 429, title: "Too many requests" });
    const suivi = suivis.get(numero);
    if (!suivi) return envoie(404, { status: 404, title: "No result found", detail: "No shipment with given tracking number found." });
    const evts = suivi.map((e) => ({
      timestamp: new Date(Date.now() - e.h * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z"),
      location: { address: { addressLocality: e.ville || "Paris" } },
      statusCode: e.statusCode,
      status: e.status || e.description,
      description: e.description,
    }));
    return envoie(200, { shipments: [{ id: numero, service: "parcel-de", status: { statusCode: suivi[0]?.statusCode || "unknown" }, events: evts }] });
  });
  return {
    cle,
    ...s,
    suivi: (numero, evenements) => suivis.set(numero, evenements),
    comporte: (numero, c) => comportements.set(numero, c),
    vide: () => {
      suivis.clear();
      comportements.clear();
      s.appels.length = 0;
    },
  };
}

module.exports = { creeFauxUPS, creeFauxDHL };
