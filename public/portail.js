// ============================================================================
// L'espace expediteur : ses colis, ou ils en sont, et le bouton pour les
// suivre chez le transporteur. Le lien de la page est la cle : le serveur
// deduit l'expediteur du jeton et ne renvoie que ses colis.
//
// La page se met a jour toute seule (toutes les 5 s quand elle est visible) :
// seul ce qui change bouge -- le badge d'un colis passe en fondu, sa barre
// avance, les compteurs roulent. Rien n'est recharge en entier.
// ============================================================================
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  // https://<portail>/<jeton> (en local : /expediteur/<jeton>)
  const jeton = location.pathname.split("/").filter(Boolean).pop() || "";

  const ETAPES = ["a_imprimer", "imprime", "en_drop", "drope"];
  const NOMS = { a_imprimer: "Pas imprimé", imprime: "Imprimé", en_drop: "En cours de drop", drope: "Drop" };
  const TRANSPORTEURS_CONNUS = new Set(["MR", "LP", "CHRONO", "UPS", "DPD", "GLS", "DHL", "FEDEX"]);
  const PAR_PAGE = 60;
  const RAFRAICHISSEMENT_MS = 5000;
  const reduit = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const etat = {
    donnees: null,
    etag: null,
    nombre: PAR_PAGE,
    filtre: null,
    enCours: false,
    echecs: 0,
    minuteur: null,
    fini: false,
  };

  // --- Dates ------------------------------------------------------------------
  // Le serveur parle en UTC ("2026-10-08 14:32:05") ; on affiche l'heure locale.
  const date = (s) => (s ? new Date(`${s.replace(" ", "T")}Z`) : null);
  const heure = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const jourCourt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
  const jourLong = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const cleJour = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  function decalageJours(d) {
    const a = new Date();
    a.setHours(0, 0, 0, 0);
    const b = new Date(d);
    b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / 86400000);
  }
  function titreJour(d) {
    const ecart = decalageJours(d);
    if (ecart === 0) return "Aujourd'hui";
    if (ecart === 1) return "Hier";
    const t = jourLong.format(d);
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function quand(d) {
    const ecart = decalageJours(d);
    if (ecart === 0) return `à ${heure.format(d)}`;
    if (ecart === 1) return `hier à ${heure.format(d)}`;
    return `le ${jourCourt.format(d)} à ${heure.format(d)}`;
  }

  const nf = new Intl.NumberFormat("fr-FR");
  const pluriel = (n, un, plusieurs) => `${nf.format(n)} ${n > 1 ? plusieurs : un}`;

  // --- Petits outils --------------------------------------------------------------
  function el(tag, classe, texte) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texte !== undefined) e.textContent = texte;
    return e;
  }
  function icone(nom) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${nom}`);
    svg.appendChild(use);
    return svg;
  }
  // seul un lien https part vers un transporteur
  const lienSur = (u) => typeof u === "string" && /^https:\/\/[a-z0-9.-]+\//i.test(u);

  let toastMinuteur = null;
  function toast(texte) {
    const t = $("toast");
    t.textContent = texte;
    t.classList.add("visible");
    clearTimeout(toastMinuteur);
    toastMinuteur = setTimeout(() => t.classList.remove("visible"), 2200);
  }

  async function copie(texte) {
    try {
      await navigator.clipboard.writeText(texte);
      return true;
    } catch (err) {
      // vieux navigateurs : par une zone de texte temporaire
      const zone = el("textarea");
      zone.value = texte;
      zone.setAttribute("readonly", "");
      zone.className = "hors-ecran";
      document.body.appendChild(zone);
      zone.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      zone.remove();
      return ok;
    }
  }

  // --- Chargement -------------------------------------------------------------
  async function charge() {
    if (etat.enCours || etat.fini) return;
    etat.enCours = true;
    try {
      const res = await fetch(`/api/portail/${encodeURIComponent(jeton)}?n=${etat.nombre}`, {
        cache: "no-store",
        credentials: "omit",
        headers: etat.etag ? { "If-None-Match": etat.etag } : {},
      });
      if (res.status === 304) return enLigne();
      if (res.status === 404 || res.status === 429) return lienRefuse(res.status);
      if (!res.ok) throw new Error(String(res.status));
      const donnees = await res.json();
      etat.etag = res.headers.get("ETag");
      rend(donnees);
      enLigne();
    } catch (err) {
      horsLigne();
    } finally {
      etat.enCours = false;
      planifie();
    }
  }

  function planifie() {
    clearTimeout(etat.minuteur);
    if (etat.fini || document.hidden) return;
    // apres une coupure : 5, 10, 20, puis 30 s entre deux essais
    const attente = etat.echecs ? Math.min(30000, RAFRAICHISSEMENT_MS * 2 ** (etat.echecs - 1)) : RAFRAICHISSEMENT_MS;
    etat.minuteur = setTimeout(charge, attente);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(etat.minuteur);
    else charge();
  });
  window.addEventListener("online", () => charge());

  let derniereMaj = 0;
  function enLigne() {
    etat.echecs = 0;
    derniereMaj = Date.now();
    const d = $("direct");
    d.classList.remove("hors-ligne");
    d.classList.add("en-ligne");
    $("direct-texte").textContent = "En direct";
  }
  function horsLigne() {
    etat.echecs += 1;
    const d = $("direct");
    d.classList.remove("en-ligne");
    d.classList.add("hors-ligne");
    $("direct-texte").textContent = etat.donnees ? "Hors ligne · nouvel essai…" : "Connexion…";
  }
  // "En direct" devient "Mis à jour il y a 2 min" si les donnees vieillissent
  setInterval(() => {
    if (!derniereMaj || $("direct").classList.contains("hors-ligne")) return;
    const s = Math.round((Date.now() - derniereMaj) / 1000);
    $("direct-texte").textContent = s < 30 ? "En direct" : `Mis à jour il y a ${s < 90 ? "1 min" : `${Math.round(s / 60)} min`}`;
  }, 5000);

  function lienRefuse(status) {
    etat.fini = true;
    clearTimeout(etat.minuteur);
    for (const id of ["accueil", "etapes", "filtre", "plus", "pied", "squelette"]) $(id).hidden = true;
    $("liste").replaceChildren();
    $("direct").hidden = true;
    if (status === 429) {
      $("message-titre").textContent = "Trop d'essais";
      $("message-texte").textContent = "Réessaie dans un quart d'heure.";
    }
    $("message").hidden = false;
    document.title = "Lien invalide · DROP";
  }

  // --- Rendu ------------------------------------------------------------------
  function rend(d, { filtreChange = false } = {}) {
    const premier = !etat.donnees;
    const avant = etat.donnees;
    etat.donnees = d;

    if (premier) {
      $("squelette").hidden = true;
      $("accueil").hidden = false;
      $("etapes").hidden = false;
      $("pied").hidden = false;
      document.body.classList.add("pret");
    }
    $("nom").textContent = d.expediteur;
    const enCours = d.compte.a_imprimer + d.compte.imprime + d.compte.en_drop;
    $("resume").textContent =
      d.total === 0
        ? "Aucun colis pour l'instant."
        : `${enCours ? pluriel(enCours, "colis en cours", "colis en cours") : "Aucun colis en cours"} · ${pluriel(d.compte.drope, "dropé", "dropés")}`;

    for (const etape of ETAPES) {
      const n = d.compte[etape] || 0;
      const cible = document.querySelector(`[data-compte="${etape}"]`);
      roule(cible, n, premier);
      cible.closest(".etape").classList.toggle("vide", n === 0);
    }

    // le filtre courant
    const filtre = etat.filtre;
    $("filtre").hidden = !filtre;
    if (filtre) $("filtre-texte").textContent = `Colis « ${NOMS[filtre]} »`;
    for (const b of document.querySelectorAll(".etape")) b.setAttribute("aria-pressed", String(b.dataset.etape === filtre));

    // la liste voulue : groupee par jour de reception, du plus recent au plus ancien
    const visibles = d.colis.filter((c) => !filtre || c.etape === filtre);
    const voulu = [];
    let jour = null;
    for (const c of visibles) {
      const recu = date(c.recuLe) || new Date();
      const cle = cleJour(recu);
      if (cle !== jour) {
        voulu.push({ cle: `j:${cle}`, jour: true, titre: titreJour(recu) });
        jour = cle;
      }
      voulu.push({ cle: `c:${c.ref}`, colis: c });
    }
    reconcilie(voulu, { anime: !premier && !filtreChange, avant });

    const liste = $("liste");
    let vide = liste.querySelector(".liste-vide");
    if (visibles.length === 0) {
      if (!vide) {
        vide = el("p", "liste-vide");
        liste.appendChild(vide);
      }
      vide.textContent = d.total === 0
        ? "Tes colis apparaîtront ici dès qu'ils seront enregistrés."
        : `Aucun colis « ${NOMS[filtre]} » pour le moment.`;
    } else if (vide) {
      vide.remove();
    }

    $("plus").hidden = !d.suite;
    $("plus").disabled = false;
    $("plus").textContent = "Voir les colis plus anciens";
  }

  // Met la liste dans l'etat voulu en touchant le moins possible : les cartes
  // existantes restent (et se mettent a jour sur place), les nouvelles entrent
  // en fondu, celles qui partent se replient.
  function reconcilie(voulu, { anime, avant }) {
    const liste = $("liste");
    const existants = new Map();
    for (const e of liste.children) if (e.dataset.cle && !e.classList.contains("sortie")) existants.set(e.dataset.cle, e);
    const gardes = new Set(voulu.map((v) => v.cle));
    for (const [cle, e] of existants) {
      if (gardes.has(cle)) continue;
      existants.delete(cle);
      if (anime && !reduit) sort(e);
      else e.remove();
    }

    const anciens = new Map((avant?.colis || []).map((c) => [c.ref, c]));
    let curseur = liste.firstElementChild;
    const passe = () => {
      while (curseur && (curseur.classList.contains("sortie") || !curseur.dataset.cle)) curseur = curseur.nextElementSibling;
    };
    let rang = 0;
    for (const v of voulu) {
      let e = existants.get(v.cle);
      if (!e) {
        e = v.jour ? creeJour(v) : creeCarte(v.colis);
        if (!reduit) entre(e, anime ? 0 : Math.min(rang, 12) * 35);
      } else if (v.jour) {
        e.textContent = v.titre;
      } else {
        majCarte(e, v.colis, anciens.get(v.colis.ref), anime);
      }
      rang += 1;
      passe();
      if (curseur === e) curseur = curseur.nextElementSibling;
      else liste.insertBefore(e, curseur);
    }
  }

  function entre(e, delai) {
    e.classList.add("entree");
    e.animate(
      [
        { opacity: 0, transform: "translateY(10px) scale(0.985)", filter: "blur(4px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ],
      { duration: 520, delay: delai, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" }
    ).finished.then(() => e.classList.remove("entree"), () => {});
  }

  function sort(e) {
    e.classList.add("sortie");
    const h = e.offsetHeight;
    e.animate(
      [
        { opacity: 1, height: `${h}px` },
        { opacity: 0, height: "0px", marginTop: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" },
      ],
      { duration: 380, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" }
    ).finished.then(() => e.remove(), () => e.remove());
  }

  function creeJour(v) {
    const h = el("h2", "jour", v.titre);
    h.dataset.cle = v.cle;
    return h;
  }

  // --- Une carte colis ------------------------------------------------------------
  function creeCarte(c) {
    const carte = el("article", "colis");
    carte.dataset.cle = `c:${c.ref}`;

    const haut = el("div", "colis-haut");
    const transporteur = el("span", "colis-transporteur");
    transporteur.append(el("i", "pastille"), el("span", "t-nom"), el("span", "t-bj", "Boîte jaune"));
    // le badge et son fantome (pendant un changement) occupent la meme case
    const zone = el("span", "badge-zone");
    zone.append(el("span", "badge"));
    haut.append(transporteur, zone);

    const numero = el("div", "colis-numero");
    numero.append(el("span", "numero-libelle", "N° de suivi"));
    const bouton = el("button", "numero");
    bouton.type = "button";
    bouton.append(el("span", "numero-texte"), icone("copy"));
    bouton.addEventListener("click", async () => {
      const n = carte._colis?.suivi?.numero;
      if (!n) return;
      if (await copie(n)) {
        bouton.classList.add("copie");
        setTimeout(() => bouton.classList.remove("copie"), 1400);
        toast("Numéro copié");
      }
    });
    numero.append(bouton, el("span", "numero-absent", "Pas de numéro de suivi pour ce colis"));

    const progression = el("div", "progression");
    progression.setAttribute("role", "img");
    const piste = el("div", "piste");
    piste.append(el("div", "remplie"));
    const jalons = el("ol", "jalons");
    ETAPES.forEach((etape) => {
      const li = el("li", "jalon");
      li.dataset.etape = etape;
      li.append(el("i", "jalon-point"), el("span", "jalon-nom", NOMS[etape]));
      jalons.append(li);
    });
    progression.append(piste, jalons);

    const dates = el("p", "colis-dates");

    const suivre = el("a", "bouton bouton-suivi");
    suivre.target = "_blank";
    suivre.rel = "noopener noreferrer";
    suivre.referrerPolicy = "no-referrer";
    suivre.append(el("span", null, "Suivre le colis"), icone("out"));
    suivre.addEventListener("click", async (ev) => {
      const s = carte._colis?.suivi;
      if (!s || s.lien) return; // lien direct : le navigateur l'ouvre
      // pas de lien direct chez ce transporteur : sa page officielle, avec le
      // numero copie pour le coller
      ev.preventDefault();
      const ok = await copie(s.numero);
      if (lienSur(s.page)) window.open(s.page, "_blank", "noopener,noreferrer");
      if (ok) toast("Numéro copié : colle-le sur la page du transporteur");
    });

    carte.append(haut, numero, progression, dates, suivre);
    majCarte(carte, c, null, false);
    return carte;
  }

  function majCarte(carte, c, ancien, anime) {
    const avant = carte._colis;
    carte._colis = c;
    const etape = ETAPES.includes(c.etape) ? c.etape : "a_imprimer";
    const change = anime && avant && avant.etape !== etape;

    const code = c.transporteur?.code;
    carte.dataset.transporteur = code && TRANSPORTEURS_CONNUS.has(code) ? code : "autre";
    carte.querySelector(".t-nom").textContent = c.transporteur?.nom || "Transporteur inconnu";
    carte.querySelector(".t-bj").hidden = !c.boiteJaune;

    const numero = c.suivi?.numero || null;
    carte.querySelector(".numero").hidden = !numero;
    carte.querySelector(".numero-absent").hidden = Boolean(numero);
    if (numero) {
      carte.querySelector(".numero-texte").textContent = numero;
      carte.querySelector(".numero").setAttribute("aria-label", `Copier le numéro ${numero}`);
    }

    const suivre = carte.querySelector(".bouton-suivi");
    const cible = c.suivi ? c.suivi.lien || c.suivi.page : null;
    if (lienSur(cible)) {
      suivre.hidden = false;
      suivre.href = cible;
      suivre.setAttribute("aria-label", `Suivre le colis ${numero} sur le site ${c.transporteur?.nom || "du transporteur"}`);
    } else {
      suivre.hidden = true;
      suivre.removeAttribute("href");
    }

    // les etapes franchies, avec leur heure
    const morceaux = [];
    const recu = date(c.recuLe);
    if (recu) morceaux.push(`Reçu ${quand(recu)}`);
    const imprime = date(c.imprimeLe);
    if (imprime && etape !== "a_imprimer") morceaux.push(`imprimé ${quand(imprime)}`);
    const drope = date(c.dropeLe);
    if (drope && etape === "drope") morceaux.push(`dropé ${quand(drope)}`);
    carte.querySelector(".colis-dates").textContent = morceaux.join(" · ");

    const rangEtape = ETAPES.indexOf(etape);
    carte.querySelector(".progression").setAttribute("aria-label", `Étape ${rangEtape + 1} sur 4 : ${NOMS[etape]}`);
    for (const li of carte.querySelectorAll(".jalon")) {
      const i = ETAPES.indexOf(li.dataset.etape);
      li.classList.toggle("fait", i < rangEtape);
      li.classList.toggle("actuel", i === rangEtape);
    }

    const badge = carte.querySelector(".badge");
    if (change && !reduit) {
      // l'ancien badge s'efface pendant que le nouveau apparait a sa place
      const fantome = badge.cloneNode(true);
      fantome.classList.add("badge-fantome");
      fantome.setAttribute("aria-hidden", "true");
      badge.after(fantome);
      fantome
        .animate(
          [
            { opacity: 1, transform: "none", filter: "blur(0)" },
            { opacity: 0, transform: "translateY(-6px) scale(0.92)", filter: "blur(3px)" },
          ],
          { duration: 360, easing: "cubic-bezier(0.55, 0, 0.75, 0.2)", fill: "forwards" }
        )
        .finished.then(() => fantome.remove(), () => fantome.remove());
      remplisBadge(badge, etape);
      badge.animate(
        [
          { opacity: 0, transform: "translateY(6px) scale(0.92)", filter: "blur(3px)" },
          { opacity: 1, transform: "none", filter: "blur(0)" },
        ],
        { duration: 520, delay: 140, easing: "cubic-bezier(0.34, 1.45, 0.64, 1)", fill: "backwards" }
      );
      carte.classList.remove("vient-de-changer");
      void carte.offsetWidth; // relance l'animation si elle tournait deja
      carte.classList.add("vient-de-changer");
      setTimeout(() => carte.classList.remove("vient-de-changer"), 1800);
      $("annonce").textContent = `${numero ? `Colis ${numero}` : "Un colis"} : ${NOMS[etape]}`;
    } else if (badge.dataset.etape !== etape) {
      remplisBadge(badge, etape);
    }
    carte.dataset.etape = etape;
  }

  function remplisBadge(badge, etape) {
    badge.dataset.etape = etape;
    badge.replaceChildren(icone(etape), el("span", null, NOMS[etape]));
  }

  // Un nombre qui change roule jusqu'a sa nouvelle valeur.
  function roule(cible, n, premier) {
    const depuis = Number(cible.dataset.valeur || 0);
    cible.dataset.valeur = String(n);
    if (depuis === n && !premier) return;
    if (reduit || (!premier && Math.abs(n - depuis) === 0)) {
      cible.textContent = nf.format(n);
      return;
    }
    const debut = performance.now();
    const duree = premier ? 900 : 600;
    const pas = (t) => {
      const p = Math.min(1, (t - debut) / duree);
      const e = 1 - Math.pow(1 - p, 4);
      cible.textContent = nf.format(Math.round(depuis + (n - depuis) * e));
      if (p < 1) requestAnimationFrame(pas);
    };
    requestAnimationFrame(pas);
    if (!premier) {
      const tuile = cible.closest(".etape");
      tuile.classList.remove("pulse");
      void tuile.offsetWidth;
      tuile.classList.add("pulse");
    }
  }

  // --- Filtres par etape ---------------------------------------------------------
  for (const b of document.querySelectorAll(".etape")) {
    b.addEventListener("click", () => {
      etat.filtre = etat.filtre === b.dataset.etape ? null : b.dataset.etape;
      if (etat.donnees) rend(etat.donnees, { filtreChange: true });
      if (etat.filtre) $("filtre").scrollIntoView({ behavior: reduit ? "auto" : "smooth", block: "nearest" });
    });
  }
  $("filtre-tout").addEventListener("click", () => {
    etat.filtre = null;
    if (etat.donnees) rend(etat.donnees, { filtreChange: true });
  });

  $("plus").addEventListener("click", () => {
    etat.nombre += PAR_PAGE;
    etat.etag = null;
    $("plus").disabled = true;
    $("plus").textContent = "Chargement…";
    clearTimeout(etat.minuteur);
    charge();
  });

  // --- C'est parti -------------------------------------------------------------
  if (!jeton) lienRefuse(404);
  else charge();
})();
