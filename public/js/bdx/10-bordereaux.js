// --- Bordereaux — étude et recherche ------------------------------------------------
// Une page a part du dashboard (/bordereaux, dans son propre onglet).
// Les etiquettes deja dans FeurDrop, affichees telles quelles (pdf.js pour les
// PDF, l'image sinon), et leurs codes lus par le serveur (/api/bordereaux) :
// chaque code-barre ou QR code est une zone posee sur la page, en pourcentage
// de la page -- elle reste collee a son code a tous les zooms et quand on
// deplace la page. Le fichier d'origine n'est jamais modifie : la page ne fait
// que le lire.
//
// Deux onglets autour de la meme visionneuse : « Étude » (la liste des
// etiquettes) et « Recherche / modifications » (un numero -> les etiquettes
// qui le portent, ouvertes a la bonne page, le code mis en evidence).

const CSS_PAR_POINT = 96 / 72; // 100 % = la taille reelle de la page
const BDX_ZOOM_MIN = 0.05;
const BDX_ZOOM_MAX = 10;
const BDX_PAS_ZOOM = [0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
// au-dela, la page est rendue un peu moins finement (memoire du navigateur)
const BDX_MAX_PIXELS = 16 * 1024 * 1024;

const bdx = {
  onglet: "etude",
  filtre: "tous",
  filtreTexte: "",
  transporteur: "",
  depuis: "",
  tri: "recent",
  categorie: "",
  categories: [],
  transporteurs: [],
  total: 0,
  liste: [],
  suite: null,
  jetonListe: 0,
  courant: null, // { id, resume, detail, type, doc, pdfPage, nbPages, page, base, cible, analyseEnCours, imageUrl }
  jeton: 0,
  zoom: 1,
  mode: "largeur", // "largeur" | "page" | "libre"
  zonesToutes: false,
  selection: null, // id du code choisi
  trouve: null, // id du code trouve par la recherche (il pulse)
  rendu: null,
  minuteurRendu: null,
  resultats: [],
  actif: -1,
  jetonRecherche: 0,
  minuteurRecherche: null,
  minuteurEtat: null,
  glisse: null,
};

const BDX_ETAPES = { a_imprimer: "À imprimer", imprime: "Imprimée", depose: "Déposée" };
const BDX_ROLES = {
  suivi: "Numéro de suivi",
  "suivi-probable": "Numéro de suivi probable",
  "contient-suivi": "Contient le numéro",
  lien: "Lien",
  donnees: "Données structurées",
  autre: "Autre code",
  illisible: "Illisible",
};
const BDX_TYPES_RECHERCHE = { exact: "Numéro exact", debut: "Commence par", fin: "Se termine par", contient: "Contient", proche: "Numéro proche" };

const bdxNorme = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const bdxBorne = (v, min, max) => Math.min(max, Math.max(min, v));
const bdxPourcent = (v) => `${(v * 100).toFixed(3)}%`;

function bdxDate(s) {
  if (!s) return "";
  const d = dateServeur(s);
  return `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

// les separateurs invisibles des codes 2D (GS, RS, EOT) deviennent visibles
const BDX_INVISIBLES = { "\x1d": "␝", "\x1e": "␞", "\x04": "␄", "\n": "↵", "\r": "", "\t": "⇥" };
// eslint-disable-next-line no-control-regex -- justement : les reperer pour les montrer
const bdxValeur = (v) => String(v ?? "").replace(/[\x00-\x1f\x7f]/g, (c) => BDX_INVISIBLES[c] ?? "·");

// les couleurs des categories (noms gardes par le serveur -> teintes du site)
const BDX_COULEURS = {
  violet: "var(--violet-500)",
  bleu: "var(--info-rgb)",
  turquoise: "var(--teal-rgb)",
  vert: "var(--c-chrono)",
  jaune: "var(--c-lp)",
  orange: "var(--special-rgb)",
  rose: "var(--c-mr)",
  rouge: "var(--danger-rgb)",
  gris: "var(--c-unknown)",
};
const bdxTeinteCategorie = (c) => `--c: ${BDX_COULEURS[c?.couleur] || BDX_COULEURS.gris}`;
const bdxPuceCategorie = (c) => (c ? `<span class="bdx-cat" style="${bdxTeinteCategorie(c)}">${escapeHtml(c.nom)}</span>` : "");

// la teinte du transporteur (pastilles), la meme que partout sur le site
const bdxTeinte = (code) => `--c: var(--c-${String(code || "unknown").toLowerCase().replace(/[^a-z]/g, "")}, var(--c-unknown))`;

function bdxLienSuivi(suivi) {
  if (!suivi) return null;
  return suivi.lien || suivi.page || null;
}

// --- pdf.js, charge a la premiere ouverture ------------------------------------------

let bdxPdfjs = null;
function bdxChargePdfjs() {
  if (!bdxPdfjs) {
    bdxPdfjs = import("/vendor/pdfjs/pdf.min.mjs")
      .then((m) => {
        m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
        return m;
      })
      .catch((err) => {
        bdxPdfjs = null;
        throw new Error(`la visionneuse n'a pas pu se charger (${err.message})`);
      });
  }
  return bdxPdfjs;
}

// --- Etat de l'index --------------------------------------------------------------------

async function bdxChargeEtat() {
  try {
    const e = await fetchJSON("/api/bordereaux/etat");
    const morceaux = [pluriel(e.etiquettes, "étiquette"), `${entier(e.analysees)} lue${e.analysees > 1 ? "s" : ""}`, pluriel(e.codes, "code indexé", "codes indexés")];
    if (e.echecs) morceaux.push(`${entier(e.echecs)} inaccessible${e.echecs > 1 ? "s" : ""}`);
    $("bdx-etat-texte").textContent = morceaux.join(" · ");
    const enFond = e.indexation?.active && e.indexation.restants > 0;
    $("bdx-etat").classList.toggle("is-actif", Boolean(enFond));
    $("bdx-etat").title = enFond ? `Lecture en fond : encore ${e.indexation.restants} étiquette(s) récente(s)` : `Étiquettes des ${e.indexation?.jours || 45} derniers jours lues en fond ; les plus anciennes, à la première ouverture`;
  } catch {
    /* l'etat n'est qu'indicatif */
  }
}

// --- La liste des etiquettes (onglet Etude) -------------------------------------------

function bdxBadge(index) {
  const i = index || {};
  if (i.etat === "analyse") {
    const total = (i.lisibles || 0) + (i.illisibles || 0);
    if (!total) return `<span class="bdx-badge is-vide">Aucun code</span>`;
    return `<span class="bdx-badge is-ok">${pluriel(i.lisibles, "code")}${i.illisibles ? `<em>${i.illisibles} illisible${i.illisibles > 1 ? "s" : ""}</em>` : ""}</span>`;
  }
  if (i.etat === "erreur") return `<span class="bdx-badge is-erreur">Fichier illisible</span>`;
  if (i.etat === "echec") return `<span class="bdx-badge is-erreur">Inaccessible</span>`;
  return `<span class="bdx-badge is-attente">À lire</span>`;
}

function bdxLigne(b) {
  const on = bdx.courant?.id === b.id;
  const titre = b.suivi?.numero || b.fichier || `Colis #${b.id}`;
  return `<li>
    <button type="button" class="bdx-ligne${on ? " is-on" : ""}" data-bdx-ouvre="${b.id}" aria-current="${on}">
      <span class="bdx-pastille" style="${bdxTeinte(b.transporteur?.code)}" aria-hidden="true"></span>
      <span class="bdx-ligne-texte">
        <b>${escapeHtml(b.expediteur || "—")}</b>
        <span class="bdx-ligne-num">${escapeHtml(titre)}</span>
        ${bdxPuceCategorie(b.categorie)}
      </span>
      <span class="bdx-ligne-meta">${bdxBadge(b.index)}<time>${escapeHtml(bdxDate(b.recuLe))}</time></span>
    </button>
  </li>`;
}

function bdxRendListe() {
  const ul = $("bdx-liste");
  if (!bdx.liste.length) {
    ul.innerHTML = `<li class="bdx-liste-vide">${bdx.filtreTexte ? "Aucune étiquette ne correspond." : "Aucune étiquette ici."}</li>`;
  } else if (bdx.tri === "transporteur") {
    // par transporteur : un intertitre avant chaque transporteur
    const nombres = Object.fromEntries(bdx.transporteurs.map((t) => [t.code, t.n]));
    let precedent = null;
    ul.innerHTML = bdx.liste
      .map((b) => {
        const code = b.transporteur?.code || "aucun";
        const tete =
          code !== precedent
            ? `<li class="bdx-groupe-tete" style="${bdxTeinte(b.transporteur?.code)}"><span class="bdx-pastille"></span>${escapeHtml(b.transporteur?.nom || "Sans transporteur")}<b>${entier(nombres[code] || 0)}</b></li>`
            : "";
        precedent = code;
        return tete + bdxLigne(b);
      })
      .join("");
  } else {
    ul.innerHTML = bdx.liste.map(bdxLigne).join("");
  }
  $("bdx-plus").hidden = bdx.suite == null;
  $("bdx-total").textContent = bdx.total ? pluriel(bdx.total, "étiquette") : "";
  $("bdx-effacer-filtres").hidden = !(bdx.transporteur || bdx.depuis || bdx.categorie || bdx.tri !== "recent");
}

async function bdxChargeListe({ suite = false } = {}) {
  const jeton = ++bdx.jetonListe;
  const params = new URLSearchParams({ filtre: bdx.filtre, tri: bdx.tri });
  if (bdx.filtreTexte) params.set("q", bdx.filtreTexte);
  if (bdx.transporteur) params.set("transporteur", bdx.transporteur);
  if (bdx.depuis) params.set("depuis", bdx.depuis);
  if (bdx.categorie) params.set("categorie", bdx.categorie);
  if (suite && bdx.suite != null) params.set("decalage", String(bdx.suite));
  if (!suite && !bdx.liste.length) $("bdx-liste").innerHTML = `<li class="bdx-liste-vide"><span class="bdx-chargement-ligne"></span><span class="bdx-chargement-ligne"></span><span class="bdx-chargement-ligne"></span></li>`;
  try {
    const r = await fetchJSON(`/api/bordereaux?${params}`);
    if (jeton !== bdx.jetonListe) return;
    bdx.liste = suite ? [...bdx.liste, ...r.bordereaux] : r.bordereaux;
    bdx.suite = r.decalageSuivant;
    bdx.total = r.total;
    bdx.transporteurs = r.transporteurs || [];
    bdxMetCategories(r.categories || []);
    bdxRendChoixTransporteurs();
    bdxRendListe();
  } catch (err) {
    if (jeton !== bdx.jetonListe) return;
    $("bdx-liste").innerHTML = `<li class="bdx-liste-vide is-erreur">${escapeHtml(err.message)}</li>`;
  }
}

// une etiquette vient d'etre lue : sa ligne suit, sans recharger la liste
function bdxMajLigne(id, detail) {
  const a = detail?.analyse;
  if (!a) return;
  const index = a.etat === "analyse" ? { etat: "analyse", pages: a.nombrePages, lisibles: a.lisibles, illisibles: a.illisibles } : { etat: a.etat, erreur: a.erreur };
  for (const liste of [bdx.liste, bdx.resultats]) {
    const b = liste.find((x) => x.id === id);
    if (b) b.index = index;
  }
  if (index.etat === "analyse") document.querySelector(`#bdx-resultats [data-bdx-id="${id}"] .bdx-res-pas-lue`)?.remove();
  const bouton = document.querySelector(`#bdx-liste [data-bdx-ouvre="${id}"] .bdx-ligne-meta`);
  if (bouton) bouton.innerHTML = `${bdxBadge(index)}<time>${escapeHtml(bdxDate(bdx.liste.find((x) => x.id === id)?.recuLe))}</time>`;
}

// --- La visionneuse ----------------------------------------------------------------------

function bdxMessage(texte, type = "info") {
  const m = $("bdx-message");
  if (!texte) {
    m.hidden = true;
    return;
  }
  m.hidden = false;
  m.className = `bdx-message is-${type}`;
  m.innerHTML = type === "chargement" ? `<span class="bdx-roue" aria-hidden="true"></span><span>${escapeHtml(texte)}</span>` : `<svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg><span>${escapeHtml(texte)}</span>`;
}

function bdxFermeDocument() {
  const c = bdx.courant;
  bdx.rendu?.cancel?.();
  bdx.rendu = null;
  clearTimeout(bdx.minuteurRendu);
  if (c?.doc) c.doc.destroy().catch(() => {});
  if (c?.imageUrl) URL.revokeObjectURL(c.imageUrl);
}

async function bdxChargeFichier(id) {
  const res = await fetch(`/api/bordereaux/${id}/fichier`);
  if (!res.ok) {
    const message = (await res.json().catch(() => ({}))).error || `Fichier inaccessible (${res.status})`;
    throw new Error(message);
  }
  const type = res.headers.get("Content-Type") || "";
  if (type.startsWith("application/pdf")) return { type: "pdf", octets: new Uint8Array(await res.arrayBuffer()) };
  if (type.startsWith("image/")) return { type: "image", blob: await res.blob() };
  throw new Error("Ce fichier n'est ni un PDF ni une image : il ne s'affiche pas ici (téléchargeable depuis le panneau).");
}

async function bdxInstalleFichier(c, fichier) {
  const canvas = $("bdx-canvas");
  const image = $("bdx-image");
  if (fichier.type === "pdf") {
    const pdfjs = await bdxChargePdfjs();
    c.doc = await pdfjs.getDocument({
      data: fichier.octets,
      isEvalSupported: false,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    }).promise;
    c.type = "pdf";
    c.nbPages = c.doc.numPages;
    canvas.hidden = false;
    image.hidden = true;
    image.removeAttribute("src");
  } else {
    c.imageUrl = URL.createObjectURL(fichier.blob);
    image.src = c.imageUrl;
    await image.decode();
    c.type = "image";
    c.nbPages = 1;
    canvas.hidden = true;
    image.hidden = false;
  }
}

/** Ouvre une etiquette ; `page`, `codeId` : la ou aller, le code a montrer. */
async function bdxOuvre(id, { page = null, codeId = null, recherche = null, resume = null } = {}) {
  const jeton = ++bdx.jeton;
  bdxFermeDocument();
  // une autre etiquette s'ouvre en entier, a la largeur (le zoom libre de la
  // precedente ne lui irait pas)
  if (bdx.mode === "libre") bdx.mode = "largeur";
  bdx.courant = { id, resume: resume || bdx.liste.find((b) => b.id === id) || bdx.resultats.find((b) => b.id === id) || null, detail: null, type: null, doc: null, pdfPage: null, nbPages: 1, page: page || 1, base: null, cible: { page, codeId, recherche }, analyseEnCours: false };
  bdx.selection = codeId;
  bdx.trouve = codeId;
  document.querySelectorAll("#bdx-liste .bdx-ligne").forEach((b) => {
    const on = Number(b.dataset.bdxOuvre) === id;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-current", String(on));
  });
  document.querySelectorAll("#bdx-resultats .bdx-res").forEach((r) => r.classList.toggle("is-on", Number(r.dataset.bdxId) === id));
  $("bdx-vide").hidden = true;
  $("bdx-feuille").hidden = true;
  $("bdx-barre").hidden = true;
  $("bdx-zones").innerHTML = "";
  bdxCacheBulle();
  bdxMessage("Ouverture de l'étiquette…", "chargement");
  bdxRendPanneau();

  let detail;
  try {
    detail = await fetchJSON(`/api/bordereaux/${id}`);
  } catch (err) {
    if (jeton === bdx.jeton) bdxMessage(err.message, "erreur");
    return;
  }
  if (jeton !== bdx.jeton) return;
  const c = bdx.courant;
  c.detail = detail;
  c.resume = detail.colis;
  bdxRendPanneau();
  // la lecture des codes part tout de suite, en meme temps que l'affichage
  const aLire = detail.analyse.etat === "attente" || detail.analyse.etat === "echec";
  if (aLire) bdxAnalyse(jeton);

  try {
    const fichier = await bdxChargeFichier(id);
    if (jeton !== bdx.jeton) return;
    await bdxInstalleFichier(c, fichier);
    if (jeton !== bdx.jeton) return;
  } catch (err) {
    if (jeton === bdx.jeton) bdxMessage(err.message, "erreur");
    return;
  }
  bdxMessage(null);
  $("bdx-feuille").hidden = false;
  $("bdx-barre").hidden = false;
  $("bdx-feuille").classList.toggle("is-scan", Boolean(c.analyseEnCours));
  await bdxAllerPage(bdxPageCible(c) || page || 1, { ajuste: bdx.mode !== "libre" });
  if (jeton !== bdx.jeton) return;
  rejoue($("bdx-feuille"), "is-arrivee", 700);
  bdxAppliqueCible();
}

async function bdxAnalyse(jeton, { force = false } = {}) {
  const c = bdx.courant;
  if (!c || c.analyseEnCours) return;
  c.analyseEnCours = true;
  $("bdx-feuille").classList.add("is-scan");
  bdxRendPanneau();
  try {
    const d = await postJSON(`/api/bordereaux/${c.id}/analyse`, { force }, { delai: 120000 });
    if (jeton !== bdx.jeton) return;
    c.detail = d;
    if (force) {
      bdx.selection = null;
      bdx.trouve = null;
    }
    bdxMajLigne(c.id, d);
  } catch (err) {
    if (jeton !== bdx.jeton) return;
    toast(err.message, "error");
    try {
      c.detail = await fetchJSON(`/api/bordereaux/${c.id}`);
      bdxMajLigne(c.id, c.detail);
    } catch {}
  } finally {
    if (jeton === bdx.jeton) {
      c.analyseEnCours = false;
      $("bdx-feuille").classList.remove("is-scan");
      bdxRendPanneau();
      bdxRendZones({ revele: true });
      bdxAppliqueCible();
      bdxChargeEtat();
    }
  }
}

const bdxPageAnalysee = (c, n = c?.page) => c?.detail?.analyse?.pages?.[n - 1] || null;
const bdxTousLesCodes = (c) => (c?.detail?.analyse?.pages || []).flatMap((p) => p.codes);

// La page ou se trouve le code vise (id, ou valeur recherchee).
function bdxCodeCible(c) {
  const codes = bdxTousLesCodes(c);
  if (!codes.length || !c.cible) return null;
  if (c.cible.codeId) {
    const exact = codes.find((x) => x.id === c.cible.codeId);
    if (exact) return exact;
  }
  const q = bdxNorme(c.cible.recherche);
  if (q.length < 3) return null;
  const lisibles = codes.filter((x) => x.lisible);
  return (
    lisibles.find((x) => bdxNorme(x.valeur) === q) ||
    lisibles.find((x) => bdxNorme(x.valeur).includes(q)) ||
    lisibles.find((x) => q.includes(bdxNorme(x.valeur)) && bdxNorme(x.valeur).length >= 6) ||
    null
  );
}
const bdxPageCible = (c) => bdxCodeCible(c)?.page || c?.cible?.page || null;

// Arrive sur le code cherche : sa page, lui au centre, en evidence.
async function bdxAppliqueCible() {
  const c = bdx.courant;
  // la page doit etre affichee (et les codes lus) : sinon, plus tard
  if (!c?.base) return;
  const code = bdxCodeCible(c);
  if (!code) return;
  c.cible = null;
  bdx.selection = code.id;
  bdx.trouve = code.id;
  if (code.page !== c.page) await bdxAllerPage(code.page);
  else bdxRendZones();
  bdxRendPanneau();
  bdxMontreZone(code, { fluide: true });
  // le pouls ne dure qu'un moment
  setTimeout(() => {
    if (bdx.trouve !== code.id) return;
    bdx.trouve = null;
    document.querySelector(`.bdx-zone[data-code="${code.id}"]`)?.classList.remove("is-trouvee");
  }, 4200);
}

function bdxTailleScene() {
  const s = $("bdx-scene");
  const style = getComputedStyle(s);
  return {
    l: s.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    h: s.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
  };
}

function bdxZoomAjuste(mode) {
  const c = bdx.courant;
  if (!c?.base) return 1;
  const { l, h } = bdxTailleScene();
  const largeur = l / c.base.l;
  const z = mode === "page" ? Math.min(largeur, h / c.base.h) : largeur;
  return bdxBorne(z, BDX_ZOOM_MIN, BDX_ZOOM_MAX);
}

function bdxDimensionne() {
  const c = bdx.courant;
  if (!c?.base) return;
  const f = $("bdx-feuille");
  f.style.width = `${Math.round(c.base.l * bdx.zoom)}px`;
  f.style.height = `${Math.round(c.base.h * bdx.zoom)}px`;
}

async function bdxAllerPage(n, { ajuste = false } = {}) {
  const c = bdx.courant;
  if (!c || (!c.doc && c.type !== "image")) return;
  n = bdxBorne(n, 1, c.nbPages);
  c.page = n;
  if (c.type === "pdf") {
    const jeton = bdx.jeton;
    const page = await c.doc.getPage(n);
    if (jeton !== bdx.jeton || c.page !== n) return;
    c.pdfPage = page;
    const v = page.getViewport({ scale: 1 });
    c.base = { l: v.width * CSS_PAR_POINT, h: v.height * CSS_PAR_POINT };
  } else {
    const img = $("bdx-image");
    c.base = { l: img.naturalWidth, h: img.naturalHeight };
  }
  if (ajuste || bdx.mode !== "libre") bdx.zoom = bdxZoomAjuste(bdx.mode === "page" ? "page" : "largeur");
  bdxDimensionne();
  bdxRendZones();
  bdxCacheBulle();
  bdxMajBarre();
  $("bdx-scene").scrollTo({ left: 0, top: 0 });
  await bdxDessine(true);
}

// Le rendu net de la page a ce zoom (et a la densite de l'ecran). Pendant un
// zoom, l'ancien rendu est etire en attendant : rien ne clignote.
function bdxDessine(toutDeSuite = false) {
  clearTimeout(bdx.minuteurRendu);
  return new Promise((resolve) => {
    bdx.minuteurRendu = setTimeout(() => bdxRendCanvas().then(resolve, resolve), toutDeSuite ? 0 : 140);
  });
}

async function bdxRendCanvas() {
  const c = bdx.courant;
  if (!c || c.type !== "pdf" || !c.pdfPage) return;
  bdx.rendu?.cancel?.();
  const page = c.pdfPage;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let echelle = bdx.zoom * CSS_PAR_POINT * dpr;
  const essai = page.getViewport({ scale: echelle });
  if (essai.width * essai.height > BDX_MAX_PIXELS) echelle *= Math.sqrt(BDX_MAX_PIXELS / (essai.width * essai.height));
  const viewport = page.getViewport({ scale: echelle });
  const tampon = document.createElement("canvas");
  tampon.width = Math.max(1, Math.floor(viewport.width));
  tampon.height = Math.max(1, Math.floor(viewport.height));
  const tache = page.render({ canvasContext: tampon.getContext("2d", { alpha: false }), viewport, background: "#ffffff" });
  bdx.rendu = tache;
  try {
    await tache.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.warn("[bordereaux] rendu :", err);
    return;
  }
  if (bdx.courant !== c || c.pdfPage !== page) return;
  const actuel = $("bdx-canvas");
  tampon.id = "bdx-canvas";
  tampon.className = actuel.className;
  tampon.setAttribute("aria-hidden", "true");
  actuel.replaceWith(tampon);
}

function bdxMajBarre() {
  const c = bdx.courant;
  if (!c) return;
  $("bdx-pages").hidden = c.nbPages <= 1;
  $("bdx-page-texte").textContent = `${c.page} / ${c.nbPages}`;
  $("bdx-page-prec").disabled = c.page <= 1;
  $("bdx-page-suiv").disabled = c.page >= c.nbPages;
  $("bdx-zoom-valeur").textContent = `${Math.round(bdx.zoom * 100)} %`;
  $("bdx-zoom-moins").disabled = bdx.zoom <= BDX_ZOOM_MIN + 1e-6;
  $("bdx-zoom-plus").disabled = bdx.zoom >= BDX_ZOOM_MAX - 1e-6;
  $("bdx-ajuste-largeur").setAttribute("aria-pressed", String(bdx.mode === "largeur"));
  $("bdx-ajuste-page").setAttribute("aria-pressed", String(bdx.mode === "page"));
  $("bdx-zones-toutes").setAttribute("aria-pressed", String(bdx.zonesToutes));
  // les pages qui portent des codes (petits points sous le numero)
  const pagesAvecCodes = (c.detail?.analyse?.pages || []).filter((p) => p.codes.length).map((p) => p.page);
  $("bdx-page-texte").title = pagesAvecCodes.length ? `Codes sur la page ${pagesAvecCodes.join(", ")}` : "";
}

/** Zoom a `z`, le point sous (cx, cy) reste sous le pointeur. */
function bdxZoomA(z, cx = null, cy = null, { mode = "libre" } = {}) {
  const c = bdx.courant;
  if (!c?.base) return;
  z = bdxBorne(z, BDX_ZOOM_MIN, BDX_ZOOM_MAX);
  const scene = $("bdx-scene");
  const feuille = $("bdx-feuille");
  const sr = scene.getBoundingClientRect();
  const avant = feuille.getBoundingClientRect();
  if (cx === null) {
    cx = sr.left + sr.width / 2;
    cy = sr.top + sr.height / 2;
  }
  const fx = (cx - avant.left) / avant.width;
  const fy = (cy - avant.top) / avant.height;
  bdx.zoom = z;
  bdx.mode = mode;
  bdxDimensionne();
  const apres = feuille.getBoundingClientRect();
  scene.scrollLeft += apres.left + fx * apres.width - cx;
  scene.scrollTop += apres.top + fy * apres.height - cy;
  bdxCacheBulle();
  bdxMajBarre();
  bdxDessine();
}

function bdxPas(sens) {
  const z = bdx.zoom;
  const suivant = sens > 0 ? BDX_PAS_ZOOM.find((p) => p > z * 1.01) : [...BDX_PAS_ZOOM].reverse().find((p) => p < z * 0.99);
  bdxZoomA(suivant ?? z);
}

function bdxAjuste(mode) {
  if (!bdx.courant?.base) return;
  bdx.mode = mode;
  bdxZoomA(bdxZoomAjuste(mode), null, null, { mode });
  $("bdx-scene").scrollTo({ left: 0, top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
}

// Le code au centre de la scene (sans changer le zoom, sauf s'il est minuscule).
function bdxMontreZone(code, { fluide = false } = {}) {
  const scene = $("bdx-scene");
  const feuille = $("bdx-feuille");
  if (!code?.zone || feuille.hidden) return;
  const l = feuille.offsetWidth;
  const h = feuille.offsetHeight;
  const cx = feuille.offsetLeft + ((code.zone.x0 + code.zone.x1) / 2) * l;
  const cy = feuille.offsetTop + ((code.zone.y0 + code.zone.y1) / 2) * h;
  scene.scrollTo({
    left: Math.max(0, cx - scene.clientWidth / 2),
    top: Math.max(0, cy - scene.clientHeight / 2),
    behavior: fluide && !prefersReducedMotion ? "smooth" : "auto",
  });
}

// --- Les zones des codes --------------------------------------------------------------

function bdxRendZones({ revele = false } = {}) {
  const c = bdx.courant;
  const conteneur = $("bdx-zones");
  conteneur.classList.toggle("is-toutes", bdx.zonesToutes);
  const page = bdxPageAnalysee(c);
  if (!page) {
    conteneur.innerHTML = "";
    return;
  }
  conteneur.innerHTML = page.codes
    .map((code, i) => {
      const z = code.zone;
      const classes = ["bdx-zone", `r-${code.role}`, code.famille === "2D" ? "is-2d" : "is-1d"];
      if (code.id === bdx.selection) classes.push("is-choisie");
      if (code.id === bdx.trouve) classes.push("is-trouvee");
      if (revele) classes.push("is-revele");
      const etiquette = code.lisible ? `${code.nomFormat} : ${bdxValeur(code.valeur).slice(0, 80)}` : `${code.nomFormat} illisible`;
      return `<button type="button" class="${classes.join(" ")}" data-code="${code.id}" style="left:${bdxPourcent(z.x0)};top:${bdxPourcent(z.y0)};width:${bdxPourcent(z.x1 - z.x0)};height:${bdxPourcent(z.y1 - z.y0)};--i:${i}" aria-label="${escapeAttr(etiquette)}"></button>`;
    })
    .join("");
}

function bdxCode(id) {
  return bdxTousLesCodes(bdx.courant).find((x) => x.id === id) || null;
}

function bdxChoisit(id, { montre = false } = {}) {
  bdx.selection = id;
  document.querySelectorAll(".bdx-zone").forEach((z) => z.classList.toggle("is-choisie", Number(z.dataset.code) === id));
  document.querySelectorAll(".bdx-code").forEach((li) => li.classList.toggle("is-choisi", Number(li.dataset.code) === id));
  const item = document.querySelector(`.bdx-code[data-code="${id}"]`);
  item?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion ? "auto" : "smooth" });
  if (montre) bdxMontreZone(bdxCode(id), { fluide: true });
}

// --- L'infobulle -------------------------------------------------------------------------

function bdxCacheBulle() {
  const b = $("bdx-bulle");
  b.hidden = true;
  b.classList.remove("is-visible");
  document.querySelectorAll(".bdx-zone.is-survol, .bdx-code.is-survol").forEach((x) => x.classList.remove("is-survol"));
}

function bdxMontreBulle(zone) {
  const code = bdxCode(Number(zone.dataset.code));
  if (!code) return;
  const b = $("bdx-bulle");
  const valeur = code.lisible
    ? `<div class="bdx-bulle-valeur">${escapeHtml(bdxValeur(code.valeur).slice(0, 220))}${code.valeur.length > 220 ? "…" : ""}</div>`
    : `<div class="bdx-bulle-valeur is-illisible">${escapeHtml(code.erreur || "illisible")}</div>`;
  b.innerHTML = `
    <div class="bdx-bulle-tete">
      <span class="bdx-format">${escapeHtml(code.nomFormat)}<em>${code.famille}</em></span>
      <span class="bdx-role r-${code.role}">${BDX_ROLES[code.role] || "Code"}</span>
    </div>
    ${valeur}
    <div class="bdx-bulle-pied">${code.lisible ? "Clic : choisir · Double-clic : copier" : "Le code est repéré, sa valeur n'a pas pu être lue"}</div>`;
  b.hidden = false;
  document.querySelectorAll(".bdx-zone.is-survol").forEach((x) => x.classList.remove("is-survol"));
  zone.classList.add("is-survol");
  document.querySelector(`.bdx-code[data-code="${code.id}"]`)?.classList.add("is-survol");
  // au-dessus de la zone, ou dessous s'il n'y a pas la place ; dans la visionneuse
  const v = $("bdx-visionneuse").getBoundingClientRect();
  const r = zone.getBoundingClientRect();
  const bl = b.offsetWidth;
  const bh = b.offsetHeight;
  let top = r.top - v.top - bh - 12;
  let dessous = false;
  if (top < 56) {
    top = r.bottom - v.top + 12;
    dessous = true;
  }
  top = Math.min(top, v.height - bh - 8);
  const left = bdxBorne(r.left - v.left + r.width / 2 - bl / 2, 8, v.width - bl - 8);
  b.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  b.classList.toggle("is-dessous", dessous);
  requestAnimationFrame(() => b.classList.add("is-visible"));
}

// --- Le panneau de droite -----------------------------------------------------------------

function bdxRendPanneau() {
  const p = $("bdx-panneau");
  const c = bdx.courant;
  if (!c) {
    p.hidden = true;
    return;
  }
  p.hidden = false;
  const r = c.detail?.colis || c.resume;
  if (!r) {
    p.innerHTML = `<div class="bdx-p-squelette"><span></span><span></span><span></span></div>`;
    return;
  }
  const a = c.detail?.analyse;
  const lienSuivi = bdxLienSuivi(r.suivi);
  const probable = !r.suivi ? bdxTousLesCodes(c).find((x) => x.role === "suivi-probable") : null;

  const infos = [
    ["Reçue", bdxDate(r.recuLe)],
    ["Étape", BDX_ETAPES[r.etape] || "—"],
    r.imprimeLe ? ["Imprimée", bdxDate(r.imprimeLe)] : null,
    r.deposeLe ? ["Déposée", bdxDate(r.deposeLe)] : null,
    a?.nombrePages ? ["Pages", String(a.nombrePages)] : null,
    r.redrop ? ["Redrop", "oui"] : null,
  ].filter(Boolean);

  let suivi;
  if (r.suivi) {
    suivi = `
      <div class="bdx-p-num">
        <span class="bdx-p-num-label">Numéro de suivi · ${escapeHtml(r.suivi.nom)}</span>
        <span class="bdx-p-num-valeur">${escapeHtml(r.suivi.numero)}</span>
        <button class="bdx-outil bdx-p-copie" type="button" data-bdx-copie="${escapeAttr(r.suivi.numero)}" aria-label="Copier le numéro"><svg class="icon"><use href="#i-copy"/></svg></button>
      </div>
      ${lienSuivi ? `<a class="btn btn-primary btn-sm bdx-p-ouvrir" href="${escapeAttr(lienSuivi)}" target="_blank" rel="noopener noreferrer"><svg class="icon"><use href="#i-external"/></svg><span>Ouvrir le suivi du colis</span></a>` : ""}`;
  } else if (probable) {
    const lien = bdxLienSuivi(probable.suivi);
    suivi = `
      <p class="bdx-p-note-info">Aucun numéro dans le nom du fichier. Un code lu a la forme d'un numéro ${escapeHtml(probable.suivi.nom)} :</p>
      <div class="bdx-p-num is-probable">
        <span class="bdx-p-num-label">Numéro probable · lu sur l'étiquette</span>
        <span class="bdx-p-num-valeur">${escapeHtml(probable.suivi.numero)}</span>
        <button class="bdx-outil bdx-p-copie" type="button" data-bdx-copie="${escapeAttr(probable.suivi.numero)}" aria-label="Copier le numéro"><svg class="icon"><use href="#i-copy"/></svg></button>
      </div>
      ${lien ? `<a class="btn btn-secondary btn-sm bdx-p-ouvrir" href="${escapeAttr(lien)}" target="_blank" rel="noopener noreferrer"><svg class="icon"><use href="#i-external"/></svg><span>Ouvrir le suivi du colis</span></a>` : ""}`;
  } else {
    suivi = `<p class="bdx-p-note-info">Aucun numéro de suivi connu pour ce colis${a?.etat === "analyse" ? " ni reconnu sur l'étiquette" : ""}.</p>`;
  }

  let codes;
  if (c.analyseEnCours) {
    codes = `<div class="bdx-p-lecture"><span class="bdx-roue" aria-hidden="true"></span><span>Lecture des codes-barres et QR codes…</span></div>`;
  } else if (!a || a.etat === "attente") {
    codes = `<div class="bdx-p-lecture is-attente">Pas encore lue.</div>`;
  } else if (a.etat === "echec" || a.etat === "erreur") {
    codes = `<div class="bdx-p-lecture is-erreur"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg><span>${escapeHtml(a.erreur || "Lecture impossible")}</span></div>`;
  } else {
    const tous = a.pages.flatMap((pg) => pg.codes);
    codes = tous.length
      ? `<ul class="bdx-codes">${tous.map((code, i) => bdxItemCode(code, i, a.nombrePages > 1)).join("")}</ul>`
      : `<div class="bdx-p-lecture is-attente">Aucun code-barre ni QR code trouvé sur ${a.nombrePages > 1 ? "ces pages" : "cette page"}.</div>`;
    if (a.partiel) codes += `<p class="bdx-p-note-info">Seules les ${a.pages.length} premières pages ont été lues.</p>`;
  }
  const nbCodes = a?.etat === "analyse" ? (a.lisibles || 0) + (a.illisibles || 0) : null;
  const note = c.detail?.annotation?.texte || "";

  p.innerHTML = `
    <div class="bdx-p-tete">
      <span class="bdx-p-transporteur" style="${bdxTeinte(r.transporteur?.code)}">${escapeHtml(r.transporteur?.nom || "Transporteur inconnu")}</span>
      <h2 class="bdx-p-titre">${escapeHtml(r.expediteur || "—")}</h2>
      <p class="bdx-p-fichier" title="${escapeAttr(r.fichier || "")}"><svg class="icon" aria-hidden="true"><use href="#i-file"/></svg>${escapeHtml(r.fichier || `Colis #${r.id}`)}</p>
    </div>
    <dl class="bdx-p-infos">${infos.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>
    <section class="bdx-p-bloc bdx-p-suivi">${suivi}</section>
    <section class="bdx-p-bloc">
      <h3 class="bdx-p-h">Codes détectés${nbCodes !== null ? ` <b>${nbCodes}</b>` : ""}</h3>
      ${codes}
    </section>
    <section class="bdx-p-bloc">
      <h3 class="bdx-p-h">Catégorie <span class="bdx-p-h-info">un classement à part</span></h3>
      <div class="bdx-p-categorie">
        <select id="bdx-p-categorie" aria-label="Catégorie de l'étiquette">
          <option value="">Sans catégorie</option>
          ${bdx.categories.map((k) => `<option value="${k.id}"${c.detail?.categorie?.id === k.id ? " selected" : ""}>${escapeHtml(k.nom)}</option>`).join("")}
          <option value="nouvelle">Nouvelle catégorie…</option>
        </select>
        ${c.detail?.categorie ? bdxPuceCategorie(c.detail.categorie) : ""}
      </div>
    </section>
    ${c.detail?.note ? `<section class="bdx-p-bloc"><h3 class="bdx-p-h">Note du colis</h3><p class="bdx-p-texte">${escapeHtml(c.detail.note)}</p></section>` : ""}
    <section class="bdx-p-bloc bdx-p-annotation">
      <h3 class="bdx-p-h">Note d'étude <span class="bdx-p-h-info">gardée à part : le fichier n'est jamais modifié</span></h3>
      <textarea id="bdx-annotation" rows="2" maxlength="2000" placeholder="Ex. code abîmé, numéro relu à la main…">${escapeHtml(note)}</textarea>
      <button class="btn btn-secondary btn-sm" id="bdx-annotation-ok" type="button" hidden><svg class="icon"><use href="#i-check"/></svg><span>Enregistrer la note</span></button>
    </section>
    <div class="bdx-p-actions">
      <button class="btn btn-secondary btn-sm" id="bdx-relire" type="button"${c.analyseEnCours ? " disabled" : ""}><svg class="icon"><use href="#i-refresh"/></svg><span>Relire les codes</span></button>
      <a class="btn btn-ghost btn-sm" href="/api/bordereaux/${r.id}/fichier?telecharger=1" download><svg class="icon"><use href="#i-upload"/></svg><span>Fichier d'origine</span></a>
    </div>
    ${a?.empreinte ? `<p class="bdx-p-origine" title="Empreinte SHA-256 du fichier d'origine : ${escapeAttr(a.empreinte)}">Original intact · ${escapeHtml(a.empreinte.slice(0, 12))}…${a.analyseLe ? ` · lu le ${escapeHtml(new Date(a.analyseLe).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }))}` : ""}</p>` : ""}`;
}

function bdxItemCode(code, i, plusieursPages) {
  const classes = ["bdx-code", `r-${code.role}`];
  if (code.id === bdx.selection) classes.push("is-choisi");
  const valeur = code.lisible ? escapeHtml(bdxValeur(code.valeur)) : `<em>${escapeHtml(code.erreur || "illisible")}</em>`;
  const lien = code.role === "lien" && /^https?:\/\//i.test(code.lien || "") ? code.lien : code.suivi && code.role === "suivi-probable" ? bdxLienSuivi(code.suivi) : null;
  return `<li class="${classes.join(" ")}" data-code="${code.id}" style="--i:${i}">
    <button type="button" class="bdx-code-corps" data-bdx-code="${code.id}">
      <span class="bdx-code-tete">
        <span class="bdx-format">${escapeHtml(code.nomFormat)}<em>${code.famille}</em></span>
        <span class="bdx-role r-${code.role}">${BDX_ROLES[code.role] || "Code"}</span>
        ${plusieursPages ? `<span class="bdx-code-page">p. ${code.page}</span>` : ""}
      </span>
      <span class="bdx-code-valeur">${valeur}</span>
    </button>
    <span class="bdx-code-actions">
      ${code.lisible ? `<button class="bdx-outil" type="button" data-bdx-copie="${escapeAttr(code.valeur)}" aria-label="Copier la valeur"><svg class="icon"><use href="#i-copy"/></svg></button>` : ""}
      ${lien ? `<a class="bdx-outil" href="${escapeAttr(lien)}" target="_blank" rel="noopener noreferrer" aria-label="${code.role === "lien" ? "Ouvrir le lien" : "Ouvrir le suivi"}"><svg class="icon"><use href="#i-external"/></svg></a>` : ""}
    </span>
  </li>`;
}

// --- La recherche (onglet Recherche / modifications) ------------------------------------

function bdxSurligne(norme, debut, fin) {
  const n = String(norme || "");
  if (!(fin > debut)) return escapeHtml(n);
  return `${escapeHtml(n.slice(0, debut))}<mark>${escapeHtml(n.slice(debut, fin))}</mark>${escapeHtml(n.slice(fin))}`;
}

function bdxRendResultats(r) {
  const ul = $("bdx-resultats");
  const info = $("bdx-recherche-info");
  if (!r) {
    ul.innerHTML = "";
    info.textContent = "Tape au moins 3 caractères : le numéro entier, son début, sa fin, ou avec une faute de frappe.";
    return;
  }
  if (!r.resultats.length) {
    ul.innerHTML = "";
    info.innerHTML = `Aucune étiquette ne porte <b>${escapeHtml(r.requete)}</b>, même à une faute près.`;
    return;
  }
  info.innerHTML = r.total > r.resultats.length ? `${entier(r.total)} étiquettes — les ${r.resultats.length} plus proches` : `${pluriel(r.total, "étiquette trouvée", "étiquettes trouvées")}`;
  ul.innerHTML = r.resultats
    .map((b, i) => {
      const meilleur = b.correspondances[0];
      const lien = bdxLienSuivi(b.suivi);
      return `<li class="bdx-res${i === bdx.actif ? " is-actif" : ""}${bdx.courant?.id === b.id ? " is-on" : ""}" role="option" data-bdx-id="${b.id}" data-bdx-res="${i}" aria-selected="${i === bdx.actif}" style="--i:${Math.min(i, 12)}">
        <button type="button" class="bdx-res-corps" data-bdx-res-ouvre="${i}">
          <span class="bdx-res-tete">
            <span class="bdx-pastille" style="${bdxTeinte(b.transporteur?.code)}" aria-hidden="true"></span>
            <b>${escapeHtml(b.expediteur || "—")}</b>
            <span class="bdx-res-type t-${meilleur.type}">${BDX_TYPES_RECHERCHE[meilleur.type] || ""}</span>
          </span>
          <span class="bdx-res-sous">${escapeHtml([b.transporteur?.nom, bdxDate(b.recuLe), BDX_ETAPES[b.etape]].filter(Boolean).join(" · "))}</span>
          <span class="bdx-res-codes">
            ${b.correspondances
              .map(
                (m) => `<span class="bdx-res-code">
                <span class="bdx-res-source">${m.source === "code" ? `${escapeHtml(m.nomFormat)}${m.page ? ` · p. ${m.page}` : ""}` : "Nom du fichier"}</span>
                <span class="bdx-res-valeur">${bdxSurligne(m.norme, m.debut, m.fin)}</span>
              </span>`
              )
              .join("")}
          </span>
        </button>
        <span class="bdx-res-actions">
          ${b.index?.etat !== "analyse" ? `<span class="bdx-res-pas-lue">Étiquette pas encore lue : elle le sera à l'ouverture</span>` : ""}
          ${lien ? `<a class="btn btn-secondary btn-sm" href="${escapeAttr(lien)}" target="_blank" rel="noopener noreferrer"><svg class="icon"><use href="#i-external"/></svg><span>Ouvrir le suivi du colis</span></a>` : ""}
        </span>
      </li>`;
    })
    .join("");
}

async function bdxCherche(q) {
  const jeton = ++bdx.jetonRecherche;
  if (bdxNorme(q).length < 3) {
    bdx.resultats = [];
    bdx.actif = -1;
    bdxRendResultats(null);
    return;
  }
  $("bdx-grande-recherche").classList.add("is-cherche");
  try {
    const r = await fetchJSON(`/api/bordereaux/recherche?q=${encodeURIComponent(q)}`);
    if (jeton !== bdx.jetonRecherche) return;
    bdx.resultats = r.resultats;
    bdx.actif = r.resultats.length ? 0 : -1;
    bdxRendResultats(r);
  } catch (err) {
    if (jeton !== bdx.jetonRecherche) return;
    $("bdx-recherche-info").textContent = err.message;
  } finally {
    if (jeton === bdx.jetonRecherche) $("bdx-grande-recherche").classList.remove("is-cherche");
  }
}

function bdxOuvreResultat(i) {
  const b = bdx.resultats[i];
  if (!b) return;
  bdx.actif = i;
  const m = b.correspondances.find((x) => x.source === "code") || b.correspondances[0];
  bdxOuvre(b.id, { page: m?.page || null, codeId: m?.source === "code" ? m.codeId : null, recherche: $("bdx-q").value, resume: b });
}

// --- Onglets ----------------------------------------------------------------------------

function bdxOnglet(onglet, { focus = true } = {}) {
  bdx.onglet = onglet;
  $("bdx-espace").dataset.onglet = onglet;
  document.querySelectorAll("[data-bdx-onglet]").forEach((b) => {
    const on = b.dataset.bdxOnglet === onglet;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("bdx-gauche-etude").hidden = onglet !== "etude";
  $("bdx-gauche-recherche").hidden = onglet !== "recherche";
  $("bdx-grande-recherche").hidden = onglet !== "recherche";
  if (onglet === "recherche" && focus) setTimeout(() => $("bdx-q").focus({ preventScroll: true }), 30);
  // la scene change de taille : le zoom « ajuste » suit
  requestAnimationFrame(bdxReajuste);
}

function bdxReajuste() {
  const c = bdx.courant;
  if (!c?.base || bdx.mode === "libre") return;
  const z = bdxZoomAjuste(bdx.mode);
  if (Math.abs(z - bdx.zoom) < 0.001) return;
  bdx.zoom = z;
  bdxDimensionne();
  bdxMajBarre();
  bdxDessine();
}

// --- Branchements --------------------------------------------------------------------------

document.querySelectorAll("[data-bdx-onglet]").forEach((b) => b.addEventListener("click", () => bdxOnglet(b.dataset.bdxOnglet)));

$("bdx-filtres").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filtre]");
  if (!b || b.dataset.filtre === bdx.filtre) return;
  bdx.filtre = b.dataset.filtre;
  document.querySelectorAll("#bdx-filtres .bdx-puce").forEach((x) => {
    const on = x === b;
    x.classList.toggle("is-on", on);
    x.setAttribute("aria-checked", String(on));
  });
  bdx.liste = [];
  bdxChargeListe();
});

let bdxMinuteurFiltre = null;
$("bdx-filtre").addEventListener("input", (e) => {
  clearTimeout(bdxMinuteurFiltre);
  bdxMinuteurFiltre = setTimeout(() => {
    bdx.filtreTexte = e.target.value.trim();
    bdxChargeListe();
  }, 220);
});

$("bdx-plus").addEventListener("click", (e) => agir(e.currentTarget, () => bdxChargeListe({ suite: true })));

$("bdx-liste").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bdx-ouvre]");
  if (b) bdxOuvre(Number(b.dataset.bdxOuvre));
});

$("bdx-q").addEventListener("input", (e) => {
  clearTimeout(bdx.minuteurRecherche);
  const q = e.target.value;
  bdx.minuteurRecherche = setTimeout(() => bdxCherche(q), 160);
});
$("bdx-q").addEventListener("keydown", (e) => {
  const n = bdx.resultats.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!n) return;
    e.preventDefault();
    bdx.actif = (bdx.actif + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    document.querySelectorAll("#bdx-resultats .bdx-res").forEach((li, i) => {
      li.classList.toggle("is-actif", i === bdx.actif);
      li.setAttribute("aria-selected", String(i === bdx.actif));
      if (i === bdx.actif) li.scrollIntoView({ block: "nearest" });
    });
  } else if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(bdx.minuteurRecherche);
    if (bdx.actif >= 0) bdxOuvreResultat(bdx.actif);
    else bdxCherche(e.target.value);
  } else if (e.key === "Escape" && e.target.value) {
    e.preventDefault();
    e.target.value = "";
    bdxCherche("");
  }
});
$("bdx-resultats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bdx-res-ouvre]");
  if (b) bdxOuvreResultat(Number(b.dataset.bdxResOuvre));
});

// barre d'outils
$("bdx-page-prec").addEventListener("click", () => bdxAllerPage((bdx.courant?.page || 1) - 1));
$("bdx-page-suiv").addEventListener("click", () => bdxAllerPage((bdx.courant?.page || 1) + 1));
$("bdx-zoom-moins").addEventListener("click", () => bdxPas(-1));
$("bdx-zoom-plus").addEventListener("click", () => bdxPas(1));
$("bdx-zoom-valeur").addEventListener("click", () => bdxZoomA(1));
$("bdx-ajuste-largeur").addEventListener("click", () => bdxAjuste("largeur"));
$("bdx-ajuste-page").addEventListener("click", () => bdxAjuste("page"));
$("bdx-zones-toutes").addEventListener("click", () => {
  bdx.zonesToutes = !bdx.zonesToutes;
  $("bdx-zones").classList.toggle("is-toutes", bdx.zonesToutes);
  bdxMajBarre();
});

// les zones : survol, choix, copie
const bdxZonesEl = $("bdx-zones");
bdxZonesEl.addEventListener("pointerover", (e) => {
  const z = e.target.closest(".bdx-zone");
  if (z && !bdx.glisse?.bouge) bdxMontreBulle(z);
});
bdxZonesEl.addEventListener("pointerout", (e) => {
  const z = e.target.closest(".bdx-zone");
  if (z && !z.contains(e.relatedTarget)) bdxCacheBulle();
});
bdxZonesEl.addEventListener("focusin", (e) => {
  const z = e.target.closest(".bdx-zone");
  if (z) bdxMontreBulle(z);
});
bdxZonesEl.addEventListener("focusout", bdxCacheBulle);
bdxZonesEl.addEventListener("click", (e) => {
  const z = e.target.closest(".bdx-zone");
  if (!z) return;
  bdxChoisit(Number(z.dataset.code));
});
bdxZonesEl.addEventListener("dblclick", (e) => {
  const z = e.target.closest(".bdx-zone");
  const code = z && bdxCode(Number(z.dataset.code));
  if (code?.lisible) copyText(code.valeur, z, "Valeur copiée");
});

// le panneau : un code -> sa page et sa zone ; copier ; la note d'etude ; relire
$("bdx-panneau").addEventListener("click", async (e) => {
  const copie = e.target.closest("[data-bdx-copie]");
  if (copie) {
    copyText(copie.dataset.bdxCopie, copie, "Copié");
    return;
  }
  const item = e.target.closest("[data-bdx-code]");
  if (item) {
    const code = bdxCode(Number(item.dataset.bdxCode));
    if (!code) return;
    if (code.page !== bdx.courant.page) await bdxAllerPage(code.page);
    bdxChoisit(code.id, { montre: true });
    const zone = document.querySelector(`.bdx-zone[data-code="${code.id}"]`);
    if (zone) rejoue(zone, "is-flash", 900);
    return;
  }
  if (e.target.closest("#bdx-relire")) {
    bdxAnalyse(bdx.jeton, { force: true });
    return;
  }
  const ok = e.target.closest("#bdx-annotation-ok");
  if (ok) {
    const c = bdx.courant;
    const texte = $("bdx-annotation").value;
    await agir(ok, async () => {
      const r = await fetchJSON(`/api/bordereaux/${c.id}/annotation`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texte }) });
      if (c.detail) c.detail.annotation = r.annotation;
      ok.hidden = true;
      toast(r.annotation ? "Note d'étude enregistrée" : "Note d'étude effacée");
    });
  }
});
$("bdx-panneau").addEventListener("change", (e) => {
  if (e.target.id === "bdx-p-categorie") bdxClasse(e.target.value);
});
$("bdx-panneau").addEventListener("input", (e) => {
  if (e.target.id !== "bdx-annotation") return;
  const avant = bdx.courant?.detail?.annotation?.texte || "";
  $("bdx-annotation-ok").hidden = e.target.value.trim() === avant.trim();
});
$("bdx-panneau").addEventListener("pointerover", (e) => {
  const li = e.target.closest(".bdx-code");
  document.querySelectorAll(".bdx-zone.is-lie").forEach((z) => z.classList.remove("is-lie"));
  if (li) document.querySelector(`.bdx-zone[data-code="${li.dataset.code}"]`)?.classList.add("is-lie");
});
$("bdx-panneau").addEventListener("pointerleave", () => document.querySelectorAll(".bdx-zone.is-lie").forEach((z) => z.classList.remove("is-lie")));

// glisser pour deplacer la page ; Ctrl/Cmd + molette ou pincement pour zoomer
const bdxSceneEl = $("bdx-scene");
bdxSceneEl.addEventListener(
  "wheel",
  (e) => {
    if (!bdx.courant?.base) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    bdxZoomA(bdx.zoom * Math.exp(-delta * 0.0022), e.clientX, e.clientY);
  },
  { passive: false }
);
let bdxGesteZoom = null;
bdxSceneEl.addEventListener("gesturestart", (e) => {
  e.preventDefault();
  bdxGesteZoom = bdx.zoom;
});
bdxSceneEl.addEventListener("gesturechange", (e) => {
  if (bdxGesteZoom === null) return;
  e.preventDefault();
  bdxZoomA(bdxGesteZoom * e.scale, e.clientX, e.clientY);
});
bdxSceneEl.addEventListener("gestureend", () => {
  bdxGesteZoom = null;
});
bdxSceneEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.pointerType === "touch" || !bdx.courant?.base) return;
  // sur une barre de defilement : c'est elle qui fait defiler
  const r = bdxSceneEl.getBoundingClientRect();
  if (e.clientX - r.left > bdxSceneEl.clientWidth || e.clientY - r.top > bdxSceneEl.clientHeight) return;
  bdx.glisse = { x: e.clientX, y: e.clientY, sl: bdxSceneEl.scrollLeft, st: bdxSceneEl.scrollTop, bouge: false, id: e.pointerId };
});
bdxSceneEl.addEventListener("pointermove", (e) => {
  const g = bdx.glisse;
  if (!g || g.id !== e.pointerId) return;
  const dx = e.clientX - g.x;
  const dy = e.clientY - g.y;
  if (!g.bouge && Math.hypot(dx, dy) < 4) return;
  if (!g.bouge) {
    g.bouge = true;
    bdxSceneEl.setPointerCapture(e.pointerId);
    bdxSceneEl.classList.add("is-glisse");
    bdxCacheBulle();
  }
  bdxSceneEl.scrollLeft = g.sl - dx;
  bdxSceneEl.scrollTop = g.st - dy;
});
function bdxFinGlisse(e) {
  const g = bdx.glisse;
  if (!g || g.id !== e.pointerId) return;
  bdx.glisse = null;
  if (g.bouge) {
    bdxSceneEl.classList.remove("is-glisse");
    // le clic qui suit un glisser ne choisit rien
    const bloque = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", bloque, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", bloque, { capture: true }), 0);
  }
}
bdxSceneEl.addEventListener("pointerup", bdxFinGlisse);
bdxSceneEl.addEventListener("pointercancel", bdxFinGlisse);
bdxSceneEl.addEventListener("scroll", () => {
  if (!$("bdx-bulle").hidden && !document.querySelector(".bdx-zone:focus")) bdxCacheBulle();
}, { passive: true });

// la bdxSceneEl change de taille (fenetre, onglet) : « ajuster » suit
if ("ResizeObserver" in window) {
  let attente = null;
  new ResizeObserver(() => {
    cancelAnimationFrame(attente);
    attente = requestAnimationFrame(bdxReajuste);
  }).observe(bdxSceneEl);
}

// clavier : pages, zoom, recherche (seulement sur cette page, hors saisie)
document.addEventListener("keydown", (e) => {
  const saisie = e.target.closest?.("input, textarea, select, [contenteditable]");
  if (saisie) return;
  if (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f")) {
    e.preventDefault();
    bdxOnglet("recherche");
    $("bdx-q").select();
    return;
  }
  if (!bdx.courant?.base || e.metaKey || e.altKey) return;
  const actions = {
    ArrowRight: () => bdxAllerPage(bdx.courant.page + 1),
    PageDown: () => bdxAllerPage(bdx.courant.page + 1),
    ArrowLeft: () => bdxAllerPage(bdx.courant.page - 1),
    PageUp: () => bdxAllerPage(bdx.courant.page - 1),
    "+": () => bdxPas(1),
    "=": () => bdxPas(1),
    "-": () => bdxPas(-1),
    0: () => bdxAjuste("largeur"),
    1: () => bdxAjuste("page"),
    z: () => $("bdx-zones-toutes").click(),
    Escape: () => {
      bdxCacheBulle();
      bdxChoisit(null);
    },
  };
  const action = actions[e.key];
  if (!action || (e.ctrlKey && !["+", "=", "-", "0"].includes(e.key))) return;
  e.preventDefault();
  action();
});

// --- Demarrage --------------------------------------------------------------------------
// L'adresse peut viser une etiquette ou un numero : /bordereaux?colis=123,
// /bordereaux?q=6A123.

// la hauteur de l'espace : jusqu'en bas de la fenetre, la page ne defile pas
function bdxMesureHaut() {
  const espace = $("bdx-espace");
  let haut = 0;
  for (let el = espace; el; el = el.offsetParent) haut += el.offsetTop;
  if (haut > 0) espace.style.setProperty("--bdx-haut", `${Math.round(haut)}px`);
}
window.addEventListener("resize", bdxMesureHaut, { passive: true });

// --- Tris, filtres et categories -----------------------------------------------------

const BDX_GARDE = "bordereaux.filtres";
function bdxGardeFiltres() {
  try {
    localStorage.setItem(BDX_GARDE, JSON.stringify({ transporteur: bdx.transporteur, depuis: bdx.depuis, tri: bdx.tri, categorie: bdx.categorie }));
  } catch {}
}
function bdxReprendFiltres() {
  try {
    const g = JSON.parse(localStorage.getItem(BDX_GARDE) || "{}");
    if (typeof g.transporteur === "string") bdx.transporteur = g.transporteur;
    if (/^\d{4}-\d{2}-\d{2}$/.test(g.depuis || "")) bdx.depuis = g.depuis;
    if (["recent", "ancien", "transporteur"].includes(g.tri)) bdx.tri = g.tri;
    if (typeof g.categorie === "string") bdx.categorie = g.categorie;
  } catch {}
  $("bdx-depuis").value = bdx.depuis;
  $("bdx-tri").value = bdx.tri;
}

function bdxRendChoixTransporteurs() {
  const sel = $("bdx-transporteur");
  const options = [`<option value="">Tous</option>`];
  const presents = new Set();
  for (const t of bdx.transporteurs) {
    presents.add(t.code);
    options.push(`<option value="${escapeAttr(t.code)}">${escapeHtml(t.nom)} (${entier(t.n)})</option>`);
  }
  // le transporteur choisi reste dans la liste, meme sans etiquette
  if (bdx.transporteur && !presents.has(bdx.transporteur)) options.push(`<option value="${escapeAttr(bdx.transporteur)}">${escapeHtml(bdx.transporteur)} (0)</option>`);
  sel.innerHTML = options.join("");
  sel.value = bdx.transporteur;
}

function bdxMetCategories(liste) {
  bdx.categories = liste;
  const sel = $("bdx-categorie");
  sel.innerHTML = `<option value="">Toutes</option><option value="aucune">Sans catégorie</option>${liste
    .map((c) => `<option value="${c.id}">${escapeHtml(c.nom)} (${entier(c.etiquettes)})</option>`)
    .join("")}`;
  if (bdx.categorie && bdx.categorie !== "aucune" && !liste.some((c) => String(c.id) === bdx.categorie)) bdx.categorie = "";
  sel.value = bdx.categorie;
  if (!$("bdx-fenetre-categories").hidden) bdxRendCategories();
}

function bdxFiltreChange(cle, valeur) {
  bdx[cle] = valeur;
  bdxGardeFiltres();
  bdx.liste = [];
  bdxChargeListe();
}

$("bdx-transporteur").addEventListener("change", (e) => bdxFiltreChange("transporteur", e.target.value));
$("bdx-depuis").addEventListener("change", (e) => bdxFiltreChange("depuis", e.target.value));
$("bdx-tri").addEventListener("change", (e) => bdxFiltreChange("tri", e.target.value));
$("bdx-categorie").addEventListener("change", (e) => bdxFiltreChange("categorie", e.target.value));
$("bdx-effacer-filtres").addEventListener("click", () => {
  Object.assign(bdx, { transporteur: "", depuis: "", tri: "recent", categorie: "" });
  $("bdx-depuis").value = "";
  $("bdx-tri").value = "recent";
  bdxFiltreChange("categorie", "");
});

// classer l'etiquette ouverte (panneau)
async function bdxClasse(valeur) {
  const c = bdx.courant;
  if (!c) return;
  let id = valeur === "" ? null : Number(valeur);
  if (valeur === "nouvelle") {
    const nom = window.prompt("Nom de la nouvelle catégorie :");
    if (!nom || !nom.trim()) {
      bdxRendPanneau();
      return;
    }
    try {
      const r = await postJSON("/api/bordereaux/categories", { nom });
      id = r.categorie.id;
    } catch (err) {
      toast(err.message, "error");
      bdxRendPanneau();
      return;
    }
  }
  try {
    const r = await fetchJSON(`/api/bordereaux/${c.id}/categorie`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categorie: id }) });
    if (c.detail) c.detail.categorie = r.categorie;
    const ligne = bdx.liste.find((b) => b.id === c.id);
    if (ligne) ligne.categorie = r.categorie;
    toast(r.categorie ? `Classée dans « ${r.categorie.nom} »` : "Retirée de sa catégorie", "info", 2200);
    await bdxChargeCategories();
    bdxRendListe();
    bdxRendPanneau();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function bdxChargeCategories() {
  try {
    const r = await fetchJSON("/api/bordereaux/categories");
    bdx.couleurs = r.couleurs;
    bdxMetCategories(r.categories);
  } catch {}
}

// la fenetre « Catégories »
function bdxRendCategories() {
  const couleurs = bdx.couleurs || Object.keys(BDX_COULEURS);
  $("bdx-categories-liste").innerHTML = bdx.categories.length
    ? bdx.categories
        .map(
          (c) => `<li class="bdx-categorie" data-id="${c.id}" style="${bdxTeinteCategorie(c)}">
        <span class="bdx-categorie-pastille"></span>
        <input class="bdx-categorie-nom" value="${escapeAttr(c.nom)}" maxlength="40" aria-label="Nom de la catégorie" />
        <span class="bdx-categorie-n">${pluriel(c.etiquettes, "étiquette")}</span>
        <span class="bdx-categorie-couleurs" role="radiogroup" aria-label="Couleur">${couleurs
          .map((k) => `<button type="button" class="bdx-couleur${k === c.couleur ? " is-on" : ""}" style="--c: ${BDX_COULEURS[k]}" data-couleur="${k}" aria-label="${k}" aria-checked="${k === c.couleur}" role="radio"></button>`)
          .join("")}</span>
        <button class="bdx-outil" type="button" data-supprime="${c.id}" aria-label="Supprimer la catégorie"><svg class="icon"><use href="#i-trash"/></svg></button>
      </li>`
        )
        .join("")
    : `<li class="bdx-liste-vide">Aucune catégorie pour l'instant.</li>`;
}

async function bdxModifieCategorie(id, corps) {
  try {
    await fetchJSON(`/api/bordereaux/categories/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
    await bdxChargeCategories();
    bdxChargeListe();
  } catch (err) {
    toast(err.message, "error");
    bdxRendCategories();
  }
}

$("bdx-gerer-categories").addEventListener("click", async () => {
  await bdxChargeCategories();
  bdxRendCategories();
  $("bdx-fenetre-categories").hidden = false;
  setTimeout(() => $("bdx-categorie-nom").focus(), 50);
});
$("bdx-fenetre-categories").addEventListener("click", async (e) => {
  if (e.target.closest("[data-bdx-ferme]")) {
    $("bdx-fenetre-categories").hidden = true;
    return;
  }
  const couleur = e.target.closest("[data-couleur]");
  if (couleur) {
    await bdxModifieCategorie(Number(couleur.closest("[data-id]").dataset.id), { couleur: couleur.dataset.couleur });
    return;
  }
  const suppr = e.target.closest("[data-supprime]");
  if (suppr) {
    const c = bdx.categories.find((x) => x.id === Number(suppr.dataset.supprime));
    if (!c || !window.confirm(`Supprimer la catégorie « ${c.nom} » ? Ses ${c.etiquettes} étiquette(s) restent, simplement sans catégorie.`)) return;
    try {
      await fetchJSON(`/api/bordereaux/categories/${c.id}`, { method: "DELETE" });
      if (bdx.categorie === String(c.id)) bdx.categorie = "";
      await bdxChargeCategories();
      bdxChargeListe();
      if (bdx.courant?.detail?.categorie?.id === c.id) {
        bdx.courant.detail.categorie = null;
        bdxRendPanneau();
      }
    } catch (err) {
      toast(err.message, "error");
    }
  }
});
$("bdx-fenetre-categories").addEventListener("change", (e) => {
  const champ = e.target.closest(".bdx-categorie-nom");
  if (champ) bdxModifieCategorie(Number(champ.closest("[data-id]").dataset.id), { nom: champ.value });
});
$("bdx-categorie-nouvelle").addEventListener("submit", async (e) => {
  e.preventDefault();
  const champ = $("bdx-categorie-nom");
  try {
    await postJSON("/api/bordereaux/categories", { nom: champ.value });
    champ.value = "";
    await bdxChargeCategories();
    bdxRendCategories();
  } catch (err) {
    toast(err.message, "error");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("bdx-fenetre-categories").hidden) $("bdx-fenetre-categories").hidden = true;
});

function bdxDemarre() {
  bdxReprendFiltres();
  bdxMesureHaut();
  bdxChargeEtat();
  bdxChargeListe();
  setInterval(() => {
    if (!document.hidden) bdxChargeEtat();
  }, 15000);
  const params = new URLSearchParams(location.search);
  const q = params.get("q");
  const colis = Number(params.get("colis"));
  if (q) {
    bdxOnglet("recherche", { focus: false });
    $("bdx-q").value = q;
    bdxCherche(q).then(() => {
      if (!colis && bdx.resultats.length) bdxOuvreResultat(0);
    });
  }
  if (Number.isInteger(colis) && colis > 0) bdxOuvre(colis, { recherche: q || null });
}

bdxDemarre();
