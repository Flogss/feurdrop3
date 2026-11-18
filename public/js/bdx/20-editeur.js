// --- Éditeur de bordereaux -------------------------------------------------------------
// Un DOCUMENT DE TRAVAIL pose par-dessus l'etiquette d'origine : la page
// d'origine reste dessous, telle quelle (pdf.js) ; les elements ajoutes ou
// modifies sont dessines au-dessus, en points de la page affichee (origine en
// haut a gauche). L'etiquette d'origine n'est jamais modifiee : l'export
// fabrique un nouveau PDF sur le serveur (src/bordereaux/editeur.js).
//
// Les textes et codes de l'etiquette se prennent d'un clic : un texte
// deplace, modifie ou supprime laisse un masque blanc a sa place d'origine.
// Les codes de l'etiquette gardent leur valeur (donnees du transporteur) ;
// un code ajoute ne porte ni numero de suivi ni donnees d'expedition (le
// serveur le verifie).

const MM = 0.3527777; // 1 point = 0,353 mm
const PX_PAR_POINT = 96 / 72;
const ED_ZOOM_MIN = 0.1;
const ED_ZOOM_MAX = 12;
const PAS_ZOOM = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12];
const GRILLE_PT = 5 / MM; // 5 mm
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const POLICES = [
  ["Helvetica", "Helvetica"],
  ["Helvetica-Bold", "Helvetica gras"],
  ["Times-Roman", "Times"],
  ["Times-Bold", "Times gras"],
  ["Courier", "Courier"],
  ["Courier-Bold", "Courier gras"],
];
const CSS_POLICE = {
  Helvetica: "400 1em Helvetica, Arial, sans-serif",
  "Helvetica-Bold": "700 1em Helvetica, Arial, sans-serif",
  "Times-Roman": "400 1em 'Times New Roman', Times, serif",
  "Times-Bold": "700 1em 'Times New Roman', Times, serif",
  Courier: "400 1em 'Courier New', Courier, monospace",
  "Courier-Bold": "700 1em 'Courier New', Courier, monospace",
};
const FORMATS_BARRES = ["Code128", "Code39", "Code93", "EAN13", "EAN8", "UPCA", "ITF", "Codabar"];
const FORMATS_2D = ["QRCode", "DataMatrix", "PDF417", "Aztec"];
// la fenetre de l'app Mac (elle pose la classe app-mac des le chargement) :
// les images deposees depuis le Finder, le menu contextuel, la rotation, le
// recadrage et l'habillage « verre » n'existent que la
const APP_MAC = document.documentElement.classList.contains("app-mac") || /FeurDropMac/.test(navigator.userAgent);
if (APP_MAC) document.documentElement.classList.add("app-mac");
const G = GeometrieEditeur;
const NOMS_FORMAT = { Code128: "Code 128", Code39: "Code 39", Code93: "Code 93", EAN13: "EAN-13", EAN8: "EAN-8", UPCA: "UPC-A", ITF: "ITF", Codabar: "Codabar", QRCode: "QR Code", DataMatrix: "Data Matrix", PDF417: "PDF417", Aztec: "Aztec" };

const ed = {
  colisId: null,
  detail: null,
  type: null,
  doc: null,
  pdfPage: null,
  page: 1,
  nbPages: 1,
  W: 0,
  H: 0,
  originaux: new Map(), // page -> { textes: [], codes: [] }
  modele: { version: 1, pages: [] },
  selection: new Set(),
  outil: "selection",
  zoom: 1,
  ajuste: true,
  grille: false,
  magnetisme: true,
  historique: [],
  position: -1,
  codes: new Map(), // "format|valeur" -> { largeur, hauteur, chemin } | promesse
  edition: null, // id du texte en cours d'edition directe
  sauvegarde: { minuteur: null, enCours: false, sale: false, quand: null, erreur: null, version: 0 },
  geste: null,
  rendu: null,
  versionPage: 0, // change a chaque nouveau rendu de la page d'origine (les extraits se redessinent)
  noeuds: new Map(), // id -> { el, cle } : un noeud par element, mis a jour sans tout reconstruire
  masquesRendus: "",
  recadrage: null, // l'image dont on regle le contenu (double-clic)
  apercus: new Map(), // id -> { url, l, h } : une image deposee, montree pendant son envoi
  urls: new Map(), // empreinte -> adresse locale (l'image deposee, sans attendre le serveur)
};

const uid = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const borne = (v, a, b) => Math.min(b, Math.max(a, v));
const enMm = (pt) => Math.round(pt * MM * 10) / 10;
const depuisMm = (mm) => mm / MM;

// --- Le modele -------------------------------------------------------------------------

function pageModele(n = ed.page) {
  let p = ed.modele.pages.find((x) => x.page === n);
  if (!p) {
    p = { page: n, elements: [] };
    ed.modele.pages.push(p);
    ed.modele.pages.sort((a, b) => a.page - b.page);
  }
  return p;
}
const elements = () => pageModele().elements;

// Le code lu sur l'etiquette d'ou vient un element (ou null).
function codeLu(e) {
  if (e.type !== "code" || e.origine !== "original") return null;
  for (const o of ed.originaux.values()) {
    const c = o.codes.find((x) => x.id === e.codeId);
    if (c) return c;
  }
  return null;
}

// La valeur d'un code de l'etiquette peut-elle changer ? (pas celui du transporteur)
const codeLibre = (e) => Boolean(codeLu(e)?.modifiable);

// Un code de l'etiquette est-il reecrit (autre valeur, format ou couleur) ?
// Le panneau montre « Valeur d'origine » des la frappe, sans etre redessine
// (le curseur reste dans le champ).
function marqueReecrit(e) {
  const lu = codeLu(e);
  if (!lu) return;
  e.reecrit = !(e.valeur === lu.valeur && e.format === lu.format && (e.couleur || "#000000").toLowerCase() === "#000000");
  marqueModifie(e);
  const note = document.querySelector("#ed-proprietes .ed-libre");
  if (note) {
    const bouton = note.querySelector('[data-action="valeur-origine"]');
    if (e.reecrit && !bouton) note.insertAdjacentHTML("beforeend", '<button class="ed-petit" type="button" data-action="valeur-origine">Valeur d\'origine</button>');
    else if (!e.reecrit) bouton?.remove();
  }
}

// Un element de l'etiquette rendu tel quel (ses pixels, pas une copie
// redessinee) : un code, un texte deplace sans etre retape, une image pas
// remplacee. Meme regle que l'export (src/bordereaux/editeur.js).
function estExtrait(e) {
  if (e.origine !== "original" || !e.source || !e.depart) return false;
  if (e.type === "code") return !e.reecrit;
  if (e.type === "texte") return !e.retape;
  if (e.type === "image") return !e.image && !ed.apercus.has(e.id);
  return false;
}
const element = (id) => elements().find((e) => e.id === id) || null;
const visibles = () => elements().filter((e) => !e.supprime);
const choisis = () => visibles().filter((e) => ed.selection.has(e.id));

// --- Historique (Ctrl/Cmd + Z, Ctrl/Cmd + Maj + Z, Ctrl + Y) ---------------------------------

// Le document tel qu'il s'enregistre, s'exporte et entre dans l'historique :
// sans les images ajoutees encore en route (leur contenu n'est pas sur le
// serveur, qui refuserait tout le document ; elles entrent a leur arrivee).
const enRoute = (e) => e.origine === "ajout" && e.type === "image" && !e.image;
function modeleEnvoye() {
  if (!ed.modele.pages.some((p) => p.elements.some(enRoute))) return ed.modele;
  return { ...ed.modele, pages: ed.modele.pages.map((p) => ({ ...p, elements: p.elements.filter((e) => !enRoute(e)) })) };
}

function instantane() {
  return JSON.stringify(modeleEnvoye());
}

// `initial` : le point de depart (rien a enregistrer)
function engage(libelle, { initial = false } = {}) {
  const etat = instantane();
  if (ed.position >= 0 && ed.historique[ed.position].etat === etat) return;
  ed.historique = ed.historique.slice(0, ed.position + 1);
  ed.historique.push({ libelle, etat, quand: new Date(), page: ed.page });
  if (ed.historique.length > 300) ed.historique.shift();
  ed.position = ed.historique.length - 1;
  if (!initial) planifieSauvegarde();
  gardeHistorique();
  rendHistorique();
  majBoutonsHistorique();
}

// l'historique survit a la fermeture de l'editeur, sur cet ordinateur (les 60
// dernieres etapes) : Ctrl/Cmd + Z marche encore a la reouverture
function gardeHistorique() {
  try {
    const garde = ed.historique.slice(-60);
    const position = ed.position - (ed.historique.length - garde.length);
    localStorage.setItem(`editeur.historique.${ed.colisId}`, JSON.stringify({ position, etapes: garde.map((h) => ({ ...h, quand: h.quand.getTime() })) }));
  } catch {}
}

function reprendHistorique() {
  try {
    const g = JSON.parse(localStorage.getItem(`editeur.historique.${ed.colisId}`) || "null");
    if (!g || !Array.isArray(g.etapes) || !g.etapes[g.position]) return false;
    // seulement s'il mene bien au document repris
    if (g.etapes[g.position].etat !== instantane()) return false;
    ed.historique = g.etapes.map((h) => ({ ...h, quand: new Date(h.quand) }));
    ed.position = g.position;
    rendHistorique();
    majBoutonsHistorique();
    return true;
  } catch {
    return false;
  }
}

function vaA(position) {
  if (position < 0 || position >= ed.historique.length || position === ed.position) return;
  ed.position = position;
  ed.modele = JSON.parse(ed.historique[position].etat);
  migreElements(ed.page);
  if (ed.recadrage && !element(ed.recadrage)) ed.recadrage = null;
  // les elements choisis qui n'existent plus a cette etape sortent de la selection
  for (const id of [...ed.selection]) if (!element(id) || element(id).supprime) ed.selection.delete(id);
  finEdition(false);
  planifieSauvegarde();
  rendTout();
  rendHistorique();
  majBoutonsHistorique();
}

const annule = () => vaA(ed.position - 1);
const retablit = () => vaA(ed.position + 1);

function majBoutonsHistorique() {
  $("ed-annuler").disabled = ed.position <= 0;
  $("ed-retablir").disabled = ed.position >= ed.historique.length - 1;
  $("ed-annuler").title = ed.position > 0 ? `Annuler « ${ed.historique[ed.position].libelle} » (${MAC ? "⌘Z" : "Ctrl+Z"})` : "Rien à annuler";
  $("ed-retablir").title = ed.position < ed.historique.length - 1 ? `Rétablir « ${ed.historique[ed.position + 1].libelle} » (${MAC ? "⌘⇧Z" : "Ctrl+Y"})` : "Rien à rétablir";
}

function rendHistorique() {
  const ul = $("ed-historique");
  if (ul.hidden) return;
  ul.innerHTML = `<ol class="ed-histo">${ed.historique
    .map(
      (h, i) =>
        `<li><button type="button" class="ed-histo-etape${i === ed.position ? " is-on" : ""}${i > ed.position ? " is-futur" : ""}" data-etape="${i}">
          <span class="ed-histo-num">${i}</span><span class="ed-histo-texte">${escapeHtml(h.libelle)}</span>
          <time>${h.quand.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></button></li>`
    )
    .reverse()
    .join("")}</ol>`;
}

// --- Sauvegarde automatique du brouillon ----------------------------------------------------

function etatSauvegarde(texte, classe) {
  $("ed-sauvegarde-texte").textContent = texte;
  $("ed-sauvegarde").className = `ed-sauvegarde ${classe || ""}`;
}

function planifieSauvegarde() {
  ed.sauvegarde.sale = true;
  ed.sauvegarde.version += 1;
  etatSauvegarde("Modifications en cours…", "is-sale");
  // une copie de secours sur cet ordinateur, au cas ou le serveur ne repond pas
  try {
    localStorage.setItem(`editeur.brouillon.${ed.colisId}`, JSON.stringify({ modele: modeleEnvoye(), quand: Date.now() }));
  } catch {}
  clearTimeout(ed.sauvegarde.minuteur);
  ed.sauvegarde.minuteur = setTimeout(sauvegarde, 1200);
}

async function sauvegarde() {
  if (ed.sauvegarde.enCours) {
    planifieSauvegarde();
    return;
  }
  ed.sauvegarde.enCours = true;
  // ce qui part maintenant : une modification faite pendant l'envoi reste a
  // enregistrer (et sa copie de secours reste sur l'ordinateur)
  const version = ed.sauvegarde.version;
  etatSauvegarde("Enregistrement…", "is-encours");
  try {
    const r = await fetchJSON(`/api/bordereaux/${ed.colisId}/travail`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modele: modeleEnvoye() }) }, { delai: 20000 });
    ed.sauvegarde.quand = new Date(r.modifieLe);
    if (version !== ed.sauvegarde.version) {
      etatSauvegarde("Modifications en cours…", "is-sale");
      return;
    }
    ed.sauvegarde.sale = false;
    etatSauvegarde(`Brouillon enregistré à ${ed.sauvegarde.quand.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`, "is-ok");
    try {
      localStorage.removeItem(`editeur.brouillon.${ed.colisId}`);
    } catch {}
  } catch (err) {
    etatSauvegarde(`Gardé sur cet ordinateur · ${err.message}`, "is-erreur");
  } finally {
    ed.sauvegarde.enCours = false;
  }
}

window.addEventListener("beforeunload", (e) => {
  if (!ed.sauvegarde.sale) return;
  // dernier envoi (le brouillon local reste de toute facon)
  sauvegarde();
  e.preventDefault();
  e.returnValue = "";
});

// --- Les codes (regeneres par le serveur, dessines en SVG) -----------------------------------

// Le cache : le dessin, sa promesse, ou { echec } (redemande a la prochaine
// saisie, ou quand la page se redessine).
async function codeDe(format, valeur, codeId = null) {
  const cle = `${format}|${valeur}`;
  const deja = ed.codes.get(cle);
  if (deja && !deja.echec) return deja;
  const promesse = postJSON(`/api/bordereaux/${ed.colisId}/code`, { format, valeur, codeId }, { delai: 20000 })
    .then((c) => {
      ed.codes.set(cle, c);
      return c;
    })
    .catch((err) => {
      ed.codes.set(cle, { echec: true });
      throw err;
    });
  ed.codes.set(cle, promesse);
  return promesse;
}

// l'etat du dessin d'un code : 0 en attente, 1 pret, x impossible
function etatCode(e) {
  const c = ed.codes.get(`${e.format}|${e.valeur}`);
  if (!c || c instanceof Promise) return "0";
  return c.echec ? "x" : "1";
}

function svgCode(e) {
  const c = ed.codes.get(`${e.format}|${e.valeur}`);
  if (c?.echec) return '<span class="ed-code-attente">Code impossible</span>';
  if (!c || c instanceof Promise) {
    codeDe(e.format, e.valeur, e.origine === "original" ? e.codeId : null).then(() => rendElements(), () => rendElements());
    return '<span class="ed-code-attente">…</span>';
  }
  // un code reecrit de l'etiquette garde l'orientation de l'original (comme a l'export)
  const q = codeLu(e)?.orientation || 0;
  const travers = Math.abs(q) === 90;
  const style = q
    ? ` style="position:absolute;left:50%;top:50%;width:${(((travers ? e.h : e.l) / e.l) * 100).toFixed(4)}%;height:${(((travers ? e.l : e.h) / e.h) * 100).toFixed(4)}%;transform:translate(-50%,-50%) rotate(${q}deg)"`
    : "";
  return `<svg viewBox="0 0 ${c.largeur} ${c.hauteur}" preserveAspectRatio="none" aria-hidden="true"${style}><path d="${c.chemin}" fill="${escapeAttr(e.couleur || "#000000")}"/></svg>`;
}

// --- Rendu --------------------------------------------------------------------------------

const pc = (v, total) => `${((v / total) * 100).toFixed(4)}%`;
const placement = (e) => `left:${pc(e.x, ed.W)};top:${pc(e.y, ed.H)};width:${pc(e.l, ed.W)};height:${pc(e.h, ed.H)}`;

function echelle() {
  return ed.zoom * PX_PAR_POINT;
}

function dimensionne() {
  const f = $("ed-feuille");
  f.style.width = `${Math.round(ed.W * echelle())}px`;
  f.style.height = `${Math.round(ed.H * echelle())}px`;
  f.style.setProperty("--e", String(echelle()));
  $("ed-zoom").textContent = `${Math.round(ed.zoom * 100)} %`;
  $("ed-grille").style.backgroundSize = `${GRILLE_PT * echelle()}px ${GRILLE_PT * echelle()}px`;
}

function rendOriginaux() {
  const o = ed.originaux.get(ed.page) || { textes: [], codes: [], images: [] };
  // ce qui est deja pris dans le document ne se reprend pas
  const pris = new Set(elements().filter((e) => e.origine === "original").map((e) => e.cle));
  const cible = (k, cle, rect, titre) =>
    pris.has(cle) ? "" : `<div class="ed-original ${k}" data-original="${escapeAttr(cle)}" style="${placement(rect)}" title="${escapeAttr(titre)}"></div>`;
  // les images dessous : un texte ou un code pose sur une image se prend d'abord
  $("ed-originaux").innerHTML = [
    ...(o.images || []).map((i) => cible("is-image", i.cle, i.boite, APP_MAC ? "Image de l'étiquette : glisse une image dessus pour la remplacer" : "Image de l'étiquette")),
    ...o.codes.map((c) => cible("is-code", c.cle, c, c.lisible ? `${NOMS_FORMAT[c.format] || c.format} de l'étiquette : ${c.valeur}` : "Code illisible")),
    ...o.textes.map((t) => cible("is-texte", t.cle, t, `Texte de l'étiquette : ${t.texte}`)),
  ].join("");
}

// L'adresse du contenu d'une image (l'image deposee reste locale tant
// qu'elle est la : aucun clignotement a l'arrivee de la version du serveur).
function sourceImage(e) {
  const a = ed.apercus.get(e.id);
  if (a) return a;
  if (!e.image) return null;
  return { url: ed.urls.get(e.image.ref) || `/api/bordereaux/${ed.colisId}/images/${e.image.ref}`, l: e.image.l, h: e.image.h };
}

// La page d'origine, telle qu'elle est rendue : la source des extraits.
function fondPage() {
  if (ed.type === "image") {
    const img = $("ed-image");
    return img.naturalWidth ? { source: img, k: img.naturalWidth / ed.W } : null;
  }
  const c = $("ed-canvas");
  return ed.versionPage && c.width > 1 ? { source: c, k: c.width / ed.W } : null;
}

// Les pixels d'un extrait : la zone d'origine, a la resolution du rendu.
function dessineExtrait(canvas, e) {
  const fond = fondPage();
  if (!fond) return;
  const s = e.source;
  canvas.width = Math.max(1, Math.round(s.l * fond.k));
  canvas.height = Math.max(1, Math.round(s.h * fond.k));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(fond.source, s.x * fond.k, s.y * fond.k, s.l * fond.k, s.h * fond.k, 0, 0, canvas.width, canvas.height);
}

// Ou poser l'extrait dans son cadre : la meme matrice que l'export, en
// pourcentages (le zoom ne change rien, les pixels suivent le cadre).
function placeExtrait(canvas, e) {
  const s = e.source;
  const m = G.matriceExtrait(e.depart, e);
  const o = G.applique(m, s.x, s.y);
  canvas.style.width = `${((s.l / e.l) * 100).toFixed(5)}%`;
  canvas.style.height = `${((s.h / e.h) * 100).toFixed(5)}%`;
  canvas.style.transform = `translate(${((o.x / s.l) * 100).toFixed(5)}%, ${((o.y / s.h) * 100).toFixed(5)}%) matrix(${m.slice(0, 4).map((v) => v.toFixed(6)).join(",")},0,0)`;
}

// Le contenu d'une image dans son cadre, en pourcentages du cadre.
function placeImage(img, e, src) {
  const c = G.contenuImage(e.l, e.h, src.l, src.h, e.cadrage);
  img.style.left = `${((c.x / e.l) * 100).toFixed(4)}%`;
  img.style.top = `${((c.y / e.h) * 100).toFixed(4)}%`;
  img.style.width = `${((c.l / e.l) * 100).toFixed(4)}%`;
  img.style.height = `${((c.h / e.h) * 100).toFixed(4)}%`;
}

function classesDe(e) {
  const classes = ["ed-el", `is-${e.type}`];
  if (ed.selection.has(e.id)) classes.push("is-choisi");
  if (e.verrou) classes.push("is-verrou");
  if (e.origine === "original") classes.push(e.modifie ? "is-original-modifie" : "is-original");
  if (estExtrait(e)) classes.push("is-extrait");
  if (ed.recadrage === e.id) classes.push("is-recadrage");
  if (ed.apercus.has(e.id)) classes.push("is-envoi");
  return classes.join(" ");
}

// Un element : son noeud est garde d'un rendu a l'autre. Seul ce qui change
// est touche -- deplacer ne fait que bouger le cadre (aucune image refaite,
// rien qui clignote, meme avec beaucoup d'elements).
function majNoeud(n, e) {
  const el = n.el;
  const cls = classesDe(e);
  if (el.className !== cls) el.className = cls;
  let style = placement(e);
  if (e.rotation) style += `;transform:rotate(${e.rotation}deg)`;
  // un element de l'etiquette pas encore touche : on voit l'original
  const intact = e.origine === "original" && !e.modifie;
  const editant = ed.edition === e.id;
  let cle = "";
  if (intact && !editant) {
    cle = "intact";
  } else if (estExtrait(e) && !editant) {
    cle = `x|${ed.versionPage}|${e.source.x},${e.source.y},${e.source.l},${e.source.h}`;
  } else if (e.type === "texte") {
    const aligne = { gauche: "left", centre: "center", droite: "right" }[e.alignement] || "left";
    style += `;--taille:${e.taille};color:${e.couleur};text-align:${aligne};font:${CSS_POLICE[e.police] || CSS_POLICE.Helvetica};font-size:calc(var(--taille) * var(--e) * 1px)`;
    cle = `t|${ed.edition === e.id}|${e.texte}`;
  } else if (e.type === "code") {
    cle = `c|${e.format}|${e.valeur}|${e.couleur}|${etatCode(e)}`;
  } else if (e.type === "image") {
    const src = sourceImage(e);
    cle = `i|${src?.url || ""}|${ed.recadrage === e.id}`;
  } else if (e.type === "rect") {
    style += `;background:${e.fond}`;
    cle = "r";
  }
  if (el.getAttribute("style") !== style) el.setAttribute("style", style);
  if (n.cle !== cle) {
    n.cle = cle;
    if (cle === "intact" || cle === "r") el.innerHTML = "";
    else if (cle.startsWith("x|")) {
      el.innerHTML = '<canvas class="ed-extrait"></canvas>';
      dessineExtrait(el.firstChild, e);
    } else if (cle.startsWith("t|")) {
      el.innerHTML = `<div class="ed-texte"${ed.edition === e.id ? ' contenteditable="true" spellcheck="false"' : ""}>${escapeHtml(e.texte)}</div>`;
    } else if (cle.startsWith("c|")) el.innerHTML = svgCode(e);
    else if (cle.startsWith("i|")) {
      const src = sourceImage(e);
      // en recadrage : l'image entiere, voilee, autour du cadre
      el.innerHTML = src
        ? `${ed.recadrage === e.id ? `<img class="ed-img-fantome" alt="" draggable="false" src="${escapeAttr(src.url)}" />` : ""}<span class="ed-img-cadre"><img class="ed-img" alt="" draggable="false" src="${escapeAttr(src.url)}" /></span>`
        : "";
    }
  }
  if (cle.startsWith("x|")) placeExtrait(el.firstChild, e);
  else if (cle.startsWith("i|")) {
    const src = sourceImage(e);
    if (src) for (const img of el.querySelectorAll("img")) placeImage(img, e, src);
  }
}

function rendElements() {
  const masques = elements()
    .filter((e) => e.origine === "original" && (e.modifie || e.supprime) && e.masque)
    .map((e) => `<div class="ed-masque" style="${placement(e.masque)}"></div>`)
    .join("");
  if (masques !== ed.masquesRendus) {
    $("ed-masques").innerHTML = masques;
    ed.masquesRendus = masques;
  }
  const conteneur = $("ed-elements");
  const vus = new Set();
  let precedent = null;
  for (const e of elements()) {
    if (e.supprime) continue;
    vus.add(e.id);
    let n = ed.noeuds.get(e.id);
    if (!n) {
      n = { el: document.createElement("div"), cle: null };
      n.el.dataset.id = e.id;
      ed.noeuds.set(e.id, n);
    }
    majNoeud(n, e);
    // l'ordre des calques : le premier tout au fond
    const attendu = precedent ? precedent.nextSibling : conteneur.firstChild;
    if (attendu !== n.el) conteneur.insertBefore(n.el, attendu);
    precedent = n.el;
  }
  for (const [id, n] of ed.noeuds) {
    if (!vus.has(id)) {
      n.el.remove();
      ed.noeuds.delete(id);
    }
  }
  if (ed.edition) {
    const champ = document.querySelector(`.ed-el[data-id="${ed.edition}"] .ed-texte`);
    if (champ && document.activeElement !== champ) {
      champ.focus();
      const r = document.createRange();
      r.selectNodeContents(champ);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
  }
  rendSelection();
}

// tout redessiner (une autre page, un autre zoom de la page d'origine)
function oublieNoeuds() {
  for (const n of ed.noeuds.values()) n.el.remove();
  ed.noeuds.clear();
  ed.masquesRendus = "";
  // les codes qui n'avaient pas pu etre dessines sont redemandes
  for (const [cle, c] of ed.codes) if (c?.echec) ed.codes.delete(cle);
}

function boiteDe(liste) {
  if (!liste.length) return null;
  const b = liste.map((e) => G.boite(e));
  const x0 = Math.min(...b.map((e) => e.x));
  const y0 = Math.min(...b.map((e) => e.y));
  const x1 = Math.max(...b.map((e) => e.x + e.l));
  const y1 = Math.max(...b.map((e) => e.y + e.h));
  return { x: x0, y: y0, l: x1 - x0, h: y1 - y0 };
}

// Les poignees d'un element : les extraits (code, texte, image de
// l'etiquette) ne se deforment jamais -- les coins seulement, proportions
// gardees ; une image (cadre) a ses huit poignees, les coins gardent ses
// proportions, les cotes recadrent.
function poigneesDe(e) {
  if (fige(e)) return [];
  if (estExtrait(e)) return ["nw", "ne", "se", "sw"];
  return ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
}

function rendSelection() {
  const s = $("ed-selection");
  const liste = choisis();
  const unSeul = liste.length === 1 ? liste[0] : null;
  const b = unSeul ? { x: unSeul.x, y: unSeul.y, l: unSeul.l, h: unSeul.h } : boiteDe(liste);
  if (!b) {
    s.hidden = true;
    s.dataset.pour = "";
    return;
  }
  const pour = liste.map((e) => e.id).join(",");
  // une nouvelle selection apparait en douceur ; la meme, qui bouge, suit
  if (s.hidden || s.dataset.pour !== pour) {
    s.classList.remove("is-apparition");
    void s.offsetWidth;
    s.classList.add("is-apparition");
  }
  s.dataset.pour = pour;
  s.hidden = false;
  s.setAttribute("style", placement(b) + (unSeul?.rotation ? `;transform:rotate(${unSeul.rotation}deg)` : ""));
  const poignees = unSeul ? poigneesDe(unSeul).map((p) => `<span class="ed-poignee is-${p}" data-poignee="${p}"></span>`).join("") : "";
  const tourne = APP_MAC && unSeul && unSeul.type === "image" && !unSeul.verrou ? '<span class="ed-rotation" data-rotation title="Faire pivoter (Maj : par 15°)"><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg></span>' : "";
  const angle = unSeul?.rotation ? ` · ${Math.round(unSeul.rotation * 10) / 10}°` : "";
  const html = `${tourne}${poignees}<span class="ed-dimensions">${liste.length > 1 ? `${liste.length} éléments · ` : ""}${enMm(b.l)} × ${enMm(b.h)} mm${angle}</span>`;
  if (s.innerHTML !== html) s.innerHTML = html;
  s.classList.toggle("is-verrou", Boolean(unSeul?.verrou));
  s.classList.toggle("is-recadrage", Boolean(unSeul && ed.recadrage === unSeul.id));
}

function rendTout() {
  dimensionne();
  rendOriginaux();
  rendElements();
  rendProprietes();
  rendCalques();
}

// --- Le panneau : proprietes, calques ------------------------------------------------------

function champMm(nom, valeur, etiquette, desactive) {
  return `<label class="ed-champ"><span>${etiquette}</span><input type="number" step="0.1" data-prop="${nom}" value="${enMm(valeur)}"${desactive ? " disabled" : ""} /><em>mm</em></label>`;
}

function blocPosition(e) {
  return `<section class="ed-bloc"><h3>Position et taille</h3><div class="ed-grille-champs">
    ${champMm("x", e.x, "X", e.verrou)}${champMm("y", e.y, "Y", e.verrou)}${champMm("l", e.l, "L", e.verrou)}${champMm("h", e.h, "H", e.verrou)}
  </div>
  <div class="ed-ligne-boutons">
    <button class="ed-petit" type="button" data-action="centrer-h">Centrer horizontalement</button>
    <button class="ed-petit" type="button" data-action="centrer-v">Centrer verticalement</button>
  </div></section>`;
}

function blocActions(e) {
  return `<section class="ed-bloc ed-ligne-boutons">
    <button class="ed-petit" type="button" data-action="verrou">${e.verrou ? "Déverrouiller" : "Verrouiller"}</button>
    <button class="ed-petit" type="button" data-action="devant">Devant</button>
    <button class="ed-petit" type="button" data-action="derriere">Derrière</button>
    <button class="ed-petit" type="button" data-action="dupliquer">Dupliquer</button>
    <button class="ed-petit is-danger" type="button" data-action="supprimer">Supprimer</button>
  </section>`;
}

function rendProprietes() {
  const zone = $("ed-proprietes");
  if (zone.hidden) return;
  const liste = choisis();
  if (!liste.length) {
    const modifs = elements().filter((e) => e.origine === "ajout" || e.modifie || e.supprime).length;
    zone.innerHTML = `
      <section class="ed-bloc"><h3>Page ${ed.page}${ed.nbPages > 1 ? ` sur ${ed.nbPages}` : ""}</h3>
        <p class="ed-valeur-ligne">${enMm(ed.W)} × ${enMm(ed.H)} mm · ${pluriel(modifs, "modification")}</p></section>`;
    return;
  }
  if (liste.length > 1) {
    zone.innerHTML = `
      <section class="ed-bloc"><h3>${liste.length} éléments</h3>
        <div class="ed-aligner">
          ${[["gauche", "Aligner à gauche"], ["centre-h", "Centrer horizontalement"], ["droite", "Aligner à droite"], ["haut", "Aligner en haut"], ["milieu-v", "Centrer verticalement"], ["bas", "Aligner en bas"]]
            .map(([k, t]) => `<button class="ed-petit" type="button" data-aligne="${k}">${t}</button>`)
            .join("")}
          <button class="ed-petit" type="button" data-distribue="h">Répartir horizontalement</button>
          <button class="ed-petit" type="button" data-distribue="v">Répartir verticalement</button>
        </div></section>
      <section class="ed-bloc ed-ligne-boutons">
        <button class="ed-petit" type="button" data-action="dupliquer">Dupliquer</button>
        <button class="ed-petit is-danger" type="button" data-action="supprimer">Supprimer</button>
      </section>`;
    return;
  }
  const e = liste[0];
  const origine = e.origine === "original" && e.modifie ? `<p class="ed-origine"><b>Modifié</b></p>` : "";
  let propres = "";
  if (e.type === "texte") {
    propres = `<section class="ed-bloc"><h3>Texte</h3>
      <textarea class="ed-zone-texte" data-prop="texte" rows="3"${e.verrou ? " disabled" : ""}>${escapeHtml(e.texte)}</textarea>
      <div class="ed-grille-champs">
        <label class="ed-champ is-large"><span>Police</span><select data-prop="police">${POLICES.map(([v, t]) => `<option value="${v}"${e.police === v ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="ed-champ"><span>Taille</span><input type="number" min="2" max="300" step="0.5" data-prop="taille" value="${e.taille}" /><em>pt</em></label>
        <label class="ed-champ ed-champ-couleur"><span>Couleur</span><input type="color" data-prop="couleur" value="${e.couleur}" /></label>
      </div>
      <div class="segmented ed-alignement" role="radiogroup" aria-label="Alignement">
        ${[["gauche", "À gauche"], ["centre", "Centré"], ["droite", "À droite"]].map(([v, t]) => `<button type="button" class="seg${e.alignement === v ? " is-on" : ""}" data-alignement="${v}" role="radio" aria-checked="${e.alignement === v}">${t}</button>`).join("")}
      </div></section>`;
  } else if (e.type === "code") {
    // le code du transporteur : verrouille ; un autre code de l'etiquette
    // (reference, lien de boutique) : modifiable, comme un code ajoute
    const protege = e.origine === "original" && !codeLibre(e);
    const formats = protege ? [e.format] : FORMATS_2D.includes(e.format) ? FORMATS_2D : FORMATS_BARRES;
    propres = `<section class="ed-bloc"><h3>${NOMS_FORMAT[e.format] || e.format}</h3>
      <label class="ed-champ is-large"><span>Format</span><select data-prop="format"${protege ? " disabled" : ""}>${formats.map((f) => `<option value="${f}"${f === e.format ? " selected" : ""}>${NOMS_FORMAT[f]}</option>`).join("")}</select></label>
      <label class="ed-champ is-large ed-champ-valeur"><span>Contenu décodé</span>
        <textarea class="ed-zone-texte ed-mono" data-prop="valeur" rows="2"${e.verrou ? " readonly" : ""}>${escapeHtml(e.valeur)}</textarea></label>
      <p class="ed-message" id="ed-message-code"></p>${
        !protege && e.origine === "original"
          ? `<p class="ed-libre"><span>Code de l'étiquette · pas un numéro de suivi</span>${e.reecrit ? '<button class="ed-petit" type="button" data-action="valeur-origine">Valeur d\'origine</button>' : ""}</p>`
          : ""
      }
      <label class="ed-champ ed-champ-couleur"><span>Couleur</span><input type="color" data-prop="couleur" value="${e.couleur || "#000000"}"${protege ? " disabled" : ""} /></label>
      </section>`;
  } else if (e.type === "image") {
    const src = sourceImage(e);
    const c = G.cadrage(e.cadrage);
    propres = `<section class="ed-bloc ed-bloc-image"><h3>${e.origine === "original" && !e.image ? "Image de l'étiquette" : "Image"}</h3>
      ${
        src
          ? `<div class="ed-vignette"><img alt="" src="${escapeAttr(src.url)}" /><span>${src.l} × ${src.h} px</span></div>`
          : `<p class="ed-aide">${APP_MAC ? "Glisse une image du Finder sur ce cadre pour la remplacer : le cadre reste le même." : "Partie de l'étiquette d'origine."}</p>`
      }
      ${
        APP_MAC
          ? `<div class="ed-ligne-boutons"><button class="ed-petit is-principal" type="button" data-action="remplacer-image">Remplacer…</button>${
              src ? `<button class="ed-petit${ed.recadrage === e.id ? " is-on" : ""}" type="button" data-action="recadrer">${ed.recadrage === e.id ? "Terminer le recadrage" : "Recadrer"}</button>` : ""
            }</div>`
          : ""
      }
      ${
        src && APP_MAC
          ? `<div class="segmented ed-cadrage" role="radiogroup" aria-label="Cadrage">
              ${[["remplir", "Remplir"], ["ajuster", "Ajuster"]].map(([v, t]) => `<button type="button" class="seg${c.mode === v ? " is-on" : ""}" data-cadrage="${v}" role="radio" aria-checked="${c.mode === v}">${t}</button>`).join("")}
            </div>
            <label class="ed-champ is-large ed-curseur"><span>Zoom du contenu</span><input type="range" min="100" max="${G.ZOOM_MAX * 100}" step="1" data-prop="zoom-contenu" value="${Math.round(c.zoom * 100)}" /><b>${Math.round(c.zoom * 100)} %</b></label>
            <div class="ed-ligne-boutons"><button class="ed-petit" type="button" data-action="centrer-contenu">Centrer le contenu</button><button class="ed-petit" type="button" data-action="reinitialiser-cadrage">Réinitialiser</button></div>`
          : ""
      }
      ${
        APP_MAC
          ? `<div class="ed-grille-champs"><label class="ed-champ"><span>Rotation</span><input type="number" step="1" data-prop="rotation" value="${Math.round((e.rotation || 0) * 100) / 100}"${e.verrou ? " disabled" : ""} /><em>°</em></label>
              <button class="ed-petit ed-pivote" type="button" data-action="pivoter"${e.verrou ? " disabled" : ""}>Pivoter de 90°</button></div>`
          : ""
      }
      </section>`;
  } else if (e.type === "rect") {
    propres = `<section class="ed-bloc"><h3>Rectangle</h3>
      <label class="ed-champ ed-champ-couleur"><span>Fond</span><input type="color" data-prop="fond" value="${e.fond}" /></label></section>`;
  }
  zone.innerHTML = `${origine}${propres}${blocPosition(e)}${blocActions(e)}`;
}

function nomElement(e) {
  if (e.type === "texte") return `« ${e.texte.slice(0, 28)}${e.texte.length > 28 ? "…" : ""} »`;
  if (e.type === "code") return `${NOMS_FORMAT[e.format] || e.format} · ${String(e.valeur).slice(0, 18)}`;
  if (e.type === "image") return e.origine === "original" && !e.image ? "Image de l'étiquette" : "Image";
  return "Rectangle";
}

function vignetteCalque(e) {
  if (e.type === "image") {
    const src = sourceImage(e);
    return src ? `<img alt="" src="${escapeAttr(src.url)}" />` : "▣";
  }
  return { texte: "T", code: e.format && FORMATS_2D.includes(e.format) ? "QR" : "|||", rect: "▭" }[e.type] || "?";
}

function rendCalques() {
  const zone = $("ed-calques");
  if (zone.hidden) return;
  const liste = visibles().slice().reverse(); // le premier de la liste = tout devant
  zone.innerHTML = liste.length
    ? `<ul class="ed-calques">${liste
        .map(
          (e) => `<li class="ed-calque-ligne${ed.selection.has(e.id) ? " is-on" : ""}" data-calque="${e.id}">
        <span class="ed-calque-type">${vignetteCalque(e)}</span>
        <span class="ed-calque-nom">${escapeHtml(nomElement(e))}${e.origine === "original" ? `<em>${e.modifie ? "étiquette · modifié" : "étiquette"}</em>` : ""}</span>
        <span class="ed-calque-ordre"><button class="bdx-outil" type="button" data-calque-action="monter" aria-label="Monter d'un cran" title="Monter d'un cran"><svg class="icon"><use href="#i-chevron-down"/></svg></button><button class="bdx-outil" type="button" data-calque-action="descendre" aria-label="Descendre d'un cran" title="Descendre d'un cran"><svg class="icon"><use href="#i-chevron-down"/></svg></button></span>
        <button class="bdx-outil${e.verrou ? " is-on" : ""}" type="button" data-calque-action="verrou" aria-label="${e.verrou ? "Déverrouiller" : "Verrouiller"}"><svg class="icon"><use href="#i-cadenas"/></svg></button>
      </li>`
        )
        .join("")}</ul>`
    : `<p class="ed-aide">Aucun élément.</p>`;
}

// --- Actions -------------------------------------------------------------------------------

function choisit(ids, { ajoute = false } = {}) {
  if (!ajoute) ed.selection.clear();
  for (const id of ids) ed.selection.add(id);
  rendElements();
  rendProprietes();
  rendCalques();
}

// un element d'origine (texte ou code de l'etiquette) devient un element du document
function prendOriginal(cle) {
  const o = ed.originaux.get(ed.page);
  const deja = elements().find((e) => e.cle === cle);
  if (deja) return deja;
  const t = o.textes.find((x) => x.cle === cle);
  const c = o.codes.find((x) => x.cle === cle);
  let e = null;
  const i = (o.images || []).find((x) => x.cle === cle);
  // la zone copiee (source) est celle qu'on masque : ce qui part de sa place
  // est exactement ce qui arrive ailleurs
  if (t) {
    const masque = { x: t.x - 0.8, y: t.y - 0.6, l: t.l + 1.6, h: t.h + 1.2 };
    e = { id: uid(), type: "texte", origine: "original", modifie: false, retape: false, cle, x: t.x, y: t.y, l: t.l, h: t.h, texte: t.texte, taille: t.taille, police: t.police, couleur: "#000000", alignement: "gauche", masque, source: masque, depart: { x: t.x, y: t.y, l: t.l, h: t.h, rotation: 0 } };
  } else if (c) {
    const masque = { x: c.x - 2, y: c.y - 2, l: c.l + 4, h: c.h + 4 };
    e = { id: uid(), type: "code", origine: "original", modifie: false, cle, codeId: c.id, x: c.x, y: c.y, l: c.l, h: c.h, format: c.format, valeur: c.valeur || "", couleur: "#000000", lisible: c.lisible, masque, source: masque, depart: { x: c.x, y: c.y, l: c.l, h: c.h, rotation: 0 } };
  } else if (i) {
    const masque = { x: i.boite.x - 0.5, y: i.boite.y - 0.5, l: i.boite.l + 1, h: i.boite.h + 1 };
    e = { id: uid(), type: "image", origine: "original", modifie: false, cle, x: i.x, y: i.y, l: i.l, h: i.h, rotation: i.rotation, image: null, cadrage: G.cadrage(), masque, source: masque, depart: { x: i.x, y: i.y, l: i.l, h: i.h, rotation: i.rotation } };
  }
  if (e) elements().push(e);
  return e;
}

// un texte grandit avec son contenu (jamais ne retrecit tout seul)
const mesureur = document.createElement("canvas").getContext("2d");
function ajusteTexte(e) {
  if (!e || e.type !== "texte") return;
  mesureur.font = (CSS_POLICE[e.police] || CSS_POLICE.Helvetica).replace("1em", `${e.taille}px`);
  const lignes = String(e.texte).split("\n");
  const largeur = Math.max(...lignes.map((l) => mesureur.measureText(l).width)) + 2;
  const hauteur = lignes.length * e.taille * 1.18 + 1;
  if (largeur > e.l) e.l = largeur;
  if (hauteur > e.h) e.h = hauteur;
}

function marqueModifie(e) {
  if (e.origine === "original") e.modifie = true;
}

// un texte de l'etiquette dont on change le contenu ou le style : il n'est
// plus un extrait, il s'ecrit (dans une police standard)
function marqueRetape(e) {
  if (e.type === "texte" && e.origine === "original") e.retape = true;
  marqueModifie(e);
}

function supprime() {
  const liste = choisis().filter((e) => !e.verrou);
  if (!liste.length) return;
  const page = elements();
  for (const e of liste) {
    if (e.origine === "original") {
      e.supprime = true;
      e.modifie = true;
    } else page.splice(page.indexOf(e), 1);
    ed.selection.delete(e.id);
  }
  engage(liste.length > 1 ? `Supprimer ${liste.length} éléments` : `Supprimer ${nomElement(liste[0])}`);
  rendTout();
}

function duplique() {
  // une image de l'etiquette pas encore remplacee n'est qu'un morceau de la
  // page : elle ne se copie pas (une image deposee, si)
  const liste = choisis().filter((e) => !(e.type === "image" && !e.image));
  if (!liste.length) {
    if (choisis().length) toast("Remplace d'abord cette image pour pouvoir la dupliquer.", "info");
    return;
  }
  const nouveaux = liste.map((e) => {
    const copie = JSON.parse(JSON.stringify(e));
    Object.assign(copie, { id: uid(), origine: "ajout", modifie: true, x: e.x + 8, y: e.y + 8, verrou: false });
    delete copie.cle;
    delete copie.masque;
    delete copie.codeId;
    delete copie.source;
    delete copie.depart;
    delete copie.retape;
    return copie;
  });
  // une copie d'un code de l'etiquette est un code ajoute : le serveur
  // refusera s'il porte un numero de suivi
  elements().push(...nouveaux);
  choisit(nouveaux.map((e) => e.id));
  engage(nouveaux.length > 1 ? `Dupliquer ${nouveaux.length} éléments` : `Dupliquer ${nomElement(nouveaux[0])}`);
  rendTout();
}

function ordre(sens) {
  const page = elements();
  const liste = choisis();
  if (!liste.length) return;
  for (const e of sens === "devant" ? liste.slice().reverse() : liste) {
    page.splice(page.indexOf(e), 1);
    if (sens === "devant") page.push(e);
    else page.unshift(e);
  }
  engage(sens === "devant" ? "Mettre devant" : "Mettre derrière");
  rendTout();
}

function bougeOrdre(id, delta) {
  const page = elements();
  const i = page.findIndex((e) => e.id === id);
  const j = borne(i + delta, 0, page.length - 1);
  if (i < 0 || i === j) return;
  const [e] = page.splice(i, 1);
  page.splice(j, 0, e);
  engage("Changer l'ordre des calques");
  rendTout();
}

function basculeVerrou() {
  const liste = choisis();
  if (!liste.length) return;
  const verrou = !liste.every((e) => e.verrou);
  for (const e of liste) e.verrou = verrou;
  engage(verrou ? "Verrouiller" : "Déverrouiller");
  rendTout();
}

function aligne(sens) {
  const liste = choisis().filter((e) => !e.verrou);
  const b = boiteDe(liste);
  if (!b || liste.length < 2) return;
  for (const e of liste) {
    if (sens === "gauche") e.x = b.x;
    if (sens === "droite") e.x = b.x + b.l - e.l;
    if (sens === "centre-h") e.x = b.x + (b.l - e.l) / 2;
    if (sens === "haut") e.y = b.y;
    if (sens === "bas") e.y = b.y + b.h - e.h;
    if (sens === "milieu-v") e.y = b.y + (b.h - e.h) / 2;
    marqueModifie(e);
  }
  engage("Aligner");
  rendTout();
}

function distribue(axe) {
  const liste = choisis().filter((e) => !e.verrou);
  if (liste.length < 3) return;
  const k = axe === "h" ? "x" : "y";
  const t = axe === "h" ? "l" : "h";
  liste.sort((a, b) => a[k] - b[k]);
  const debut = liste[0][k];
  const fin = liste[liste.length - 1][k] + liste[liste.length - 1][t];
  const occupe = liste.reduce((s, e) => s + e[t], 0);
  const ecart = (fin - debut - occupe) / (liste.length - 1);
  let pos = debut;
  for (const e of liste) {
    e[k] = pos;
    pos += e[t] + ecart;
    marqueModifie(e);
  }
  engage(axe === "h" ? "Répartir horizontalement" : "Répartir verticalement");
  rendTout();
}

function centre(axe) {
  const e = choisis()[0];
  if (!e || e.verrou) return;
  if (axe === "h") e.x = (ed.W - e.l) / 2;
  else e.y = (ed.H - e.h) / 2;
  marqueModifie(e);
  engage(axe === "h" ? "Centrer horizontalement" : "Centrer verticalement");
  rendTout();
}

async function ajoute(type, x, y, l, h) {
  const e = { id: uid(), origine: "ajout", modifie: true, x, y, l, h, verrou: false };
  if (type === "texte") Object.assign(e, { type: "texte", texte: "Texte", taille: 12, police: "Helvetica", couleur: "#000000", alignement: "gauche" });
  if (type === "barres") Object.assign(e, { type: "code", format: "Code128", valeur: "REF-001", couleur: "#000000" });
  if (type === "qr") Object.assign(e, { type: "code", format: "QRCode", valeur: "https://", couleur: "#000000" });
  if (type === "rect") Object.assign(e, { type: "rect", fond: "#ffffff" });
  elements().push(e);
  ed.selection = new Set([e.id]);
  changeOutil("selection");
  engage(`Ajouter ${{ texte: "un texte", barres: "un code-barres", qr: "un QR code", rect: "un rectangle" }[type]}`);
  rendTout();
  if (type === "texte") commenceEdition(e.id);
  else if (e.type === "code") {
    const champ = document.querySelector('#ed-proprietes [data-prop="valeur"]');
    champ?.focus();
    champ?.select();
  }
}

// --- Edition directe d'un texte (double-clic) ---------------------------------------------

function commenceEdition(id) {
  const e = element(id);
  if (!e || e.type !== "texte" || e.verrou) return;
  ed.edition = id;
  rendElements();
}

function finEdition(garder = true) {
  if (!ed.edition) return;
  const id = ed.edition;
  const champ = document.querySelector(`.ed-el[data-id="${id}"] .ed-texte`);
  ed.edition = null;
  const e = element(id);
  if (garder && e && champ) {
    const texte = champ.innerText.replace(/\n$/, "");
    if (texte !== e.texte) {
      e.texte = texte;
      ajusteTexte(e);
      marqueRetape(e);
      engage(`Modifier le texte ${nomElement(e)}`);
    }
  }
  rendTout();
}

// --- Gestes : selection, deplacement, redimensionnement, lasso, vue ------------------------

function pointPage(evt) {
  const r = $("ed-feuille").getBoundingClientRect();
  return { x: ((evt.clientX - r.left) / r.width) * ed.W, y: ((evt.clientY - r.top) / r.height) * ed.H };
}

// Les lignes ou s'aimanter : bords et centre de la page, bords et centres des autres elements.
function lignesAimant(exclus) {
  const xs = [0, ed.W / 2, ed.W];
  const ys = [0, ed.H / 2, ed.H];
  for (const e of visibles()) {
    if (exclus.has(e.id)) continue;
    const b = G.boite(e);
    xs.push(b.x, b.x + b.l / 2, b.x + b.l);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

function aimante(valeurs, lignes, seuil) {
  let meilleur = null;
  for (const v of valeurs) {
    for (const l of lignes) {
      const d = l - v;
      if (Math.abs(d) <= seuil && (!meilleur || Math.abs(d) < Math.abs(meilleur.d))) meilleur = { d, ligne: l };
    }
  }
  return meilleur;
}

function grilleDe(v) {
  return ed.grille ? Math.round(v / GRILLE_PT) * GRILLE_PT : v;
}

// les guides ne se redessinent que s'ils changent (sinon leur apparition
// en fondu repartirait a chaque mouvement de la souris)
let guidesMontres = "";
function montreGuides(gx, gy) {
  const cle = `${gx}|${gy}`;
  if (cle === guidesMontres) return;
  guidesMontres = cle;
  $("ed-guides").innerHTML = [
    ...(gx != null ? [`<span class="ed-guide is-v" style="left:${pc(gx, ed.W)}"></span>`] : []),
    ...(gy != null ? [`<span class="ed-guide is-h" style="top:${pc(gy, ed.H)}"></span>`] : []),
  ].join("");
}

const zone = $("ed-zone");
const scene = $("ed-scene");
let espace = false;

scene.addEventListener("pointerdown", (evt) => {
  if (evt.button === 1 || (evt.button === 0 && (ed.outil === "main" || espace))) {
    commencePanoramique(evt);
    return;
  }
  if (evt.button !== 0) return;
  if (ed.edition && evt.target.closest(`.ed-el[data-id="${ed.edition}"]`)) return;
  if (ed.edition) finEdition(true);
  const feuille = $("ed-feuille");
  if (!feuille.contains(evt.target)) {
    if (evt.pointerType === "touch") commencePanoramique(evt);
    else if (!evt.shiftKey) choisit([]);
    return;
  }
  const p = pointPage(evt);
  if (["texte", "barres", "qr", "rect"].includes(ed.outil)) {
    commenceCreation(evt, p);
    return;
  }
  // le recadrage d'une image : glisser deplace son contenu dans le cadre
  if (ed.recadrage) {
    const r = element(ed.recadrage);
    if (r && evt.target.closest(`.ed-el[data-id="${r.id}"]`)) {
      if (doubleClic(evt, r.id)) return finRecadrage();
      capture(evt, { type: "recadre", e: r, depart: p, avant: G.cadrage(r.cadrage), bouge: false });
      return;
    }
    finRecadrage();
  }
  if (evt.target.closest("[data-rotation]")) {
    commenceRotation(evt, p);
    return;
  }
  const poignee = evt.target.closest("[data-poignee]");
  if (poignee) {
    commenceRedimension(evt, poignee.dataset.poignee, p);
    return;
  }
  let cible = evt.target.closest(".ed-el");
  const original = !cible && evt.target.closest("[data-original]");
  if (original) {
    const e = prendOriginal(original.dataset.original);
    if (e) {
      rendOriginaux();
      rendElements();
      cible = document.querySelector(`.ed-el[data-id="${e.id}"]`);
    }
  }
  if (cible) {
    const id = cible.dataset.id;
    // le double-clic, reconnu ici : le geste capture le pointeur, et WebKit
    // envoie alors « dblclick » a la scene, pas a l'element
    if (doubleClic(evt, id)) {
      ouvreElement(id);
      return;
    }
    if (evt.shiftKey || evt.metaKey || evt.ctrlKey) {
      if (ed.selection.has(id)) ed.selection.delete(id);
      else ed.selection.add(id);
      choisit([...ed.selection]);
      return;
    }
    if (!ed.selection.has(id)) choisit([id]);
    commenceDeplacement(evt, p);
    return;
  }
  // la page vide : un lasso (ou, au doigt, deplacer la vue)
  if (evt.pointerType === "touch") {
    commencePanoramique(evt);
    return;
  }
  commenceLasso(evt, p, evt.shiftKey);
});

function capture(evt, geste) {
  ed.geste = { ...geste, pointeur: evt.pointerId };
  scene.setPointerCapture(evt.pointerId);
}

// un code de l'etiquette qui n'a pas pu etre lu ne se redessine pas : il se
// masque (supprimer), il ne se deplace pas
// (un extrait, lui, se deplace tel quel, meme illisible)
const fige = (e) => e.verrou || (e.type === "code" && e.origine === "original" && !e.valeur && !e.source);

function commenceDeplacement(evt, p) {
  const liste = choisis().filter((e) => !fige(e));
  if (!liste.length) return;
  capture(evt, { type: "deplace", depart: p, avant: liste.map((e) => ({ e, x: e.x, y: e.y })), bouge: false });
}

function commenceRedimension(evt, poignee, p) {
  const e = choisis()[0];
  if (!e || fige(e)) return;
  const carre = e.type === "code" && FORMATS_2D.includes(e.format) && e.format !== "PDF417";
  capture(evt, { type: "redimensionne", poignee, depart: p, e, avant: { x: e.x, y: e.y, l: e.l, h: e.h, rotation: e.rotation || 0 }, carre, bouge: false });
}

function commenceRotation(evt, p) {
  const e = choisis()[0];
  if (!e || e.verrou) return;
  const c = { x: e.x + e.l / 2, y: e.y + e.h / 2 };
  capture(evt, { type: "tourne", e, centre: c, a0: Math.atan2(p.y - c.y, p.x - c.x), avant: e.rotation || 0, bouge: false });
}

// des que le geste part vraiment, un element de l'etiquette devient un
// extrait : ses pixels suivent le cadre pendant le geste (et non apres)
function detache(liste) {
  let change = false;
  for (const e of liste) {
    if (e.origine === "original" && !e.modifie) {
      marqueModifie(e);
      change = true;
    }
  }
  if (change) rendOriginaux();
}

function commenceLasso(evt, p, ajoute) {
  capture(evt, { type: "lasso", depart: p, ajoute, deja: new Set(ed.selection) });
}

function commencePanoramique(evt) {
  capture(evt, { type: "vue", x: evt.clientX, y: evt.clientY, sl: scene.scrollLeft, st: scene.scrollTop });
  scene.classList.add("is-vue");
}

function commenceCreation(evt, p) {
  capture(evt, { type: "cree", outil: ed.outil, depart: p, courant: p });
}

const pointeurs = new Map(); // gestes a deux doigts : pincer pour zoomer
scene.addEventListener("pointerdown", (evt) => {
  if (evt.pointerType !== "touch") return;
  pointeurs.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
  if (pointeurs.size === 2) {
    const [a, b] = [...pointeurs.values()];
    ed.pincement = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: ed.zoom };
    ed.geste = null;
  }
});

scene.addEventListener("pointermove", (evt) => {
  if (evt.pointerType === "touch" && pointeurs.has(evt.pointerId)) {
    pointeurs.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    if (ed.pincement && pointeurs.size === 2) {
      const [a, b] = [...pointeurs.values()];
      zoomeA(ed.pincement.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / ed.pincement.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
  }
  const g = ed.geste;
  if (!g || g.pointeur !== evt.pointerId) return;
  if (g.type === "vue") {
    scene.scrollLeft = g.sl - (evt.clientX - g.x);
    scene.scrollTop = g.st - (evt.clientY - g.y);
    return;
  }
  const p = pointPage(evt);
  const seuil = 5 / echelle();
  if (g.type === "deplace") {
    let dx = p.x - g.depart.x;
    let dy = p.y - g.depart.y;
    if (!g.bouge && Math.hypot(dx, dy) * echelle() < 3) return;
    if (!g.bouge) detache(g.avant.map((a) => a.e));
    g.bouge = true;
    // Maj : seulement a l'horizontale ou a la verticale
    if (evt.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const b0 = boiteDe(g.avant.map((a) => ({ x: a.x, y: a.y, l: a.e.l, h: a.e.h, rotation: a.e.rotation })));
    let gx = null;
    let gy = null;
    if (ed.magnetisme && !evt.altKey) {
      const lignes = lignesAimant(new Set(g.avant.map((a) => a.e.id)));
      const ax = aimante([b0.x + dx, b0.x + dx + b0.l / 2, b0.x + dx + b0.l], lignes.xs, seuil);
      const ay = aimante([b0.y + dy, b0.y + dy + b0.h / 2, b0.y + dy + b0.h], lignes.ys, seuil);
      if (ax) {
        dx += ax.d;
        gx = ax.ligne;
      }
      if (ay) {
        dy += ay.d;
        gy = ay.ligne;
      }
    }
    if (ed.grille && gx == null) dx = grilleDe(b0.x + dx) - b0.x;
    if (ed.grille && gy == null) dy = grilleDe(b0.y + dy) - b0.y;
    for (const a of g.avant) {
      a.e.x = a.x + dx;
      a.e.y = a.y + dy;
    }
    montreGuides(gx, gy);
    rendElements();
    return;
  }
  if (g.type === "redimensionne") {
    const { e, avant, poignee } = g;
    if (!g.bouge) detache([e]);
    g.bouge = true;
    // le geste dans les axes de l'element (s'il est tourne)
    const r = G.rotation(-avant.rotation);
    const d = G.applique(r, p.x - g.depart.x, p.y - g.depart.y);
    let x0 = 0;
    let y0 = 0;
    let l = avant.l;
    let h = avant.h;
    if (poignee.includes("e")) l = avant.l + d.x;
    if (poignee.includes("s")) h = avant.h + d.y;
    if (poignee.includes("w")) {
      x0 = d.x;
      l = avant.l - d.x;
    }
    if (poignee.includes("n")) {
      y0 = d.y;
      h = avant.h - d.y;
    }
    // proportions gardees : un QR code, un extrait de l'etiquette (jamais
    // deforme), les coins d'une image ; Maj garde celles de tout element
    const coin = poignee.length === 2;
    const garde = g.carre || estExtrait(e) || (e.type === "image" && coin ? !evt.shiftKey : evt.shiftKey);
    if (garde) {
      const ratio = avant.l / avant.h;
      if (poignee === "n" || poignee === "s") l = h * ratio;
      else if (poignee === "e" || poignee === "w") h = l / ratio;
      else if (Math.abs(l / avant.l) > Math.abs(h / avant.h)) h = l / ratio;
      else l = h * ratio;
      if (poignee.includes("w")) x0 = avant.l - l;
      if (poignee.includes("n")) y0 = avant.h - h;
      if (poignee === "n" || poignee === "s") x0 = (avant.l - l) / 2;
      if (poignee === "e" || poignee === "w") y0 = (avant.h - h) / 2;
    }
    const min = 2;
    if (l < min) {
      if (poignee.includes("w")) x0 -= min - l;
      l = min;
    }
    if (h < min) {
      if (poignee.includes("n")) y0 -= min - h;
      h = min;
    }
    // le nouveau centre, ramene sur la page
    const dc = G.applique(G.rotation(avant.rotation), x0 + l / 2 - avant.l / 2, y0 + h / 2 - avant.h / 2);
    const cx = avant.x + avant.l / 2 + dc.x;
    const cy = avant.y + avant.h / 2 + dc.y;
    e.l = l;
    e.h = h;
    e.x = cx - l / 2;
    e.y = cy - h / 2;
    if (ed.grille && !avant.rotation && !garde) {
      if (poignee.includes("e")) e.l = Math.max(min, grilleDe(e.x + e.l) - e.x);
      if (poignee.includes("s")) e.h = Math.max(min, grilleDe(e.y + e.h) - e.y);
    }
    if (e.type === "image") e.cadrage = cadrageBorne(e, e.cadrage);
    rendElements();
    return;
  }
  if (g.type === "tourne") {
    const { e, centre } = g;
    if (!g.bouge) detache([e]);
    g.bouge = true;
    let a = g.avant + ((Math.atan2(p.y - centre.y, p.x - centre.x) - g.a0) * 180) / Math.PI;
    // Maj : par 15° ; sinon, les angles droits attirent a 3° pres
    if (evt.shiftKey) a = Math.round(a / 15) * 15;
    else {
      const droit = Math.round(a / 90) * 90;
      if (Math.abs(a - droit) < 3) a = droit;
    }
    e.rotation = G.angle(a);
    rendElements();
    return;
  }
  if (g.type === "recadre") {
    const { e } = g;
    const src = sourceImage(e);
    if (!src) return;
    const d = G.applique(G.rotation(-(e.rotation || 0)), p.x - g.depart.x, p.y - g.depart.y);
    if (!g.bouge && Math.hypot(d.x, d.y) * echelle() < 2) return;
    g.bouge = true;
    e.cadrage = cadrageBorne(e, { ...g.avant, dx: g.avant.dx + d.x / e.l, dy: g.avant.dy + d.y / e.h });
    rendElements();
    return;
  }
  if (g.type === "lasso") {
    const b = { x: Math.min(g.depart.x, p.x), y: Math.min(g.depart.y, p.y), l: Math.abs(p.x - g.depart.x), h: Math.abs(p.y - g.depart.y) };
    const l = $("ed-lasso");
    l.hidden = false;
    l.setAttribute("style", placement(b));
    const dedans = visibles()
      .filter((e) => {
        const r = G.boite(e);
        return r.x < b.x + b.l && r.x + r.l > b.x && r.y < b.y + b.h && r.y + r.h > b.y;
      })
      .map((e) => e.id);
    ed.selection = new Set([...(g.ajoute ? g.deja : []), ...dedans]);
    rendElements();
    return;
  }
  if (g.type === "cree") {
    g.courant = p;
    const b = { x: Math.min(g.depart.x, p.x), y: Math.min(g.depart.y, p.y), l: Math.abs(p.x - g.depart.x), h: Math.abs(p.y - g.depart.y) };
    const l = $("ed-lasso");
    l.hidden = false;
    l.classList.add("is-creation");
    l.setAttribute("style", placement(b));
  }
});

function finGeste(evt) {
  if (evt.pointerType === "touch") {
    pointeurs.delete(evt.pointerId);
    if (pointeurs.size < 2) ed.pincement = null;
  }
  const g = ed.geste;
  if (!g || g.pointeur !== evt.pointerId) return;
  ed.geste = null;
  scene.classList.remove("is-vue");
  $("ed-lasso").hidden = true;
  $("ed-lasso").classList.remove("is-creation");
  montreGuides(null, null);
  if (g.type === "deplace" && g.bouge) {
    g.avant.forEach((a) => marqueModifie(a.e));
    engage(g.avant.length > 1 ? `Déplacer ${g.avant.length} éléments` : `Déplacer ${nomElement(g.avant[0].e)}`);
    rendTout();
  } else if (g.type === "redimensionne" && g.bouge) {
    marqueModifie(g.e);
    engage(`Redimensionner ${nomElement(g.e)}`);
    rendTout();
  } else if (g.type === "tourne" && g.bouge) {
    engage(`Faire pivoter ${nomElement(g.e)}`);
    rendTout();
  } else if (g.type === "recadre" && g.bouge) {
    marqueModifie(g.e);
    engage("Recadrer l'image");
    rendProprietes();
  } else if (g.type === "lasso") {
    rendProprietes();
    rendCalques();
  } else if (g.type === "cree") {
    const p = g.courant;
    let b = { x: Math.min(g.depart.x, p.x), y: Math.min(g.depart.y, p.y), l: Math.abs(p.x - g.depart.x), h: Math.abs(p.y - g.depart.y) };
    // un simple clic : une taille par defaut
    if (b.l * echelle() < 8 || b.h * echelle() < 8) {
      const defaut = { texte: [110, 18], barres: [150, 50], qr: [70, 70], rect: [80, 40] }[g.outil];
      b = { x: g.depart.x, y: g.depart.y, l: defaut[0], h: defaut[1] };
    }
    if (g.outil === "qr") b.h = b.l = Math.max(b.l, b.h);
    ajoute(g.outil, b.x, b.y, b.l, b.h);
  }
}
scene.addEventListener("pointerup", finGeste);
scene.addEventListener("pointercancel", finGeste);

// Deux appuis sur le meme element, vite et au meme endroit.
let dernierAppui = null;
function doubleClic(evt, id) {
  const t = performance.now();
  const double = dernierAppui && dernierAppui.id === id && t - dernierAppui.t < 450 && Math.hypot(evt.clientX - dernierAppui.x, evt.clientY - dernierAppui.y) < 6;
  dernierAppui = double ? null : { id, t, x: evt.clientX, y: evt.clientY };
  return double;
}

// le double-clic : un texte s'edite, une image se recadre (app Mac)
function ouvreElement(id) {
  const e = element(id);
  if (!e) return;
  if (e.type === "texte") commenceEdition(id);
  else if (e.type === "image" && APP_MAC) entreRecadrage(id);
}

// le texte edite directement : Entree valide (Maj + Entree : nouvelle ligne), Echap annule
$("ed-elements").addEventListener("keydown", (evt) => {
  if (!evt.target.closest(".ed-texte")) return;
  evt.stopPropagation();
  if (evt.key === "Enter" && !evt.shiftKey) {
    evt.preventDefault();
    finEdition(true);
  } else if (evt.key === "Escape") {
    evt.preventDefault();
    finEdition(false);
  }
});

// --- Images : deposer, remplacer, recadrer (app Mac) ---------------------------------------
// Une image deposee depuis le Finder sur un cadre d'image en remplace le
// CONTENU : le cadre (position, taille, rotation, masque, rang dans les
// calques) ne bouge pas. Deposee ailleurs, elle s'ajoute. Le contenu remplit
// son cadre sans etre etire (ou s'y ajuste, au choix), se deplace et se
// zoome a l'interieur (double-clic : recadrer). Tout passe par l'historique.

function cadrageBorne(e, c) {
  const src = sourceImage(e);
  return src ? G.bornePosition(e.l, e.h, src.l, src.h, c) : G.cadrage(c);
}

function entreRecadrage(id) {
  const e = element(id);
  if (!e || e.type !== "image" || !sourceImage(e) || e.verrou) return;
  ed.recadrage = id;
  ed.selection = new Set([id]);
  rendElements();
  rendProprietes();
}

function finRecadrage() {
  if (!ed.recadrage) return;
  ed.recadrage = null;
  rendElements();
  rendProprietes();
}

// L'orientation EXIF d'un JPEG (1 = droite) : le PDF ne l'applique pas, la
// photo est donc redressee avant l'envoi (ce qu'on voit = ce qu'on exporte).
function orientationExif(octets) {
  const v = new DataView(octets);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let i = 2;
  while (i + 4 < v.byteLength && v.getUint8(i) === 0xff) {
    const marqueur = v.getUint8(i + 1);
    const longueur = v.getUint16(i + 2);
    if (marqueur === 0xe1 && v.getUint32(i + 4) === 0x45786966) {
      const t = i + 10;
      const le = v.getUint16(t) === 0x4949;
      const ifd = t + v.getUint32(t + 4, le);
      if (ifd + 2 > v.byteLength) return 1;
      const n = v.getUint16(ifd, le);
      for (let k = 0; k < n; k += 1) {
        const entree = ifd + 2 + k * 12;
        if (entree + 12 > v.byteLength) break;
        if (v.getUint16(entree, le) === 0x0112) return v.getUint16(entree + 8, le);
      }
      return 1;
    }
    if (marqueur === 0xda) break;
    i += 2 + longueur;
  }
  return 1;
}

const COTE_MAX = 6000;
// le serveur n'en prend pas plus (un PNG se decompresse en entier pour le
// PDF : 16 Mpx, c'est deja sept fois une etiquette 10 x 15 a 300 dpi)
const PIXELS_MAX = 16e6;

// Une image prete (ses dimensions connues). decode() seul peut ne jamais
// repondre quand la page n'est pas a l'ecran : le chargement suffit aussi.
function imagePrete(img) {
  return new Promise((resolve, reject) => {
    if (img.complete && img.naturalWidth) return resolve();
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => reject(new Error("image illisible")), { once: true });
    img.decode?.().then(resolve, () => {});
  });
}

// Le fichier depose -> { blob, l, h, url } pret a envoyer : PNG et JPEG droits
// partent tels quels (qualite intacte) ; le reste (HEIC, WebP, GIF, photo
// tournee par EXIF, image geante) est redessine une fois, droit.
async function prepareImage(fichier, { forcer = false } = {}) {
  const octets = await fichier.arrayBuffer();
  const url = URL.createObjectURL(new Blob([octets], { type: fichier.type || "application/octet-stream" }));
  const img = new Image();
  img.src = url;
  try {
    await imagePrete(img);
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Ce fichier n'est pas une image lisible.");
  }
  const l = img.naturalWidth;
  const h = img.naturalHeight;
  const type = fichier.type === "image/png" || fichier.type === "image/jpeg" ? fichier.type : null;
  const droit = type !== "image/jpeg" || orientationExif(octets) === 1;
  if (!forcer && type && droit && Math.max(l, h) <= COTE_MAX && l * h <= PIXELS_MAX && octets.byteLength <= 14 * 1024 * 1024) {
    return { blob: new Blob([octets], { type }), l, h, url };
  }
  const k = Math.min(1, COTE_MAX / Math.max(l, h), Math.sqrt(PIXELS_MAX / (l * h)) * 0.999);
  const toile = document.createElement("canvas");
  toile.width = Math.max(1, Math.round(l * k));
  toile.height = Math.max(1, Math.round(h * k));
  toile.getContext("2d").drawImage(img, 0, 0, toile.width, toile.height);
  const sortie = type === "image/jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise((r) => toile.toBlob(r, sortie, 0.95));
  URL.revokeObjectURL(url);
  return { blob, l: toile.width, h: toile.height, url: URL.createObjectURL(blob) };
}

async function envoieImage(prepa, fichier) {
  const res = await fetch(`/api/bordereaux/${ed.colisId}/images`, { method: "POST", headers: { "Content-Type": prepa.blob.type }, body: prepa.blob });
  const corps = await res.json().catch(() => ({}));
  if (res.ok) return corps;
  // un format que le serveur ne prend pas tel quel : redessinee, une fois
  if (corps.reencoder && fichier && !prepa.redessinee) {
    const autre = await prepareImage(fichier, { forcer: true });
    autre.redessinee = true;
    Object.assign(prepa, autre);
    return envoieImage(prepa, null);
  }
  const err = new Error(corps.error || `Envoi impossible (${res.status})`);
  err.transporteur = corps.transporteur;
  throw err;
}

// Pendant un envoi, le document peut changer : une page quittee, une
// annulation (le modele est alors une copie de l'historique, sans l'objet
// de depart). L'element se retrouve donc par son id, dans SA page.
const dansPage = (page, id) => pageModele(page).elements.find((x) => x.id === id) || null;
function retireDePage(page, id) {
  const liste = pageModele(page).elements;
  const i = liste.findIndex((x) => x.id === id);
  if (i >= 0) liste.splice(i, 1);
}

// Remplace le contenu d'un cadre d'image (ou d'une image de l'etiquette) :
// montre tout de suite, envoie, puis une seule etape d'historique.
async function remplaceImage(cible, fichier) {
  const page = ed.page;
  let e = cible.id ? element(cible.id) : null;
  let prise = false;
  if (!e && cible.cle) {
    e = prendOriginal(cible.cle);
    prise = true;
  }
  if (!e || e.type !== "image" || e.verrou) return;
  let prepa;
  try {
    prepa = await prepareImage(fichier);
  } catch (err) {
    if (prise) retireDePage(page, e.id);
    toast(err.message, "error");
    return;
  }
  finRecadrage();
  ed.selection = new Set([e.id]);
  ed.apercus.set(e.id, { url: prepa.url, l: prepa.l, h: prepa.h });
  const avant = { cadrage: e.cadrage, modifie: e.modifie };
  // le nouveau contenu remplit le cadre, centre (le mode choisi reste)
  e.cadrage = G.cadrage({ mode: G.cadrage(e.cadrage).mode });
  marqueModifie(e);
  rendTout();
  try {
    const r = await envoieImage(prepa, fichier);
    ed.urls.set(r.ref, prepa.url);
    ed.apercus.delete(e.id);
    let actuel = dansPage(page, e.id);
    // une image de l'etiquette prise pour l'occasion, retiree par une
    // annulation pendant l'envoi : elle revient (le depot reste voulu)
    if (!actuel && prise) {
      pageModele(page).elements.push(e);
      actuel = e;
    }
    // un cadre supprime entre-temps : rien a remplir
    if (!actuel) return rendTout();
    actuel.image = { ref: r.ref, l: r.l, h: r.h };
    actuel.cadrage = G.cadrage({ mode: G.cadrage(actuel.cadrage).mode });
    marqueModifie(actuel);
    engage(prise || !avant.modifie ? "Remplacer une image de l'étiquette" : "Remplacer l'image");
    rendTout();
    flash(e.id);
  } catch (err) {
    ed.apercus.delete(e.id);
    URL.revokeObjectURL(prepa.url);
    if (prise) retireDePage(page, e.id);
    else if (dansPage(page, e.id) === e) Object.assign(e, avant);
    rendTout();
    refusImage(err);
  }
}

function refusImage(err) {
  if (err.transporteur?.page) {
    bandeau(`${escapeHtml(err.message)} <a href="${escapeAttr(err.transporteur.page)}" target="_blank" rel="noopener noreferrer">Site ${escapeHtml(err.transporteur.nom)}</a>`, "erreur");
  }
  toast(err.message, "error");
}

// Une nouvelle image, posee a `point` (sinon au centre de la page) : sa
// taille naturelle si elle tient, sinon reduite pour tenir dans la page.
async function ajouteImage(fichier, point = null) {
  let prepa;
  try {
    prepa = await prepareImage(fichier);
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  const ratio = prepa.l / prepa.h;
  let l = Math.min(prepa.l * 0.75, ed.W * 0.5);
  let h = l / ratio;
  if (h > ed.H * 0.5) {
    h = ed.H * 0.5;
    l = h * ratio;
  }
  const c = point || { x: ed.W / 2, y: ed.H / 2 };
  const page = ed.page;
  const e = { id: uid(), type: "image", origine: "ajout", modifie: true, x: c.x - l / 2, y: c.y - h / 2, l, h, rotation: 0, image: null, cadrage: G.cadrage(), verrou: false };
  elements().push(e);
  ed.apercus.set(e.id, { url: prepa.url, l: prepa.l, h: prepa.h });
  ed.selection = new Set([e.id]);
  changeOutil("selection");
  rendTout();
  try {
    const r = await envoieImage(prepa, fichier);
    ed.urls.set(r.ref, prepa.url);
    e.image = { ref: r.ref, l: r.l, h: r.h };
    ed.apercus.delete(e.id);
    // une annulation pendant l'envoi a repris un document sans elle : l'image
    // deposee reste voulue, elle s'ajoute a ce document-la
    if (!dansPage(page, e.id)) pageModele(page).elements.push(e);
    engage("Ajouter une image");
    rendTout();
    flash(e.id);
  } catch (err) {
    ed.apercus.delete(e.id);
    URL.revokeObjectURL(prepa.url);
    retireDePage(page, e.id);
    ed.selection.delete(e.id);
    rendTout();
    refusImage(err);
  }
}

// un petit eclat sur l'element qui vient de changer
function flash(id) {
  const n = ed.noeuds.get(id);
  if (!n) return;
  n.el.classList.remove("is-flash");
  void n.el.offsetWidth;
  n.el.classList.add("is-flash");
}

// Le cadre d'image sous le pointeur : un element (pas verrouille) ou une
// image de l'etiquette pas encore prise.
function cadreSous(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const n = el.closest?.(".ed-el.is-image");
    if (n) {
      const e = element(n.dataset.id);
      if (e && !e.verrou) return { id: e.id, el: n };
    }
    const o = el.closest?.(".ed-original.is-image");
    if (o) return { cle: o.dataset.original, el: o };
  }
  return null;
}

const fichiersDe = (dt) => [...(dt?.files || [])].filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|heic|heif|webp|gif|tiff?|bmp)$/i.test(f.name));
const porteFichiers = (dt) => [...(dt?.types || [])].includes("Files");

let survolDepot = null;
function marqueDepot(cible, surPage) {
  if (survolDepot?.el !== cible?.el) {
    survolDepot?.el.classList.remove("is-cible-depot");
    cible?.el.classList.add("is-cible-depot");
  }
  survolDepot = cible;
  $("ed-feuille").classList.toggle("is-depot", Boolean(!cible && surPage));
  const etiquette = $("ed-depot-etiquette");
  if (!etiquette) return;
  if (cible) {
    const r = cible.el.getBoundingClientRect();
    etiquette.textContent = "Remplacer l'image";
    etiquette.style.left = `${r.left + r.width / 2}px`;
    etiquette.style.top = `${r.top}px`;
    etiquette.hidden = false;
  } else if (surPage) {
    const r = $("ed-feuille").getBoundingClientRect();
    etiquette.textContent = "Ajouter l'image";
    etiquette.style.left = `${r.left + r.width / 2}px`;
    etiquette.style.top = `${r.top}px`;
    etiquette.hidden = false;
  } else etiquette.hidden = true;
}

if (APP_MAC) {
  // jamais la page ouverte a la place de l'editeur quand on lache un fichier
  document.addEventListener("dragover", (evt) => {
    if (!porteFichiers(evt.dataTransfer)) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "copy";
    if (!ed.W) return;
    const cible = cadreSous(evt.clientX, evt.clientY);
    marqueDepot(cible, $("ed-feuille").contains(document.elementFromPoint(evt.clientX, evt.clientY)));
  });
  document.addEventListener("dragleave", (evt) => {
    if (!evt.relatedTarget || !document.documentElement.contains(evt.relatedTarget)) marqueDepot(null, false);
  });
  document.addEventListener("drop", (evt) => {
    if (!porteFichiers(evt.dataTransfer)) return;
    evt.preventDefault();
    const fichier = fichiersDe(evt.dataTransfer)[0];
    const cible = ed.W ? cadreSous(evt.clientX, evt.clientY) : null;
    const surPage = $("ed-feuille").contains(document.elementFromPoint(evt.clientX, evt.clientY));
    marqueDepot(null, false);
    if (!ed.W) return;
    if (!fichier) {
      toast("Dépose une image (PNG, JPEG, HEIC…).", "info");
      return;
    }
    if (cible) remplaceImage(cible, fichier);
    else ajouteImage(fichier, surPage ? pointPage(evt) : null);
  });
  // coller une image : elle remplace l'image choisie, sinon elle s'ajoute
  document.addEventListener("paste", (evt) => {
    if (evt.target.closest?.("input, textarea, [contenteditable]")) return;
    const fichier = fichiersDe(evt.clipboardData)[0];
    if (!fichier || !ed.W) return;
    evt.preventDefault();
    const e = choisis().length === 1 ? choisis()[0] : null;
    if (e && e.type === "image" && !e.verrou) remplaceImage({ id: e.id }, fichier);
    else ajouteImage(fichier);
  });
}

// « Ajouter une image… », « Remplacer… » : le choix d'un fichier
function choisitFichier(quand) {
  const champ = document.createElement("input");
  champ.type = "file";
  champ.accept = "image/*";
  champ.addEventListener("change", () => {
    if (champ.files[0]) quand(champ.files[0]);
  });
  champ.click();
}

// Recadrer : la molette (ou le pincement) zoome le contenu sous le pointeur
let minuteurZoomContenu = null;
function zoomeContenu(e, facteur, cx, cy) {
  const src = e && sourceImage(e);
  if (!src || !ed.noeuds.has(e.id)) return;
  const avant = G.cadrage(e.cadrage);
  const zoom = borne(avant.zoom * facteur, 1, G.ZOOM_MAX);
  if (zoom === avant.zoom) return;
  // le point du contenu sous le pointeur y reste
  const n = ed.noeuds.get(e.id);
  const r = n.el.getBoundingClientRect();
  const centreEcran = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const k = 1 / echelle();
  const u = G.applique(G.rotation(-(e.rotation || 0)), (cx - centreEcran.x) * k, (cy - centreEcran.y) * k);
  const pt = { x: u.x + e.l / 2, y: u.y + e.h / 2 };
  const c0 = G.contenuImage(e.l, e.h, src.l, src.h, avant);
  const rel = { x: (pt.x - c0.x) / c0.l, y: (pt.y - c0.y) / c0.h };
  const c1 = G.contenuImage(e.l, e.h, src.l, src.h, { ...avant, zoom, dx: 0, dy: 0 });
  const centre = { x: pt.x - rel.x * c1.l + c1.l / 2, y: pt.y - rel.y * c1.h + c1.h / 2 };
  e.cadrage = cadrageBorne(e, { ...avant, zoom, dx: (centre.x - e.l / 2) / e.l, dy: (centre.y - e.h / 2) / e.h });
  marqueModifie(e);
  rendElements();
  const curseur = document.querySelector('#ed-proprietes [data-prop="zoom-contenu"]');
  if (curseur) {
    curseur.value = String(Math.round(zoom * 100));
    curseur.nextElementSibling.textContent = `${Math.round(zoom * 100)} %`;
  }
  clearTimeout(minuteurZoomContenu);
  minuteurZoomContenu = setTimeout(() => engage("Zoom du contenu"), 500);
}

// --- Menu contextuel (app Mac) ------------------------------------------------------------------

function fermeMenu() {
  const m = $("ed-menu");
  if (m && !m.hidden) {
    m.classList.add("is-sortie");
    setTimeout(() => {
      m.hidden = true;
      m.classList.remove("is-sortie");
    }, 120);
  }
}

function ouvreMenu(x, y) {
  const m = $("ed-menu");
  const liste = choisis();
  const un = liste.length === 1 ? liste[0] : null;
  const raccourci = (k) => `<kbd>${k}</kbd>`;
  const items = [];
  const item = (action, texte, k = "", { danger = false, inactif = false } = {}) =>
    items.push(`<button type="button" role="menuitem" class="ed-menu-item${danger ? " is-danger" : ""}" data-menu="${action}"${inactif ? " disabled" : ""}><span>${texte}</span>${k ? raccourci(k) : ""}</button>`);
  const sep = () => items.push('<span class="ed-menu-sep" role="separator"></span>');
  if (liste.length) {
    if (un?.type === "image") {
      item("remplacer-image", "Remplacer l'image…");
      if (sourceImage(un)) {
        item("recadrer", ed.recadrage === un.id ? "Terminer le recadrage" : "Recadrer", "↩");
        const mode = G.cadrage(un.cadrage).mode;
        item(mode === "remplir" ? "ajuster" : "remplir", mode === "remplir" ? "Ajuster au cadre (image entière)" : "Remplir le cadre");
      }
      item("pivoter", "Pivoter de 90°");
      sep();
    }
    item("dupliquer", "Dupliquer", "⌘D", { inactif: liste.every((e) => e.type === "image" && !e.image) });
    item("devant", "Mettre devant", "]");
    item("derriere", "Mettre derrière", "[");
    item("verrou", liste.every((e) => e.verrou) ? "Déverrouiller" : "Verrouiller", "⌘L");
    if (liste.length > 1) {
      sep();
      item("aligner-gauche", "Aligner à gauche");
      item("aligner-centre-h", "Centrer horizontalement");
      item("aligner-haut", "Aligner en haut");
    }
    sep();
    item("supprimer", liste.length > 1 ? `Supprimer ${liste.length} éléments` : "Supprimer", "⌫", { danger: true });
  } else {
    item("ajouter-image", "Ajouter une image…");
    item("ajouter-texte", "Ajouter un texte", "T");
    sep();
    item("tout", "Tout sélectionner", "⌘A");
    item("ajuster-vue", "Ajuster à la fenêtre", "⌘0");
    sep();
    item("grille", `${ed.grille ? "Masquer" : "Afficher"} la grille`, "G");
    item("magnetisme", `${ed.magnetisme ? "Désactiver" : "Activer"} le magnétisme`, "M");
  }
  m.innerHTML = items.join("");
  m.hidden = false;
  m.classList.remove("is-sortie");
  // dans la fenetre, jamais coupe par un bord
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  ed.menuPoint = pointPage({ clientX: x, clientY: y });
  m.querySelector(".ed-menu-item:not(:disabled)")?.focus({ preventScroll: true });
}

function actionMenu(action) {
  fermeMenu();
  const e = choisis()[0];
  const direct = {
    dupliquer: () => duplique(),
    devant: () => ordre("devant"),
    derriere: () => ordre("derriere"),
    verrou: () => basculeVerrou(),
    supprimer: () => supprime(),
    "aligner-gauche": () => aligne("gauche"),
    "aligner-centre-h": () => aligne("centre-h"),
    "aligner-haut": () => aligne("haut"),
    tout: () => choisit(visibles().map((x) => x.id)),
    "ajuster-vue": () => ajusteVue(),
    grille: () => bascule("grille"),
    magnetisme: () => bascule("magnetisme"),
    "ajouter-texte": () => ajoute("texte", ed.menuPoint.x, ed.menuPoint.y, 110, 18),
    "ajouter-image": () => choisitFichier((f) => ajouteImage(f, ed.menuPoint)),
  };
  if (direct[action]) return direct[action]();
  faitAction(action, e);
}

if (APP_MAC) {
  scene.addEventListener("contextmenu", (evt) => {
    evt.preventDefault();
    if (ed.edition) finEdition(true);
    // le clic droit choisit ce qu'il touche (comme dans le Finder)
    const cible = evt.target.closest(".ed-el");
    const original = !cible && evt.target.closest("[data-original]");
    if (cible && !ed.selection.has(cible.dataset.id)) choisit([cible.dataset.id]);
    else if (original) {
      const e = prendOriginal(original.dataset.original);
      if (e) {
        rendOriginaux();
        choisit([e.id]);
      }
    } else if (!cible && !evt.target.closest("#ed-selection")) choisit([]);
    ouvreMenu(evt.clientX, evt.clientY);
  });
  document.addEventListener("pointerdown", (evt) => {
    if (!evt.target.closest("#ed-menu")) fermeMenu();
  }, true);
  document.addEventListener("click", (evt) => {
    const b = evt.target.closest("[data-menu]");
    if (b) actionMenu(b.dataset.menu);
  });
}

// --- Zoom et vue ---------------------------------------------------------------------------

function zoomAjuste() {
  const s = scene.getBoundingClientRect();
  return borne(Math.min((s.width - 80) / (ed.W * PX_PAR_POINT), (s.height - 80) / (ed.H * PX_PAR_POINT)), ED_ZOOM_MIN, ED_ZOOM_MAX);
}

function zoomeA(z, cx = null, cy = null) {
  const f = $("ed-feuille");
  const avant = f.getBoundingClientRect();
  const s = scene.getBoundingClientRect();
  if (cx === null) {
    cx = s.left + s.width / 2;
    cy = s.top + s.height / 2;
  }
  const fx = (cx - avant.left) / avant.width;
  const fy = (cy - avant.top) / avant.height;
  ed.zoom = borne(z, ED_ZOOM_MIN, ED_ZOOM_MAX);
  ed.ajuste = false;
  dimensionne();
  const apres = f.getBoundingClientRect();
  scene.scrollLeft += apres.left + fx * apres.width - cx;
  scene.scrollTop += apres.top + fy * apres.height - cy;
  dessine();
}

function ajusteVue() {
  ed.zoom = zoomAjuste();
  ed.ajuste = true;
  dimensionne();
  dessine(true);
  scene.scrollTo({ left: (scene.scrollWidth - scene.clientWidth) / 2, top: (scene.scrollHeight - scene.clientHeight) / 2 });
}

scene.addEventListener(
  "wheel",
  (evt) => {
    if (!ed.W) return;
    const delta = evt.deltaMode === 1 ? evt.deltaY * 16 : evt.deltaY;
    // en recadrage, la molette zoome le contenu de l'image, sous le pointeur
    if (ed.recadrage && !(evt.ctrlKey || evt.metaKey) && evt.target.closest(`.ed-el[data-id="${ed.recadrage}"]`)) {
      evt.preventDefault();
      zoomeContenu(element(ed.recadrage), Math.exp(-delta * 0.0025), evt.clientX, evt.clientY);
      return;
    }
    if (!(evt.ctrlKey || evt.metaKey)) return;
    evt.preventDefault();
    zoomeA(ed.zoom * Math.exp(-delta * 0.0022), evt.clientX, evt.clientY);
  },
  { passive: false }
);
// le pincement du trackpad du Mac (WebKit) : zoom ancre sous les doigts
let pincementMac = null;
scene.addEventListener("gesturestart", (evt) => {
  evt.preventDefault();
  pincementMac = { zoom: ed.zoom, x: evt.clientX, y: evt.clientY };
});
scene.addEventListener("gesturechange", (evt) => {
  evt.preventDefault();
  if (!pincementMac || !ed.W) return;
  if (ed.recadrage) zoomeContenu(element(ed.recadrage), 1 + (evt.scale - (pincementMac.dernier || 1)), evt.clientX, evt.clientY);
  else zoomeA(pincementMac.zoom * evt.scale, pincementMac.x, pincementMac.y);
  pincementMac.dernier = evt.scale;
});
scene.addEventListener("gestureend", (evt) => {
  evt.preventDefault();
  pincementMac = null;
});
$("ed-zoom-plus").addEventListener("click", () => zoomeA(PAS_ZOOM.find((p) => p > ed.zoom * 1.01) ?? ED_ZOOM_MAX));
$("ed-zoom-moins").addEventListener("click", () => zoomeA([...PAS_ZOOM].reverse().find((p) => p < ed.zoom * 0.99) ?? ED_ZOOM_MIN));
$("ed-zoom").addEventListener("click", ajusteVue);
new ResizeObserver(() => {
  if (ed.ajuste && ed.W) ajusteVue();
}).observe(zone);

// --- La page d'origine (pdf.js) -------------------------------------------------------------

let pdfjsCharge = null;
function chargePdfjs() {
  if (!pdfjsCharge) {
    pdfjsCharge = import("/vendor/pdfjs/pdf.min.mjs").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsCharge;
}

let minuteurDessin = null;
function dessine(toutDeSuite = false) {
  clearTimeout(minuteurDessin);
  minuteurDessin = setTimeout(rendCanvas, toutDeSuite ? 0 : 140);
}

async function rendCanvas() {
  if (ed.type !== "pdf" || !ed.pdfPage) return;
  ed.rendu?.cancel?.();
  const page = ed.pdfPage;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let s = ed.zoom * PX_PAR_POINT * dpr;
  const essai = page.getViewport({ scale: s });
  const max = 16 * 1024 * 1024;
  if (essai.width * essai.height > max) s *= Math.sqrt(max / (essai.width * essai.height));
  const vp = page.getViewport({ scale: s });
  const tampon = document.createElement("canvas");
  tampon.width = Math.floor(vp.width);
  tampon.height = Math.floor(vp.height);
  const tache = page.render({ canvasContext: tampon.getContext("2d", { alpha: false }), viewport: vp, background: "#ffffff" });
  ed.rendu = tache;
  try {
    await tache.promise;
  } catch {
    return;
  }
  if (ed.pdfPage !== page) return;
  const actuel = $("ed-canvas");
  tampon.id = "ed-canvas";
  tampon.className = actuel.className;
  actuel.replaceWith(tampon);
  ed.versionPage += 1;
  rendElements();
}

// Les textes de la page d'origine (pdf.js) : ceux qui s'ecrivent a
// l'horizontale, a l'ecran, se prennent d'un clic.
async function textesDe(page, pdfjs) {
  const vp = page.getViewport({ scale: 1 });
  const contenu = await page.getTextContent();
  const textes = [];
  contenu.items.forEach((it, i) => {
    if (!it.str || !it.str.trim()) return;
    const t = pdfjs.Util.transform(vp.transform, it.transform);
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01 || t[0] <= 0) return;
    const taille = Math.abs(t[3]);
    if (taille < 2) return;
    const famille = contenu.styles[it.fontName]?.fontFamily || "sans-serif";
    const police = /mono/.test(famille) ? "Courier" : /serif/.test(famille) && !/sans/.test(famille) ? "Times-Roman" : "Helvetica";
    const largeur = it.width || taille * it.str.length * 0.5;
    textes.push({ cle: `t${i}`, texte: it.str, x: t[4], y: t[5] - taille * 0.86, l: largeur, h: taille * 1.12, taille: Math.round(taille * 10) / 10, police });
  });
  return textes;
}

// Les images de la page d'origine (logos, photos...) : leur cadre exact,
// rotation comprise, d'apres les operations de dessin de la page. Ni le fond
// d'une etiquette qui serait une seule grande image, ni un code-barres dessine
// en image (il se prend comme un code).
async function imagesDe(page, pdfjs, codes) {
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS;
  const pile = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const mul = pdfjs.Util.transform;
  const images = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const f = ops.fnArray[i];
    const a = ops.argsArray[i];
    if (f === O.save) pile.push(ctm);
    else if (f === O.restore) ctm = pile.pop() || [1, 0, 0, 1, 0, 0];
    else if (f === O.transform) ctm = mul(ctm, a);
    else if (f === O.paintFormXObjectBegin) {
      pile.push(ctm);
      if (Array.isArray(a?.[0]) && a[0].length === 6) ctm = mul(ctm, a[0]);
    } else if (f === O.paintFormXObjectEnd) ctm = pile.pop() || [1, 0, 0, 1, 0, 0];
    else if (f === O.paintImageXObject || f === O.paintInlineImageXObject || f === O.paintImageMaskXObject) {
      const m = mul(vp.transform, ctm);
      const p = (x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
      // le haut de l'image est en y = 1 dans son carre unite
      const hg = p(0, 1);
      const hd = p(1, 1);
      const bg = p(0, 0);
      const l = Math.hypot(hd.x - hg.x, hd.y - hg.y);
      const h = Math.hypot(bg.x - hg.x, bg.y - hg.y);
      if (l < 6 || h < 6) continue;
      const rotation = G.angle((Math.atan2(hd.y - hg.y, hd.x - hg.x) * 180) / Math.PI);
      const c = p(0.5, 0.5);
      const cadre = { x: c.x - l / 2, y: c.y - h / 2, l, h, rotation };
      const boite = G.boite(cadre);
      if (boite.l * boite.h > vp.width * vp.height * 0.7) continue;
      const surCode = codes.some((k) => {
        const ix = Math.max(0, Math.min(boite.x + boite.l, k.x + k.l) - Math.max(boite.x, k.x));
        const iy = Math.max(0, Math.min(boite.y + boite.h, k.y + k.h) - Math.max(boite.y, k.y));
        return ix * iy > 0.5 * Math.min(boite.l * boite.h, k.l * k.h);
      });
      if (surCode) continue;
      images.push({ cle: `i${i}`, ...cadre, boite });
      if (images.length >= 60) break;
    }
  }
  return images;
}

// Les anciens brouillons (avant les extraits) : chaque element de l'etiquette
// retrouve sa zone d'origine. Un texte dont le contenu ou le style avait
// change reste retape ; un texte seulement deplace redevient un extrait.
function migreElements(n) {
  const o = ed.originaux.get(n);
  const p = ed.modele.pages.find((x) => x.page === n);
  if (!o || !p) return;
  for (const e of p.elements) {
    if (e.origine !== "original" || (e.source && e.depart)) continue;
    const t = o.textes.find((x) => x.cle === e.cle);
    const c = o.codes.find((x) => x.cle === e.cle);
    const zone = t || c;
    if (!zone) continue;
    e.depart = { x: zone.x, y: zone.y, l: zone.l, h: zone.h, rotation: 0 };
    e.source = e.masque || { ...e.depart };
    if (t && e.retape === undefined) {
      e.retape = e.texte !== t.texte || e.police !== t.police || Math.abs(e.taille - t.taille) > 0.05 || e.couleur !== "#000000" || (e.alignement || "gauche") !== "gauche";
    }
  }
}

async function allerPage(n) {
  if (n < 1 || n > ed.nbPages || (n === ed.page && ed.W)) return;
  finEdition(true);
  ed.page = n;
  ed.selection.clear();
  // le recadrage d'une image de l'autre page s'arrete avec elle
  ed.recadrage = null;
  if (ed.type === "pdf") {
    const pdfjs = await chargePdfjs();
    ed.pdfPage = await ed.doc.getPage(n);
    const vp = ed.pdfPage.getViewport({ scale: 1 });
    ed.W = vp.width;
    ed.H = vp.height;
    if (!ed.originaux.has(n)) {
      const textes = await textesDe(ed.pdfPage, pdfjs).catch(() => []);
      const codes = codesOriginaux(n);
      const images = await imagesDe(ed.pdfPage, pdfjs, codes).catch(() => []);
      ed.originaux.set(n, { textes, codes, images });
    }
    ed.versionPage = 0;
  } else {
    const img = $("ed-image");
    ed.W = img.naturalWidth;
    ed.H = img.naturalHeight;
    if (!ed.originaux.has(n)) ed.originaux.set(n, { textes: [], codes: codesOriginaux(n), images: [] });
    ed.versionPage = 1;
  }
  migreElements(n);
  oublieNoeuds();
  $("ed-pages").hidden = ed.nbPages <= 1;
  $("ed-page-texte").textContent = `${n} / ${ed.nbPages}`;
  $("ed-page-prec").disabled = n <= 1;
  $("ed-page-suiv").disabled = n >= ed.nbPages;
  ajusteVue();
  rendTout();
}

function codesOriginaux(n) {
  const p = ed.detail?.analyse?.pages?.[n - 1];
  if (!p) return [];
  return p.codes.map((c) => ({
    cle: `c${c.id}`,
    id: c.id,
    format: c.format,
    valeur: c.valeur,
    lisible: c.lisible,
    // decide par le serveur : jamais le code du transporteur
    modifiable: c.modifiable === true,
    orientation: Math.round((c.orientation || 0) / 90) * 90,
    x: c.zone.x0 * ed.W,
    y: c.zone.y0 * ed.H,
    l: (c.zone.x1 - c.zone.x0) * ed.W,
    h: (c.zone.y1 - c.zone.y0) * ed.H,
  }));
}

// --- Le panneau : saisies -------------------------------------------------------------------

let minuteurValeur = null;
let minuteurClavier = null;
$("ed-proprietes").addEventListener("input", (evt) => {
  const prop = evt.target.dataset.prop;
  const e = choisis()[0];
  if (!prop || !e) return;
  if (["x", "y", "l", "h"].includes(prop)) return; // a la validation (change)
  if (prop === "valeur") {
    // La valeur d’un code transporteur peut aussi être modifiée.
    // Le verrou manuel de l’élément reste respecté par le champ readonly.
    // le code se redessine a la frappe
    clearTimeout(minuteurValeur);
    minuteurValeur = setTimeout(() => appliqueValeur(e, evt.target.value, null, { silencieux: true }), 90);
    return;
  }
  if (prop === "texte") {
    e.texte = evt.target.value;
    ajusteTexte(e);
    marqueRetape(e);
    rendElements();
    clearTimeout(minuteurValeur);
    minuteurValeur = setTimeout(() => engage(`Modifier le texte ${nomElement(e)}`), 700);
    return;
  }
  if (prop === "taille") {
    e.taille = borne(Number(evt.target.value) || e.taille, 2, 300);
    ajusteTexte(e);
  }
  if (prop === "couleur") e.couleur = evt.target.value;
  if (prop === "couleur" && e.type === "code" && e.origine === "original") {
    if (!codeLibre(e)) return;
    marqueReecrit(e);
    rendElements();
    return;
  }
  if (prop === "fond") e.fond = evt.target.value;
  if (prop === "zoom-contenu" && e.type === "image") {
    // le contenu de l'image grandit dans son cadre, autour de son centre
    e.cadrage = cadrageBorne(e, { ...G.cadrage(e.cadrage), zoom: Number(evt.target.value) / 100 });
    if (evt.target.nextElementSibling) evt.target.nextElementSibling.textContent = `${evt.target.value} %`;
    marqueModifie(e);
    rendElements();
    return;
  }
  if (prop === "rotation") return;
  if (e.type === "texte") marqueRetape(e);
  else marqueModifie(e);
  rendElements();
});

$("ed-proprietes").addEventListener("change", (evt) => {
  const prop = evt.target.dataset.prop;
  const e = choisis()[0];
  if (!prop || !e) return;
  if (["x", "y", "l", "h"].includes(prop)) {
    const v = depuisMm(Number(evt.target.value));
    if (!Number.isFinite(v)) return;
    const ratio = e.l / e.h;
    e[prop] = prop === "l" || prop === "h" ? Math.max(2, v) : v;
    if ((e.type === "code" && FORMATS_2D.includes(e.format) && e.format !== "PDF417") || estExtrait(e)) {
      // un QR code reste carre, un extrait de l'etiquette ne se deforme pas
      if (prop === "l") e.h = e.l / (estExtrait(e) ? ratio : 1);
      if (prop === "h") e.l = e.h * (estExtrait(e) ? ratio : 1);
    }
    marqueModifie(e);
    engage(`Position de ${nomElement(e)}`);
    rendTout();
    return;
  }
  if (prop === "police") {
    e.police = evt.target.value;
    ajusteTexte(e);
    marqueRetape(e);
    engage("Changer la police");
    rendTout();
    return;
  }
  if (prop === "format") {
    const avant = e.format;
    e.format = evt.target.value;
    appliqueValeur(e, e.valeur, `Format ${NOMS_FORMAT[avant]} → ${NOMS_FORMAT[e.format]}`);
    return;
  }
  if (["taille", "couleur", "fond"].includes(prop)) {
    engage({ taille: "Taille du texte", couleur: "Couleur", fond: "Couleur du fond" }[prop]);
    rendTout();
  }
  if (prop === "zoom-contenu") {
    engage("Zoom du contenu");
    rendTout();
  }
  if (prop === "rotation") {
    const v = Number(evt.target.value);
    if (!Number.isFinite(v)) return;
    e.rotation = G.angle(v);
    marqueModifie(e);
    engage("Faire pivoter");
    rendTout();
  }
});

// une nouvelle valeur : le code est regenere par le serveur (qui refuse un
// numero de suivi ou des donnees d'expedition)
let minuteurHistoriqueCode = null;
// la derniere valeur demandee pour chaque code : les reponses du serveur
// peuvent arriver dans le desordre, seule la derniere saisie compte
const valeursDemandees = new Map(); // id -> numero
async function appliqueValeur(e, valeur, libelle = null, { silencieux = false } = {}) {
  const message = $("ed-message-code");
  const numero = (valeursDemandees.get(e.id) || 0) + 1;
  valeursDemandees.set(e.id, numero);
  const depassee = () => valeursDemandees.get(e.id) !== numero;
  try {
    await codeDe(e.format, valeur, e.origine === "original" ? e.codeId : null);
    if (depassee()) return;
    e.valeur = valeur;
    if (e.origine === "original") marqueReecrit(e);
    if (message) {
      message.textContent = "";
      message.className = "ed-message";
    }
    rendElements();
    rendCalques();
    // une seule etape d'historique pour une saisie (pas une par lettre)
    clearTimeout(minuteurHistoriqueCode);
    if (silencieux) minuteurHistoriqueCode = setTimeout(() => engage(`Contenu du code → ${String(valeur).slice(0, 24)}`), 700);
    else engage(libelle || `Contenu du code → ${String(valeur).slice(0, 24)}`);
  } catch (err) {
    if (depassee()) return;
    if (message) {
      message.textContent = err.message;
      message.className = "ed-message is-erreur";
    } else toast(err.message, "error");
    // le format change mais la valeur n'y tient pas : on revient a l'etape en cours
    if (libelle) {
      ed.modele = JSON.parse(ed.historique[ed.position].etat);
      rendTout();
    }
  }
}

$("ed-proprietes").addEventListener("click", (evt) => {
  const action = evt.target.closest("[data-action]")?.dataset.action;
  if (action) return faitAction(action);
  const al = evt.target.closest("[data-alignement]");
  if (al) {
    const e = choisis()[0];
    e.alignement = al.dataset.alignement;
    marqueRetape(e);
    engage("Aligner le texte");
    rendTout();
    return;
  }
  const cadrage = evt.target.closest("[data-cadrage]");
  if (cadrage) {
    const e = choisis()[0];
    if (e?.type === "image" && G.cadrage(e.cadrage).mode !== cadrage.dataset.cadrage) faitAction(cadrage.dataset.cadrage, e);
    return;
  }
  const a = evt.target.closest("[data-aligne]");
  if (a) return aligne(a.dataset.aligne);
  const d = evt.target.closest("[data-distribue]");
  if (d) distribue(d.dataset.distribue);
});

$("ed-calques").addEventListener("click", (evt) => {
  const ligne = evt.target.closest("[data-calque]");
  if (!ligne) return;
  const id = ligne.dataset.calque;
  const action = evt.target.closest("[data-calque-action]")?.dataset.calqueAction;
  if (action === "monter") return bougeOrdre(id, 1);
  if (action === "descendre") return bougeOrdre(id, -1);
  if (action === "verrou") {
    const e = element(id);
    e.verrou = !e.verrou;
    engage(e.verrou ? "Verrouiller" : "Déverrouiller");
    rendTout();
    return;
  }
  choisit([id], { ajoute: evt.shiftKey });
});

$("ed-historique").addEventListener("click", (evt) => {
  const b = evt.target.closest("[data-etape]");
  if (b) vaA(Number(b.dataset.etape));
});

document.querySelectorAll("[data-onglet]").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("[data-onglet]").forEach((x) => {
      const on = x === b;
      x.classList.toggle("is-on", on);
      x.setAttribute("aria-selected", String(on));
    });
    for (const k of ["proprietes", "calques", "historique"]) $(`ed-${k}`).hidden = k !== b.dataset.onglet;
    rendProprietes();
    rendCalques();
    rendHistorique();
  })
);

// --- La barre d'outils -------------------------------------------------------------------------

// le panneau de droite se replie : toute la largeur pour la page (⌘\)
function basculePanneau(force = null) {
  const cache = force ?? !document.body.classList.contains("is-panneau-cache");
  document.body.classList.toggle("is-panneau-cache", cache);
  document.querySelector('[data-action="panneau"]')?.setAttribute("aria-pressed", String(!cache));
  try {
    localStorage.setItem("editeur.panneau", cache ? "cache" : "ouvert");
  } catch {}
}

function changeCadrage(e, c, libelle) {
  e.cadrage = cadrageBorne(e, c);
  marqueModifie(e);
  engage(libelle);
  rendTout();
}

function changeOutil(outil) {
  ed.outil = outil;
  document.querySelectorAll("[data-outil]").forEach((b) => b.classList.toggle("is-on", b.dataset.outil === outil));
  scene.dataset.outil = outil;
}

function faitAction(action, cible = null) {
  const e = cible || (choisis().length === 1 ? choisis()[0] : null);
  if (e?.type === "image") {
    if (action === "remplacer-image") return choisitFichier((f) => remplaceImage({ id: e.id }, f));
    if (action === "recadrer") return ed.recadrage === e.id ? finRecadrage() : entreRecadrage(e.id);
    if (action === "remplir" || action === "ajuster") return changeCadrage(e, { mode: action, zoom: 1, dx: 0, dy: 0 }, action === "remplir" ? "Remplir le cadre" : "Ajuster au cadre");
    if (action === "centrer-contenu") return changeCadrage(e, { ...G.cadrage(e.cadrage), dx: 0, dy: 0 }, "Centrer le contenu");
    if (action === "reinitialiser-cadrage") return changeCadrage(e, { mode: "remplir" }, "Réinitialiser le cadrage");
    if (action === "pivoter" && !e.verrou) {
      detache([e]);
      e.rotation = G.angle((e.rotation || 0) + 90);
      engage("Pivoter de 90°");
      rendTout();
      return;
    }
  }
  if (action === "ajouter-image") return choisitFichier((f) => ajouteImage(f));
  if (action === "panneau") return basculePanneau();
  if (action === "valeur-origine" && e?.type === "code") {
    const lu = codeLu(e);
    if (!lu) return;
    Object.assign(e, { valeur: lu.valeur, format: lu.format, couleur: "#000000", reecrit: false });
    engage(`Valeur d'origine ${nomElement(e)}`);
    rendTout();
    return;
  }
  if (action === "supprimer") return supprime();
  if (action === "dupliquer") return duplique();
  if (action === "devant" || action === "derriere") return ordre(action);
  if (action === "verrou") return basculeVerrou();
  if (action === "centrer-h") return centre("h");
  if (action === "centrer-v") return centre("v");
  if (action === "regenerer") {
    const e = choisis()[0];
    const champ = document.querySelector('#ed-proprietes [data-prop="valeur"]');
    if (e && champ) appliqueValeur(e, champ.value);
  }
}

function bascule(nom) {
  ed[nom] = !ed[nom];
  document.querySelector(`[data-bascule="${nom}"]`).setAttribute("aria-pressed", String(ed[nom]));
  $("ed-grille").hidden = !ed.grille;
  try {
    localStorage.setItem("editeur.reglages", JSON.stringify({ grille: ed.grille, magnetisme: ed.magnetisme }));
  } catch {}
}

$("ed-outils").addEventListener("click", (evt) => {
  const o = evt.target.closest("[data-outil]");
  if (o) return changeOutil(o.dataset.outil);
  const a = evt.target.closest("[data-action]");
  if (a) return faitAction(a.dataset.action);
  const b = evt.target.closest("[data-bascule]");
  if (b) bascule(b.dataset.bascule);
});
$("ed-bascule-panneau").addEventListener("click", () => basculePanneau());
if (APP_MAC) {
  try {
    if (localStorage.getItem("editeur.panneau") === "cache") basculePanneau(true);
  } catch {}
}
$("ed-annuler").addEventListener("click", annule);
$("ed-retablir").addEventListener("click", retablit);
$("ed-page-prec").addEventListener("click", () => allerPage(ed.page - 1));
$("ed-page-suiv").addEventListener("click", () => allerPage(ed.page + 1));

// --- Clavier (Cmd sur Mac, Ctrl ailleurs) ------------------------------------------------------

document.addEventListener("keydown", (evt) => {
  const saisie = evt.target.closest?.("input, textarea, select, [contenteditable]");
  // ⌘ sur Mac, Ctrl ailleurs (et Ctrl sur Mac aussi : un clavier PC branche)
  const mod = evt.metaKey || evt.ctrlKey;
  const k = evt.key.toLowerCase();
  // annuler / retablir, meme depuis le panneau (sauf dans un champ de texte)
  if (mod && k === "z" && !saisie) {
    evt.preventDefault();
    if (evt.shiftKey) retablit();
    else annule();
    return;
  }
  if (mod && k === "y" && !saisie) {
    evt.preventDefault();
    retablit();
    return;
  }
  if (saisie) return;
  if (evt.key === " ") {
    espace = true;
    scene.classList.add("is-main");
    evt.preventDefault();
    return;
  }
  if (mod && k === "d") {
    evt.preventDefault();
    duplique();
    return;
  }
  if (mod && evt.key === "\\" && APP_MAC) {
    evt.preventDefault();
    basculePanneau();
    return;
  }
  if (mod && k === "a") {
    evt.preventDefault();
    choisit(visibles().map((e) => e.id));
    return;
  }
  if (mod && k === "l") {
    evt.preventDefault();
    basculeVerrou();
    return;
  }
  if (mod && (k === "=" || k === "+")) {
    evt.preventDefault();
    $("ed-zoom-plus").click();
    return;
  }
  if (mod && k === "-") {
    evt.preventDefault();
    $("ed-zoom-moins").click();
    return;
  }
  if (mod && k === "0") {
    evt.preventDefault();
    ajusteVue();
    return;
  }
  if (mod) return;
  if (evt.key === "Delete" || evt.key === "Backspace") {
    evt.preventDefault();
    supprime();
    return;
  }
  if (evt.key === "Escape") {
    if (!$("ed-menu")?.hidden) return fermeMenu();
    if (ed.recadrage) return finRecadrage();
    choisit([]);
    changeOutil("selection");
    return;
  }
  if (evt.key === "Enter" && APP_MAC) {
    const e = choisis().length === 1 ? choisis()[0] : null;
    if (ed.recadrage) return finRecadrage();
    if (e?.type === "image") return entreRecadrage(e.id);
    if (e?.type === "texte") return commenceEdition(e.id);
  }
  if (evt.key.startsWith("Arrow")) {
    const liste = choisis().filter((e) => !e.verrou);
    if (!liste.length) return;
    evt.preventDefault();
    const pas = depuisMm(evt.shiftKey ? 5 : 0.5);
    const d = { ArrowLeft: [-pas, 0], ArrowRight: [pas, 0], ArrowUp: [0, -pas], ArrowDown: [0, pas] }[evt.key];
    for (const e of liste) {
      e.x += d[0];
      e.y += d[1];
      marqueModifie(e);
    }
    rendElements();
    // son propre minuteur : une saisie du panneau en attente n'est jamais annulee
    clearTimeout(minuteurClavier);
    minuteurClavier = setTimeout(() => {
      engage("Déplacer au clavier");
      rendTout();
    }, 400);
    return;
  }
  const outils = { v: "selection", h: "main", t: "texte", b: "barres", q: "qr", r: "rect" };
  if (outils[k]) return changeOutil(outils[k]);
  if (k === "i" && APP_MAC) return choisitFichier((f) => ajouteImage(f));
  if (k === "g") return bascule("grille");
  if (k === "m") return bascule("magnetisme");
  if (evt.key === "]") return ordre("devant");
  if (evt.key === "[") return ordre("derriere");
});
document.addEventListener("keyup", (evt) => {
  if (evt.key === " ") {
    espace = false;
    scene.classList.remove("is-main");
  }
});

// --- Export : le nouveau PDF ---------------------------------------------------------------------

$("ed-exporter").addEventListener("click", async (evt) => {
  const bouton = evt.currentTarget;
  finEdition(true);
  await agir(bouton, async () => {
    const res = await fetch(`/api/bordereaux/${ed.colisId}/travail/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modele: modeleEnvoye() }),
    });
    if (!res.ok) {
      const corps = await res.json().catch(() => ({}));
      if (corps.transporteur?.page) {
        bandeau(`${corps.error} <a href="${escapeAttr(corps.transporteur.page)}" target="_blank" rel="noopener noreferrer">Site ${escapeHtml(corps.transporteur.nom)}</a>`, "erreur");
      }
      throw new Error(corps.error || `Export impossible (${res.status})`);
    }
    const blob = await res.blob();
    const nom = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") || "")?.[1];
    const lien = document.createElement("a");
    lien.href = URL.createObjectURL(blob);
    lien.download = nom ? decodeURIComponent(nom) : "bordereau-modifie.pdf";
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    setTimeout(() => URL.revokeObjectURL(lien.href), 4000);
    toast("PDF exporté · l'étiquette d'origine n'a pas changé");
  });
});

function bandeau(html, type = "info") {
  const b = $("ed-bandeau");
  if (!html) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.className = `ed-bandeau is-${type}`;
  b.innerHTML = `<span>${html}</span><button class="bdx-outil" type="button" data-ferme-bandeau aria-label="Fermer"><svg class="icon"><use href="#i-x"/></svg></button>`;
}
$("ed-bandeau").addEventListener("click", async (evt) => {
  if (evt.target.closest("[data-ferme-bandeau]")) bandeau(null);
  if (evt.target.closest("[data-repartir]")) {
    if (!window.confirm("Repartir de l'étiquette d'origine ? Le brouillon (et son historique) sera effacé.")) return;
    await fetchJSON(`/api/bordereaux/${ed.colisId}/travail`, { method: "DELETE" }).catch(() => {});
    try {
      localStorage.removeItem(`editeur.brouillon.${ed.colisId}`);
      localStorage.removeItem(`editeur.historique.${ed.colisId}`);
    } catch {}
    ed.modele = { version: 1, pages: [] };
    ed.historique = [];
    ed.position = -1;
    ed.selection.clear();
    engage("Ouverture de l'étiquette d'origine", { initial: true });
    ed.sauvegarde.sale = false;
    etatSauvegarde("Pas encore modifié", "");
    bandeau(null);
    rendTout();
  }
});

// --- Demarrage -------------------------------------------------------------------------------

async function demarreEditeur() {
  try {
    const g = JSON.parse(localStorage.getItem("editeur.reglages") || "{}");
    if (typeof g.grille === "boolean") ed.grille = g.grille;
    if (typeof g.magnetisme === "boolean") ed.magnetisme = g.magnetisme;
  } catch {}
  document.querySelector('[data-bascule="grille"]').setAttribute("aria-pressed", String(ed.grille));
  document.querySelector('[data-bascule="magnetisme"]').setAttribute("aria-pressed", String(ed.magnetisme));
  $("ed-grille").hidden = !ed.grille;

  ed.colisId = Number(new URLSearchParams(location.search).get("colis"));
  if (!Number.isInteger(ed.colisId) || ed.colisId <= 0) {
    $("ed-chargement").innerHTML = "<span>Aucune étiquette choisie. Ouvre l'éditeur depuis la page Bordereaux.</span>";
    return;
  }
  $("ed-comparer").href = `/bordereaux/comparer?a=${ed.colisId}`;
  try {
    let detail = await fetchJSON(`/api/bordereaux/${ed.colisId}`);
    // les codes doivent etre lus pour etre pris (et proteges)
    if (detail.analyse.etat === "attente" || detail.analyse.etat === "echec") detail = await postJSON(`/api/bordereaux/${ed.colisId}/analyse`, {}, { delai: 120000 }).catch(() => detail);
    ed.detail = detail;
    $("ed-titre").textContent = detail.colis.expediteur || "Bordereau";
    $("ed-fichier").textContent = detail.colis.fichier || `Colis #${detail.colis.id}`;
    document.title = `Éditeur · ${detail.colis.fichier || detail.colis.expediteur} · DROP.ctrl`;

    const res = await fetch(`/api/bordereaux/${ed.colisId}/fichier`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Fichier inaccessible");
    const type = res.headers.get("Content-Type") || "";
    if (type.startsWith("application/pdf")) {
      const pdfjs = await chargePdfjs();
      ed.doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), isEvalSupported: false, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/" }).promise;
      ed.type = "pdf";
      ed.nbPages = ed.doc.numPages;
    } else if (type.startsWith("image/")) {
      const img = $("ed-image");
      img.src = URL.createObjectURL(await res.blob());
      await imagePrete(img);
      img.hidden = false;
      $("ed-canvas").hidden = true;
      ed.type = "image";
      ed.nbPages = 1;
    } else throw new Error("Ce fichier ne s'ouvre pas dans l'éditeur.");

    // un brouillon a reprendre ? (serveur, sinon la copie de cet ordinateur)
    const { travail } = await fetchJSON(`/api/bordereaux/${ed.colisId}/travail`);
    let local = null;
    try {
      local = JSON.parse(localStorage.getItem(`editeur.brouillon.${ed.colisId}`) || "null");
    } catch {}
    const serveurQuand = travail ? Date.parse(travail.modifieLe) : 0;
    if (local && local.quand > serveurQuand) {
      ed.modele = local.modele;
      bandeau(`Brouillon non enregistré retrouvé sur cet ordinateur et repris. <button class="bdx-lien" type="button" data-repartir>Repartir de l'original</button>`, "info");
      planifieSauvegarde();
    } else if (travail) {
      ed.modele = travail.modele;
      const quand = new Date(travail.modifieLe);
      bandeau(`Brouillon du ${quand.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} à ${quand.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} repris. <button class="bdx-lien" type="button" data-repartir>Repartir de l'original</button>`, "info");
      etatSauvegarde(`Brouillon enregistré à ${quand.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`, "is-ok");
    }
    // les anciens textes d'origine sont reconnus a leur cle (meme page)
    if (!reprendHistorique()) engage(travail || local ? "Reprise du brouillon" : "Ouverture de l'étiquette", { initial: true });
    ed.sauvegarde.sale = Boolean(local && local.quand > serveurQuand);
    $("ed-chargement").hidden = true;
    $("ed-feuille").hidden = false;
    ed.page = 0;
    await allerPage(1);
  } catch (err) {
    $("ed-chargement").innerHTML = `<span class="is-erreur">${escapeHtml(err.message)}</span>`;
  }
}

demarreEditeur();
