// « Créer un itinéraire — Boîtes jaunes » : les boites La Poste (copie locale
// du jeu de donnees ouvertes), la matrice et le trajet OSRM, le geocodage --
// chacun par un faux service local. On verifie que la tournee est la plus
// rapide par la route (pas les N plus proches), que temps et distances
// viennent tels quels du routeur, et les cas limites.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { environnementDeTest, demarreApp } = require("./aide");

environnementDeTest();
process.env.OSRM_INTERVALLE_MS = "0";

// --- Faux jeu de donnees La Poste ---------------------------------------------------
// Autour de Villejuif : une grille de boites tous les ~110 m sur 2 km de
// cote, plus des cas particuliers.
const CENTRE = { lat: 48.792, lon: 2.3634 };
const boites = [];
let n = 0;
for (let i = -9; i <= 9; i += 1) {
  for (let j = -9; j <= 9; j += 1) {
    n += 1;
    boites.push({ id: `G${String(n).padStart(4, "0")}`, lat: CENTRE.lat + i * 0.001, lon: CENTRE.lon + j * 0.0015, voie: `RUE ${n}`, num: String(n), com: "VILLEJUIF", hdl: n % 2 ? "T09:00:00+00:00" : "T16:30:00+00:00" });
  }
}
// un village isole a ~20 km : 3 boites seulement dans 1 km
const VILLAGE = { lat: 48.62, lon: 2.6 };
for (let k = 0; k < 3; k += 1) boites.push({ id: `V${k}`, lat: VILLAGE.lat + k * 0.002, lon: VILLAGE.lon, voie: "GRANDE RUE", num: String(k + 1), com: "SAINT-GERMAIN-LÈS-CORBEIL", hdl: "T11:00:00+00:00" });
// 3 boites d'adresses differentes posees sur le meme point (centre de commune) : imprecises
for (let k = 0; k < 3; k += 1) boites.push({ id: `I${k}`, lat: 48.7931, lon: 2.36521, voie: `AVENUE ${k}`, num: "1", com: "VILLEJUIF", hdl: "T09:00:00+00:00" });
// position a 3 decimales : imprecise ; position hors de France : ecartee
boites.push({ id: "P3", lat: 48.791, lon: 2.364, voie: "RUE ARRONDIE", num: "1", com: "VILLEJUIF", hdl: "T09:00:00+00:00", brut: true });
boites.push({ id: "HORS", lat: 55.99, lon: -2.94, voie: "NULLE PART", num: "1", com: "VILLEJUIF", hdl: "T09:00:00+00:00" });
// deux boites a 5 m l'une de l'autre : un seul arret
// (entre deux points de la grille, a plus de 50 m de chacun)
boites.push({ id: "D1", lat: 48.7985, lon: 2.37015, voie: "PLACE DE LA POSTE", num: "2", com: "VILLEJUIF", hdl: "T12:00:00+00:00" });
boites.push({ id: "D2", lat: 48.79853, lon: 2.37018, voie: "PLACE DE LA POSTE", num: "2", com: "VILLEJUIF", hdl: "T17:00:00+00:00" });

function csv() {
  const lignes = ["CO_MUP;VA_NO_VOIE;LB_EXTENSION;LB_VOIE_EXT;LB_COM;CO_POSTAL;CO_INSEE_COM;VA_COORD_ADR_X;VA_COORD_ADR_Y;HDL_SEMAINE_EXTRA;HDL_SAMEDI_EXTRA"];
  for (const b of boites) {
    const x = b.brut ? b.lon.toFixed(3) : b.lon.toFixed(10);
    const y = b.brut ? b.lat.toFixed(3) : b.lat.toFixed(10);
    lignes.push(`${b.id};${b.num};;${b.voie};${b.com};94800;94076;${x};${y};${b.hdl};T09:00:00+00:00`);
  }
  return Buffer.from(`${lignes.join("\r\n")}\r\n`, "latin1");
}

// --- Faux OSRM ------------------------------------------------------------------------
// Temps = distance / 8 m/s, plus une « autoroute sans sortie » : franchir la
// longitude 2.3634 + 0.004 coute 10 minutes (les boites a l'est sont proches a
// vol d'oiseau mais loin par la route). Le sens nord -> sud coute 10 % de plus
// (matrice asymetrique, comme des sens uniques).
const R = 6371008.8;
const dist = (a, b) => {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const BARRIERE = CENTRE.lon + 0.004;
function temps(a, b) {
  let t = (dist(a, b) * 1.3) / 8;
  if (a.lon < BARRIERE !== b.lon < BARRIERE) t += 600;
  if (b.lat < a.lat) t *= 1.1;
  return Math.round(t * 10) / 10;
}
const osrm = { appels: [], panne: null };
const services = { lignes: 0, csv: 0, meta: 0, geocodage: 0 };

function repond(res, status, corps, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof corps === "string" || Buffer.isBuffer(corps) ? corps : JSON.stringify(corps));
}

let serveur;
let app;
before(async () => {
  serveur = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/lp") {
      services.meta += 1;
      return repond(res, 200, { dataUpdatedAt: "2026-09-08T14:16:24.165Z", file: { md5: "abc" }, storage: { dataFiles: [{ key: "original", name: "MUP_TEST.csv" }] } });
    }
    if (url.pathname === "/lp/data-files/MUP_TEST.csv") {
      services.csv += 1;
      return repond(res, 200, csv(), "text/csv");
    }
    if (url.pathname.startsWith("/osrm/")) {
      const [, , service, , , coords] = url.pathname.split("/");
      const points = coords.split(";").map((c) => {
        const [lon, lat] = c.split(",").map(Number);
        return { lat, lon };
      });
      osrm.appels.push({ service, n: points.length });
      if (osrm.panne) return repond(res, osrm.panne.status, osrm.panne.corps);
      if (service === "table") {
        return repond(res, 200, {
          code: "Ok",
          durations: points.map((a) => points.map((b) => temps(a, b))),
          distances: points.map((a) => points.map((b) => Math.round(dist(a, b) * 1.3))),
        });
      }
      if (service === "route") {
        const legs = points.slice(1).map((b, i) => ({ duration: temps(points[i], b) + 0.5, distance: Math.round(dist(points[i], b) * 1.3) + 7 }));
        return repond(res, 200, {
          code: "Ok",
          routes: [{ duration: legs.reduce((s, l) => s + l.duration, 0), distance: legs.reduce((s, l) => s + l.distance, 0), legs, geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) } }],
          waypoints: points.map(() => ({ name: "Rue", distance: 4.2 })),
        });
      }
    }
    if (url.pathname === "/geo/search") {
      services.geocodage += 1;
      if (/introuvable/i.test(url.searchParams.get("q"))) return repond(res, 200, { features: [] });
      return repond(res, 200, { features: [{ geometry: { coordinates: [2.3661, 48.7962] }, properties: { label: "12 Rue Jean Jaurès 94800 Villejuif", city: "Villejuif", type: "housenumber", score: 0.97 } }] });
    }
    if (url.pathname === "/geo/reverse") {
      return repond(res, 200, { features: [{ geometry: { coordinates: [2.3634, 48.792] }, properties: { label: "2 Esplanade Pierre Yves Cosnier 94800 Villejuif", distance: 14 } }] });
    }
    if (url.pathname.startsWith("/tuiles/")) return repond(res, 200, Buffer.from("PNG"), "image/png");
    repond(res, 404, { message: "?" });
  });
  await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  process.env.BOITES_SOURCE_URL = `${base}/lp`;
  process.env.OSRM_URL = `${base}/osrm`;
  process.env.GEOCODAGE_URL = `${base}/geo`;
  process.env.TUILES_URL = `${base}/tuiles/{z}/{x}/{y}.png`;
  app = await demarreApp();
});

after(async () => {
  await app.ferme();
  require("../src/itineraire/boites").ferme();
  await new Promise((r) => serveur.close(r));
});

beforeEach(() => {
  osrm.appels = [];
  osrm.panne = null;
});

const calcule = (corps) => app.appel("/api/itineraire/calcul", { methode: "POST", corps });
const GPS = { lat: CENTRE.lat, lon: CENTRE.lon, origine: "gps" };

test("la copie La Poste : importee une fois, positions douteuses ecartees, accents lus", async () => {
  const { actualise, boitesAutour, etat } = require("../src/itineraire/boites");
  const r = await actualise();
  assert.equal(r.change, true);
  assert.equal(r.ecartees, 1, "la boite hors de France");
  // une deuxieme verification ne retelecharge pas un fichier inchange
  const avant = services.csv;
  assert.equal((await actualise()).change, false);
  assert.equal(services.csv, avant);
  assert.equal(etat().imprecises, 4, "3 sur le meme point + 1 a 3 decimales");

  const village = await boitesAutour(VILLAGE, 1000);
  assert.equal(village.boites.length, 3);
  assert.equal(village.boites[0].commune, "SAINT-GERMAIN-LÈS-CORBEIL", "ISO-8859-1 decode");
  assert.equal(village.boites[0].limiteSemaine, "11:00");
  const ici = await boitesAutour(CENTRE, 400);
  assert.ok(ici.imprecises >= 4);
  assert.ok(!ici.boites.some((b) => ["I0", "I1", "I2", "P3"].includes(b.id)), "jamais une position douteuse");
});

test("depart GPS, 8 boites dans 5 km : la tournee la plus rapide par la route, pas les 8 plus proches", async () => {
  const r = await calcule({ depart: GPS, rayonKm: 5, nombre: 8 });
  assert.equal(r.status, 200, r.texte);
  const d = r.json;
  assert.equal(d.arrets.length, 8);
  assert.deepEqual(d.arrets.map((a) => a.ordre), [1, 2, 3, 4, 5, 6, 7, 8]);
  // la barriere : aucune boite de l'autre cote, meme si certaines sont plus
  // proches a vol d'oiseau que celles retenues
  assert.ok(d.arrets.every((a) => a.lon < BARRIERE), "rien derriere la barriere");
  // une requete de matrice, une de trajet : pas plus
  assert.deepEqual(osrm.appels.map((a) => a.service), ["table", "route"]);
  assert.equal(osrm.appels[0].n, 100, "depart + 99 arrets compares");
  // temps et distances : ceux du trajet OSRM, tels quels (le faux OSRM ajoute
  // 0,5 s et 7 m par troncon : un calcul maison ne les retrouverait pas)
  const somme = d.arrets.reduce((s, a) => s + a.depuisPrecedent.duree, 0);
  assert.equal(Math.round(d.total.duree * 10), Math.round(somme * 10));
  d.arrets.forEach((a, i) => {
    const avant = i === 0 ? CENTRE : d.arrets[i - 1];
    assert.ok(Math.abs(a.depuisPrecedent.duree - (temps(avant, a) + 0.5)) < 0.2, `troncon ${i + 1} : la duree du routeur`);
    assert.ok(Math.abs(a.depuisPrecedent.distance - (Math.round(dist(avant, a) * 1.3) + 7)) <= 1, `troncon ${i + 1} : la distance du routeur`);
  });
  assert.equal(d.arrets.at(-1).arriveeDans, d.total.duree);
  assert.ok(d.geometrie.length >= 9);
  assert.equal(d.sources.routage.trafic, false, "pas de trafic avec OSRM : dit, pas invente");
  // les liens de navigation passent par toutes les boites, dans l'ordre
  assert.equal(d.liens.applePlans.length, 1);
  assert.equal((d.liens.applePlans[0].match(/waypoint=/g) || []).length, 7);
  assert.match(d.liens.applePlans[0], /^https:\/\/maps\.apple\.com\/directions\?source=48\.792000,2\.363400&destination=/);
  assert.equal(d.liens.googleMaps.length, 1);
  assert.equal(d.liens.googleMaps[0].split("waypoints=")[1].split("&")[0].split("|").length, 7);
  // les heures limites suivent
  assert.ok(d.arrets.every((a) => ["09:00", "16:30", "12:00", "17:00"].includes(a.limiteSemaine)));
});

test("5, 8 et 10 boites ; le rayon change la zone", async () => {
  for (const nombre of [5, 8, 10]) {
    const r = await calcule({ depart: GPS, rayonKm: 3, nombre });
    assert.equal(r.status, 200);
    assert.equal(r.json.arrets.length, nombre);
    assert.equal(new Set(r.json.arrets.map((a) => a.id)).size, nombre, "jamais deux fois la meme boite");
  }
  const petit = await calcule({ depart: GPS, rayonKm: 0.5, nombre: 8 });
  const grand = await calcule({ depart: GPS, rayonKm: 5, nombre: 8 });
  assert.ok(petit.json.zone.arrets < grand.json.zone.arrets);
  assert.ok(petit.json.arrets.every((a) => Math.hypot((a.lat - CENTRE.lat) * 111320, (a.lon - CENTRE.lon) * 73400) <= 520));
});

test("beaucoup de boites : les 99 plus proches comparees, et c'est dit", async () => {
  const r = await calcule({ depart: GPS, rayonKm: 5, nombre: 15 });
  assert.equal(r.json.zone.comparees, 99);
  assert.ok(r.json.zone.arrets > 99, "la zone en compte davantage (le site et l'app l'ecrivent sous la tournee)");
  assert.deepEqual(r.json.avertissements, [], "ce n'est pas un avertissement");
});

test("moins de boites que demande : toutes celles du rayon, et c'est dit", async () => {
  const r = await calcule({ depart: { ...VILLAGE, origine: "gps" }, rayonKm: 1, nombre: 8 });
  assert.equal(r.status, 200);
  assert.equal(r.json.arrets.length, 3);
  assert.match(r.json.avertissements[0], /Seulement 3 boîtes accessibles dans 1 km \(8 demandées\)/);

  const vide = await calcule({ depart: { lat: 48.5, lon: 2.0 }, rayonKm: 1, nombre: 8 });
  assert.equal(vide.status, 404);
  assert.match(vide.json.error, /Aucune boîte jaune dans un rayon de 1 km/);
});

test("deux boites au meme endroit : un seul arret, la levee la plus tardive", async () => {
  const r = await calcule({ depart: { lat: 48.7985, lon: 2.3702 }, rayonKm: 0.3, nombre: 25 });
  const poste = r.json.arrets.find((a) => a.ids.includes("D1"));
  assert.ok(poste);
  assert.deepEqual(poste.ids.sort(), ["D1", "D2"]);
  assert.equal(poste.boites, 2);
  assert.equal(poste.limiteSemaine, "17:00");
});

test("depart depuis une adresse tapee", async () => {
  const r = await calcule({ depart: { adresse: "12 rue Jean Jaurès, Villejuif" }, rayonKm: 2, nombre: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.depart.label, "12 Rue Jean Jaurès 94800 Villejuif");
  assert.equal(r.json.depart.lat, 48.7962);
  assert.equal(r.json.arrets.length, 5);

  const introuvable = await calcule({ depart: { adresse: "adresse introuvable" }, rayonKm: 2, nombre: 5 });
  assert.equal(introuvable.status, 404);
  assert.match(introuvable.json.error, /Adresse introuvable/);

  const s = await app.appel(`/api/itineraire/adresses?q=${encodeURIComponent("12 rue jean")}&lat=48.79&lon=2.36`);
  assert.equal(s.json.lieux[0].label, "12 Rue Jean Jaurès 94800 Villejuif");
  const lieu = await app.appel("/api/itineraire/lieu?lat=48.792&lon=2.3634");
  assert.match(lieu.json.lieu.label, /Villejuif/);
});

test("parametres et position invalides : refus clairs", async () => {
  assert.equal((await calcule({ depart: { lat: 999, lon: 2 }, rayonKm: 3, nombre: 8 })).status, 400);
  assert.equal((await calcule({ depart: GPS, rayonKm: 100, nombre: 8 })).status, 400);
  assert.equal((await calcule({ depart: GPS, rayonKm: 3, nombre: 0 })).status, 400);
  assert.equal((await calcule({ depart: GPS, rayonKm: 3, nombre: 40 })).status, 400);
  const sans = await calcule({ rayonKm: 3, nombre: 8 });
  assert.equal(sans.status, 400);
  assert.match(sans.json.error, /Choisis un départ/);
  assert.equal((await app.appel("/api/itineraire/lieu?lat=abc&lon=2")).status, 400);
});

test("le routeur en panne : une erreur claire, jamais de temps invente", async () => {
  osrm.panne = { status: 500, corps: { code: "InternalError", message: "panne de test" } };
  const r = await calcule({ depart: { lat: 48.7905, lon: 2.36 }, rayonKm: 2, nombre: 5 });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /calcul d'itinéraire a échoué \(OSRM : panne de test\)/);
  assert.equal(r.json.total, undefined);
  assert.equal(r.json.arrets, undefined);

  osrm.panne = { status: 429, corps: { code: "TooManyRequests" } };
  const trop = await calcule({ depart: { lat: 48.7906, lon: 2.36 }, rayonKm: 2, nombre: 5 });
  assert.equal(trop.status, 429);
});

test("recalculer : une autre selection sans redemander la matrice ; apres un deplacement, tout est recalcule", async () => {
  const depart = { lat: 48.7915, lon: 2.3612, origine: "gps" };
  const a = await calcule({ depart, rayonKm: 2, nombre: 6 });
  assert.equal(a.json.variante, 0);
  assert.ok(a.json.variantes >= 2);
  osrm.appels = [];
  const b = await calcule({ depart, rayonKm: 2, nombre: 6, variante: 1 });
  assert.equal(b.json.variante, 1);
  assert.equal(b.json.sources.matriceGardee, true);
  assert.deepEqual(osrm.appels.map((x) => x.service), ["route"], "seulement le nouveau trajet");
  assert.notDeepEqual(new Set(b.json.arrets.map((x) => x.id)), new Set(a.json.arrets.map((x) => x.id)));
  assert.ok(b.json.total.duree >= a.json.total.duree - 1, "la premiere est la meilleure");

  // deplace de 600 m : nouvelle matrice, nouvelle tournee
  osrm.appels = [];
  const c = await calcule({ depart: { lat: 48.7969, lon: 2.3612, origine: "gps" }, rayonKm: 2, nombre: 6 });
  assert.equal(c.json.sources.matriceGardee, false);
  assert.deepEqual(osrm.appels.map((x) => x.service), ["table", "route"]);
  assert.notDeepEqual(c.json.arrets.map((x) => x.id), a.json.arrets.map((x) => x.id));
});

test("eviter des boites, et seulement les levees a venir", async () => {
  const depart = { lat: 48.7915, lon: 2.3612, origine: "gps" };
  const a = await calcule({ depart, rayonKm: 1, nombre: 4 });
  const evitee = a.json.arrets[0].id;
  const b = await calcule({ depart, rayonKm: 1, nombre: 4, exclure: [evitee] });
  assert.ok(!b.json.arrets.some((x) => x.id === evitee));

  // un mardi a 14 h (Paris) : seules les boites levees a 16 h 30 restent
  const { calculeItineraire } = require("../src/itineraire");
  const mardi14h = Date.parse("2026-11-03T13:00:00Z");
  const c = await calculeItineraire({ depart, rayonKm: 1, nombre: 4, leveeAVenir: true }, { maintenant: mardi14h });
  assert.ok(c.arrets.every((x) => x.limiteSemaine === "16:30"));
  assert.ok(c.arrets.every((x) => x.apresLimite === false));
  assert.ok(c.avertissements.some((x) => /déjà levées aujourd'hui, écartées/.test(x)));
  // sans le filtre, a 14 h, une boite levee a 9 h est signalee « apres la limite »
  const d = await calculeItineraire({ depart, rayonKm: 1, nombre: 8 }, { maintenant: mardi14h });
  assert.ok(d.arrets.some((x) => x.limiteSemaine === "09:00" && x.apresLimite === true));
});

test("liens de navigation au-dela de 9 boites : Google Maps en plusieurs morceaux", () => {
  const { liensNavigation } = require("../src/itineraire");
  const pts = Array.from({ length: 15 }, (_, i) => ({ lat: 48.7 + i / 1000, lon: 2.3 }));
  const l = liensNavigation({ lat: 48.69, lon: 2.3 }, pts);
  assert.equal(l.googleMaps.length, 2);
  // le second repart de la derniere boite du premier
  const fin1 = new URL(l.googleMaps[0]).searchParams.get("destination");
  assert.equal(new URL(l.googleMaps[1]).searchParams.get("origin"), fin1);
  // Apple Plans : 14 etapes par lien, les 15 boites tiennent en un
  assert.equal(l.applePlans.length, 1);
  assert.equal((l.applePlans[0].match(/waypoint=/g) || []).length, 14);
});

test("les tuiles du fond de carte passent par le serveur", async () => {
  const r = await app.appel("/api/itineraire/tuiles/12/2075/1410");
  assert.equal(r.status, 200);
  assert.equal(r.texte, "PNG");
  assert.match(r.entetes.get("cache-control"), /max-age/);
  assert.equal((await app.appel("/api/itineraire/tuiles/3/99/1")).status, 400);
  assert.equal((await app.appel("/api/itineraire/tuiles/12/2075/1410", { anonyme: true })).status, 401);
});

test("l'optimisation trouve l'optimum (comparee a la force brute)", () => {
  const { meilleuresTournees, coutsDe, coutChemin } = require("../src/itineraire/optimise");
  let graine = 11;
  const alea = () => ((graine = (graine * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 25; k += 1) {
    const pts = Array.from({ length: 11 }, () => ({ lat: 48.79 + alea() / 50, lon: 2.36 + alea() / 50 }));
    const t = pts.map((a) => pts.map((b) => temps(a, b)));
    const nb = 4 + (k % 3);
    const c = coutsDe(t, null);
    let brut = Infinity;
    const essaie = (chemin, reste) => {
      if (chemin.length - 1 === nb) {
        brut = Math.min(brut, coutChemin(c, chemin));
        return;
      }
      for (const x of reste) essaie([...chemin, x], reste.filter((y) => y !== x));
    };
    essaie([0], Array.from({ length: 10 }, (_, i) => i + 1));
    const [meilleure] = meilleuresTournees(t, null, nb);
    assert.ok(Math.abs(meilleure.cout - brut) < 1e-6, `instance ${k} : ${meilleure.cout} contre ${brut}`);
  }
});
