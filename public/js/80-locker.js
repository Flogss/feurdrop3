// --- Mode locker ------------------------------------------------------------------
// Devant le locker : on prend un colis, on lit le "#3" imprime dans la bande de
// son etiquette, le telephone montre le code-barre #3. La visionneuse suit
// l'ordre des numeros, donc l'ordre de la liasse imprimee.

let lockerPaires = [];
let lockerIndex = 0;
let lockerVerrou = null;

async function loadSpecialCount() {
  try {
    const { paires } = await fetchJSON("/api/special/paires");
    const badge = $("special-link-count");
    const texte = paires.length ? String(paires.length) : "";
    if (badge.textContent !== texte) {
      badge.textContent = texte;
      if (texte) rejoue(badge, "is-bump", 600);
    }
  } catch {
    // le compteur est un confort : une erreur ici ne doit rien casser
  }
}

async function loadSpecial() {
  const liste = $("special-list");
  if (!liste.children.length) liste.innerHTML = squelettes(2);
  let paires;
  try {
    ({ paires } = await fetchJSON("/api/special/paires"));
  } catch (err) {
    liste.innerHTML = vide("alert", "Liste indisponible", escapeHtml(err.message));
    return;
  }

  lockerPaires = paires;
  const avecCode = paires.filter((p) => p.code).length;
  $("special-count").textContent = paires.length
    ? `${pluriel(paires.length, "paire", "paires")} · ${pluriel(avecCode, "code arrivé", "codes arrivés")}`
    : "Aucun code en attente";
  $("special-link-count").textContent = paires.length ? String(paires.length) : "";
  const depart = $("special-start");
  depart.disabled = paires.length === 0;
  depart.lastElementChild.textContent = paires.length ? `Commencer au #${paires[0].numero}` : "Commencer";

  if (paires.length === 0) {
    liste.innerHTML = vide("key", "Aucun code en attente", "Les codes postés dans le topic spécial arriveront ici.");
    return;
  }

  // une paire incomplete se voit tout de suite : c'est avant de partir qu'il
  // faut s'en rendre compte, pas devant le locker
  liste.innerHTML = paires
    .map((p, i) => {
      // un code seul n'attend aucun PDF : il n'est pas incomplet
      const manque = !p.code ? "Code manquant" : !p.colis && !p.seul ? "PDF manquant" : "";
      const etat = manque
        ? `<span class="sp-state ko">${manque}</span>`
        : p.seul
          ? `<span class="sp-state">Code seul</span>`
          : p.colis?.printed
            ? `<span class="sp-state ok">Imprimé</span>`
            : `<span class="sp-state">À imprimer</span>`;
      return `<button class="sp-card${manque ? " incomplete" : ""} is-new" style="--n:${Math.min(i, 10)}" data-locker="${i}" type="button">
        <span class="sp-top"><span class="sp-num">#${p.numero}</span>${etat}</span>
        ${
          p.code
            ? `<img class="sp-thumb" loading="lazy" src="/api/special/code/${p.id}" alt="Code #${p.numero}" />`
            : `<span class="sp-thumb sp-thumb-vide">${ico("key")}</span>`
        }
        <span class="sp-name">${escapeHtml(p.colis?.fileName || (p.seul ? "Sans colis" : "PDF pas encore arrivé"))}</span>
        <span class="sp-sub">${escapeHtml(p.sender || "")}</span>
      </button>`;
    })
    .join("");
}

function ouvreLocker(index) {
  if (lockerPaires.length === 0) return;
  lockerIndex = Math.max(0, Math.min(index, lockerPaires.length - 1));
  $("locker").hidden = false;
  document.body.classList.add("locker-ouvert");
  haptique();
  // Plein ecran quand le navigateur le permet (Android) : la barre d'adresse
  // et celle du systeme laissent leur place au code. Sur iPhone, l'app
  // ajoutee a l'ecran d'accueil est deja en plein ecran.
  document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch(() => {});
  afficheLocker(0);
  garderEcranAllume();
}

function fermeLocker() {
  $("locker").hidden = true;
  document.body.classList.remove("locker-ouvert");
  if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
  if (lockerVerrou) lockerVerrou.release().catch(() => {});
  lockerVerrou = null;
  loadSpecial();
}

// Le code occupe toute la zone libre. Un code-barre, plus large que haut, est
// tourne d'un quart de tour quand le telephone est tenu droit : il court alors
// sur toute la hauteur de l'ecran au lieu d'une bande de la largeur -- a peu
// pres deux fois plus grand, et c'est la taille des barres qui compte pour le
// lecteur. Un QR code, carre, reste droit.
function ajusteCode() {
  const img = $("locker-img");
  const zone = $("locker-code");
  if (img.hidden || !img.naturalWidth) return;

  const largeur = zone.clientWidth;
  const hauteur = zone.clientHeight;
  const ratio = img.naturalWidth / img.naturalHeight;
  const tourner = ratio > 1.15 && hauteur > largeur;

  // dimensions de l'image AVANT rotation : tournee, sa largeur court le long
  // de la hauteur de la zone
  const longueurDispo = tourner ? hauteur : largeur;
  const epaisseurDispo = tourner ? largeur : hauteur;
  let w = longueurDispo;
  let h = w / ratio;
  if (h > epaisseurDispo) {
    h = epaisseurDispo;
    w = h * ratio;
  }
  img.style.width = `${Math.floor(w)}px`;
  img.style.height = `${Math.floor(h)}px`;
  img.classList.toggle("tourne", tourner);
}

$("locker-img").addEventListener("load", ajusteCode);
window.addEventListener("resize", () => {
  if (!$("locker").hidden) ajusteCode();
});

// `sens` : d'ou arrive le code (1 = de la droite quand on avance)
function afficheLocker(sens = 0) {
  const p = lockerPaires[lockerIndex];
  const num = $("locker-num");
  num.textContent = `#${p.numero}`;
  if (sens) rejoue(num, "swap", 450);
  $("locker-pos").textContent = `${lockerIndex + 1} / ${lockerPaires.length}`;

  const img = $("locker-img");
  img.hidden = !p.code;
  $("locker-missing").hidden = Boolean(p.code);
  if (p.code) {
    const src = `/api/special/code/${p.id}`;
    if (img.getAttribute("src") !== src) {
      img.classList.remove("vient-droite", "vient-gauche");
      void img.offsetWidth;
      if (sens) img.classList.add(sens > 0 ? "vient-droite" : "vient-gauche");
      img.src = src;
    }
    // deja en cache : "load" ne repassera pas, on ajuste tout de suite
    if (img.complete) ajusteCode();
  }

  $("locker-file").textContent = p.colis?.fileName || (p.seul ? "Code seul — aucun colis" : "PDF pas encore arrivé");
  $("locker-sub").textContent = [p.sender, p.colis?.note ? `Note : ${p.colis.note}` : ""].filter(Boolean).join(" · ");

  const bouton = $("locker-drop");
  // un code seul n'a pas de colis a droper : "Fait" le retire une fois utilise
  bouton.disabled = !p.colis && !p.seul;
  desarmeDrop();
  $("locker-prev").disabled = lockerIndex === 0;
  $("locker-next").disabled = lockerIndex === lockerPaires.length - 1;

  // le suivant est deja charge quand on balaie
  const suivant = lockerPaires[lockerIndex + 1];
  if (suivant?.code) new Image().src = `/api/special/code/${suivant.id}`;
}

function bougeLocker(pas) {
  const cible = lockerIndex + pas;
  if (cible < 0 || cible >= lockerPaires.length) return;
  lockerIndex = cible;
  haptique();
  afficheLocker(pas);
}

// L'ecran qui s'eteint au moment de scanner, c'est ce qui arrive toujours.
async function garderEcranAllume() {
  try {
    if ("wakeLock" in navigator) lockerVerrou = await navigator.wakeLock.request("screen");
  } catch {
    // refuse (batterie faible, navigateur) : on fait sans
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("locker").hidden) garderEcranAllume();
});

// "Depose" en deux appuis : un drop ne s'annule pas, et devant un locker on a
// vite fait de toucher le mauvais bouton.
let dropArme = null;

function desarmeDrop() {
  clearTimeout(dropArme);
  dropArme = null;
  const bouton = $("locker-drop");
  bouton.classList.remove("arme");
  const p = lockerPaires[lockerIndex];
  bouton.textContent = p?.seul && !p?.colis ? "Fait" : "Déposé";
}

$("locker-drop").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  const p = lockerPaires[lockerIndex];
  if (!p?.colis && !p?.seul) return;

  if (!dropArme) {
    bouton.classList.add("arme");
    bouton.textContent = "Confirmer ?";
    haptique();
    dropArme = setTimeout(desarmeDrop, 3000);
    return;
  }

  desarmeDrop();
  bouton.disabled = true;
  try {
    await postJSON(p.colis ? `/api/print/colis/${p.colis.id}/drop` : `/api/special/paires/${p.id}/fini`);
    haptique();
    rejoue($("locker"), "flash", 650);
    // le colis quitte la liste : on reste a la meme place, qui montre le suivant
    lockerPaires.splice(lockerIndex, 1);
    if (lockerPaires.length === 0) {
      fermeLocker();
      toast("Locker terminé, tout est déposé");
      return;
    }
    lockerIndex = Math.min(lockerIndex, lockerPaires.length - 1);
    afficheLocker(1);
  } catch (err) {
    bouton.disabled = false;
    toast(err.message, "error");
  }
});

$("locker-prev").addEventListener("click", () => bougeLocker(-1));
$("locker-next").addEventListener("click", () => bougeLocker(1));
$("locker-close").addEventListener("click", fermeLocker);
$("special-start").addEventListener("click", () => ouvreLocker(0));
$("special-link").addEventListener("click", () => switchView("special"));
$("special-back").addEventListener("click", () => switchView("dashboard"));

$("special-list").addEventListener("click", (e) => {
  const carte = e.target.closest("[data-locker]");
  if (carte) ouvreLocker(Number(carte.dataset.locker));
});

document.addEventListener("keydown", (e) => {
  if ($("locker").hidden) return;
  if (e.key === "ArrowLeft") bougeLocker(-1);
  if (e.key === "ArrowRight") bougeLocker(1);
  if (e.key === "Escape") fermeLocker();
});

// balayage : a une main, le colis dans l'autre
{
  let departX = null;
  const zone = $("locker-code");
  zone.addEventListener("touchstart", (e) => (departX = e.touches[0].clientX), { passive: true });
  zone.addEventListener("touchend", (e) => {
    if (departX === null) return;
    const ecart = e.changedTouches[0].clientX - departX;
    departX = null;
    if (Math.abs(ecart) > 50) bougeLocker(ecart < 0 ? 1 : -1);
  });
}

// Pas de zoom par pincement non plus. Safari sur iPhone ignore
// "user-scalable=no" : ses gestes de zoom se bloquent a la main.
for (const geste of ["gesturestart", "gesturechange"]) {
  document.addEventListener(geste, (e) => e.preventDefault(), { passive: false });
}

