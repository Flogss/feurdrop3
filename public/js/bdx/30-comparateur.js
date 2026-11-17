// --- Comparateur de bordereaux -------------------------------------------------------------
// Deux etiquettes (ou plus : une pile, la premiere sert de reference) : cote a
// cote (zoom et deplacement synchronises) ou superposees (transparence
// reglable), avec ce qui differe :
//   - les codes (lus par le serveur) : identiques, deplaces, modifies (meme
//     place, autre valeur), ajoutes, supprimes -- et leurs valeurs ;
//   - les textes (pdf.js), de la meme facon ;
//   - les pixels qui changent (« Différences »), pour tout le reste.
// Les positions sont rapportees a la taille de chaque page (0..1) : deux
// etiquettes de tailles differentes se comparent quand meme. Rien n'est modifie.

const CMP_PX_PAR_POINT = 96 / 72;
const STATUTS = { identique: "Identique", deplace: "Déplacé", modifie: "Modifié", ajoute: "Ajouté", supprime: "Supprimé" };

const cmp = {
  pile: [], // [{ id, resume, detail, doc, type, image }]
  a: 0, // index de la reference
  b: 1, // index de l'etiquette comparee
  page: 1,
  mode: "cote",
  zoom: 1,
  ajuste: true,
  sync: true,
  pixels: true,
  opacite: 0.5,
  diff: null,
  survol: null,
  jeton: 0,
};

let cmpPdfjs = null;
function cmpChargePdfjs() {
  if (!cmpPdfjs) {
    cmpPdfjs = import("/vendor/pdfjs/pdf.min.mjs").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return cmpPdfjs;
}

// --- Chargement d'une etiquette -------------------------------------------------------------

async function chargeEtiquette(id) {
  let detail = await fetchJSON(`/api/bordereaux/${id}`);
  if (detail.analyse.etat === "attente" || detail.analyse.etat === "echec") {
    detail = await postJSON(`/api/bordereaux/${id}/analyse`, {}, { delai: 120000 }).catch(() => detail);
  }
  const res = await fetch(`/api/bordereaux/${id}/fichier`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Fichier inaccessible");
  const type = res.headers.get("Content-Type") || "";
  const e = { id, detail, resume: detail.colis, textes: new Map() };
  if (type.startsWith("application/pdf")) {
    const pdfjs = await cmpChargePdfjs();
    e.doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), isEvalSupported: false, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/" }).promise;
    e.type = "pdf";
    e.nbPages = e.doc.numPages;
  } else if (type.startsWith("image/")) {
    const img = new Image();
    img.src = URL.createObjectURL(await res.blob());
    await img.decode();
    Object.assign(e, { type: "image", image: img, nbPages: 1 });
  } else throw new Error("Ce fichier ne se compare pas.");
  return e;
}

// La page d'une etiquette : taille (points), textes (0..1), codes (0..1).
async function pageDe(e, n) {
  if (e.type === "image") {
    return { W: e.image.naturalWidth, H: e.image.naturalHeight, textes: [], codes: codesDe(e, n) };
  }
  const page = await e.doc.getPage(Math.min(n, e.nbPages));
  const vp = page.getViewport({ scale: 1 });
  if (!e.textes.has(n)) {
    const pdfjs = await cmpChargePdfjs();
    const contenu = await page.getTextContent();
    const textes = [];
    for (const it of contenu.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const horizontal = Math.abs(t[1]) < 0.01 && Math.abs(t[2]) < 0.01;
      const taille = horizontal ? Math.abs(t[3]) : Math.hypot(t[2], t[3]);
      const largeur = it.width || taille * it.str.length * 0.5;
      const x = horizontal ? t[4] : t[4] - taille;
      const y = horizontal ? t[5] - taille * 0.86 : t[5] - largeur;
      const l = horizontal ? largeur : taille * 1.12;
      const h = horizontal ? taille * 1.12 : largeur;
      textes.push({ texte: it.str.trim(), x0: x / vp.width, y0: y / vp.height, x1: (x + l) / vp.width, y1: (y + h) / vp.height });
    }
    e.textes.set(n, textes);
  }
  return { W: vp.width, H: vp.height, page, textes: e.textes.get(n), codes: codesDe(e, n) };
}

function codesDe(e, n) {
  const p = e.detail?.analyse?.pages?.[n - 1];
  return p ? p.codes.map((c) => ({ id: c.id, format: c.format, nomFormat: c.nomFormat, valeur: c.valeur, lisible: c.lisible, ...c.zone })) : [];
}

// --- Les differences ---------------------------------------------------------------------------

const centre = (z) => [(z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2];
const distance = (a, b) => {
  const [ax, ay] = centre(a);
  const [bx, by] = centre(b);
  return Math.hypot(ax - bx, ay - by);
};
function recouvre(a, b) {
  const l = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const aire = (z) => Math.max(1e-6, (z.x1 - z.x0) * (z.y1 - z.y0));
  return (l * h) / Math.min(aire(a), aire(b));
}

/**
 * Apparie les elements de A et de B : meme cle et meme place -> identique ;
 * meme cle ailleurs -> deplace ; autre cle a la meme place -> modifie ; le
 * reste -> supprime (A seulement) ou ajoute (B seulement).
 */
function apparie(listeA, listeB, cle, { seuilPlace = 0.015, memeGenre = () => true } = {}) {
  const resultats = [];
  const restantsB = new Set(listeB.map((_, i) => i));
  const restantsA = new Set(listeA.map((_, i) => i));
  // 1. meme valeur : la plus proche
  for (const i of [...restantsA]) {
    const a = listeA[i];
    let meilleur = null;
    for (const j of restantsB) {
      const b = listeB[j];
      if (cle(a) == null || cle(a) !== cle(b)) continue;
      const d = distance(a, b);
      if (!meilleur || d < meilleur.d) meilleur = { j, d };
    }
    if (meilleur) {
      restantsA.delete(i);
      restantsB.delete(meilleur.j);
      resultats.push({ statut: meilleur.d <= seuilPlace ? "identique" : "deplace", a, b: listeB[meilleur.j], ecart: meilleur.d });
    }
  }
  // 2. meme place, autre valeur
  for (const i of [...restantsA]) {
    const a = listeA[i];
    let meilleur = null;
    for (const j of restantsB) {
      const b = listeB[j];
      if (!memeGenre(a, b)) continue;
      const r = recouvre(a, b);
      if (r > 0.35 && (!meilleur || r > meilleur.r)) meilleur = { j, r };
    }
    if (meilleur) {
      restantsA.delete(i);
      restantsB.delete(meilleur.j);
      resultats.push({ statut: "modifie", a, b: listeB[meilleur.j] });
    }
  }
  for (const i of restantsA) resultats.push({ statut: "supprime", a: listeA[i], b: null });
  for (const j of restantsB) resultats.push({ statut: "ajoute", a: null, b: listeB[j] });
  return resultats;
}

function compare(pa, pb) {
  const codes = apparie(pa.codes, pb.codes, (c) => (c.lisible ? `${c.format}|${c.valeur}` : null), { seuilPlace: 0.015, memeGenre: (a, b) => a.format === b.format || (a.lisible !== b.lisible) });
  const textes = apparie(pa.textes, pb.textes, (t) => t.texte, { seuilPlace: 0.008 });
  return { codes, textes };
}

// --- Rendu des pages ---------------------------------------------------------------------------

function largeurCommune() {
  // les deux pages a la meme largeur a l'ecran : leurs positions (0..1) se comparent a l'oeil
  const scene = $(cmp.mode === "superpose" ? "cmp-scene-a" : "cmp-scene-b").getBoundingClientRect();
  return Math.max(200, scene.width - 48);
}

async function dessinePage(cote, e, p, largeur) {
  const feuille = $(`cmp-feuille-${cote}`);
  const hauteur = (largeur * p.H) / p.W;
  feuille.style.width = `${Math.round(largeur)}px`;
  feuille.style.height = `${Math.round(hauteur)}px`;
  feuille.dataset.pret = "";
  const canvas = feuille.querySelector("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(largeur * dpr);
  canvas.height = Math.round(hauteur * dpr);
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (e.type === "pdf") {
    const vp = p.page.getViewport({ scale: canvas.width / p.W });
    await p.page.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
  } else {
    ctx.drawImage(e.image, 0, 0, canvas.width, canvas.height);
  }
  feuille.dataset.pret = "1";
  return canvas;
}

// Les pixels qui different (une fois les deux pages a la meme taille).
function pixelsDifferents(ca, cb) {
  const l = Math.min(ca.width, cb.width);
  const h = Math.min(ca.height, cb.height);
  const da = ca.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, l, h).data;
  const db = cb.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, l, h).data;
  const masque = new ImageData(l, h);
  let n = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    if (d > 90) {
      masque.data[i] = 255;
      masque.data[i + 1] = 60;
      masque.data[i + 2] = 170;
      masque.data[i + 3] = 150;
      n += 1;
    }
  }
  return { masque, part: n / (l * h) };
}

function posePixels(cote, masque) {
  const c = $(`cmp-feuille-${cote}`).querySelector(".cmp-pixels");
  c.width = masque.width;
  c.height = masque.height;
  c.getContext("2d").putImageData(masque, 0, 0);
  c.hidden = !cmp.pixels;
}

function zonesDe(cote) {
  const d = cmp.diff;
  if (!d) return "";
  const html = [];
  const pose = (r, z, genre, i) => {
    const etiquette = genre === "code" ? `${r.statut === "modifie" && cote === "b" ? "→ " : ""}${(cote === "a" ? r.a : r.b)?.valeur ?? "illisible"}` : (cote === "a" ? r.a : r.b)?.texte;
    html.push(
      `<span class="cmp-zone is-${r.statut} is-${genre}${cmp.survol === `${genre}${i}` ? " is-survol" : ""}" data-diff="${genre}${i}" style="left:${(z.x0 * 100).toFixed(3)}%;top:${(z.y0 * 100).toFixed(3)}%;width:${((z.x1 - z.x0) * 100).toFixed(3)}%;height:${((z.y1 - z.y0) * 100).toFixed(3)}%" title="${escapeAttr(`${STATUTS[r.statut]} · ${etiquette || ""}`)}"></span>`
    );
  };
  d.codes.forEach((r, i) => {
    const z = cote === "a" ? r.a : r.b;
    if (z) pose(r, z, "code", i);
  });
  d.textes.forEach((r, i) => {
    if (r.statut === "identique") return; // les textes identiques ne chargent pas la vue
    const z = cote === "a" ? r.a : r.b;
    if (z) pose(r, z, "texte", i);
  });
  return html.join("");
}

function rendZones() {
  for (const cote of ["a", "b"]) $(`cmp-feuille-${cote}`).querySelector(".cmp-zones").innerHTML = zonesDe(cote);
}

async function rendComparaison() {
  const A = cmp.pile[cmp.a];
  const B = cmp.pile[cmp.b];
  const jeton = ++cmp.jeton;
  majPile();
  if (!A || !B) {
    $("cmp-differences").innerHTML = `<p class="ed-aide">Choisis au moins deux étiquettes : la première sert de référence (A).</p>`;
    return;
  }
  $("cmp-nom-a").textContent = `${A.resume.expediteur || "—"} · ${A.resume.fichier || `#${A.id}`}`;
  $("cmp-nom-b").textContent = `${B.resume.expediteur || "—"} · ${B.resume.fichier || `#${B.id}`}`;
  const pages = Math.max(A.nbPages, B.nbPages);
  cmp.page = Math.min(cmp.page, pages);
  $("cmp-pages").hidden = pages <= 1;
  $("cmp-page-texte").textContent = `${cmp.page} / ${pages}`;
  const [pa, pb] = await Promise.all([pageDe(A, cmp.page), pageDe(B, cmp.page)]);
  if (jeton !== cmp.jeton) return;
  cmp.diff = compare(pa, pb);
  const base = largeurCommune() * (cmp.ajuste ? 1 : cmp.zoom);
  const [ca, cb] = await Promise.all([dessinePage("a", A, pa, base), dessinePage("b", B, pb, base)]);
  if (jeton !== cmp.jeton) return;
  const { masque, part } = pixelsDifferents(ca, cb);
  posePixels("a", masque);
  posePixels("b", masque);
  cmp.part = part;
  $("cmp-zoom").textContent = `${Math.round((base / (pa.W * CMP_PX_PAR_POINT)) * 100)} %`;
  rendZones();
  rendDifferences();
  appliqueMode();
}

function rendDifferences() {
  const d = cmp.diff;
  const compte = (liste) => Object.fromEntries(Object.keys(STATUTS).map((k) => [k, liste.filter((r) => r.statut === k).length]));
  const cc = compte(d.codes);
  const ct = compte(d.textes);
  const changes = d.codes.filter((r) => r.statut !== "identique").length + d.textes.filter((r) => r.statut !== "identique").length;
  $("cmp-resume").textContent = changes ? `${pluriel(changes, "différence")} · ${(cmp.part * 100).toFixed(1).replace(".", ",")} % des pixels changent` : "Aucune différence de code ni de texte";
  const ligneCode = (r, i) => `
    <li class="cmp-diff is-${r.statut}" data-diff="code${i}">
      <span class="cmp-diff-statut">${STATUTS[r.statut]}</span>
      <span class="cmp-diff-format">${escapeHtml((r.a || r.b).nomFormat || (r.a || r.b).format)}</span>
      <span class="cmp-diff-valeurs">
        ${r.a ? `<span><b class="cmp-lettre is-a">A</b>${escapeHtml(r.a.lisible ? r.a.valeur : "illisible")}</span>` : ""}
        ${r.b && (r.statut !== "identique" && r.statut !== "deplace") ? `<span><b class="cmp-lettre is-b">B</b>${escapeHtml(r.b.lisible ? r.b.valeur : "illisible")}</span>` : ""}
        ${r.statut === "deplace" ? `<span class="cmp-diff-ecart">déplacé de ${(r.ecart * 100).toFixed(1).replace(".", ",")} % de la page</span>` : ""}
      </span>
    </li>`;
  const ligneTexte = (r, i) => `
    <li class="cmp-diff is-${r.statut}" data-diff="texte${i}">
      <span class="cmp-diff-statut">${STATUTS[r.statut]}</span>
      <span class="cmp-diff-valeurs">
        ${r.a ? `<span><b class="cmp-lettre is-a">A</b>${escapeHtml(r.a.texte)}</span>` : ""}
        ${r.b && r.statut === "modifie" ? `<span><b class="cmp-lettre is-b">B</b>${escapeHtml(r.b.texte)}</span>` : ""}
        ${r.b && r.statut === "ajoute" ? `<span><b class="cmp-lettre is-b">B</b>${escapeHtml(r.b.texte)}</span>` : ""}
      </span>
    </li>`;
  const ordre = { modifie: 0, deplace: 1, ajoute: 2, supprime: 3, identique: 4 };
  const codes = d.codes.map((r, i) => [r, i]).sort((x, y) => ordre[x[0].statut] - ordre[y[0].statut]);
  const textes = d.textes.map((r, i) => [r, i]).filter(([r]) => r.statut !== "identique").sort((x, y) => ordre[x[0].statut] - ordre[y[0].statut]);
  const resume = (c) => Object.entries(c).filter(([, n]) => n).map(([k, n]) => `<span class="cmp-cle is-${k}">${n} ${STATUTS[k].toLowerCase()}${n > 1 ? "s" : ""}</span>`).join("");
  $("cmp-differences").innerHTML = `
    <section class="ed-bloc"><h3>Codes-barres et QR codes</h3><div class="cmp-compte">${resume(cc) || '<span class="ed-aide">Aucun code lu</span>'}</div>
      <ul class="cmp-diffs">${codes.map(([r, i]) => ligneCode(r, i)).join("")}</ul></section>
    <section class="ed-bloc"><h3>Textes</h3><div class="cmp-compte">${resume(ct) || '<span class="ed-aide">Pas de texte lisible (image)</span>'}</div>
      <ul class="cmp-diffs">${textes.length ? textes.map(([r, i]) => ligneTexte(r, i)).join("") : `<li class="ed-aide">${ct.identique ? `Les ${ct.identique} textes sont identiques.` : ""}</li>`}</ul></section>
    <section class="ed-bloc"><h3>Visuellement</h3><p class="ed-aide">${(cmp.part * 100).toFixed(2).replace(".", ",")} % des pixels changent entre A et B (en rose avec « Différences »).</p></section>`;
}

// --- Modes, zoom, synchro ---------------------------------------------------------------------

function appliqueMode() {
  $("cmp-vues").dataset.mode = cmp.mode;
  $("cmp-opacite-bloc").hidden = cmp.mode !== "superpose";
  $("cmp-feuille-b").style.opacity = cmp.mode === "superpose" ? String(cmp.opacite) : "";
  document.querySelectorAll("[data-mode]").forEach((b) => {
    const on = b.dataset.mode === cmp.mode;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-checked", String(on));
  });
}

let synchroEnCours = false;
function synchronise(source) {
  // superposees, les deux pages bougent toujours ensemble ; cote a cote, selon « Synchro »
  if (synchroEnCours || (!cmp.sync && cmp.mode !== "superpose")) return;
  const autre = source.id === "cmp-scene-a" ? $("cmp-scene-b") : $("cmp-scene-a");
  synchroEnCours = true;
  const rx = source.scrollLeft / Math.max(1, source.scrollWidth - source.clientWidth);
  const ry = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
  autre.scrollLeft = rx * (autre.scrollWidth - autre.clientWidth);
  autre.scrollTop = ry * (autre.scrollHeight - autre.clientHeight);
  requestAnimationFrame(() => (synchroEnCours = false));
}
for (const id of ["cmp-scene-a", "cmp-scene-b"]) {
  $(id).addEventListener("scroll", (e) => synchronise(e.currentTarget), { passive: true });
  $(id).addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      changeZoom(cmp.zoom * Math.exp(-e.deltaY * 0.0022));
    },
    { passive: false }
  );
}

let minuteurZoom = null;
function changeZoom(z) {
  cmp.ajuste = false;
  cmp.zoom = Math.min(8, Math.max(0.25, z));
  // l'apercu suit tout de suite (etire), le rendu net suit
  const l = largeurCommune() * cmp.zoom;
  for (const cote of ["a", "b"]) {
    const f = $(`cmp-feuille-${cote}`);
    const ratio = f.offsetHeight / Math.max(1, f.offsetWidth);
    f.style.width = `${Math.round(l)}px`;
    f.style.height = `${Math.round(l * ratio)}px`;
  }
  clearTimeout(minuteurZoom);
  minuteurZoom = setTimeout(rendComparaison, 180);
}

$("cmp-zoom-plus").addEventListener("click", () => changeZoom((cmp.ajuste ? 1 : cmp.zoom) * 1.25));
$("cmp-zoom-moins").addEventListener("click", () => changeZoom((cmp.ajuste ? 1 : cmp.zoom) / 1.25));
$("cmp-zoom").addEventListener("click", () => {
  cmp.ajuste = true;
  cmp.zoom = 1;
  rendComparaison();
});
$("cmp-sync").addEventListener("click", (e) => {
  cmp.sync = !cmp.sync;
  e.currentTarget.setAttribute("aria-pressed", String(cmp.sync));
});
$("cmp-pixels").addEventListener("click", (e) => {
  cmp.pixels = !cmp.pixels;
  e.currentTarget.setAttribute("aria-pressed", String(cmp.pixels));
  document.querySelectorAll(".cmp-pixels").forEach((c) => (c.hidden = !cmp.pixels));
});
document.querySelectorAll("[data-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    cmp.mode = b.dataset.mode;
    appliqueMode();
    rendComparaison();
  })
);
$("cmp-opacite").addEventListener("input", (e) => {
  cmp.opacite = Number(e.target.value) / 100;
  $("cmp-feuille-b").style.opacity = String(cmp.opacite);
});
$("cmp-page-prec").addEventListener("click", () => {
  cmp.page = Math.max(1, cmp.page - 1);
  rendComparaison();
});
$("cmp-page-suiv").addEventListener("click", () => {
  cmp.page += 1;
  rendComparaison();
});

// survoler une difference (liste ou page) l'allume des deux cotes
function survole(cle) {
  if (cmp.survol === cle) return;
  cmp.survol = cle;
  document.querySelectorAll(".cmp-zone, .cmp-diff").forEach((x) => x.classList.toggle("is-survol", x.dataset.diff === cle));
}
document.addEventListener("pointerover", (e) => {
  const d = e.target.closest?.("[data-diff]");
  survole(d ? d.dataset.diff : null);
});
$("cmp-differences").addEventListener("click", (e) => {
  const d = e.target.closest("[data-diff]");
  if (!d) return;
  const zone = document.querySelector(`#cmp-feuille-b .cmp-zone[data-diff="${d.dataset.diff}"]`) || document.querySelector(`#cmp-feuille-a .cmp-zone[data-diff="${d.dataset.diff}"]`);
  zone?.scrollIntoView({ block: "center", inline: "center", behavior: prefersReducedMotion ? "auto" : "smooth" });
  if (zone) rejoue(zone, "is-flash", 900);
});

// --- La pile d'etiquettes -----------------------------------------------------------------------

function majPile() {
  $("cmp-etiquettes").innerHTML = cmp.pile
    .map((e, i) => {
      const role = i === cmp.a ? "A" : i === cmp.b ? "B" : "";
      return `<li class="cmp-etiquette${role ? ` is-${role.toLowerCase()}` : ""}" data-index="${i}">
        <button type="button" class="cmp-etiquette-corps" data-choisit="${i}" title="${i === cmp.a ? "Référence (A)" : "Comparer avec la référence"}">
          ${role ? `<span class="cmp-lettre is-${role.toLowerCase()}">${role}</span>` : `<span class="cmp-lettre">${i + 1}</span>`}
          <span><b>${escapeHtml(e.resume.expediteur || "—")}</b><em>${escapeHtml(e.resume.fichier || `#${e.id}`)}</em></span>
        </button>
        ${i !== cmp.a ? `<button type="button" class="bdx-outil" data-reference="${i}" title="En faire la référence (A)" aria-label="En faire la référence"><svg class="icon"><use href="#i-star"/></svg></button>` : ""}
        <button type="button" class="bdx-outil" data-retire="${i}" title="Retirer" aria-label="Retirer"><svg class="icon"><use href="#i-x"/></svg></button>
      </li>`;
    })
    .join("");
  const p = new URLSearchParams();
  cmp.pile.forEach((e, i) => p.set(i === 0 ? "a" : i === 1 ? "b" : `e${i}`, String(e.id)));
  history.replaceState(null, "", `?${p}`);
}

async function ajouteEtiquette(id) {
  if (cmp.pile.some((e) => e.id === id)) return;
  try {
    const e = await chargeEtiquette(id);
    cmp.pile.push(e);
    if (cmp.pile.length === 2) cmp.b = 1;
    if (cmp.pile.length > 2) cmp.b = cmp.pile.length - 1;
    await rendComparaison();
  } catch (err) {
    toast(err.message, "error");
  }
}

$("cmp-etiquettes").addEventListener("click", (e) => {
  const choisit = e.target.closest("[data-choisit]");
  const reference = e.target.closest("[data-reference]");
  const retire = e.target.closest("[data-retire]");
  if (reference) {
    const i = Number(reference.dataset.reference);
    cmp.b = cmp.a === i ? cmp.b : cmp.a;
    cmp.a = i;
  } else if (retire) {
    const i = Number(retire.dataset.retire);
    cmp.pile.splice(i, 1);
    cmp.a = Math.min(cmp.a > i ? cmp.a - 1 : cmp.a === i ? 0 : cmp.a, Math.max(0, cmp.pile.length - 1));
    cmp.b = cmp.pile.length > 1 ? (cmp.a === 0 ? 1 : 0) : 0;
  } else if (choisit) {
    const i = Number(choisit.dataset.choisit);
    if (i === cmp.a) return;
    cmp.b = i;
  } else return;
  rendComparaison();
});

// passer d'une etiquette comparee a l'autre : fleches gauche / droite
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select") || cmp.pile.length < 3) return;
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  e.preventDefault();
  const autres = cmp.pile.map((_, i) => i).filter((i) => i !== cmp.a);
  const k = autres.indexOf(cmp.b);
  cmp.b = autres[(k + (e.key === "ArrowRight" ? 1 : -1) + autres.length) % autres.length];
  rendComparaison();
});

let minuteurRecherche = null;
$("cmp-q").addEventListener("input", (e) => {
  clearTimeout(minuteurRecherche);
  const q = e.target.value.trim();
  minuteurRecherche = setTimeout(async () => {
    const ul = $("cmp-propositions");
    if (q.length < 2) {
      ul.hidden = true;
      return;
    }
    try {
      // un numero (codes lus) ou un expediteur / un fichier
      const [r1, r2] = await Promise.all([
        fetchJSON(`/api/bordereaux/recherche?q=${encodeURIComponent(q)}`).catch(() => ({ resultats: [] })),
        fetchJSON(`/api/bordereaux?q=${encodeURIComponent(q)}`).catch(() => ({ bordereaux: [] })),
      ]);
      const vus = new Set();
      const liste = [...r1.resultats, ...r2.bordereaux].filter((b) => !vus.has(b.id) && vus.add(b.id)).slice(0, 12);
      ul.innerHTML = liste.length
        ? liste.map((b) => `<li><button type="button" data-ajoute="${b.id}"><b>${escapeHtml(b.expediteur || "—")}</b><span>${escapeHtml(b.suivi?.numero || b.fichier || `#${b.id}`)}</span></button></li>`).join("")
        : `<li class="ed-aide">Aucune étiquette</li>`;
      ul.hidden = false;
    } catch {}
  }, 200);
});
$("cmp-propositions").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ajoute]");
  if (!b) return;
  $("cmp-propositions").hidden = true;
  $("cmp-q").value = "";
  ajouteEtiquette(Number(b.dataset.ajoute));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".cmp-ajout")) $("cmp-propositions").hidden = true;
});

new ResizeObserver(() => {
  if (cmp.ajuste && cmp.pile.length > 1) {
    clearTimeout(minuteurZoom);
    minuteurZoom = setTimeout(rendComparaison, 200);
  }
}).observe($("cmp-vues"));

// --- Demarrage : ?a=12&b=34&e2=56 --------------------------------------------------------------

(async () => {
  const p = new URLSearchParams(location.search);
  const ids = [...p.entries()].filter(([k]) => /^(a|b|e\d+)$/.test(k)).map(([, v]) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
  for (const id of ids) {
    try {
      cmp.pile.push(await chargeEtiquette(id));
    } catch (err) {
      toast(err.message, "error");
    }
  }
  cmp.b = cmp.pile.length > 1 ? 1 : 0;
  appliqueMode();
  await rendComparaison();
  if (cmp.pile.length < 2) $("cmp-q").focus();
})();
