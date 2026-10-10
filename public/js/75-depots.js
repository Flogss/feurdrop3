// --- Controle des depots ------------------------------------------------------------
// Ce que les transporteurs disent des colis dropes. Le serveur interroge
// l'API officielle La Poste (La Poste, Colissimo, Chronopost, DPD) a son
// rythme, en file d'attente ; UPS et DHL refusent les verifications
// automatiques : leurs colis se constatent sur la page officielle. Mondial
// Relay n'est pas controle (ses colis sont seulement comptes). Ouvrir la page ne fait que lire la base. Le statut FeurDrop et
// ce que dit le transporteur restent deux colonnes distinctes.

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
};

const DEPOTS_COURTS = { confirme: "Confirmé", non_confirme: "Non confirmé", a_verifier: "Vérif. nécessaire", bloque: "Vérif. bloquée", anomalie: "Anomalie" };
const DEPOTS_ICONES = { confirme: "check", non_confirme: "clock", a_verifier: "search", bloque: "lock", anomalie: "alert" };
const DEPOTS_ETAPES = {
  info_received: "Étiquette créée",
  in_transit: "Pris en charge / en transit",
  out_for_delivery: "En cours de livraison",
  available_for_pickup: "Disponible au retrait",
  delivered: "Livré",
  exception: "Incident",
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
  return l.verifieLe ? "Inconnu du transporteur" : "Pas encore vérifié";
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
    : "étiquette seule, pas de scan";
  $("depots-n-a-constater").textContent = c.aConstater ? `dont ${pluriel(c.aConstater, "à constater", "à constater")}` : "site protégé ou en pause";
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

// Une puce par transporteur present : comment ses colis sont verifies.
function rendMethodesDepots(etat) {
  const box = $("depots-methodes");
  const lp = etat.methodes.laposte;
  const html = etat.transporteurs
    .map((t) => {
      const manuel = t.methode === "manuel";
      const [classe, icone, texte, titre] = manuel
        ? ["is-manuel", "edit", "à la main", "Le transporteur refuse les vérifications automatiques : constat sur la page officielle"]
        : !lp.configure
          ? ["is-pause", "info", "non configuré", "OKAPI_KEY manquante sur le serveur"]
          : lp.pause
            ? ["is-pause", "clock", "en pause", `Pause demandée par La Poste jusqu'à ${depotHeure(lp.pause.jusqua)}`]
            : ["is-auto", "bolt", "automatique", lp.nom];
      return (
        `<span class="depot-methode ${classe}" title="${escapeAttr(titre)}">` +
        `<span class="carrier depot-transporteur" data-carrier="${escapeAttr(t.code)}"><i class="carrier-dot"></i>${escapeHtml(t.nom)}</span>` +
        `<span class="depot-methode-etat">${ico(icone)}${texte}</span><span class="depot-methode-n">${entier(t.colis)}</span></span>`
      );
    })
    .join("");
  if (box._html !== html) {
    box.innerHTML = html;
    box._html = html;
  }
  box.hidden = !html;
}

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
        <span class="depot-sous">${escapeHtml(depotStatutTransporteur(l))}${c.livre && c.categorie !== "anomalie" ? " · livré" : ""}</span>
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
  const origine = manuel ? "constat sur la page officielle" : `La Poste · ${e.code || "?"}${e.etape === "unknown" ? " (code non reconnu)" : ""}`;
  return `
    <li class="depot-evt${estPreuve ? " is-preuve" : ""}${e.incident || e.etape === "exception" ? " is-incident" : ""}${manuel ? " is-manuel" : ""}">
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
  const aide = manuel ? "" : "L'API La Poste ne permet pas de trancher pour ce colis : tu peux noter ce que montre la page officielle. ";
  return `
    <section class="depot-constat">
      <h3 class="depot-detail-titre">Constat sur la page officielle</h3>
      <p class="depot-constat-aide">${aide}Ouvre le suivi officiel, puis note ce que tu y vois :</p>
      <div class="depot-constat-choix">
        <button class="btn btn-sm depot-constat-btn cat-confirme" type="button" data-constat="pris">${ico("check")}Pris en charge</button>
        <button class="btn btn-sm depot-constat-btn cat-non_confirme" type="button" data-constat="pas_encore">${ico("clock")}Pas encore</button>
        <button class="btn btn-sm depot-constat-btn cat-anomalie" type="button" data-constat="probleme">${ico("alert")}Problème</button>
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
    : `${depotIlYa(d.verifieLe || d.essaiLe)}${d.prochaineLe ? ` · prochaine ${depotHeure(d.prochaineLe)}` : ""}`;
  $("depot-sheet-contenu").innerHTML = `
    <div class="depot-detail-tete">
      <span class="depot-badge cat-${escapeAttr(c.categorie)}">${ico(DEPOTS_ICONES[c.categorie])}${escapeHtml(c.libelle)}</span>
      <p class="depot-detail-raison">${escapeHtml(c.raison)}</p>
    </div>
    <dl class="depot-detail-grille">
      <div><dt>FeurDrop</dt><dd>Dropé le ${escapeHtml(depotHeure(d.statutInterne.dropeLe))}</dd></div>
      <div><dt>Transporteur</dt><dd><span class="carrier depot-transporteur" data-carrier="${escapeAttr(d.transporteur.code)}"><i class="carrier-dot"></i>${escapeHtml(d.transporteur.nom)}</span></dd></div>
      <div><dt>Expéditeur</dt><dd>${escapeHtml(d.expediteur)}</dd></div>
      <div><dt>Vérification</dt><dd>${manuel ? "À la main (page officielle)" : "API La Poste (officielle)"}</dd></div>
      <div><dt>Statut transporteur</dt><dd>${escapeHtml(depotStatutTransporteur(d))}</dd></div>
      <div><dt>Vérifié</dt><dd>${escapeHtml(verifie)}</dd></div>
      ${d.erreur ? `<div class="depot-detail-erreur"><dt>Dernière erreur</dt><dd>${escapeHtml(d.erreur.message)}</dd></div>` : ""}
    </dl>
    ${constatDepot(d)}
    <h3 class="depot-detail-titre">Chronologie</h3>
    ${
      d.evenements?.length
        ? `<ol class="depot-chrono">${d.evenements.map((e) => evenementDepot(e, preuve)).join("")}</ol>`
        : vide("clock", "Aucun événement pour l'instant", manuel ? "Rien n'est lu automatiquement chez ce transporteur." : "La Poste n'a encore rien remonté pour ce numéro.")
    }`;
  $("depot-verifier-un").hidden = manuel;
  const lp = depotsEtat.donnees?.etat.methodes.laposte;
  $("depot-verifier-un").disabled = !lp?.configure || Boolean(lp?.pause);
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
      return d;
    },
    { succes: (d) => `${d.numero} : ${d.controle.libelle.toLowerCase()}` }
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
