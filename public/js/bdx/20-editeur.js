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
  sauvegarde: { minuteur: null, enCours: false, sale: false, quand: null, erreur: null },
  geste: null,
  rendu: null,
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
const element = (id) => elements().find((e) => e.id === id) || null;
const visibles = () => elements().filter((e) => !e.supprime);
const choisis = () => visibles().filter((e) => ed.selection.has(e.id));

// --- Historique (Ctrl/Cmd + Z, Ctrl/Cmd + Maj + Z, Ctrl + Y) ---------------------------------

function instantane() {
  return JSON.stringify(ed.modele);
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
  ul.innerHTML = `<p class="ed-aide">Clique une étape pour y revenir ; ce qui suit reste rétablissable tant que tu ne modifies rien.</p><ol class="ed-histo">${ed.historique
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
  etatSauvegarde("Modifications en cours…", "is-sale");
  // une copie de secours sur cet ordinateur, au cas ou le serveur ne repond pas
  try {
    localStorage.setItem(`editeur.brouillon.${ed.colisId}`, JSON.stringify({ modele: ed.modele, quand: Date.now() }));
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
  etatSauvegarde("Enregistrement…", "is-encours");
  try {
    const r = await fetchJSON(`/api/bordereaux/${ed.colisId}/travail`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modele: ed.modele }) }, { delai: 20000 });
    ed.sauvegarde.sale = false;
    ed.sauvegarde.quand = new Date(r.modifieLe);
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

async function codeDe(format, valeur, codeId = null) {
  const cle = `${format}|${valeur}`;
  const deja = ed.codes.get(cle);
  if (deja) return deja instanceof Promise ? deja : deja;
  const promesse = postJSON(`/api/bordereaux/${ed.colisId}/code`, { format, valeur, codeId }, { delai: 20000 })
    .then((c) => {
      ed.codes.set(cle, c);
      return c;
    })
    .catch((err) => {
      ed.codes.delete(cle);
      throw err;
    });
  ed.codes.set(cle, promesse);
  return promesse;
}

function svgCode(e) {
  const c = ed.codes.get(`${e.format}|${e.valeur}`);
  if (!c || c instanceof Promise) {
    codeDe(e.format, e.valeur, e.origine === "original" ? e.codeId : null).then(() => rendElements(), () => rendElements());
    return `<span class="ed-code-attente">${c instanceof Promise ? "…" : "Code impossible"}</span>`;
  }
  return `<svg viewBox="0 0 ${c.largeur} ${c.hauteur}" preserveAspectRatio="none" aria-hidden="true"><path d="${c.chemin}" fill="${escapeAttr(e.couleur || "#000000")}" shape-rendering="crispEdges"/></svg>`;
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
  const o = ed.originaux.get(ed.page) || { textes: [], codes: [] };
  // ce qui est deja pris dans le document ne se reprend pas
  const pris = new Set(elements().filter((e) => e.origine === "original").map((e) => e.cle));
  const cible = (k, cle, rect, titre) =>
    pris.has(cle) ? "" : `<div class="ed-original ${k}" data-original="${escapeAttr(cle)}" style="${placement(rect)}" title="${escapeAttr(titre)}"></div>`;
  $("ed-originaux").innerHTML = [
    ...o.codes.map((c) => cible("is-code", c.cle, c, c.lisible ? `${NOMS_FORMAT[c.format] || c.format} de l'étiquette : ${c.valeur}` : "Code illisible")),
    ...o.textes.map((t) => cible("is-texte", t.cle, t, `Texte de l'étiquette : ${t.texte}`)),
  ].join("");
}

function rendElements() {
  const masques = [];
  const html = [];
  for (const e of elements()) {
    if (e.origine === "original" && (e.modifie || e.supprime) && e.masque) masques.push(`<div class="ed-masque" style="${placement(e.masque)}"></div>`);
    if (e.supprime) continue;
    const classes = ["ed-el", `is-${e.type}`];
    if (ed.selection.has(e.id)) classes.push("is-choisi");
    if (e.verrou) classes.push("is-verrou");
    if (e.origine === "original") classes.push(e.modifie ? "is-original-modifie" : "is-original");
    let contenu = "";
    let style = placement(e);
    if (e.type === "texte") {
      // un texte d'origine pas encore modifie : rien n'est redessine, on voit l'original
      const visible = e.origine !== "original" || e.modifie;
      const aligne = { gauche: "left", centre: "center", droite: "right" }[e.alignement] || "left";
      style += `;--taille:${e.taille};color:${e.couleur};text-align:${aligne};font:${CSS_POLICE[e.police] || CSS_POLICE.Helvetica};font-size:calc(var(--taille) * var(--e) * 1px)`;
      contenu = visible || ed.edition === e.id ? `<div class="ed-texte"${ed.edition === e.id ? ' contenteditable="true" spellcheck="false"' : ""}>${escapeHtml(e.texte)}</div>` : "";
      if (!visible) classes.push("is-transparent");
    } else if (e.type === "code") {
      if (e.origine !== "original" || e.modifie) contenu = svgCode(e);
      else classes.push("is-transparent");
    } else if (e.type === "rect") {
      style += `;background:${e.fond}`;
    }
    html.push(`<div class="${classes.join(" ")}" data-id="${e.id}" style="${style}">${contenu}</div>`);
  }
  $("ed-masques").innerHTML = masques.join("");
  $("ed-elements").innerHTML = html.join("");
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

function boiteDe(liste) {
  if (!liste.length) return null;
  const x0 = Math.min(...liste.map((e) => e.x));
  const y0 = Math.min(...liste.map((e) => e.y));
  const x1 = Math.max(...liste.map((e) => e.x + e.l));
  const y1 = Math.max(...liste.map((e) => e.y + e.h));
  return { x: x0, y: y0, l: x1 - x0, h: y1 - y0 };
}

function rendSelection() {
  const s = $("ed-selection");
  const liste = choisis();
  const b = boiteDe(liste);
  if (!b) {
    s.hidden = true;
    return;
  }
  s.hidden = false;
  s.setAttribute("style", placement(b));
  const unSeul = liste.length === 1 ? liste[0] : null;
  const poignees = unSeul && !fige(unSeul) ? ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((p) => `<span class="ed-poignee is-${p}" data-poignee="${p}"></span>`).join("") : "";
  s.innerHTML = `${poignees}<span class="ed-dimensions">${liste.length > 1 ? `${liste.length} éléments · ` : ""}${enMm(b.l)} × ${enMm(b.h)} mm</span>`;
  s.classList.toggle("is-verrou", Boolean(unSeul?.verrou));
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
        <p class="ed-valeur-ligne">${enMm(ed.W)} × ${enMm(ed.H)} mm · ${pluriel(modifs, "modification")}</p>
        <p class="ed-aide">Clique un texte ou un code de l'étiquette pour le prendre, ou ajoute des éléments avec les outils à gauche. Glisse sur la page pour en choisir plusieurs (Maj + clic aussi).</p></section>
      <section class="ed-bloc ed-protection"><h3><svg class="icon"><use href="#i-lock"/></svg>Données d'expédition protégées</h3>
        <p class="ed-aide">L'étiquette d'origine n'est jamais modifiée : l'export crée un nouveau PDF. Les codes lus sur l'étiquette gardent leur valeur (données du transporteur) ; un code ajouté ne peut pas porter un numéro de suivi ni des données d'expédition. Pour changer de numéro de suivi, il faut rééditer le bordereau chez le transporteur.</p></section>
      <section class="ed-bloc"><h3>Raccourcis</h3><p class="ed-aide ed-raccourcis">
        <kbd>${MAC ? "⌘" : "Ctrl"} Z</kbd> annuler · <kbd>${MAC ? "⌘⇧Z" : "Ctrl Y"}</kbd> rétablir · <kbd>${MAC ? "⌘" : "Ctrl"} D</kbd> dupliquer · <kbd>Suppr</kbd> supprimer · flèches : 0,5 mm (Maj : 5 mm) · <kbd>V</kbd> <kbd>H</kbd> <kbd>T</kbd> <kbd>B</kbd> <kbd>Q</kbd> <kbd>R</kbd> outils · <kbd>Espace</kbd> + glisser : déplacer la vue · <kbd>${MAC ? "⌘" : "Ctrl"}</kbd> + molette : zoom</p></section>`;
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
  const origine = e.origine === "original"
    ? `<p class="ed-origine">${e.type === "code" ? "Code de l'étiquette d'origine" : "Texte de l'étiquette d'origine"}${e.modifie ? " · <b>modifié</b> (masqué à sa place d'origine)" : " · pas encore modifié"}</p>`
    : `<p class="ed-origine is-ajout">Ajouté dans cette version de travail</p>`;
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
    const formats = e.origine === "original" ? [e.format] : FORMATS_2D.includes(e.format) ? FORMATS_2D : FORMATS_BARRES;
    const protege = e.origine === "original";
    propres = `<section class="ed-bloc"><h3>${NOMS_FORMAT[e.format] || e.format}</h3>
      <label class="ed-champ is-large"><span>Format</span><select data-prop="format"${protege ? " disabled" : ""}>${formats.map((f) => `<option value="${f}"${f === e.format ? " selected" : ""}>${NOMS_FORMAT[f]}</option>`).join("")}</select></label>
      <label class="ed-champ is-large ed-champ-valeur"><span>Contenu décodé</span>
        <textarea class="ed-zone-texte ed-mono" data-prop="valeur" rows="2"${protege || e.verrou ? " readonly" : ""}>${escapeHtml(e.valeur)}</textarea></label>
      ${
        protege
          ? `<p class="ed-protege"><svg class="icon"><use href="#i-lock"/></svg><span>Valeur protégée : donnée d'expédition du transporteur. Tu peux déplacer, redimensionner ou masquer ce code ; pour changer son contenu, réédite le bordereau chez le transporteur.</span></p>`
          : `<button class="btn btn-secondary btn-sm" type="button" data-action="regenerer"><svg class="icon"><use href="#i-refresh"/></svg><span>Régénérer le code</span></button><p class="ed-message" id="ed-message-code"></p>`
      }
      <label class="ed-champ ed-champ-couleur"><span>Couleur</span><input type="color" data-prop="couleur" value="${e.couleur || "#000000"}"${protege ? " disabled" : ""} /></label>
      </section>`;
  } else if (e.type === "rect") {
    propres = `<section class="ed-bloc"><h3>Rectangle</h3>
      <label class="ed-champ ed-champ-couleur"><span>Fond</span><input type="color" data-prop="fond" value="${e.fond}" /></label>
      <p class="ed-aide">Un rectangle blanc masque une zone de l'étiquette dans la version exportée.</p></section>`;
  }
  zone.innerHTML = `${origine}${propres}${blocPosition(e)}${blocActions(e)}`;
}

function nomElement(e) {
  if (e.type === "texte") return `« ${e.texte.slice(0, 28)}${e.texte.length > 28 ? "…" : ""} »`;
  if (e.type === "code") return `${NOMS_FORMAT[e.format] || e.format} · ${String(e.valeur).slice(0, 18)}`;
  return "Rectangle";
}

function rendCalques() {
  const zone = $("ed-calques");
  if (zone.hidden) return;
  const liste = visibles().slice().reverse(); // le premier de la liste = tout devant
  zone.innerHTML = liste.length
    ? `<p class="ed-aide">Du premier plan (en haut) au fond. Les éléments de l'étiquette d'origine sont dessous tous les calques.</p><ul class="ed-calques">${liste
        .map(
          (e) => `<li class="ed-calque-ligne${ed.selection.has(e.id) ? " is-on" : ""}" data-calque="${e.id}">
        <span class="ed-calque-type">${{ texte: "T", code: e.format && FORMATS_2D.includes(e.format) ? "QR" : "|||", rect: "▭" }[e.type]}</span>
        <span class="ed-calque-nom">${escapeHtml(nomElement(e))}${e.origine === "original" ? `<em>${e.modifie ? "étiquette · modifié" : "étiquette"}</em>` : ""}</span>
        <button class="bdx-outil" type="button" data-calque-action="monter" aria-label="Monter"><svg class="icon"><use href="#i-chevron-down"/></svg></button>
        <button class="bdx-outil${e.verrou ? " is-on" : ""}" type="button" data-calque-action="verrou" aria-label="${e.verrou ? "Déverrouiller" : "Verrouiller"}"><svg class="icon"><use href="#i-cadenas"/></svg></button>
      </li>`
        )
        .join("")}</ul>`
    : `<p class="ed-aide">Aucun élément sur cette page pour l'instant.</p>`;
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
  if (t) {
    e = { id: uid(), type: "texte", origine: "original", modifie: false, cle, x: t.x, y: t.y, l: t.l, h: t.h, texte: t.texte, taille: t.taille, police: t.police, couleur: "#000000", alignement: "gauche", masque: { x: t.x - 0.8, y: t.y - 0.6, l: t.l + 1.6, h: t.h + 1.2 } };
  } else if (c) {
    e = { id: uid(), type: "code", origine: "original", modifie: false, cle, codeId: c.id, x: c.x, y: c.y, l: c.l, h: c.h, format: c.format, valeur: c.valeur || "", couleur: "#000000", lisible: c.lisible, masque: { x: c.x - 2, y: c.y - 2, l: c.l + 4, h: c.h + 4 } };
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
  const liste = choisis();
  if (!liste.length) return;
  const nouveaux = liste.map((e) => {
    const copie = JSON.parse(JSON.stringify(e));
    Object.assign(copie, { id: uid(), origine: "ajout", modifie: true, x: e.x + 8, y: e.y + 8, verrou: false });
    delete copie.cle;
    delete copie.masque;
    delete copie.codeId;
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
      marqueModifie(e);
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
    xs.push(e.x, e.x + e.l / 2, e.x + e.l);
    ys.push(e.y, e.y + e.h / 2, e.y + e.h);
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

function montreGuides(gx, gy) {
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
const fige = (e) => e.verrou || (e.type === "code" && e.origine === "original" && !e.valeur);

function commenceDeplacement(evt, p) {
  const liste = choisis().filter((e) => !fige(e));
  if (!liste.length) return;
  capture(evt, { type: "deplace", depart: p, avant: liste.map((e) => ({ e, x: e.x, y: e.y })), bouge: false });
}

function commenceRedimension(evt, poignee, p) {
  const e = choisis()[0];
  if (!e || fige(e)) return;
  const carre = e.type === "code" && FORMATS_2D.includes(e.format) && e.format !== "PDF417";
  capture(evt, { type: "redimensionne", poignee, depart: p, e, avant: { x: e.x, y: e.y, l: e.l, h: e.h }, carre, bouge: false });
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
    g.bouge = true;
    // Maj : seulement a l'horizontale ou a la verticale
    if (evt.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const b0 = boiteDe(g.avant.map((a) => ({ x: a.x, y: a.y, l: a.e.l, h: a.e.h })));
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
    g.bouge = true;
    let { x, y, l, h } = avant;
    const dx = p.x - g.depart.x;
    const dy = p.y - g.depart.y;
    if (poignee.includes("e")) l = avant.l + dx;
    if (poignee.includes("s")) h = avant.h + dy;
    if (poignee.includes("w")) {
      x = avant.x + dx;
      l = avant.l - dx;
    }
    if (poignee.includes("n")) {
      y = avant.y + dy;
      h = avant.h - dy;
    }
    // un QR code reste carre ; Maj garde les proportions de tout element
    if (g.carre || evt.shiftKey) {
      const ratio = avant.l / avant.h;
      if (poignee === "n" || poignee === "s") l = h * ratio;
      else h = l / ratio;
      if (poignee.includes("w")) x = avant.x + avant.l - l;
      if (poignee.includes("n")) y = avant.y + avant.h - h;
    }
    const min = 2;
    e.x = x;
    e.y = y;
    e.l = Math.max(min, l);
    e.h = Math.max(min, h);
    if (ed.grille) {
      if (poignee.includes("e")) e.l = Math.max(min, grilleDe(e.x + e.l) - e.x);
      if (poignee.includes("s")) e.h = Math.max(min, grilleDe(e.y + e.h) - e.y);
    }
    rendElements();
    return;
  }
  if (g.type === "lasso") {
    const b = { x: Math.min(g.depart.x, p.x), y: Math.min(g.depart.y, p.y), l: Math.abs(p.x - g.depart.x), h: Math.abs(p.y - g.depart.y) };
    const l = $("ed-lasso");
    l.hidden = false;
    l.setAttribute("style", placement(b));
    const dedans = visibles().filter((e) => e.x < b.x + b.l && e.x + e.l > b.x && e.y < b.y + b.h && e.y + e.h > b.y).map((e) => e.id);
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

scene.addEventListener("dblclick", (evt) => {
  const cible = evt.target.closest(".ed-el.is-texte");
  if (cible) commenceEdition(cible.dataset.id);
});

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
    if (!(evt.ctrlKey || evt.metaKey) || !ed.W) return;
    evt.preventDefault();
    zoomeA(ed.zoom * Math.exp(-(evt.deltaMode === 1 ? evt.deltaY * 16 : evt.deltaY) * 0.0022), evt.clientX, evt.clientY);
  },
  { passive: false }
);
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

async function allerPage(n) {
  if (n < 1 || n > ed.nbPages || (n === ed.page && ed.W)) return;
  finEdition(true);
  ed.page = n;
  ed.selection.clear();
  if (ed.type === "pdf") {
    const pdfjs = await chargePdfjs();
    ed.pdfPage = await ed.doc.getPage(n);
    const vp = ed.pdfPage.getViewport({ scale: 1 });
    ed.W = vp.width;
    ed.H = vp.height;
    if (!ed.originaux.has(n)) {
      const textes = await textesDe(ed.pdfPage, pdfjs).catch(() => []);
      ed.originaux.set(n, { textes, codes: codesOriginaux(n) });
    }
  } else {
    const img = $("ed-image");
    ed.W = img.naturalWidth;
    ed.H = img.naturalHeight;
    if (!ed.originaux.has(n)) ed.originaux.set(n, { textes: [], codes: codesOriginaux(n) });
  }
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
    x: c.zone.x0 * ed.W,
    y: c.zone.y0 * ed.H,
    l: (c.zone.x1 - c.zone.x0) * ed.W,
    h: (c.zone.y1 - c.zone.y0) * ed.H,
  }));
}

// --- Le panneau : saisies -------------------------------------------------------------------

let minuteurValeur = null;
$("ed-proprietes").addEventListener("input", (evt) => {
  const prop = evt.target.dataset.prop;
  const e = choisis()[0];
  if (!prop || !e) return;
  if (["x", "y", "l", "h"].includes(prop)) return; // a la validation (change)
  if (prop === "valeur") {
    if (e.origine === "original") return;
    clearTimeout(minuteurValeur);
    minuteurValeur = setTimeout(() => appliqueValeur(e, evt.target.value), 500);
    return;
  }
  if (prop === "texte") {
    e.texte = evt.target.value;
    ajusteTexte(e);
    marqueModifie(e);
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
  if (prop === "fond") e.fond = evt.target.value;
  marqueModifie(e);
  rendElements();
});

$("ed-proprietes").addEventListener("change", (evt) => {
  const prop = evt.target.dataset.prop;
  const e = choisis()[0];
  if (!prop || !e) return;
  if (["x", "y", "l", "h"].includes(prop)) {
    const v = depuisMm(Number(evt.target.value));
    if (!Number.isFinite(v)) return;
    e[prop] = prop === "l" || prop === "h" ? Math.max(2, v) : v;
    if (e.type === "code" && FORMATS_2D.includes(e.format) && e.format !== "PDF417") {
      if (prop === "l") e.h = e.l;
      if (prop === "h") e.l = e.h;
    }
    marqueModifie(e);
    engage(`Position de ${nomElement(e)}`);
    rendTout();
    return;
  }
  if (prop === "police") {
    e.police = evt.target.value;
    ajusteTexte(e);
    marqueModifie(e);
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
});

// une nouvelle valeur : le code est regenere par le serveur (qui refuse un
// numero de suivi ou des donnees d'expedition)
async function appliqueValeur(e, valeur, libelle = null) {
  const message = $("ed-message-code");
  try {
    await codeDe(e.format, valeur);
    e.valeur = valeur;
    if (message) {
      message.textContent = "Code régénéré.";
      message.className = "ed-message is-ok";
    }
    engage(libelle || `Contenu du code → ${String(valeur).slice(0, 24)}`);
    rendElements();
    rendCalques();
  } catch (err) {
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
    marqueModifie(e);
    engage("Aligner le texte");
    rendTout();
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

function changeOutil(outil) {
  ed.outil = outil;
  document.querySelectorAll("[data-outil]").forEach((b) => b.classList.toggle("is-on", b.dataset.outil === outil));
  scene.dataset.outil = outil;
}

function faitAction(action) {
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
    choisit([]);
    changeOutil("selection");
    return;
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
    clearTimeout(minuteurValeur);
    minuteurValeur = setTimeout(() => {
      engage("Déplacer au clavier");
      rendTout();
    }, 400);
    return;
  }
  const outils = { v: "selection", h: "main", t: "texte", b: "barres", q: "qr", r: "rect" };
  if (outils[k]) return changeOutil(outils[k]);
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
      body: JSON.stringify({ modele: ed.modele }),
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
      await img.decode();
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
