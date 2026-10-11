// --- Controle des depots ------------------------------------------------------------
// Une question : le transporteur a-t-il pris en charge ce colis ? Le serveur
// interroge l'API officielle La Poste (La Poste, Colissimo, Chronopost, DPD) ;
// l'app Drop du Mac lit les pages officielles de Mondial Relay, DHL, FedEx et
// GLS quand on lance « Tout vérifier » ; UPS (consultation automatisee
// interdite par ses conditions) se constate a la main. Ouvrir la page ne fait
// que lire la base. Le statut FeurDrop et ce que dit le transporteur restent
// deux colonnes distinctes.

const depotsEtat = {
  donnees: null,
  filtre: "tous",
  transporteur: "",
  expediteur: "",
  recherche: "",
  charge: 0,
  suiviPassage: null,
  detail: null,
  serie: null, // constats a la suite : { ids, position }
  campagne: null,
  suiviCampagne: null,
  campagneMasquee: 0,
};

const DEPOTS_COURTS = { confirme: "Posté confirmé", non_confirme: "Non confirmé", a_verifier: "À vérifier", bloque: "Vérif. bloquée" };
const DEPOTS_ICONES = { confirme: "check", non_confirme: "clock", a_verifier: "search", bloque: "lock" };
const DEPOTS_LECTURES = { laposte: "API La Poste (officielle)", navigateur: "page officielle lue sur le Mac", manuel: "constat à la main" };
const DEPOTS_ETAPES = {
  info_received: "Étiquette créée",
  in_transit: "Pris en charge / en transit",
  out_for_delivery: "En cours de livraison",
  available_for_pickup: "Disponible au retrait",
  delivered: "Livré",
  exception: "Suite après prise en charge",
  unknown: "Statut non reconnu",
};

// "2026-10-09 12:32:00" (UTC du serveur) ou ISO -> "09/10 14:32"
function depotHeure(valeur) {
  if (!valeur) return "—";
  const d = /^\d{4}-\d{2}-\d{2} /.test(valeur) ? dateServeur(valeur) : new Date(valeur);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// l'heure d'un evenement telle que le transporteur la donne (heure locale) ;
// un constat fait ici est en UTC : il passe par l'heure du navigateur
function depotHeureTransporteur(texte) {
  if (!texte) return "—";
  if (/Z$/.test(texte)) return depotHeure(texte);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(texte);
  if (!m) return escapeHtml(texte);
  return m[4] ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : `${m[3]}/${m[2]}`;
}

function depotIlYa(valeur) {
  if (!valeur) return "jamais";
  const d = /^\d{4}-\d{2}-\d{2} /.test(valeur) ? dateServeur(valeur) : new Date(valeur);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

const depotManuel = (l) => l.transporteur.methode === "manuel";

// Ce que le transporteur dit, en quelques mots (colonne "Contrôle").
function depotStatutTransporteur(l) {
  const c = l.controle;
  if (c.dernierStatut) return c.dernierStatut.libelle;
  if (depotManuel(l)) return c.constat ? "Constaté à la main" : "Pas de lecture automatique";
  if (l.lecture?.statutBrut && l.erreur) return l.lecture.statutBrut;
  return l.verifieLe ? "Inconnu du transporteur" : l.transporteur.methode === "navigateur" ? "En attente du Mac" : "Pas encore vérifié";
}

async function loadDepots(force = false) {
  if (!force && Date.now() - depotsEtat.charge < 15000) return;
  depotsEtat.charge = Date.now();
  const box = $("depots-lignes");
  if (!depotsEtat.donnees) box.innerHTML = squelettes(4);
  try {
    const d = await fetchJSON("/api/depots");
    depotsEtat.donnees = d;
    rendDepots();
    majBadgeDepots(d.compteurs);
    if (d.etat.enCours) suisPassageDepots();
    rendCampagne(d.etat.campagne);
    if (d.etat.campagne?.campagne?.statut === "active") suisCampagne();
  } catch (err) {
    if (!depotsEtat.donnees) box.innerHTML = vide("alert", "Contrôle indisponible", escapeHtml(err.message));
  }
}

// La pastille de l'outil, sur le dashboard : combien de colis demandent un
// regard. Leger, et pas plus d'une fois par minute.
let depotsBadgeCharge = 0;
async function loadDepotsBadge() {
  if (Date.now() - depotsBadgeCharge < 60000) return;
  depotsBadgeCharge = Date.now();
  try {
    const r = await fetchJSON("/api/depots/resume", {}, { essais: 1 });
    majBadgeDepots(r.compteurs);
  } catch {
    /* la pastille attendra */
  }
}

function majBadgeDepots(c, etat = depotsEtat.donnees?.etat) {
  const badge = $("depots-link-count");
  const sub = $("depots-link-sub");
  if (!badge || !c) return;
  badge.textContent = c.attention ? entier(c.attention) : "";
  if (etat && !etat.methodes.laposte.configure) sub.textContent = "API La Poste à configurer";
  else if (c.attention) sub.textContent = pluriel(c.attention, "colis à regarder", "colis à regarder");
  else if (c.total) sub.textContent = `${pluriel(c.confirme, "dépôt confirmé", "dépôts confirmés")} sur ${entier(c.total)}`;
  else sub.textContent = "Preuves de prise en charge";
}

function rendDepots() {
  const d = depotsEtat.donnees;
  if (!d) return;
  const { compteurs: c, etat } = d;

  for (const cat of Object.keys(DEPOTS_COURTS)) compte($(`depots-n-${cat}`), c[cat]);
  $("depots-n-hors-delai").textContent = c.nonConfirmeHorsDelai
    ? `dont ${pluriel(c.nonConfirmeHorsDelai, "hors délai", "hors délai")}`
    : "étiquette seule, pas de prise en charge";
  $("depots-n-a-constater").textContent = c.aConstater ? `dont ${pluriel(c.aConstater, "à constater", "à constater")}` : "site protégé, en pause ou à la main";
  document.querySelectorAll(".depot-metric").forEach((b) => b.classList.toggle("active", b.dataset.depotsFiltre === depotsEtat.filtre));

  $("depots-sub").textContent = c.total
    ? `${pluriel(c.total, "colis dropé", "colis dropés")} sur ${entier(etat.affichageJours)} jours${c.attention ? ` · ${pluriel(c.attention, "à regarder", "à regarder")}` : ""}`
    : `Aucun colis dropé avec un numéro de suivi sur ${entier(etat.affichageJours)} jours`;

  rendPassageDepots(etat, c);
  rendBandeauDepots(etat);
  rendMethodesDepots(etat);
  rendChoixDepots(d.lignes);
  rendLignesDepots();
}

function rendPassageDepots(etat, c) {
  const lp = etat.methodes.laposte;
  $("depots-synchro-point").classList.toggle("is-busy", etat.enCours);
  $("depots-synchro").textContent = etat.enCours
    ? "Vérifications en cours…"
    : etat.derniereSynchro
      ? `Dernier passage : ${depotHeure(etat.derniereSynchro)} (${depotIlYa(etat.derniereSynchro)})`
      : "Pas encore de passage";
  const morceaux = [];
  const b = etat.dernierBilan;
  if (b && !etat.enCours) {
    const faits = [];
    if (b.verifies) faits.push(pluriel(b.verifies, "colis vérifié", "colis vérifiés"));
    if (b.nouveauxEvenements) faits.push(pluriel(b.nouveauxEvenements, "nouvel événement", "nouveaux événements"));
    if (b.erreurs) faits.push(pluriel(b.erreurs, "erreur", "erreurs"));
    if (b.reportes) faits.push(pluriel(b.reportes, "reporté", "reportés"));
    if (faits.length) morceaux.push(faits.join(" · "));
  }
  morceaux.push(etat.file.enAttente ? pluriel(etat.file.enAttente, "vérification en attente", "vérifications en attente") : "rien en attente");
  if (lp.pause) morceaux.push(`La Poste en pause jusqu'à ${depotHeure(lp.pause.jusqua)}`);
  $("depots-synchro-detail").textContent = morceaux.join(" · ");

  const bouton = $("depots-relancer");
  bouton.disabled = !lp.configure || Boolean(lp.pause);
  bouton.title = !lp.configure ? "API La Poste non configurée" : lp.pause ? "La Poste a demandé une pause : la file reprendra seule" : "";
  bouton.setAttribute("aria-busy", etat.enCours ? "true" : "false");
  $("depots-constater").hidden = !c.aConstater;
  $("depots-constater-n").textContent = entier(c.aConstater);
}

function rendBandeauDepots(etat) {
  const lp = etat.methodes.laposte;
  const bandeau = $("depots-bandeau");
  let html = "";
  if (!lp.configure) {
    html = `${ico("info")}<span><b>L'API La Poste n'est pas configurée.</b> Ajoute la variable <code>OKAPI_KEY</code> sur le serveur (Railway) : sans elle, aucun colis n'est vérifié automatiquement.</span>`;
  } else if (lp.pause) {
    html = `${ico("lock")}<span><b>Vérifications La Poste en pause jusqu'à ${escapeHtml(depotHeure(lp.pause.jusqua))}</b> : ${escapeHtml(lp.pause.motif)}. Rien n'est forcé : les colis sans lecture passent en « Vérification bloquée », leur suivi officiel reste accessible, et la file reprend seule ensuite.</span>`;
  } else if (etat.derniereErreur) {
    html = `${ico("alert")}<span><b>Dernier passage interrompu</b> (${escapeHtml(depotHeure(etat.derniereErreur.at))}) : ${escapeHtml(etat.derniereErreur.message)}</span>`;
  }
  bandeau.hidden = !html;
  bandeau.classList.toggle("is-info", !lp.configure);
  bandeau.innerHTML = html;
}

// Une puce par transporteur present : comment ses colis sont verifies (et,
// pour les pages lues sur le Mac, l'interrupteur de lecture automatique).
function rendMethodesDepots(etat) {
  const box = $("depots-methodes");
  const lp = etat.methodes.laposte;
  const lectures = new Map((etat.lecture || []).map((l) => [l.code, l]));
  const html = etat.transporteurs
    .map((t) => {
      const lecture = lectures.get(t.code);
      let etatPuce;
      if (lecture && !lecture.active) etatPuce = ["is-manuel", "edit", "lecture coupée", "La lecture automatique sur le Mac est coupée : constat à la main"];
      else if (t.methode === "manuel") etatPuce = ["is-manuel", "edit", "à la main", "Consultation automatisée interdite par les conditions du transporteur : constat sur la page officielle"];
      else if (t.methode === "navigateur")
        etatPuce = t.pause
          ? ["is-pause", "lock", "bloqué", `Le site a affiché une vérification anti-robot : nouvel essai après ${depotHeure(t.pause.jusqua)} (ou « Tout vérifier »)`]
          : ["is-auto", "bolt", "lu sur le Mac", "La page officielle est lue par l'app Drop du Mac (« Tout vérifier »)"];
      else if (!lp.configure) etatPuce = ["is-pause", "info", "non configuré", "OKAPI_KEY manquante sur le serveur"];
      else if (lp.pause) etatPuce = ["is-pause", "clock", "en pause", `Pause demandée par La Poste jusqu'à ${depotHeure(lp.pause.jusqua)}`];
      else etatPuce = ["is-auto", "bolt", "automatique", lp.nom];
      const [classe, icone, texte, titre] = etatPuce;
      const bascule = lecture
        ? `<button class="depot-methode-bascule" type="button" data-lecture="${escapeAttr(t.code)}" data-active="${lecture.active ? "1" : "0"}" title="${lecture.active ? "Couper la lecture automatique" : "Rallumer la lecture automatique"}" aria-pressed="${lecture.active}">${lecture.active ? "auto" : "manuel"}</button>`
        : "";
      return (
        `<span class="depot-methode ${classe}" title="${escapeAttr(titre)}">` +
        `<span class="carrier depot-transporteur" data-carrier="${escapeAttr(t.code)}"><i class="carrier-dot"></i>${escapeHtml(t.nom)}</span>` +
        `<span class="depot-methode-etat">${ico(icone)}${texte}</span><span class="depot-methode-n">${entier(t.colis)}</span>${bascule}</span>`
      );
    })
    .join("");
  if (box._html !== html) {
    box.innerHTML = html;
    box._html = html;
  }
  box.hidden = !html;
}

$("depots-methodes").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lecture]");
  if (!b) return;
  const active = b.dataset.active !== "1";
  agir(
    b,
    async () => {
      await postJSON(`/api/depots/lecture/${b.dataset.lecture}`, { active });
      await loadDepots(true);
    },
    { succes: active ? "Lecture automatique rallumée" : "Lecture automatique coupée : constat à la main" }
  );
});

function rendChoixDepots(lignes) {
  const remplit = (select, valeurs, tous, actuel) => {
    const html =
      `<option value="">${tous}</option>` +
      valeurs.map(([v, libelle]) => `<option value="${escapeAttr(v)}"${v === actuel ? " selected" : ""}>${escapeHtml(libelle)}</option>`).join("");
    if (select._html !== html) {
      select.innerHTML = html;
      select._html = html;
    }
  };
  const transporteurs = new Map(lignes.map((l) => [l.transporteur.code, l.transporteur.nom]));
  const expediteurs = new Map(lignes.map((l) => [l.expediteur, l.expediteur]));
  const tri = (m) => [...m].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  remplit($("depots-transporteur"), tri(transporteurs), "Tous les transporteurs", depotsEtat.transporteur);
  remplit($("depots-expediteur"), tri(expediteurs), "Tous les expéditeurs", depotsEtat.expediteur);
}

function depotsFiltrees() {
  const { lignes } = depotsEtat.donnees;
  const q = depotsEtat.recherche.replace(/\s+/g, "").toUpperCase();
  return lignes.filter((l) => {
    if (depotsEtat.filtre === "attention" && !l.attention) return false;
    if (!["tous", "attention"].includes(depotsEtat.filtre) && l.controle.categorie !== depotsEtat.filtre) return false;
    if (depotsEtat.transporteur && l.transporteur.code !== depotsEtat.transporteur) return false;
    if (depotsEtat.expediteur && l.expediteur !== depotsEtat.expediteur) return false;
    if (q && !l.numero.includes(q)) return false;
    return true;
  });
}

function ligneDepot(l) {
  const c = l.controle;
  const dernier = c.dernierEvenement;
  const manuel = depotManuel(l);
  const verdict = c.categorie === "non_confirme" && c.enRetard ? "Non confirmé · hors délai" : DEPOTS_COURTS[c.categorie];
  const quand = manuel ? (c.constat ? `constaté ${depotIlYa(c.constat.le)}` : "à constater") : depotIlYa(l.verifieLe || l.essaiLe);
  const numero = escapeAttr(l.numero);
  return `
    <div class="depot-ligne cat-${escapeAttr(c.categorie)}${l.attention ? " attention" : ""}" data-key="${l.colisId}" data-depot="${l.colisId}">
      <div class="depot-cell depot-colis">
        <button class="depot-numero" type="button" aria-label="Détail du colis ${numero}">${escapeHtml(l.numero)}</button>
        <span class="depot-sous"><span class="carrier depot-transporteur" data-carrier="${escapeAttr(l.transporteur.code)}"><i class="carrier-dot"></i>${escapeHtml(l.transporteur.nom)}</span> · ${escapeHtml(l.expediteur)}</span>
      </div>
      <div class="depot-cell depot-interne">
        <span class="depot-interne-statut">Dropé</span>
        <span class="depot-sous">${escapeHtml(depotHeure(l.statutInterne.dropeLe))}</span>
      </div>
      <div class="depot-cell depot-verdict">
        <span class="depot-badge cat-${escapeAttr(c.categorie)}">${ico(DEPOTS_ICONES[c.categorie])}${escapeHtml(verdict)}</span>
        <span class="depot-sous">${escapeHtml(depotStatutTransporteur(l))}${c.suite ? ` · ${escapeHtml(c.suite.retour ? "retour" : c.suite.etape === "delivered" ? "livré" : "suite")}` : c.livre ? " · livré" : ""}</span>
      </div>
      <div class="depot-cell depot-evenement">
        <span class="depot-evenement-texte">${dernier ? escapeHtml(dernier.statut) : manuel && !c.constat ? "À constater sur la page officielle" : "—"}</span>
        <span class="depot-sous">${dernier ? `${depotHeureTransporteur(dernier.le)}${dernier.lieu ? ` · ${escapeHtml(dernier.lieu)}` : ""}` : escapeHtml(c.raison)}</span>
      </div>
      <div class="depot-cell depot-verifie">
        <span class="depot-sous">${l.erreur ? `<span class="depot-erreur">${ico("alert")}erreur</span> · ` : ""}${escapeHtml(quand)}</span>
      </div>
      <div class="depot-actions">
        ${manuel ? "" : `<button class="icon-btn icon-btn-sm" type="button" data-depot-verifier title="Vérifier maintenant" aria-label="Vérifier ${numero} maintenant">${ico("refresh")}</button>`}
        ${l.lien ? `<a class="icon-btn icon-btn-sm" href="${escapeAttr(l.lien)}" target="_blank" rel="noopener noreferrer" title="Suivi officiel" aria-label="Suivi officiel de ${numero}">${ico("external")}</a>` : ""}
      </div>
    </div>`;
}

function rendLignesDepots() {
  const lignes = depotsFiltrees();
  const d = depotsEtat.donnees;
  const filtreActif = depotsEtat.filtre !== "tous" || depotsEtat.transporteur || depotsEtat.expediteur || depotsEtat.recherche;
  rendListe($("depots-lignes"), lignes, {
    cle: (l) => l.colisId,
    html: ligneDepot,
    videHtml: filtreActif
      ? vide("search", "Aucun colis ne correspond", "Change de filtre ou de recherche.")
      : vide("inbox", "Aucun colis dropé à contrôler", "Les colis dropés avec un numéro de suivi apparaîtront ici."),
  });
  const pied = [];
  if (filtreActif) pied.push(`${pluriel(lignes.length, "colis affiché", "colis affichés")} sur ${entier(d.lignes.length)}`);
  for (const h of d.compteurs.horsControle || []) pied.push(pluriel(h.colis, `colis ${h.nom} non contrôlé`, `colis ${h.nom} non contrôlés`));
  if (d.compteurs.sansNumero) pied.push(`${pluriel(d.compteurs.sansNumero, "colis dropé sans numéro de suivi lisible", "colis dropés sans numéro de suivi lisible")} (non contrôlables)`);
  $("depots-pied").textContent = pied.join(" · ");
}

// --- Passages ------------------------------------------------------------------------

function suisPassageDepots() {
  if (depotsEtat.suiviPassage) return;
  const debut = Date.now();
  depotsEtat.suiviPassage = setInterval(async () => {
    await loadDepots(true);
    const fini = !depotsEtat.donnees?.etat.enCours;
    if (fini || Date.now() - debut > 10 * 60 * 1000 || currentView !== "depots") {
      clearInterval(depotsEtat.suiviPassage);
      depotsEtat.suiviPassage = null;
      if (fini && currentView === "depots") toast("Vérifications terminées", "info");
    }
  }, 3000);
}

$("depots-relancer").addEventListener("click", (e) =>
  agir(
    e.currentTarget,
    async () => {
      await postJSON("/api/depots/relancer");
      await loadDepots(true);
      suisPassageDepots();
    },
    { succes: "Vérifications relancées, au rythme de La Poste : la page se met à jour au fil de l'eau" }
  )
);

// --- « Tout vérifier » : la campagne -------------------------------------------------------

function rendCampagne(etat) {
  depotsEtat.campagne = etat;
  const panneau = $("depots-campagne");
  const c = etat?.campagne;
  // une campagne finie depuis longtemps (ou masquee) ne s'affiche plus
  const recente = c && (c.statut === "active" || Date.now() - dateServeur(c.finLe || c.creeLe).getTime() < 6 * 3600 * 1000);
  if (!c || !recente || depotsEtat.campagneMasquee === c.id) {
    panneau.hidden = true;
    $("depots-tout").disabled = false;
    return;
  }
  panneau.hidden = false;
  const n = etat.compteurs;
  const active = c.statut === "active";
  panneau.classList.toggle("is-active", active);
  $("depots-tout").disabled = active;
  $("depots-tout").querySelector("span").textContent = active ? "Vérification en cours…" : "Tout vérifier";
  for (const k of ["total", "verifies", "restants", "confirmes", "nonConfirmes", "bloques", "erreurs", "aConstater"]) {
    const el = $(`campagne-n-${k}`);
    if (el._valeur !== n[k]) compte(el, n[k]);
    el.parentElement.classList.toggle("is-zero", !n[k] && !["total", "verifies", "restants"].includes(k));
  }
  const faits = n.total - n.restants;
  $("campagne-barre").style.setProperty("--p", n.total ? (faits / n.total).toFixed(4) : 1);
  const mac = etat.agent;
  const macActif = mac?.actif;
  $("campagne-titre").textContent = active ? "Vérification de tous les colis" : c.statut === "annulee" ? "Vérification annulée" : "Vérification terminée";
  let sous;
  if (active && etat.attendMac) {
    sous = macActif ? `L'app Drop du Mac lit les pages officielles (${escapeHtml(mac.nom)})…` : "En attente de l'app Drop sur le Mac : ouvre-la pour lire Mondial Relay, DHL, FedEx et GLS.";
  } else if (active) {
    sous = "L'API La Poste vérifie ses colis…";
  } else {
    sous = `${c.statut === "annulee" ? "Arrêtée" : "Finie"} ${depotIlYa(c.finLe)} · ${pluriel(n.verifies, "colis vérifié", "colis vérifiés")}`;
  }
  $("campagne-sous").innerHTML = sous;
  $("campagne-app").hidden = !(active && etat.attendMac && !macActif);
  $("campagne-annuler").hidden = !active;
  $("campagne-fermer").hidden = active;
  $("campagne-transporteurs").innerHTML = etat.parTransporteur
    .map((t) => {
      const methode = t.methode === "navigateur" ? "Mac" : t.methode === "laposte" ? "API" : "à la main";
      const detail = t.restants
        ? `${entier(t.faits)} / ${entier(t.total)}`
        : [t.faits && `${entier(t.faits)} vérifié${t.faits > 1 ? "s" : ""}`, t.bloques && `${entier(t.bloques)} bloqué${t.bloques > 1 ? "s" : ""}`, t.erreurs && `${entier(t.erreurs)} erreur${t.erreurs > 1 ? "s" : ""}`, t.aConstater && `${entier(t.aConstater)} à constater`]
            .filter(Boolean)
            .join(" · ") || "—";
      const enCours = t.restants && active && (t.methode !== "navigateur" || macActif);
      return `
        <div class="campagne-ligne${t.bloques ? " is-bloque" : ""}${enCours ? " is-encours" : ""}">
          <span class="carrier depot-transporteur" data-carrier="${escapeAttr(t.code)}"><i class="carrier-dot"></i>${escapeHtml(t.nom)}</span>
          <span class="campagne-methode">${methode}</span>
          <span class="campagne-detail">${detail}</span>
          ${t.message ? `<span class="campagne-message" title="${escapeAttr(t.message)}">${escapeHtml(t.message)}</span>` : ""}
          <span class="campagne-mini" style="--p:${t.total ? ((t.total - t.restants) / t.total).toFixed(3) : 1}"></span>
        </div>`;
    })
    .join("");
}

function suisCampagne() {
  if (depotsEtat.suiviCampagne) return;
  depotsEtat.suiviCampagne = setInterval(async () => {
    if (currentView !== "depots" || document.hidden) return;
    try {
      const etat = await fetchJSON("/api/depots/campagne", {}, { essais: 1 });
      const avant = depotsEtat.campagne?.compteurs?.verifies;
      rendCampagne(etat);
      // de nouveaux resultats : les lignes et les compteurs suivent
      if (etat.compteurs?.verifies !== avant || etat.campagne?.statut !== "active") loadDepots(true);
      if (etat.campagne?.statut !== "active") {
        clearInterval(depotsEtat.suiviCampagne);
        depotsEtat.suiviCampagne = null;
        const n = etat.compteurs;
        toast(`Vérification terminée : ${pluriel(n.confirmes, "posté confirmé", "postés confirmés")}, ${pluriel(n.nonConfirmes, "non confirmé", "non confirmés")}${n.bloques ? `, ${pluriel(n.bloques, "bloqué", "bloqués")}` : ""}`, "success");
      }
    } catch {
      /* la prochaine fois */
    }
  }, 2000);
}

$("depots-tout").addEventListener("click", (e) =>
  agir(
    e.currentTarget,
    async () => {
      depotsEtat.campagneMasquee = 0;
      const etat = await postJSON("/api/depots/campagne", {});
      rendCampagne(etat);
      suisCampagne();
      return etat;
    },
    { succes: (etat) => (etat.compteurs?.total ? `${pluriel(etat.compteurs.total, "colis à vérifier", "colis à vérifier")} : c'est parti` : "Rien à vérifier : tous les dépôts sont déjà confirmés ou lus à l'instant") }
  )
);
$("campagne-annuler").addEventListener("click", (e) =>
  agir(
    e.currentTarget,
    async () => {
      rendCampagne(await postJSON("/api/depots/campagne/annuler", {}));
      loadDepots(true);
    },
    { succes: "Vérification annulée : ce qui a été lu est gardé" }
  )
);
$("campagne-fermer").addEventListener("click", () => {
  depotsEtat.campagneMasquee = depotsEtat.campagne?.campagne?.id || 0;
  $("depots-campagne").hidden = true;
});

// --- Filtres -----------------------------------------------------------------------------

function choisisFiltreDepots(filtre) {
  depotsEtat.filtre = filtre;
  document.querySelectorAll("#depots-filtres .journal-filtre").forEach((b) => {
    const actif = b.dataset.filtre === filtre;
    b.classList.toggle("active", actif);
    b.setAttribute("aria-selected", String(actif));
  });
  document.querySelectorAll(".depot-metric").forEach((b) => b.classList.toggle("active", b.dataset.depotsFiltre === filtre));
  rendLignesDepots();
}

$("depots-filtres").addEventListener("click", (e) => {
  const b = e.target.closest(".journal-filtre");
  if (b) choisisFiltreDepots(b.dataset.filtre);
});
document.querySelectorAll(".depot-metric").forEach((b) =>
  b.addEventListener("click", () => {
    choisisFiltreDepots(depotsEtat.filtre === b.dataset.depotsFiltre ? "tous" : b.dataset.depotsFiltre);
    $("depots-lignes").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
  })
);
$("depots-transporteur").addEventListener("change", (e) => {
  depotsEtat.transporteur = e.target.value;
  rendLignesDepots();
});
$("depots-expediteur").addEventListener("change", (e) => {
  depotsEtat.expediteur = e.target.value;
  rendLignesDepots();
});
let depotsRechercheMinuteur = null;
$("depots-recherche").addEventListener("input", (e) => {
  clearTimeout(depotsRechercheMinuteur);
  depotsRechercheMinuteur = setTimeout(() => {
    depotsEtat.recherche = e.target.value;
    rendLignesDepots();
  }, 120);
});

// --- Detail d'un colis --------------------------------------------------------------------

function evenementDepot(e, preuve) {
  const estPreuve = preuve && e.survenuLe === preuve.le && e.code === preuve.code;
  const manuel = e.source === "manuel";
  const statut = e.libelle || DEPOTS_ETAPES[e.etape] || e.code || "—";
  const origine = manuel
    ? "constat sur la page officielle"
    : e.source === "navigateur"
      ? "page officielle lue sur le Mac"
      : `La Poste · ${e.code || "?"}${e.etape === "unknown" ? " (code non reconnu)" : ""}`;
  return `
    <li class="depot-evt${estPreuve ? " is-preuve" : ""}${e.incident || e.etape === "exception" ? " is-suite" : ""}${manuel ? " is-manuel" : ""}">
      <span class="depot-evt-point" aria-hidden="true"></span>
      <div class="depot-evt-corps">
        <span class="depot-evt-statut">${escapeHtml(statut)}${estPreuve ? `<span class="depot-evt-preuve">preuve de dépôt</span>` : ""}</span>
        <span class="depot-evt-meta">${depotHeureTransporteur(e.survenuLe)}${e.lieu ? ` · ${escapeHtml(e.lieu)}` : ""}</span>
        <span class="depot-evt-code">${escapeHtml(origine)}</span>
      </div>
    </li>`;
}

// Les boutons de constat : pour les transporteurs a verifier a la main, et
// pour un colis La Poste que l'API ne permet pas de trancher.
function constatDepot(d) {
  const c = d.controle;
  const manuel = d.transporteur.methode === "manuel";
  if (!manuel && !["bloque", "a_verifier"].includes(c.categorie) && !c.constat) return "";
  // (pour un transporteur a la main, la raison est deja dite en tete)
  const aide = manuel
    ? ""
    : d.transporteur.methode === "navigateur"
      ? "La lecture automatique n'a pas pu trancher pour ce colis : tu peux noter ce que montre la page officielle. "
      : "L'API La Poste ne permet pas de trancher pour ce colis : tu peux noter ce que montre la page officielle. ";
  return `
    <section class="depot-constat">
      <h3 class="depot-detail-titre">Constat sur la page officielle</h3>
      <p class="depot-constat-aide">${aide}Ouvre le suivi officiel, puis note ce que tu y vois :</p>
      <div class="depot-constat-choix">
        <button class="btn btn-sm depot-constat-btn cat-confirme" type="button" data-constat="pris">${ico("check")}Pris en charge</button>
        <button class="btn btn-sm depot-constat-btn cat-non_confirme" type="button" data-constat="pas_encore">${ico("clock")}Pas encore</button>
        <button class="btn btn-sm depot-constat-btn cat-a_verifier" type="button" data-constat="probleme">${ico("alert")}Problème</button>
      </div>
      ${c.constat ? `<button class="depot-constat-annule" type="button" data-constat="annule">Effacer le constat (${escapeHtml(depotIlYa(c.constat.le))})</button>` : ""}
    </section>`;
}

function rendDetailDepot(d) {
  depotsEtat.detail = d;
  const c = d.controle;
  const manuel = d.transporteur.methode === "manuel";
  const serie = depotsEtat.serie;
  $("depot-sheet-titre").textContent = d.numero || "Colis";
  $("depot-sheet-serie").textContent = serie ? `${serie.position + 1} / ${serie.ids.length}` : "";
  const lien = $("depot-lien");
  const url = d.liens?.transporteur || d.liens?.page;
  lien.hidden = !url;
  if (url) lien.href = url;
  const preuve = c.preuve ? { le: c.preuve.le, code: c.preuve.code } : null;
  const verifie = manuel
    ? c.constat
      ? `constaté ${depotIlYa(c.constat.le)}`
      : "jamais (à la main)"
    : d.enAttenteDuMac
      ? "le Mac va lire la page officielle"
      : `${depotIlYa(d.verifieLe || d.essaiLe)}${d.prochaineLe ? ` · prochaine ${depotHeure(d.prochaineLe)}` : ""}`;
  const methode = DEPOTS_LECTURES[d.lecture?.methode] || DEPOTS_LECTURES[d.transporteur.methode];
  const suite = c.suite
    ? `<div class="depot-detail-suite"><dt>Après la prise en charge</dt><dd>${escapeHtml(c.suite.libelle || "")}${c.suite.le ? ` · ${depotHeureTransporteur(c.suite.le)}` : ""}<span class="depot-sous"> — sans effet sur le dépôt, déjà prouvé</span></dd></div>`
    : "";
  $("depot-sheet-contenu").innerHTML = `
    <div class="depot-detail-tete">
      <span class="depot-badge cat-${escapeAttr(c.categorie)}">${ico(DEPOTS_ICONES[c.categorie])}${escapeHtml(c.libelle)}</span>
      <p class="depot-detail-raison">${escapeHtml(c.raison)}</p>
    </div>
    <dl class="depot-detail-grille">
      <div><dt>FeurDrop</dt><dd>Dropé le ${escapeHtml(depotHeure(d.statutInterne.dropeLe))}</dd></div>
      <div><dt>Transporteur</dt><dd><span class="carrier depot-transporteur" data-carrier="${escapeAttr(d.transporteur.code)}"><i class="carrier-dot"></i>${escapeHtml(d.transporteur.nom)}</span></dd></div>
      <div><dt>Expéditeur</dt><dd>${escapeHtml(d.expediteur)}</dd></div>
      <div><dt>Vérification</dt><dd>${escapeHtml(methode)}${d.lecture?.par ? ` · ${escapeHtml(d.lecture.par)}` : ""}</dd></div>
      <div><dt>Statut transporteur</dt><dd>${escapeHtml(d.lecture?.statutBrut || depotStatutTransporteur(d))}</dd></div>
      <div><dt>Vérifié</dt><dd>${escapeHtml(verifie)}</dd></div>
      ${suite}
      ${d.erreur ? `<div class="depot-detail-erreur"><dt>Dernière erreur</dt><dd>${escapeHtml(d.erreur.message)}</dd></div>` : ""}
    </dl>
    ${constatDepot(d)}
    <h3 class="depot-detail-titre">Chronologie</h3>
    ${
      d.evenements?.length
        ? `<ol class="depot-chrono">${d.evenements.map((e) => evenementDepot(e, preuve)).join("")}</ol>`
        : vide(
            "clock",
            "Aucun événement pour l'instant",
            manuel
              ? "Rien n'est lu automatiquement chez ce transporteur."
              : d.transporteur.methode === "navigateur"
                ? "La page officielle n'a pas encore été lue par le Mac."
                : "La Poste n'a encore rien remonté pour ce numéro."
          )
    }`;
  $("depot-verifier-un").hidden = manuel;
  const lp = depotsEtat.donnees?.etat.methodes.laposte;
  $("depot-verifier-un").disabled = d.transporteur.methode === "laposte" && (!lp?.configure || Boolean(lp?.pause));
  $("depot-suivant").hidden = !serie;
}

async function ouvreDetailDepot(colisId) {
  const couche = $("depot-sheet");
  try {
    const d = await fetchJSON(`/api/depots/${colisId}`);
    rendDetailDepot(d);
  } catch (err) {
    toast(err.message || "Détail indisponible", "error");
    return;
  }
  couche.classList.remove("closing");
  couche.hidden = false;
  haptique();
}

function fermeDetailDepot() {
  const couche = $("depot-sheet");
  depotsEtat.serie = null;
  if (couche.hidden) return;
  couche.classList.add("closing");
  setTimeout(() => {
    couche.hidden = true;
    couche.classList.remove("closing");
  }, prefersReducedMotion ? 0 : 260);
}

// « Vérifier » : une lecture tout de suite (le serveur refuse poliment si La
// Poste a demande une pause, ou si le colis vient d'etre lu).
function verifieDepot(colisId, bouton) {
  return agir(
    bouton,
    async () => {
      const d = await postJSON(`/api/depots/${colisId}/verifier`, {}, { delai: 45000 });
      if (!$("depot-sheet").hidden && depotsEtat.detail?.colisId === d.colisId) rendDetailDepot(d);
      loadDepots(true);
      if (d.enAttenteDuMac) suisCampagne();
      return d;
    },
    { succes: (d) => (d.enAttenteDuMac ? `${d.numero} : l'app Drop du Mac va lire la page officielle` : `${d.numero} : ${d.controle.libelle.toLowerCase()}`) }
  );
}

$("depots-lignes").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // le suivi officiel s'ouvre dans un onglet
  const ligne = e.target.closest("[data-depot]");
  if (!ligne) return;
  const verifier = e.target.closest("[data-depot-verifier]");
  if (verifier) verifieDepot(ligne.dataset.depot, verifier);
  else ouvreDetailDepot(ligne.dataset.depot);
});
$("depot-sheet").addEventListener("click", (e) => {
  if (e.target.closest("[data-depot-fermer]")) fermeDetailDepot();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") fermeDetailDepot();
});
$("depot-verifier-un").addEventListener("click", (e) => {
  const id = depotsEtat.detail?.colisId;
  if (id) verifieDepot(id, e.currentTarget);
});

// --- Constats a la main, un colis apres l'autre ------------------------------------------

async function suivantSerie() {
  const s = depotsEtat.serie;
  if (!s) return false;
  if (s.position + 1 >= s.ids.length) {
    fermeDetailDepot();
    toast("Tous les colis à constater sont passés", "info");
    return true;
  }
  s.position += 1;
  await ouvreDetailDepot(s.ids[s.position]);
  return true;
}

$("depot-sheet-contenu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-constat]");
  const id = depotsEtat.detail?.colisId;
  if (!b || !id) return;
  agir(
    b,
    async () => {
      const d = await postJSON(`/api/depots/${id}/constat`, { resultat: b.dataset.constat });
      loadDepots(true);
      if (!(b.dataset.constat !== "annule" && (await suivantSerie()))) rendDetailDepot(d);
      return d;
    },
    { succes: (d) => `${d.numero} : ${d.controle.libelle.toLowerCase()}` }
  );
});
$("depot-suivant").addEventListener("click", () => suivantSerie());
$("depots-constater").addEventListener("click", () => {
  const ids = (depotsEtat.donnees?.lignes || []).filter((l) => l.aConstater).map((l) => l.colisId);
  if (!ids.length) return;
  depotsEtat.serie = { ids, position: 0 };
  ouvreDetailDepot(ids[0]);
});

$("depots-link").addEventListener("click", () => switchView("depots"));
$("depots-back").addEventListener("click", () => switchView("dashboard"));
