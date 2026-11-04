// --- Itinéraire — Boîtes jaunes ------------------------------------------------------
// Le depart (position du navigateur ou adresse), le rayon et le nombre de
// boites ; le serveur choisit les boites et l'ordre de passage les plus
// rapides en voiture (POST /api/itineraire/calcul) ; la carte montre la
// tournee. Temps et distances : ceux du routeur, jamais recalcules ici.
// Leaflet n'est charge qu'a la premiere ouverture de la page.

const iti = {
  mode: "gps", // "gps" | "adresse"
  position: null, // { lat, lon, precision, label }
  adresse: null, // { lat, lon, label }
  rayon: 3,
  nombre: 8,
  leveeAVenir: false,
  resultat: null,
  variante: 0,
  exclure: [],
  dernierDepart: null,
  carte: null,
  couches: null,
  marqueurs: [],
  choisi: null,
  localisation: null, // la demande de position en cours
};

// les reglages d'une fois sur l'autre (rien de sensible : pas la position)
try {
  const garde = JSON.parse(localStorage.getItem("itineraire") || "{}");
  if (garde.mode === "adresse" || garde.mode === "gps") iti.mode = garde.mode;
  if ([1, 3, 5, 10].includes(garde.rayon)) iti.rayon = garde.rayon;
  if (Number.isInteger(garde.nombre) && garde.nombre >= 1 && garde.nombre <= 25) iti.nombre = garde.nombre;
  iti.leveeAVenir = garde.leveeAVenir === true;
} catch {}
function gardeReglages() {
  try {
    localStorage.setItem("itineraire", JSON.stringify({ mode: iti.mode, rayon: iti.rayon, nombre: iti.nombre, leveeAVenir: iti.leveeAVenir }));
  } catch {}
}

// « 7 min », « 1 h 05 » ; « 3,6 km », « 450 m »
function dureeTexte(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}
function distanceTexte(m) {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0).replace(".", ",")} km`;
}
const heureTexte = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":");
  return h ? `${Number(h)}h${m}` : "—";
};

// --- Les reglages -------------------------------------------------------------------

function rendReglages() {
  document.querySelectorAll(".iti-modes .seg").forEach((b) => {
    const on = b.dataset.depart === iti.mode;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("iti-adresse-bloc").hidden = iti.mode !== "adresse";
  $("iti-position").hidden = iti.mode !== "gps";
  document.querySelectorAll("#iti-rayons .iti-puce").forEach((b) => {
    const on = Number(b.dataset.rayon) === iti.rayon;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("#iti-nombres .iti-puce").forEach((b) => {
    const on = Number(b.dataset.nombre) === iti.nombre;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("iti-nombre").textContent = String(iti.nombre);
  document.querySelector('[data-iti-pas="-1"]').disabled = iti.nombre <= 1;
  document.querySelector('[data-iti-pas="1"]').disabled = iti.nombre >= 25;
  $("iti-levee").checked = iti.leveeAVenir;
  const depart = departChoisi();
  $("iti-creer").disabled = !depart;
}

function departChoisi() {
  if (iti.mode === "gps") return iti.position ? { ...iti.position, origine: "gps" } : null;
  return iti.adresse ? { ...iti.adresse, origine: "adresse" } : null;
}

// --- Position du navigateur ---------------------------------------------------------

function etatPosition(texte, { erreur = false, ok = false, reessayer = false } = {}) {
  const bloc = $("iti-position");
  bloc.classList.toggle("is-erreur", erreur);
  bloc.classList.toggle("is-ok", ok);
  $("iti-position-texte").textContent = texte;
  $("iti-relocaliser").hidden = !reessayer;
}

const MESSAGES_POSITION = {
  1: "Localisation refusée : autorise-la pour ce site dans le navigateur, ou choisis une adresse.",
  2: "Position introuvable pour l'instant (GPS, Wi-Fi ?) : réessaie, ou choisis une adresse.",
  3: "La position met trop de temps à venir : réessaie, ou choisis une adresse.",
};

// La position actuelle (une seule demande a la fois). Rend null si refusee.
function localise() {
  if (iti.localisation) return iti.localisation;
  if (!("geolocation" in navigator)) {
    etatPosition("Ce navigateur ne donne pas la position : choisis une adresse.", { erreur: true });
    return Promise.resolve(null);
  }
  if (!window.isSecureContext) {
    etatPosition("La position demande une connexion sécurisée (https) : choisis une adresse.", { erreur: true });
    return Promise.resolve(null);
  }
  etatPosition("Recherche de ta position…");
  $("iti-position").classList.add("is-cherche");
  iti.localisation = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const position = { lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy, label: null };
        iti.position = position;
        etatPosition(`Position trouvée, à ${Math.round(position.precision)} m près`, { ok: true });
        // l'adresse la plus proche, pour se reperer (sans bloquer le calcul)
        fetchJSON(`/api/itineraire/lieu?lat=${position.lat}&lon=${position.lon}`)
          .then((r) => {
            if (r.lieu?.label && iti.position === position) {
              position.label = r.lieu.label;
              etatPosition(`${r.lieu.label} · à ${Math.round(position.precision)} m près`, { ok: true });
            }
          })
          .catch(() => {});
        resolve(position);
      },
      (err) => {
        etatPosition(MESSAGES_POSITION[err.code] || `Position indisponible (${err.message}).`, { erreur: true, reessayer: true });
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 20000 }
    );
  }).finally(() => {
    iti.localisation = null;
    $("iti-position").classList.remove("is-cherche");
    rendReglages();
  });
  return iti.localisation;
}

// --- Adresse tapee : suggestions -----------------------------------------------------

let minuteurSuggestions = null;
let suggestions = [];
let suggestionActive = -1;

function rendSuggestions() {
  const liste = $("iti-suggestions");
  liste.hidden = suggestions.length === 0;
  liste.innerHTML = suggestions
    .map(
      (l, i) => `
    <li role="option" id="iti-sug-${i}" class="iti-suggestion${i === suggestionActive ? " is-active" : ""}" data-i="${i}" aria-selected="${i === suggestionActive}">
      ${ico("pin")}<span>${escapeHtml(l.label)}</span>
    </li>`
    )
    .join("");
  $("iti-adresse").setAttribute("aria-activedescendant", suggestionActive >= 0 ? `iti-sug-${suggestionActive}` : "");
}

function choisitAdresse(lieu) {
  iti.adresse = { lat: lieu.lat, lon: lieu.lon, label: lieu.label };
  $("iti-adresse").value = lieu.label;
  suggestions = [];
  rendSuggestions();
  rendReglages();
  haptique();
}

$("iti-adresse").addEventListener("input", () => {
  const q = $("iti-adresse").value.trim();
  // l'adresse choisie ne vaut plus si on la retouche
  if (iti.adresse && q !== iti.adresse.label) {
    iti.adresse = null;
    rendReglages();
  }
  clearTimeout(minuteurSuggestions);
  if (q.length < 3) {
    suggestions = [];
    rendSuggestions();
    return;
  }
  minuteurSuggestions = setTimeout(async () => {
    const pres = iti.position ? `&lat=${iti.position.lat}&lon=${iti.position.lon}` : "";
    try {
      const r = await fetchJSON(`/api/itineraire/adresses?q=${encodeURIComponent(q)}${pres}`);
      if ($("iti-adresse").value.trim() !== q) return;
      suggestions = r.lieux || [];
      suggestionActive = suggestions.length ? 0 : -1;
      rendSuggestions();
    } catch (err) {
      toast(`Recherche d'adresse impossible : ${err.message}`, "error");
    }
  }, 280);
});
$("iti-adresse").addEventListener("keydown", (e) => {
  if (!suggestions.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    suggestionActive = (suggestionActive + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
    rendSuggestions();
  } else if (e.key === "Enter" && suggestionActive >= 0) {
    e.preventDefault();
    choisitAdresse(suggestions[suggestionActive]);
  } else if (e.key === "Escape") {
    suggestions = [];
    rendSuggestions();
  }
});
$("iti-suggestions").addEventListener("pointerdown", (e) => {
  const li = e.target.closest(".iti-suggestion");
  if (!li) return;
  e.preventDefault();
  choisitAdresse(suggestions[Number(li.dataset.i)]);
});

// --- Choix ----------------------------------------------------------------------------

document.querySelector(".iti-modes").addEventListener("click", (e) => {
  const b = e.target.closest(".seg");
  if (!b || b.dataset.depart === iti.mode) return;
  iti.mode = b.dataset.depart;
  gardeReglages();
  rendReglages();
  haptique();
  if (iti.mode === "gps" && !iti.position) localise();
  if (iti.mode === "adresse") setTimeout(() => $("iti-adresse").focus(), 60);
});
$("iti-relocaliser").addEventListener("click", () => localise());
$("iti-rayons").addEventListener("click", (e) => {
  const b = e.target.closest(".iti-puce");
  if (!b) return;
  iti.rayon = Number(b.dataset.rayon);
  gardeReglages();
  rendReglages();
  haptique();
});
$("iti-nombres").addEventListener("click", (e) => {
  const b = e.target.closest(".iti-puce");
  if (!b) return;
  iti.nombre = Number(b.dataset.nombre);
  gardeReglages();
  rendReglages();
  haptique();
});
document.querySelector(".iti-stepper").addEventListener("click", (e) => {
  const b = e.target.closest("[data-iti-pas]");
  if (!b) return;
  iti.nombre = Math.min(25, Math.max(1, iti.nombre + Number(b.dataset.itiPas)));
  gardeReglages();
  rendReglages();
  haptique();
});
$("iti-levee").addEventListener("change", () => {
  iti.leveeAVenir = $("iti-levee").checked;
  gardeReglages();
  haptique();
});

// --- La carte (Leaflet, chargee a la demande) -----------------------------------------

let leafletCharge = null;
function chargeLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletCharge) return leafletCharge;
  leafletCharge = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/vendor/leaflet/leaflet.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "/vendor/leaflet/leaflet.js";
    js.onload = () => resolve(window.L);
    js.onerror = () => {
      leafletCharge = null;
      reject(new Error("la carte n'a pas pu se charger"));
    };
    document.head.appendChild(js);
  });
  return leafletCharge;
}

async function carte() {
  const L = await chargeLeaflet();
  if (iti.carte) return iti.carte;
  const depart = departChoisi() || { lat: 48.8566, lon: 2.3522 };
  iti.carte = L.map("iti-carte", { zoomControl: true, attributionControl: true, zoomSnap: 0.5, wheelPxPerZoomLevel: 90 }).setView([depart.lat, depart.lon], 13);
  // tuiles OpenStreetMap, relayees par le serveur, assombries par la page
  L.tileLayer("/api/itineraire/tuiles/{z}/{x}/{y}", {
    maxZoom: 19,
    // ecran Retina : les tuiles du niveau au-dessus, nettes
    detectRetina: true,
    className: "iti-tuiles",
    attribution: "© contributeurs OpenStreetMap · itinéraire OSRM",
  }).addTo(iti.carte);
  iti.carte.attributionControl.setPrefix(false);
  iti.couches = L.layerGroup().addTo(iti.carte);
  return iti.carte;
}

function iconeArret(L, numero, { actif = false, apres = false } = {}) {
  return L.divIcon({
    className: "",
    html: `<span class="iti-marqueur${actif ? " is-actif" : ""}${apres ? " is-apres" : ""}"><b>${numero}</b></span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

async function rendCarte(d) {
  const map = await carte();
  const L = window.L;
  $("iti-carte-vide").hidden = true;
  iti.couches.clearLayers();
  iti.marqueurs = [];
  // les autres boites de la zone, en fond
  for (const [lat, lon] of d.autres || []) {
    L.circleMarker([lat, lon], { radius: 3, className: "iti-autre", interactive: false }).addTo(iti.couches);
  }
  // le trajet routier : un halo, puis le trait
  const trace = d.geometrie.map(([lon, lat]) => [lat, lon]);
  L.polyline(trace, { className: "iti-trace-halo", interactive: false }).addTo(iti.couches);
  L.polyline(trace, { className: "iti-trace", interactive: false }).addTo(iti.couches);
  // le depart
  L.marker([d.depart.lat, d.depart.lon], {
    icon: L.divIcon({ className: "", html: '<span class="iti-depart"><i></i></span>', iconSize: [26, 26], iconAnchor: [13, 13] }),
    title: "Départ",
    keyboard: false,
  }).addTo(iti.couches);
  d.arrets.forEach((a, i) => {
    const m = L.marker([a.lat, a.lon], { icon: iconeArret(L, a.ordre, { apres: a.apresLimite === true }), title: `${a.ordre}. ${a.adresse || "Boîte"}`, riseOnHover: true })
      .addTo(iti.couches)
      .on("click", () => choisitArret(i, { depuisCarte: true }));
    iti.marqueurs.push(m);
  });
  map.invalidateSize();
  const bornes = L.latLngBounds([[d.depart.lat, d.depart.lon], ...d.arrets.map((a) => [a.lat, a.lon])]);
  map.flyToBounds(bornes, { padding: [44, 44], maxZoom: 16, duration: prefersReducedMotion ? 0 : 0.8 });
}

// --- Le resultat -----------------------------------------------------------------------

function ligneLevee(a) {
  if (!a.limiteSemaine && !a.limiteSamedi) return "";
  const texte = `Levée ${heureTexte(a.limiteSemaine)}${a.limiteSamedi && a.limiteSamedi !== a.limiteSemaine ? ` · sam. ${heureTexte(a.limiteSamedi)}` : ""}`;
  const etat = a.apresLimite === true ? ` <em class="iti-apres">après la levée d'aujourd'hui</em>` : a.apresLimite === false ? ` <em class="iti-avant">avant la levée</em>` : "";
  return `<span class="iti-levee">${escapeHtml(texte)}${etat}</span>`;
}

function rendResultat(d) {
  iti.resultat = d;
  iti.choisi = null;
  $("iti-resultat").hidden = false;
  compte($("iti-temps"), Math.round(d.total.duree / 60), { format: (v) => dureeTexte(v * 60) });
  $("iti-distance").textContent = distanceTexte(d.total.distance);
  $("iti-nb").textContent = String(d.arrets.length);
  $("iti-nb-unite").textContent = d.arrets.length > 1 ? "boîtes" : "boîte";
  $("iti-alertes").innerHTML = (d.avertissements || []).map((t) => `<p class="iti-alerte">${ico("alert")}<span>${escapeHtml(t)}</span></p>`).join("");

  const n = (liens) => liens.length;
  const boutons = [];
  d.liens.applePlans.forEach((url, i) =>
    boutons.push(`<a class="btn btn-primary iti-lien" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Apple Plans${n(d.liens.applePlans) > 1 ? ` ${i + 1}/${n(d.liens.applePlans)}` : ""}</a>`)
  );
  d.liens.googleMaps.forEach((url, i) =>
    boutons.push(`<a class="btn btn-secondary iti-lien" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Google Maps${n(d.liens.googleMaps) > 1 ? ` ${i + 1}/${n(d.liens.googleMaps)}` : ""}</a>`)
  );
  $("iti-nav").innerHTML = boutons.join("");

  $("iti-arrets").innerHTML = d.arrets
    .map(
      (a, i) => `
    <li class="iti-arret${a.apresLimite === true ? " is-apres" : ""}" data-i="${i}" tabindex="0" aria-label="Arrêt ${a.ordre} : ${escapeAttr(a.adresse || "boîte")}">
      <span class="iti-num">${a.ordre}</span>
      <span class="iti-arret-texte">
        <span class="iti-adresse-ligne">${escapeHtml(a.adresse || "Adresse inconnue")}${a.boites > 1 ? ` <b class="iti-plusieurs">${a.boites} boîtes</b>` : ""}</span>
        <span class="iti-commune">${escapeHtml([a.cp, a.commune].filter(Boolean).join(" "))}</span>
        ${ligneLevee(a)}
      </span>
      <span class="iti-troncon"><b>+${escapeHtml(dureeTexte(a.depuisPrecedent.duree))}</b><span>${escapeHtml(distanceTexte(a.depuisPrecedent.distance))}</span></span>
      <button class="icon-btn iti-eviter" type="button" data-eviter="${i}" title="Éviter cette boîte et recalculer" aria-label="Éviter cette boîte">${ico("x")}</button>
    </li>`
    )
    .join("");

  const maj = d.sources.boites.miseAJour ? ` du ${new Date(d.sources.boites.miseAJour).toLocaleDateString("fr-FR")}` : "";
  $("iti-sources").textContent =
    `Temps et distances : ${d.sources.routage.nom}, sur les vraies routes, sans trafic en temps réel (la navigation en tient compte). ` +
    `Boîtes : ${d.sources.boites.nom}${maj} · ${pluriel(d.zone.arrets, "arrêt possible", "arrêts possibles")} dans ${String(d.rayonKm).replace(".", ",")} km` +
    (d.zone.arrets > d.zone.comparees ? ` (les ${d.zone.comparees} plus proches comparés par la route)` : "") +
    (d.zone.imprecises ? `, ${pluriel(d.zone.imprecises, "position douteuse écartée", "positions douteuses écartées")}` : "") +
    (d.variantes > 1 ? ` · tournée ${d.variante + 1} sur ${d.variantes}` : "") +
    ".";
  rendCarte(d).catch((err) => toast(`Carte indisponible : ${err.message}`, "error"));
}

function choisitArret(i, { depuisCarte = false } = {}) {
  const d = iti.resultat;
  if (!d || !window.L) return;
  iti.choisi = i;
  document.querySelectorAll(".iti-arret").forEach((li) => li.classList.toggle("is-choisi", Number(li.dataset.i) === i));
  d.arrets.forEach((a, k) => iti.marqueurs[k]?.setIcon(iconeArret(window.L, a.ordre, { actif: k === i, apres: a.apresLimite === true })));
  const a = d.arrets[i];
  const m = iti.marqueurs[i];
  if (m) {
    m.setZIndexOffset(1000);
    m.bindPopup(
      `<div class="iti-bulle"><b>${a.ordre}. ${escapeHtml(a.adresse || "Boîte")}</b><span>${escapeHtml([a.cp, a.commune].filter(Boolean).join(" "))}</span>` +
        `${ligneLevee(a)}<span>+${escapeHtml(dureeTexte(a.depuisPrecedent.duree))} · ${escapeHtml(distanceTexte(a.depuisPrecedent.distance))} depuis ${i === 0 ? "le départ" : `l'arrêt ${i}`}</span>` +
        `<span class="iti-bulle-id">Boîte ${escapeHtml(a.ids.join(", "))}</span></div>`,
      { closeButton: false, offset: [0, -14], className: "iti-popup" }
    ).openPopup();
    if (!depuisCarte) iti.carte.flyTo([a.lat, a.lon], Math.max(iti.carte.getZoom(), 16), { duration: prefersReducedMotion ? 0 : 0.6 });
  }
  if (depuisCarte) document.querySelector(`.iti-arret[data-i="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion ? "auto" : "smooth" });
  haptique();
}

$("iti-arrets").addEventListener("click", (e) => {
  const eviter = e.target.closest("[data-eviter]");
  if (eviter) {
    const a = iti.resultat?.arrets[Number(eviter.dataset.eviter)];
    if (!a) return;
    iti.exclure.push(...a.ids);
    toast(`${a.adresse || "Boîte"} évitée : nouveau calcul`);
    calcule({ variante: 0, depart: iti.resultat.depart });
    return;
  }
  const li = e.target.closest(".iti-arret");
  if (li) choisitArret(Number(li.dataset.i));
});
$("iti-arrets").addEventListener("keydown", (e) => {
  const li = e.target.closest(".iti-arret");
  if (li && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    choisitArret(Number(li.dataset.i));
  }
});

// --- Calcul ------------------------------------------------------------------------------

async function calcule({ variante = 0, depart = departChoisi(), bouton = $("iti-creer") } = {}) {
  if (!depart) {
    secoue($("iti-creer"));
    toast(iti.mode === "gps" ? "Ta position n'est pas encore connue." : "Choisis une adresse dans la liste.", "error");
    return;
  }
  if (bouton.getAttribute("aria-busy") === "true") return;
  occupe(bouton, true);
  try {
    const d = await postJSON(
      "/api/itineraire/calcul",
      {
        depart: { lat: depart.lat, lon: depart.lon, label: depart.label || null, origine: depart.origine },
        rayonKm: iti.rayon,
        nombre: iti.nombre,
        variante,
        exclure: iti.exclure,
        leveeAVenir: iti.leveeAVenir,
      },
      { delai: 60000 }
    );
    occupe(bouton, false);
    fait(bouton);
    iti.variante = d.variante;
    iti.dernierDepart = { lat: d.depart.lat, lon: d.depart.lon };
    rendResultat(d);
    // sur telephone, la carte est plus bas : on la montre
    if (window.matchMedia("(max-width: 959px)").matches) $("iti-resultat").scrollIntoView({ block: "start", behavior: prefersReducedMotion ? "auto" : "smooth" });
  } catch (err) {
    occupe(bouton, false);
    secoue(bouton);
    toast(err.message, "error", 7000);
  }
}

$("iti-creer").addEventListener("click", () => {
  iti.exclure = [];
  calcule({ variante: 0 });
});

// « Recalculer » : depuis la position du moment si l'on a bouge (plus de
// 100 m), sinon une autre selection de boites depuis le meme depart.
$("iti-recalculer").addEventListener("click", async () => {
  const bouton = $("iti-recalculer");
  let depart = departChoisi();
  if (iti.mode === "gps") {
    iti.position = null;
    depart = await localise().then((p) => (p ? { ...p, origine: "gps" } : null));
    if (!depart) return;
  }
  const bouge = iti.dernierDepart && Math.hypot((depart.lat - iti.dernierDepart.lat) * 111320, (depart.lon - iti.dernierDepart.lon) * 111320 * Math.cos((depart.lat * Math.PI) / 180)) > 100;
  if (bouge) {
    toast("Tu as bougé : nouvelle tournée depuis ici");
    calcule({ variante: 0, depart, bouton });
  } else {
    calcule({ variante: (iti.variante || 0) + 1, depart, bouton });
  }
});

$("itineraire-link").addEventListener("click", () => switchView("itineraire"));
$("itineraire-back").addEventListener("click", () => switchView("dashboard"));

// A l'arrivee sur la page : la carte se prepare, la position est demandee.
function arriveeItineraire() {
  rendReglages();
  if (iti.mode === "gps" && !iti.position) localise();
  carte()
    .then((m) => setTimeout(() => m.invalidateSize(), 350))
    .catch(() => {});
}
