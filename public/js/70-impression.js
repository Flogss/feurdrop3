// --- Onglet Imprime ---------------------------------------------------------------
// Meme chaine que /imprime sur Telegram : memes etiquettes, meme mise en page,
// meme marquage. Seule la sortie change -- le PDF s'ouvre dans un onglet, et
// c'est le navigateur qui imprime.

const impColis = new Map(); // id -> colis tel que charge, pour pre-remplir
let impTransporteurs = [];
let impAFaire = null; // le dernier resume "a imprimer" (pour « Choisir »)
// le dernier contenu de chaque categorie depliee : il s'affiche aussitot au
// rafraichissement, sans repli ni squelette, puis se met a jour
const impMemoire = new Map();

async function loadImprime() {
  let aFaire;
  let deja;
  try {
    [aFaire, deja] = await Promise.all([fetchJSON("/api/print/resume?scope=new"), fetchJSON("/api/print/resume?scope=printed")]);
  } catch (err) {
    // un onglet muet ne dit pas s'il est vide ou casse : on le dit (sans
    // effacer une liste deja affichee pour une coupure passagere)
    if ($("imp-categories").dataset.etat !== "liste") {
      $("imp-total").textContent = "Erreur de chargement";
      $("imp-categories").dataset.etat = "erreur";
      $("imp-categories").innerHTML = vide("alert", "Liste indisponible", escapeHtml(err.message));
    }
    return;
  }

  impTransporteurs = aFaire.transporteurs || [];
  impAFaire = aFaire;
  $("imp-total").textContent =
    aFaire.total > 0
      ? `${pluriel(aFaire.total, "étiquette", "étiquettes")} à imprimer${aFaire.noted > 0 ? ` · ${pluriel(aFaire.noted, "annotée", "annotées")}` : ""}`
      : "Rien en attente";
  majPastilleImprime(aFaire.total);

  // "Tout" ne couvre que le thermique 4x6 : les LIT sortent sur le rouleau
  // 210 mm, dans un PDF qui ne se melange pas au reste.
  const thermiques = aFaire.categories.filter((c) => !c.roll).reduce((sum, c) => sum + c.count, 0);
  $("imp-all").disabled = thermiques === 0;
  $("imp-choisir").disabled = thermiques === 0;
  const compteur = $("imp-all-count");
  if (compteur.textContent !== (thermiques > 0 ? entier(thermiques) : "")) {
    compteur.textContent = thermiques > 0 ? entier(thermiques) : "";
    rejoue(compteur, "is-bump", 600);
  }

  renderCategories("imp-categories", aFaire.categories, "new");
  $("imp-printed-count").textContent = deja.total > 0 ? pluriel(deja.total, "étiquette", "étiquettes") : "Aucune";
  renderCategories("imp-printed", deja.categories, "printed");
  prechargeCategories([aFaire, deja]).catch(() => {});
}

// Les categories deja affichees sont mises a jour en place (compte, notes) :
// rien n'est reconstruit, donc une categorie depliee reste depliee, un appui
// en cours n'est jamais perdu, et seules les vraies nouveautes bougent.
const impOuvertes = new Set(); // "scope:code" des categories depliees

function renderCategories(cible, categories, scope) {
  const box = $(cible);

  if (!categories || categories.length === 0) {
    if (box.dataset.etat !== "vide") {
      box.dataset.etat = "vide";
      box.innerHTML =
        scope === "new"
          ? vide("check", "Tout est imprimé", "Les nouvelles étiquettes apparaîtront ici.", true)
          : vide("printer", "Aucune étiquette imprimée en attente");
    }
    return;
  }
  if (box.dataset.etat !== "liste") {
    box.dataset.etat = "liste";
    box.innerHTML = "";
  }

  const existantes = new Map(
    [...box.querySelectorAll(":scope > .imp-cat:not(.is-leaving)")].map((el) => [el.dataset.cat, el])
  );
  const ordre = categories.map((c, i) => {
    let el = existantes.get(c.code);
    if (el) existantes.delete(c.code);
    else el = creeCategorie(c, scope, i);
    majCategorie(el, c);
    return el;
  });
  // une categorie videe s'en va en se repliant
  for (const el of existantes.values()) sortCategorie(el);
  let precedent = null;
  for (const el of ordre) {
    const attendu = precedent ? precedent.nextElementSibling : box.firstElementChild;
    if (el !== attendu) box.insertBefore(el, attendu);
    precedent = el;
    // une categorie deja depliee se remet a jour derriere, sans se refermer
    if (el.classList.contains("open") && !el.classList.contains("is-new")) fillCategory(el);
  }
}

function creeCategorie(c, scope, rang) {
  const cle = `${scope}:${c.code}`;
  const ouverte = impOuvertes.has(cle);
  const modele = document.createElement("template");
  modele.innerHTML = `<div class="imp-cat carrier is-new${ouverte ? " open" : ""}" style="--n:${Math.min(rang, 8)}" data-carrier="${escapeAttr(c.code)}" data-cat="${escapeAttr(c.code)}" data-scope="${scope}">
      <div class="imp-cat-head" role="button" tabindex="0" aria-expanded="${ouverte}">
        <span class="carrier-dot"></span>
        <span class="imp-cat-name"></span>
        <span class="imp-cat-noted" hidden>${ico("note")}<b></b></span>
        <span class="imp-cat-count"></span>
        <button class="btn btn-icon btn-sm btn-ghost" data-print-cat="${escapeAttr(c.code)}" data-scope="${scope}" type="button" title="Imprimer">${ico("printer")}</button>
        ${ico("chevron-down", "imp-chevron")}
      </div>
      <div class="imp-body"><div class="imp-list">${impMemoire.get(cle)?.html || ""}</div></div>
    </div>`;
  const el = modele.content.firstElementChild;
  el.addEventListener("animationend", () => el.classList.remove("is-new"), { once: true });
  if (ouverte) fillCategory(el);
  return el;
}

function majCategorie(el, c) {
  const nom = el.querySelector(".imp-cat-name");
  if (nom.textContent !== c.label) nom.textContent = c.label;
  el.querySelector("[data-print-cat]").setAttribute("aria-label", `Imprimer ${c.label}`);
  el.classList.toggle("noted", c.noted > 0);
  const note = el.querySelector(".imp-cat-noted");
  note.hidden = !c.noted;
  note.title = pluriel(c.noted, "colis annoté", "colis annotés");
  note.querySelector("b").textContent = c.noted || "";
  const compte = el.querySelector(".imp-cat-count");
  const texte = entier(c.count);
  if (compte.textContent !== texte) {
    const avant = compte.textContent;
    compte.textContent = texte;
    if (avant) rejoue(compte, "is-bump", 560);
  }
  // le nombre a change : la liste memorisee n'est plus a jour
  const memoire = impMemoire.get(`${el.dataset.scope}:${c.code}`);
  if (memoire && memoire.ids.length !== c.count) memoire.perime = true;
}

function sortCategorie(el) {
  el.classList.add("is-leaving");
  impOuvertes.delete(`${el.dataset.scope}:${el.dataset.cat}`);
  sortLigne(el).then(() => el.remove());
}

function basculeCategorie(cat) {
  const cle = `${cat.dataset.scope}:${cat.dataset.cat}`;
  const ouverte = cat.classList.toggle("open");
  cat.querySelector(".imp-cat-head").setAttribute("aria-expanded", String(ouverte));
  if (ouverte) impOuvertes.add(cle);
  else impOuvertes.delete(cle);
  haptique();
  if (ouverte) fillCategory(cat);
}

// Une ligne qui s'en va glisse de cote, puis l'espace qu'elle laissait se
// referme : on voit ce qui part, et la liste se resserre sans sauter.
async function sortLigne(ligne) {
  if (!ligne || prefersReducedMotion || !ligne.animate) return;
  const h = ligne.offsetHeight;
  await ligne
    .animate(
      [
        { opacity: 1, transform: "none", filter: "blur(0)" },
        { opacity: 0, transform: "translateX(40px) scale(0.96)", filter: "blur(4px)" },
      ],
      { duration: 240, easing: "cubic-bezier(0.55, 0, 0.75, 0.2)", fill: "forwards" }
    )
    .finished.catch(() => {});
  await ligne
    .animate(
      [
        { height: `${h}px`, marginTop: getComputedStyle(ligne).marginTop, paddingTop: getComputedStyle(ligne).paddingTop, paddingBottom: getComputedStyle(ligne).paddingBottom },
        { height: "0px", marginTop: "-6px", paddingTop: "0px", paddingBottom: "0px" },
      ],
      { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }
    )
    .finished.catch(() => {});
}

// Deplier une categorie charge sa liste : inutile de tout descendre d'avance.
document.addEventListener("click", async (e) => {
  const head = e.target.closest(".imp-cat-head");
  if (head && !e.target.closest("[data-print-cat]")) return basculeCategorie(head.parentElement);

  const printCat = e.target.closest("[data-print-cat]");
  if (printCat) return lancerImpression(printCat, { categorie: printCat.dataset.printCat, scope: printCat.dataset.scope });

  const printOne = e.target.closest("[data-print-one]");
  if (printOne) return lancerImpression(printOne, { ids: [Number(printOne.dataset.printOne)], scope: printOne.dataset.scope });

  const edite = e.target.closest("[data-edit-colis]");
  if (edite) return ouvreEdition(Number(edite.dataset.editColis));

  if (e.target.closest("[data-edit-cancel]")) return fermeEdition(e.target.closest(".imp-edit"));

  const drope = e.target.closest("[data-drop-colis]");
  if (drope) {
    const c = impColis.get(Number(drope.dataset.dropColis));
    return agir(
      drope,
      async () => {
        await postJSON(`/api/print/colis/${drope.dataset.dropColis}/drop`);
        eclat(drope, { nombre: 12 });
        await sortLigne(drope.closest(".imp-row"));
        await loadImprime();
      },
      { succes: `Colis dropé${c ? ` · ${euro(c.price)}` : ""}` }
    );
  }

  const supprime = e.target.closest("[data-del-colis]");
  if (supprime) {
    const ok = await confirmer({
      titre: "Retirer ce colis ?",
      message: "Son fichier sera aussi effacé sur Telegram.",
      action: "Retirer",
      danger: true,
    });
    if (!ok) return;
    return agir(
      supprime,
      async () => {
        await fetchJSON(`/api/print/colis/${supprime.dataset.delColis}`, { method: "DELETE" });
        await sortLigne(supprime.closest(".imp-row"));
        await loadImprime();
      },
      { succes: "Colis retiré" }
    );
  }
});

document.addEventListener("keydown", (e) => {
  const head = e.target.closest?.(".imp-cat-head");
  if (!head || e.target !== head || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  basculeCategorie(head.parentElement);
});

// Charge les colis d'une categorie et prepare leur HTML, sans toucher a la
// page. Une seule requete a la fois par categorie.
const impEnCours = new Map();
function chargeColis(code, scope) {
  const cle = `${scope}:${code}`;
  if (impEnCours.has(cle)) return impEnCours.get(cle);
  const promesse = fetchJSON(`/api/print/colis?categorie=${encodeURIComponent(code)}&scope=${scope}`)
    .then(({ colis }) => {
      for (const c of colis) impColis.set(c.id, c);
      const precedente = impMemoire.get(cle);
      const memoire = { html: colis.length ? lignesColis(colis, scope) : "", ids: colis.map((c) => c.id), connues: precedente?.ids || [] };
      impMemoire.set(cle, memoire);
      return memoire;
    })
    .finally(() => impEnCours.delete(cle));
  impEnCours.set(cle, promesse);
  return promesse;
}

// Deplier une categorie montre aussitot sa liste memorisee (prechargee a
// l'ouverture de l'onglet) : le depliage part avec la vraie hauteur, sans
// squelette ni saut. La liste se met a jour derriere si elle a change.
async function fillCategory(cat) {
  const liste = cat.querySelector(".imp-list");
  const { cat: code, scope } = cat.dataset;
  const cle = `${scope}:${code}`;
  const deja = impMemoire.get(cle);
  if (deja && liste.dataset.html !== deja.html && !liste.querySelector(".imp-edit")) poseListe(liste, deja, false);
  if (!deja && !liste.children.length) liste.innerHTML = squelettes(2);
  if (deja && !deja.perime && liste.dataset.html === deja.html) {
    // a jour : on verifie quand meme en fond, sans rien bloquer
    chargeColis(code, scope).then((m) => cat.isConnected && poseListe(liste, m, true)).catch(() => {});
    return;
  }
  try {
    poseListe(liste, await chargeColis(code, scope), true);
  } catch (err) {
    if (!deja) liste.innerHTML = vide("alert", "Liste indisponible", escapeHtml(err.message));
  }
}

function poseListe(liste, memoire, anime) {
  // rien de neuf : pas une ecriture dans la page
  if (liste.dataset.html === memoire.html) return;
  // un formulaire d'edition ouvert ne doit pas sauter
  if (liste.querySelector(".imp-edit")) return;
  liste.dataset.html = memoire.html;
  liste.innerHTML = memoire.html || vide("inbox", "Vide");
  if (!anime) return;
  const connues = new Set(memoire.connues);
  let n = 0;
  for (const ligne of liste.querySelectorAll(".imp-row")) {
    if (connues.has(Number(ligne.dataset.row))) continue;
    ligne.classList.add("arrive");
    ligne.style.setProperty("--n", Math.min(n++, 10));
  }
}

// Une etiquette deja imprimee n'a plus besoin d'etre supprimee d'ici : elle
// a besoin d'etre dropee quand on l'a postee, colis par colis.
function lignesColis(colis, scope) {
  const imprimee = scope === "printed";
  return colis
    .map(
      (c) => `<div class="imp-row${c.note ? " noted" : ""}" data-row="${c.id}">
        <div class="imp-row-main">
          <div class="imp-row-name">${
            c.special
              ? `<span class="imp-num${c.special.code ? "" : " sans-code"}" title="${
                  c.special.code ? "Code-barre lié" : "Code-barre pas encore arrivé"
                }">#${c.special.numero}${ico("key")}${c.special.code ? "" : "?"}</span>`
              : ""
          }${escapeHtml(c.fileName || `colis #${c.id}`)}</div>
          <div class="imp-row-sub">${escapeHtml(c.sender)} · ${euro(c.price)}${c.kind === "image" ? " · photo" : ""}</div>
          ${c.note ? `<div class="imp-row-note">${ico("note")}<span>${escapeHtml(c.note)}</span></div>` : ""}
        </div>
        <div class="imp-row-actions">
          <button class="btn btn-icon btn-sm btn-ghost" data-edit-colis="${c.id}" type="button" aria-label="Modifier" title="Modifier">${ico("edit")}</button>
          <button class="btn btn-icon btn-sm btn-ghost" data-print-one="${c.id}" data-scope="${scope}" type="button" aria-label="Imprimer" title="Imprimer">${ico("printer")}</button>
          ${
            imprimee
              ? `<button class="btn btn-sm btn-tinted imp-drop" data-drop-colis="${c.id}" type="button">${ico("send")}<span>Drop</span></button>`
              : `<button class="btn btn-icon btn-sm btn-ghost" data-del-colis="${c.id}" type="button" aria-label="Retirer" title="Retirer">${ico("trash")}</button>`
          }
        </div>
      </div>`
    )
    .join("");
}

// A l'ouverture de l'onglet, les listes se chargent en fond, quelques-unes a
// la fois : deplier une categorie est ensuite instantane.
async function prechargeCategories(resumes) {
  const aCharger = resumes.flatMap(({ scope, categories }) =>
    (categories || []).filter((c) => {
      const m = impMemoire.get(`${scope}:${c.code}`);
      return !m || m.perime || m.ids.length !== c.count;
    }).map((c) => [c.code, scope])
  );
  const travail = async () => {
    while (aCharger.length) {
      const [code, scope] = aCharger.shift();
      await chargeColis(code, scope).catch(() => {});
    }
  };
  await Promise.all([travail(), travail(), travail()]);
}

// --- Edition d'un colis ------------------------------------------------------------
// Prix, transporteur, note : les trois choses qu'on corrige a la main. Le
// formulaire se deplie sous la ligne, sans quitter la liste.

function fermeEdition(form) {
  if (!form) return;
  if (prefersReducedMotion) return form.remove();
  form.classList.add("is-leaving");
  setTimeout(() => form.remove(), 200);
}

function ouvreEdition(id) {
  const ligne = document.querySelector(`.imp-row[data-row="${id}"]`);
  if (!ligne) return;
  // un deuxieme appui referme
  const deja = ligne.nextElementSibling;
  if (deja && deja.classList.contains("imp-edit")) return fermeEdition(deja);
  document.querySelectorAll(".imp-edit").forEach(fermeEdition);
  haptique();

  const c = impColis.get(id);
  const options = [`<option value="">— non reconnu —</option>`]
    .concat(
      impTransporteurs.map(
        (t) => `<option value="${escapeAttr(t.code)}"${t.code === c.carrier ? " selected" : ""}>${escapeHtml(t.label)}</option>`
      )
    )
    .join("");

  ligne.insertAdjacentHTML(
    "afterend",
    `<form class="imp-edit" data-edit-form="${id}">
      <div class="imp-edit-grid">
        <label class="field-label">
          <span>Prix €</span>
          <input class="field" name="price" type="text" inputmode="decimal" value="${escapeAttr(String(c.price).replace(".", ","))}" />
        </label>
        <label class="field-label">
          <span>Transporteur</span>
          <select class="field" name="carrier">${options}</select>
        </label>
      </div>
      <label class="field-label">
        <span>Note</span>
        <textarea class="field" name="note" rows="2" placeholder="fragile, avant 14h…">${escapeHtml(c.note || "")}</textarea>
      </label>
      <div class="imp-edit-actions">
        <button type="button" class="btn btn-sm btn-ghost" data-edit-cancel>Annuler</button>
        <button type="submit" class="btn btn-sm btn-primary">Enregistrer</button>
      </div>
    </form>`
  );
  const champ = ligne.nextElementSibling.querySelector("input");
  champ.addEventListener("input", () => champ.classList.remove("invalid"));
  champ.focus({ preventScroll: true });
  ligne.nextElementSibling.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion ? "auto" : "smooth" });
}

// On n'envoie que ce qui a change : renvoyer le prix tel quel le figerait
// contre les futurs changements de tarif de l'expediteur.
async function enregistreEdition(form) {
  const id = Number(form.dataset.editForm);
  const c = impColis.get(id);
  const champs = new FormData(form);
  const corps = {};

  const prix = String(champs.get("price")).trim().replace(",", ".");
  if (prix === "" || !Number.isFinite(Number(prix)) || Number(prix) < 0) {
    rejoue(form.querySelector("input[name=price]"), "invalid", 1400);
    return;
  }
  if (Number(prix) !== c.price) corps.price = Number(prix);

  const transporteur = champs.get("carrier") || null;
  if (transporteur !== (c.carrier || null)) corps.carrier = transporteur;

  const note = String(champs.get("note")).trim();
  if (note !== (c.note || "")) corps.note = note;

  if (Object.keys(corps).length === 0) return fermeEdition(form);

  await agir(
    form.querySelector("[type=submit]"),
    async () => {
      const res = await fetchJSON(`/api/print/colis/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      });
      // corriger un transporteur apprend au bot, comme /transporteur : autant
      // dire ce qu'il a retenu, et s'il a reclasse d'autres colis au passage
      if (res.appris) signaleImprime(res.appris);
      fermeEdition(form);
      await attends(200);
      await loadImprime();
    },
    { succes: "Colis modifié" }
  );
}

function signaleImprime(texte) {
  const box = $("imp-notice");
  box.innerHTML = `${ico("bolt")}<span></span>`;
  box.lastChild.textContent = texte;
  box.hidden = false;
  rejoue(box, "revele", 900);
  clearTimeout(signaleImprime.minuteur);
  signaleImprime.minuteur = setTimeout(() => masque(box), 7000);
}

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-edit-form]");
  if (!form) return;
  e.preventDefault();
  enregistreEdition(form);
});

// Sur ordinateur, l'onglet s'ouvre AVANT la construction du PDF : un
// navigateur ne laisse ouvrir une fenetre que pendant le clic, pas apres un
// aller-retour reseau. Sur iPhone, cet onglet vide recouvrait toute l'app
// pendant la construction (l'app semblait bloquee) : on construit d'abord,
// puis un message "PDF pret" ouvre le PDF d'un appui.
async function lancerImpression(bouton, corps) {
  if (bouton.getAttribute("aria-busy") === "true") return;
  const onglet = surIPhone ? null : window.open("", "_blank");
  occupe(bouton, true);
  haptique();

  let res = null;
  try {
    res = await postJSON("/api/print/build", corps, { delai: 120000 });
  } catch (err) {
    if (onglet) onglet.close();
    occupe(bouton, false);
    secoue(bouton);
    toast(`Impression impossible : ${err.message}`, "error");
    return;
  }

  // rendre son etat au bouton AVANT le rafraichissement : dans l'autre ordre,
  // le compte revient alors qu'il ne reste plus rien
  occupe(bouton, false);
  fait(bouton);
  eclat(bouton, { nombre: 10, force: 0.9 });

  if (onglet) onglet.location = res.url;
  else if (!surIPhone) window.location = res.url; // fenetre bloquee : on y va quand meme

  // Un bloqueur de fenetres avale parfois l'onglet sans rien dire. Le lien
  // reste affiche : il y a toujours quelque chose a toucher pour ouvrir le
  // PDF, et il sert aussi a le rouvrir sans le reconstruire.
  const detail = res.roll
    ? `${pluriel(res.count, "étiquette", "étiquettes")} · ${res.lengthMm} mm de rouleau`
    : `${pluriel(res.count, "étiquette", "étiquettes")} · ${pluriel(res.pages, "page", "pages")}`;
  const lien = $("imp-last");
  lien.href = res.url;
  lien.innerHTML = `${ico("file")}<span>Rouvrir le PDF · ${escapeHtml(detail)}</span>${ico("external")}`;
  montre(lien);
  if (surIPhone) toast(`PDF prêt · ${detail} · Ouvrir`, "success", 9000, { lien: res.url });
  else toast(`PDF prêt · ${detail}`);

  // ce qui n'a pas pu entrer dans le PDF : on le dit (il reste a imprimer)
  const absentes = (res.missing || 0) + (res.failed || 0);
  if (absentes > 0) {
    const raison = res.absents?.[0]?.reason ? ` (${res.absents[0].reason})` : "";
    toast(
      `⚠️ ${pluriel(absentes, "étiquette n'a pas pu être ajoutée", "étiquettes n'ont pas pu être ajoutées")}${raison} : ${absentes > 1 ? "elles restent" : "elle reste"} à imprimer.`,
      "error",
      9000
    );
  }

  // Les etiquettes sont marquees imprimees quand le PDF s'ouvre (pas avant) :
  // la liste se met a jour une fois l'onglet charge.
  await loadImprime();
  setTimeout(() => loadImprime().catch(() => {}), 2500);
}

$("imp-all").addEventListener("click", (e) => lancerImpression(e.currentTarget, { categorie: "*", scope: "new" }));

// --- « Choisir » : les transporteurs a imprimer ----------------------------------
// Une seule liasse avec les transporteurs coches (thermique 4x6 : les LIT
// gardent leur categorie, ils sortent sur le rouleau). Le choix est retenu
// d'une fois sur l'autre.
const impChoix = { categories: [], selection: new Set() };

function impChoixRetenu() {
  try {
    return new Set(JSON.parse(localStorage.getItem("imp-choix") || "[]"));
  } catch {
    return new Set();
  }
}

function ouvreChoixImpression() {
  impChoix.categories = (impAFaire?.categories || []).filter((c) => !c.roll && c.count > 0);
  if (!impChoix.categories.length) return;
  const codes = impChoix.categories.map((c) => c.code);
  const retenu = [...impChoixRetenu()].filter((c) => codes.includes(c));
  impChoix.selection = new Set(retenu.length ? retenu : codes);
  rendChoixImpression();
  const couche = $("imp-choix-sheet");
  couche.classList.remove("closing");
  couche.hidden = false;
  haptique();
  requestAnimationFrame(() => $("imp-choix-imprimer").focus({ preventScroll: true }));
}

function fermeChoixImpression() {
  const couche = $("imp-choix-sheet");
  if (couche.hidden) return;
  couche.classList.add("closing");
  setTimeout(() => {
    couche.hidden = true;
    couche.classList.remove("closing");
  }, prefersReducedMotion ? 0 : 260);
}

function rendChoixImpression() {
  const sel = impChoix.selection;
  $("imp-choix-puces").innerHTML = impChoix.categories
    .map(
      (c) => `
    <button class="tour-puce carrier" type="button" data-code="${escapeAttr(c.code)}" data-carrier="${escapeAttr(c.code)}" aria-pressed="${sel.has(c.code)}">
      <i class="carrier-dot"></i><span>${escapeHtml(c.label)}</span><b>${entier(c.count)}</b>
    </button>`
    )
    .join("");
  const pris = impChoix.categories.filter((c) => sel.has(c.code));
  const count = pris.reduce((n, c) => n + c.count, 0);
  const notees = pris.reduce((n, c) => n + (c.noted || 0), 0);
  $("imp-choix-tout").textContent = pris.length === impChoix.categories.length ? "Aucun" : "Tout";
  $("imp-choix-resume").innerHTML = pris.length
    ? `<b>${pluriel(count, "étiquette", "étiquettes")}</b> à imprimer${notees ? ` · ${pluriel(notees, "annotée", "annotées")} sur le dessus` : ""}`
    : "Choisis au moins un transporteur.";
  $("imp-choix-imprimer").disabled = pris.length === 0;
}

$("imp-choisir").addEventListener("click", ouvreChoixImpression);
$("imp-choix-puces").addEventListener("click", (e) => {
  const puce = e.target.closest(".tour-puce");
  if (!puce) return;
  const code = puce.dataset.code;
  if (impChoix.selection.has(code)) impChoix.selection.delete(code);
  else impChoix.selection.add(code);
  haptique();
  rendChoixImpression();
});
$("imp-choix-tout").addEventListener("click", () => {
  const tous = impChoix.categories.map((c) => c.code);
  impChoix.selection = new Set(impChoix.selection.size === tous.length ? [] : tous);
  haptique();
  rendChoixImpression();
});
$("imp-choix-sheet").addEventListener("click", (e) => {
  if (e.target.closest("[data-imp-choix-fermer]")) fermeChoixImpression();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") fermeChoixImpression();
});
$("imp-choix-imprimer").addEventListener("click", () => {
  const categories = impChoix.categories.map((c) => c.code).filter((c) => impChoix.selection.has(c));
  if (!categories.length) return;
  try {
    localStorage.setItem("imp-choix", JSON.stringify(categories));
  } catch {
    /* navigation privee : le choix ne sera pas retenu */
  }
  fermeChoixImpression();
  // (dans le meme geste que le clic : l'onglet du PDF n'est pas bloque)
  lancerImpression($("imp-choisir"), { categories, scope: "new" });
});

