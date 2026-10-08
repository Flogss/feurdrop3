// ============================================================================
// L'espace expediteur : un outil pour retrouver un colis en quelques secondes,
// meme parmi des centaines. La recherche par numero de suivi (instantanee,
// insensible aux espaces, sur une partie du numero), les colis ranges par
// transporteur, les filtres par statut et par transporteur, le tri, et sur
// chaque colis le bouton pour le suivre chez le transporteur.
//
// Le lien de la page est la cle : le serveur deduit l'expediteur du jeton et
// ne renvoie que ses colis -- tous, pour que la recherche et les comptes
// soient exacts. La page se relit toutes les 5 s quand elle est visible
// (304 tant que rien ne bouge) ; seul ce qui change bouge a l'ecran.
// ============================================================================
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  // https://<portail>/<jeton> (en local : /expediteur/<jeton>)
  const jeton = location.pathname.split("/").filter(Boolean).pop() || "";

  const ETAPES = ["a_imprimer", "imprime", "en_drop", "drope"];
  const NOMS = { a_imprimer: "Pas imprimé", imprime: "Imprimé", en_drop: "En cours de drop", drope: "Drop" };
  const CONNUS = new Set(["MR", "LP", "CHRONO", "UPS", "DPD", "GLS", "DHL", "FEDEX"]);
  const TOUS = 2000; // tout l'historique (le serveur plafonne au meme nombre)
  const APERCU = 5; // colis montres par groupe avant "Afficher les autres"
  const LOT = 100; // colis ajoutes a chaque "Afficher plus"
  const MAX_RESULTATS = 60;
  const RAFRAICHISSEMENT_MS = 5000;
  const reduit = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const avecSouris = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  const memoire = {
    lis(cle, defaut) {
      try {
        return JSON.parse(localStorage.getItem(cle)) ?? defaut;
      } catch (e) {
        return defaut;
      }
    },
    ecris(cle, valeur) {
      try {
        localStorage.setItem(cle, JSON.stringify(valeur));
      } catch (e) {
        // navigation privee : tant pis pour le souvenir
      }
    },
  };

  const etat = {
    donnees: null,
    etag: null,
    enCours: false,
    echecs: 0,
    minuteur: null,
    fini: false,
    q: "",
    etape: null,
    transporteur: null,
    tri: memoire.lis("drop.portail.tri", "recent"),
    // les groupes replies (gardes d'une visite a l'autre), et ceux deplies
    // au-dela de l'apercu
    fermes: new Set(memoire.lis("drop.portail.fermes", [])),
    montres: new Map(),
  };

  // --- Petits outils ------------------------------------------------------------
  const nf = new Intl.NumberFormat("fr-FR");
  const pluriel = (n, un, plusieurs) => `${nf.format(n)} ${n > 1 ? plusieurs : un}`;
  const date = (s) => (s ? new Date(`${s.replace(" ", "T")}Z`) : null);
  const heure = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const jourCourt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
  function ecartJours(d) {
    const a = new Date();
    a.setHours(0, 0, 0, 0);
    const b = new Date(d);
    b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / 86400000);
  }
  function quand(d) {
    const ecart = ecartJours(d);
    if (ecart === 0) return `à ${heure.format(d)}`;
    if (ecart === 1) return `hier à ${heure.format(d)}`;
    return `le ${jourCourt.format(d)}`;
  }

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
  const codeDe = (c) => c.transporteur?.code || "AUTRE";
  const nomDe = (c) => c.transporteur?.nom || "Transporteur inconnu";
  const couleur = (code) => (CONNUS.has(code) ? code : "autre");

  function toast(message) {
    const pile = $("toasts");
    const t = el("div", "toast toast-success");
    t.setAttribute("role", "status");
    const ic = el("span", "toast-icon");
    ic.append(icone("check"));
    const temps = el("span", "toast-temps");
    temps.style.animationDuration = "2600ms";
    t.append(ic, el("span", null, message), temps);
    pile.append(t);
    while (pile.children.length > 2) pile.firstElementChild.remove();
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 260);
    }, 2600);
  }

  async function copie(texte) {
    try {
      await navigator.clipboard.writeText(texte);
      return true;
    } catch (err) {
      const zone = el("textarea", "sr");
      zone.value = texte;
      zone.setAttribute("readonly", "");
      document.body.append(zone);
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

  // --- Le fond vivant (le meme que le dashboard) --------------------------------
  {
    const fond = document.querySelector(".ambient");
    const toile = $("particules");
    let envoie = null;
    if (!reduit && toile?.transferControlToOffscreen && window.Worker) {
      try {
        const hors = toile.transferControlToOffscreen();
        const travailleur = new Worker("/particules.js");
        const dpr = () => Math.min(devicePixelRatio || 1, 2);
        travailleur.postMessage({ type: "init", toile: hors, L: innerWidth, H: innerHeight, dpr: dpr(), nombre: innerWidth < 700 ? 30 : 56 }, [hors]);
        envoie = (m) => travailleur.postMessage(m);
        addEventListener("resize", () => envoie({ type: "taille", L: innerWidth, H: innerHeight, dpr: dpr() }));
        document.addEventListener("visibilitychange", () => envoie({ type: "pause", pause: document.hidden }));
      } catch (err) {
        envoie = null;
      }
    }
    let attente = false;
    addEventListener(
      "scroll",
      () => {
        if (attente) return;
        attente = true;
        requestAnimationFrame(() => {
          attente = false;
          envoie?.({ type: "defilement", y: scrollY });
          fond.style.setProperty("--py", `${scrollY}px`);
        });
      },
      { passive: true }
    );
    if (avecSouris && !reduit) {
      addEventListener(
        "pointermove",
        (e) => {
          fond.style.setProperty("--mx", `${(e.clientX / innerWidth - 0.5) * 50}px`);
          fond.style.setProperty("--my", `${(e.clientY / innerHeight - 0.5) * 40}px`);
          // la lumiere des cartes suit la souris, comme sur le dashboard
          const c = e.target.closest?.(".card");
          if (!c) return;
          const r = c.getBoundingClientRect();
          c.style.setProperty("--mx", `${e.clientX - r.left}px`);
          c.style.setProperty("--my", `${e.clientY - r.top}px`);
        },
        { passive: true }
      );
    }
  }

  // --- Chargement ---------------------------------------------------------------
  async function charge() {
    if (etat.enCours || etat.fini) return;
    etat.enCours = true;
    try {
      const res = await fetch(`/api/portail/${encodeURIComponent(jeton)}?n=${TOUS}`, {
        cache: "no-store",
        credentials: "omit",
        headers: etat.etag ? { "If-None-Match": etat.etag } : {},
      });
      if (res.status === 304) return enLigne();
      if (res.status === 404 || res.status === 429) return lienRefuse(res.status);
      if (!res.ok) throw new Error(String(res.status));
      const donnees = await res.json();
      etat.etag = res.headers.get("ETag");
      recoit(donnees);
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
  addEventListener("online", () => charge());

  let derniereMaj = 0;
  function enLigne() {
    etat.echecs = 0;
    derniereMaj = Date.now();
    $("live").classList.remove("is-off");
    $("live-text").textContent = "En direct";
  }
  function horsLigne() {
    etat.echecs += 1;
    $("live").classList.add("is-off");
    $("live-text").textContent = etat.donnees ? "Hors ligne" : "Connexion…";
  }
  setInterval(() => {
    if (!derniereMaj || $("live").classList.contains("is-off")) return;
    const s = Math.round((Date.now() - derniereMaj) / 1000);
    $("live-text").textContent = s < 30 ? "En direct" : `Il y a ${s < 90 ? "1 min" : `${Math.round(s / 60)} min`}`;
  }, 5000);

  function lienRefuse(status) {
    etat.fini = true;
    clearTimeout(etat.minuteur);
    $("contenu").hidden = true;
    $("live").hidden = true;
    if (status === 429) {
      $("message-titre").textContent = "Trop d'essais";
      $("message-texte").textContent = "Réessaie dans un quart d'heure.";
    }
    $("message").hidden = false;
    document.title = "Lien invalide · DROP";
  }

  // --- Donnees recues -------------------------------------------------------------
  function recoit(d) {
    const avant = etat.donnees;
    etat.donnees = d;
    if (!avant) {
      $("nom").classList.remove("is-loading");
      $("pied").hidden = false;
    }
    $("nom").textContent = d.expediteur;
    const enCours = d.colis.filter((c) => c.etape !== "drope").length;
    $("resume").textContent =
      d.total === 0
        ? "Aucun colis pour l'instant."
        : `${pluriel(d.total, "colis", "colis")} · ${enCours ? `${nf.format(enCours)} en cours` : "aucun en cours"}`;
    rend({ anime: Boolean(avant), signale: Boolean(avant) });
  }

  // --- Recherche --------------------------------------------------------------------
  // Le numero tel qu'on le compare : majuscules, sans espaces ni tirets
  // ("6n 0003 1133-081" -> "6N00031133081").
  const norme = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  function cherche(q) {
    const n = norme(q);
    if (n.length < 3) return { n, resultats: [], tropCourt: true };
    const resultats = [];
    for (const c of etat.donnees.colis) {
      const num = norme(c.suivi?.numero);
      if (!num) continue;
      // le numero entier d'abord, puis son debut, sa fin (on tape souvent les
      // derniers chiffres), puis n'importe ou
      const score = num === n ? 4 : num.startsWith(n) ? 3 : num.endsWith(n) ? 2 : num.includes(n) ? 1 : 0;
      if (score) resultats.push({ c, score });
    }
    resultats.sort((a, b) => b.score - a.score || (b.c.recuLe || "").localeCompare(a.c.recuLe || ""));
    return { n, resultats: resultats.map((r) => r.c), tropCourt: false };
  }

  // --- Filtres et tri -----------------------------------------------------------------
  const filtre = (liste, { etape = etat.etape, transporteur = etat.transporteur } = {}) =>
    liste.filter((c) => (!etape || c.etape === etape) && (!transporteur || codeDe(c) === transporteur));

  function trie(liste) {
    const parDate = (a, b) => (b.recuLe || "").localeCompare(a.recuLe || "");
    if (etat.tri === "statut") return liste.sort((a, b) => ETAPES.indexOf(a.etape) - ETAPES.indexOf(b.etape) || parDate(a, b));
    return liste.sort(parDate);
  }

  // Les colis par transporteur, du plus garni au moins garni.
  function groupesDe(liste) {
    const parCode = new Map();
    for (const c of liste) {
      const code = codeDe(c);
      if (!parCode.has(code)) parCode.set(code, { code, nom: nomDe(c), colis: [] });
      parCode.get(code).colis.push(c);
    }
    return [...parCode.values()].sort((a, b) => b.colis.length - a.colis.length || a.nom.localeCompare(b.nom));
  }

  // --- Rendu ---------------------------------------------------------------------------
  function rend({ anime = false, signale = false } = {}) {
    const d = etat.donnees;
    if (!d) return;

    // les compteurs de statut suivent le transporteur choisi, et inversement
    const pourEtapes = filtre(d.colis, { etape: null });
    for (const e of ETAPES) {
      const n = pourEtapes.filter((c) => c.etape === e).length;
      const cible = document.querySelector(`[data-compte="${e}"]`);
      roule(cible, n, signale);
      cible.closest(".p-etape").classList.toggle("vide", n === 0);
    }
    for (const b of document.querySelectorAll(".p-etape")) b.setAttribute("aria-pressed", String(b.dataset.etape === etat.etape));

    rendTransporteurs();
    rendBarre();

    document.body.classList.toggle("en-recherche", Boolean(etat.q));
    if (etat.q) rendRecherche(anime);
    else rendGroupes(anime);
  }

  function rendTransporteurs() {
    const liste = filtre(etat.donnees.colis, { transporteur: null });
    const groupes = groupesDe(etat.donnees.colis);
    const total = liste.length;
    const items = [
      { code: "*", nom: "Tous", n: total },
      ...groupes.map((g) => ({ code: g.code, nom: g.nom, n: liste.filter((c) => codeDe(c) === g.code).length })),
    ];
    reconcilie($("transporteurs"), items, {
      cle: (t) => `t:${t.code}`,
      cree: (t) => {
        const b = el("button", "p-tr carrier");
        b.type = "button";
        b.dataset.carrier = t.code === "*" ? "*" : couleur(t.code);
        b.dataset.code = t.code;
        const part = el("span", "p-tr-part");
        part.append(el("i"));
        b.append(el("i", "carrier-dot"), el("span", "p-tr-nom", t.nom), el("b", "p-tr-n"), part);
        majTransporteur(b, t, total);
        return b;
      },
      maj: (b, t) => majTransporteur(b, t, total),
    });
  }

  function majTransporteur(b, t, total) {
    b.querySelector(".p-tr-n").textContent = nf.format(t.n);
    b.querySelector(".p-tr-part i").style.width = `${total ? Math.max(t.n ? 3 : 0, (t.n / total) * 100) : 0}%`;
    b.classList.toggle("vide", t.n === 0 && t.code !== "*");
    b.setAttribute("aria-pressed", String((etat.transporteur || "*") === t.code));
    b.setAttribute("aria-label", `${t.nom} : ${pluriel(t.n, "colis", "colis")}`);
  }

  function rendBarre() {
    const texte = $("barre-texte");
    texte.replaceChildren();
    if (etat.q) return;
    const n = filtre(etat.donnees.colis).length;
    const compte = el("span");
    compte.append(el("b", null, nf.format(n)), document.createTextNode(" colis"));
    texte.append(compte);
    const puce = (libelle, quoi, code) => {
      const b = el("button", `chip p-filtre${code ? " carrier" : ""}`);
      b.type = "button";
      if (code) b.dataset.carrier = couleur(code);
      b.dataset.retire = quoi;
      b.setAttribute("aria-label", `Retirer le filtre ${libelle}`);
      b.append(el("span", null, libelle), icone("x"));
      texte.append(b);
    };
    if (etat.transporteur) {
      const c = etat.donnees.colis.find((x) => codeDe(x) === etat.transporteur);
      puce(c ? nomDe(c) : etat.transporteur, "transporteur", etat.transporteur);
    }
    if (etat.etape) puce(NOMS[etat.etape], "etape");
  }

  function rendGroupes(anime) {
    const liste = $("liste");
    const visibles = filtre(etat.donnees.colis);
    if (visibles.length === 0) {
      const aucun = etat.donnees.total === 0;
      remplace(
        liste,
        "vide",
        videHtml(
          "layers",
          aucun ? "Pas encore de colis" : "Aucun colis ici",
          aucun ? "Tes colis apparaîtront ici dès qu'ils seront enregistrés." : "Aucun colis ne correspond à ces filtres."
        )
      );
      return;
    }
    const groupes = groupesDe(visibles);
    for (const g of groupes) trie(g.colis);
    reconcilie(liste, groupes, { cle: (g) => `g:${g.code}`, cree: creeGroupe, maj: majGroupe, anime });
  }

  function rendRecherche(anime) {
    const liste = $("liste");
    let carte = liste.querySelector(":scope > .p-resultats");
    if (!carte) {
      carte = el("section", "card p-resultats");
      const tete = el("header", "p-resultats-tete");
      tete.append(el("h2"), el("span", "card-meta"));
      carte.append(tete, el("div", "p-lignes"), el("div", "p-resultats-vide"), el("p", "p-resultats-plus"));
    }
    remplace(liste, "resultats", carte);

    const { n, resultats, tropCourt } = cherche(etat.q);
    const titre = carte.querySelector("h2");
    const meta = carte.querySelector(".card-meta");
    const lignes = carte.querySelector(".p-lignes");
    const vide = carte.querySelector(".p-resultats-vide");
    const plus = carte.querySelector(".p-resultats-plus");
    plus.hidden = true;
    vide.replaceChildren();

    if (tropCourt || !resultats.length) {
      reconcilie(lignes, [], { cle: () => "", cree: () => el("div") });
      if (tropCourt) {
        titre.textContent = "Recherche";
        meta.textContent = "";
        vide.append(videHtml("search", "Tape au moins 3 caractères", "Le numéro complet, son début ou ses derniers chiffres : les espaces ne comptent pas."));
        $("annonce").textContent = "";
      } else {
        titre.textContent = "Aucun résultat";
        meta.textContent = "";
        vide.append(videHtml("search", `Aucun colis ne correspond à « ${etat.q.trim()} »`, "Vérifie le numéro, ou tape seulement ses derniers chiffres."));
        $("annonce").textContent = "Aucun colis trouvé";
      }
      return;
    }
    titre.textContent = resultats.length > 1 ? "Colis trouvés" : "Colis trouvé";
    meta.textContent = pluriel(resultats.length, "colis", "colis");
    $("annonce").textContent = pluriel(resultats.length, "colis trouvé", "colis trouvés");
    const montres = resultats.slice(0, MAX_RESULTATS);
    reconcilie(lignes, montres, { cle: (c) => `c:${c.ref}`, cree: (c) => creeLigne(c, n), maj: (e, c) => majLigne(e, c, n), anime });
    if (resultats.length > montres.length) {
      plus.hidden = false;
      plus.textContent = `${pluriel(resultats.length - montres.length, "autre colis correspond", "autres colis correspondent")} : précise le numéro.`;
    }
  }

  // La liste ne montre qu'une chose (l'etat vide, ou les resultats).
  function remplace(conteneur, cle, element) {
    element.dataset.cle = cle;
    reconcilie(conteneur, [element], { cle: () => cle, cree: () => element });
    const ici = conteneur.querySelector(`:scope > [data-cle="${cle}"]`);
    if (ici !== element) ici.replaceWith(element);
  }

  function videHtml(nomIcone, titre, sous) {
    const v = el("div", "empty");
    const ic = el("span", "empty-icon");
    ic.append(icone(nomIcone));
    v.append(ic, el("span", "empty-title", titre), el("span", "empty-sub", sous));
    return v;
  }

  // --- Un groupe (un transporteur) ------------------------------------------------------
  function creeGroupe(g) {
    const s = el("section", "card p-groupe carrier");
    s.dataset.carrier = couleur(g.code);
    s.dataset.code = g.code;
    const tete = el("button", "p-groupe-tete");
    tete.type = "button";
    const mix = el("span", "p-groupe-mix");
    for (const e of ETAPES) {
      const i = el("i");
      i.dataset.e = e;
      mix.append(i);
    }
    const chevron = icone("chevron-down");
    chevron.classList.add("p-groupe-chevron");
    tete.append(el("i", "carrier-dot"), el("span", "p-groupe-nom"), el("span", "p-groupe-n"), chevron, mix);
    const corps = el("div", "p-groupe-corps");
    const interieur = el("div", "p-groupe-interieur");
    const plus = el("button", "p-plus");
    plus.type = "button";
    interieur.append(el("div", "p-lignes"), plus);
    corps.append(interieur);
    s.append(tete, corps);
    majGroupe(s, g);
    return s;
  }

  function majGroupe(s, g) {
    const code = g.code;
    const focus = etat.transporteur === code;
    const ferme = !focus && etat.fermes.has(code);
    s.classList.toggle("ferme", ferme);
    const tete = s.querySelector(".p-groupe-tete");
    tete.setAttribute("aria-expanded", String(!ferme));
    s.querySelector(".p-groupe-nom").textContent = g.nom;
    s.querySelector(".p-groupe-n").textContent = pluriel(g.colis.length, "colis", "colis");
    for (const i of s.querySelectorAll(".p-groupe-mix i")) {
      i.style.flexGrow = String(g.colis.filter((c) => c.etape === i.dataset.e).length);
    }
    const enCours = g.colis.filter((c) => c.etape !== "drope").length;
    tete.setAttribute("aria-label", `${g.nom} : ${pluriel(g.colis.length, "colis", "colis")}, ${nf.format(enCours)} en cours. ${ferme ? "Afficher" : "Masquer"} le groupe`);

    // combien de lignes : un apercu, sauf si on a deplie le groupe ou choisi
    // ce transporteur. Replie, le groupe garde ses lignes le temps de
    // l'animation : elles ne sont plus mises a jour.
    const voulu = focus ? Math.max(LOT, etat.montres.get(code) || 0) : etat.montres.get(code) || APERCU;
    const montres = g.colis.slice(0, voulu);
    if (!ferme) {
      reconcilie(s.querySelector(".p-lignes"), montres, { cle: (c) => `c:${c.ref}`, cree: (c) => creeLigne(c), maj: (e, c) => majLigne(e, c), anime: true });
    }

    const plus = s.querySelector(".p-plus");
    const reste = g.colis.length - montres.length;
    if (reste > 0) {
      plus.hidden = false;
      plus.dataset.action = "plus";
      plus.textContent = voulu <= APERCU && reste <= LOT ? `Afficher les ${pluriel(reste, "autre colis", "autres colis")}` : `Afficher ${nf.format(Math.min(reste, LOT))} de plus`;
    } else {
      // deplie au-dela de l'apercu : on peut le reduire
      plus.hidden = focus || voulu <= APERCU;
      plus.dataset.action = "moins";
      plus.textContent = "Réduire";
    }
  }

  // --- Une ligne colis -----------------------------------------------------------------
  function creeLigne(c, recherche = "") {
    const ligne = el("article", "p-colis");
    const statut = el("span", "p-colis-statut");
    statut.append(el("span", "p-ico"));

    const centre = el("div", "p-colis-centre");
    const l1 = el("div", "p-colis-l1");
    const num = el("button", "p-num");
    num.type = "button";
    num.append(el("span", "p-num-texte"), icone("copy"));
    num.addEventListener("click", async () => {
      const n = ligne._colis?.suivi?.numero;
      if (!n) return;
      if (await copie(n)) {
        num.classList.add("copie");
        setTimeout(() => num.classList.remove("copie"), 1400);
        toast("Numéro copié");
      }
    });
    l1.append(num, el("span", "p-sans", "Sans numéro de suivi"));
    const l2 = el("div", "p-colis-l2");
    const tr = el("span", "p-colis-tr carrier");
    tr.append(el("i", "carrier-dot"), el("span"));
    l2.append(el("span", "p-etat-nom"), tr, el("span", "p-bj", "Boîte jaune"), el("span", "p-quand"));
    const seg = el("div", "p-seg");
    seg.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 4; i++) seg.append(el("i"));
    centre.append(l1, l2, seg);

    const suivre = el("a", "btn btn-sm btn-secondary p-suivre");
    suivre.target = "_blank";
    suivre.rel = "noopener noreferrer";
    suivre.referrerPolicy = "no-referrer";
    const libelle = el("span");
    libelle.append(document.createTextNode("Suivre"), el("span", "p-suivre-long", " le colis"));
    suivre.append(libelle, icone("external"));
    suivre.addEventListener("click", async (ev) => {
      const s = ligne._colis?.suivi;
      if (!s || s.lien) return; // lien direct : le navigateur l'ouvre
      // pas de lien direct chez ce transporteur : sa page, numero copie
      ev.preventDefault();
      const ok = await copie(s.numero);
      if (lienSur(s.page)) window.open(s.page, "_blank", "noopener,noreferrer");
      if (ok) toast("Numéro copié : colle-le sur la page du transporteur");
    });

    ligne.append(statut, centre, suivre);
    majLigne(ligne, c, recherche, { premiere: true });
    return ligne;
  }

  function majLigne(ligne, c, recherche = "", { premiere = false } = {}) {
    const avant = ligne._colis;
    ligne._colis = c;
    const etape = ETAPES.includes(c.etape) ? c.etape : "a_imprimer";
    const change = !premiere && avant && avant.etape !== etape;

    // le numero, la partie cherchee surlignee
    const numero = c.suivi?.numero || null;
    const num = ligne.querySelector(".p-num");
    num.hidden = !numero;
    ligne.querySelector(".p-sans").hidden = Boolean(numero);
    if (numero) {
      const texte = ligne.querySelector(".p-num-texte");
      const i = recherche ? numero.toUpperCase().indexOf(recherche) : -1;
      if (i >= 0) {
        texte.replaceChildren(
          document.createTextNode(numero.slice(0, i)),
          el("mark", null, numero.slice(i, i + recherche.length)),
          document.createTextNode(numero.slice(i + recherche.length))
        );
      } else if (texte.textContent !== numero || texte.childElementCount) {
        texte.textContent = numero;
      }
      num.setAttribute("aria-label", `Copier le numéro ${numero}`);
    }

    const tr = ligne.querySelector(".p-colis-tr");
    tr.dataset.carrier = couleur(codeDe(c));
    tr.lastElementChild.textContent = nomDe(c);
    ligne.querySelector(".p-bj").hidden = !c.boiteJaune;
    ligne.querySelector(".p-etat-nom").textContent = NOMS[etape];
    // la derniere etape franchie, et quand
    const moment = etape === "drope" && c.dropeLe ? `dropé ${quand(date(c.dropeLe))}` : c.recuLe ? `reçu ${quand(date(c.recuLe))}` : "";
    ligne.querySelector(".p-quand").textContent = moment;

    const rang = ETAPES.indexOf(etape);
    ligne.querySelectorAll(".p-seg i").forEach((i, n) => {
      i.classList.toggle("fait", n <= rang);
      i.classList.toggle("actuel", n === rang);
    });

    const suivre = ligne.querySelector(".p-suivre");
    const cible = c.suivi ? c.suivi.lien || c.suivi.page : null;
    if (lienSur(cible)) {
      suivre.hidden = false;
      suivre.href = cible;
      suivre.setAttribute("aria-label", `Suivre le colis ${numero} sur le site ${nomDe(c)}`);
    } else {
      suivre.hidden = true;
      suivre.removeAttribute("href");
    }

    const zone = ligne.querySelector(".p-colis-statut");
    const ico = zone.querySelector(".p-ico:not(.fantome)");
    if (change && !reduit) {
      // l'ancien statut s'efface pendant que le nouveau apparait a sa place
      const fantome = ico.cloneNode(true);
      fantome.classList.add("fantome");
      zone.append(fantome);
      fantome
        .animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.6) rotate(-12deg)", filter: "blur(3px)" }], {
          duration: 340,
          easing: "cubic-bezier(0.55, 0, 0.75, 0.2)",
          fill: "forwards",
        })
        .finished.then(() => fantome.remove(), () => fantome.remove());
      ico.replaceChildren(icone(etape));
      ico.animate([{ opacity: 0, transform: "scale(0.6) rotate(12deg)", filter: "blur(3px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], {
        duration: 520,
        delay: 120,
        easing: "cubic-bezier(0.34, 1.45, 0.64, 1)",
        fill: "backwards",
      });
      ligne.classList.remove("vient-de-changer");
      void ligne.offsetWidth;
      ligne.classList.add("vient-de-changer");
      setTimeout(() => ligne.classList.remove("vient-de-changer"), 1800);
      $("annonce").textContent = `${numero ? `Colis ${numero}` : "Un colis"} : ${NOMS[etape]}`;
    } else if (ligne.dataset.etape !== etape) {
      ico.replaceChildren(icone(etape));
    }
    ligne.dataset.etape = etape;
  }

  // --- Mise a jour d'une liste a cles ---------------------------------------------------
  // Les elements existants restent (et se mettent a jour sur place), les
  // nouveaux entrent en fondu, ceux qui ne sont plus voulus sont retires :
  // seul ce qui change bouge. `anime` : une mise a jour en direct (pas de
  // cascade a l'entree).
  function reconcilie(conteneur, items, { cle, cree, maj, anime = false }) {
    const existants = new Map();
    for (const e of [...conteneur.children]) {
      if (e.dataset.cle) existants.set(e.dataset.cle, e);
      else e.remove(); // squelettes du chargement
    }
    const voulus = new Set(items.map(cle));
    for (const [k, e] of existants) {
      if (!voulus.has(k)) {
        existants.delete(k);
        e.remove();
      }
    }
    let curseur = conteneur.firstElementChild;
    let rang = 0;
    for (const item of items) {
      const k = cle(item);
      let e = existants.get(k);
      if (!e) {
        e = cree(item);
        e.dataset.cle = k;
        if (!reduit) {
          e.classList.add("p-entre");
          e.style.animationDelay = `${anime ? 0 : Math.min(rang, 10) * 30}ms`;
          e.addEventListener("animationend", () => e.classList.remove("p-entre"), { once: true });
        }
      } else if (maj) {
        maj(e, item);
      }
      rang += 1;
      if (curseur === e) curseur = curseur.nextElementSibling;
      else conteneur.insertBefore(e, curseur);
    }
  }

  // Un nombre qui change roule jusqu'a sa nouvelle valeur.
  function roule(cible, n, signale) {
    const premier = cible.dataset.valeur === undefined;
    const depuis = Number(cible.dataset.valeur ?? 0);
    cible.dataset.valeur = String(n);
    if (depuis === n && !premier) return;
    if (reduit) {
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
    if (signale && !premier) {
      const tuile = cible.closest(".p-etape");
      tuile.classList.remove("pulse");
      void tuile.offsetWidth;
      tuile.classList.add("pulse");
    }
  }

  // --- Gestes ---------------------------------------------------------------------------
  const champ = $("recherche");
  const zoneRecherche = $("zone-recherche");
  function surRecherche() {
    etat.q = champ.value;
    zoneRecherche.classList.toggle("a-texte", Boolean(etat.q));
    $("effacer").hidden = !etat.q;
    rend();
  }
  champ.addEventListener("input", surRecherche);
  champ.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      champ.value = "";
      surRecherche();
    } else if (e.key === "Enter") {
      champ.blur(); // ferme le clavier du telephone : les resultats sont deja la
    }
  });
  // sur telephone, la recherche remonte en haut de l'ecran au premier appui
  champ.addEventListener("focus", () => {
    if (innerWidth < 960 && zoneRecherche.getBoundingClientRect().top > 80) {
      zoneRecherche.scrollIntoView({ behavior: reduit ? "auto" : "smooth", block: "start" });
    }
  });
  $("effacer").addEventListener("click", () => {
    champ.value = "";
    surRecherche();
    champ.focus();
  });
  // "/" place le curseur dans la recherche (au clavier)
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== champ && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      champ.focus();
    }
  });

  for (const b of document.querySelectorAll(".p-etape")) {
    b.addEventListener("click", () => {
      etat.etape = etat.etape === b.dataset.etape ? null : b.dataset.etape;
      rend();
    });
  }

  $("transporteurs").addEventListener("click", (e) => {
    const b = e.target.closest(".p-tr");
    if (!b) return;
    const code = b.dataset.code;
    etat.transporteur = code === "*" || etat.transporteur === code ? null : code;
    rend();
    if (etat.transporteur && innerWidth < 960) $("liste").scrollIntoView({ behavior: reduit ? "auto" : "smooth", block: "start" });
  });

  $("barre-texte").addEventListener("click", (e) => {
    const b = e.target.closest("[data-retire]");
    if (!b) return;
    etat[b.dataset.retire] = null;
    rend();
  });

  const boutonsTri = document.querySelectorAll(".p-tri button");
  for (const b of boutonsTri) {
    b.setAttribute("aria-pressed", String(b.dataset.tri === etat.tri));
    b.addEventListener("click", () => {
      etat.tri = b.dataset.tri;
      memoire.ecris("drop.portail.tri", etat.tri);
      for (const x of boutonsTri) x.setAttribute("aria-pressed", String(x === b));
      rend();
    });
  }

  $("liste").addEventListener("click", (e) => {
    const groupe = e.target.closest(".p-groupe");
    if (!groupe) return;
    const code = groupe.dataset.code;
    if (e.target.closest(".p-groupe-tete")) {
      if (etat.transporteur === code) return; // un transporteur choisi reste deplie
      if (etat.fermes.has(code)) etat.fermes.delete(code);
      else etat.fermes.add(code);
      memoire.ecris("drop.portail.fermes", [...etat.fermes]);
      rend();
    } else if (e.target.closest(".p-plus")) {
      const plus = e.target.closest(".p-plus");
      if (plus.dataset.action === "moins") {
        etat.montres.delete(code);
        rend();
        groupe.scrollIntoView({ behavior: reduit ? "auto" : "smooth", block: "nearest" });
      } else {
        const deja = etat.transporteur === code ? Math.max(LOT, etat.montres.get(code) || 0) : etat.montres.get(code) || APERCU;
        etat.montres.set(code, deja <= APERCU ? LOT : deja + LOT);
        rend();
      }
    }
  });

  // --- C'est parti -----------------------------------------------------------------------
  if (!jeton) lienRefuse(404);
  else charge();
})();
