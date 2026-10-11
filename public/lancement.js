/* La sequence de lancement du site, la meme que l'app : au loin une lumiere
   violette, un point s'allume ; la meteorite se met en route, accelere,
   passe tout pres en traversant l'ecran, freine et s'immobilise au centre.
   Elle se fissure, la lumiere monte dans ses failles, elle se fragmente ;
   ses eclats deviennent energie et viennent un par un tracer le symbole de
   DROP, qui se condense en logo. Une onde part du logo et ouvre
   l'interface : chaque carte entre au moment ou l'onde l'atteint, et le
   logo rejoint sa place dans la barre.

   Trois entrees :
   - "complet" : la scene entiere (premiere visite, ou plus de 6 h apres) ;
   - "retour"  : une page rechargee -- l'energie se rassemble en logo puis
                 l'onde (environ 1 s) ;
   - "connexion" : juste apres le mot de passe -- la page de connexion a
                 deja amene le coeur lumineux au centre ; la roche s'y
                 fissure, puis la suite.
   `?intro=complet|retour|connexion` force une entree.

   La lumiere est dessinee en WebGL dans un worker (lancement-worker.js) :
   la page se construit dessous sans la faire hoqueter. Ici : le calendrier,
   le logo (un element de la page, net) et son vol jusqu'a la marque, et
   l'heure a laquelle l'onde atteint chaque point (les cartes s'y calent).
   Toucher l'ecran (ou une touche) passe directement au logo.
   `?introFige=3.1` arrete la sequence a cet instant (pour les photos). */

(() => {
  "use strict";

  const S = { point: 0.3, depart: 0.7, arrivee: 2.3, eclat: 2.72, attraction: 2.94, logo: 3.72, revelation: 4.0, dureeRevelation: 0.95, vol: 0.66, fin: 5.05, retour: 2.95, connexion: 2.58 };
  const toileDepart = document.getElementById("lancement");
  const params = new URLSearchParams(location.search);
  const fige = params.has("introFige") ? parseFloat(params.get("introFige")) : null;
  const reduit = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const maintenant = () => performance.timeOrigin + performance.now();

  // --- quelle entree
  const CLE = "drop-lancement-complet";
  const DELAI_COMPLET = 6 * 3600 * 1000;
  function choisitEntree() {
    const forcee = params.get("intro");
    if (["complet", "retour", "connexion"].includes(forcee)) return forcee;
    let depuisConnexion = false;
    try {
      depuisConnexion = sessionStorage.getItem("drop-entree") === "connexion";
      sessionStorage.removeItem("drop-entree");
    } catch {
      /* stockage indisponible : entree complete */
    }
    if (depuisConnexion) return "connexion";
    try {
      const dernier = Number(localStorage.getItem(CLE) || 0);
      if (Date.now() - dernier < DELAI_COMPLET) return "retour";
    } catch {
      /* idem */
    }
    return "complet";
  }
  const entree = fige !== null ? "complet" : choisitEntree();
  if (entree === "complet" && fige === null) {
    try {
      localStorage.setItem(CLE, String(Date.now()));
    } catch {
      /* rien */
    }
  }
  // mouvements reduits : pas de meteorite, le logo puis l'onde
  const instantDepart = reduit ? S.logo - 0.15 : entree === "retour" ? S.retour : entree === "connexion" ? S.connexion : 0;

  let revele, finit;
  const revelation = new Promise((r) => (revele = r));
  const fin = new Promise((r) => (finit = r));
  let debut = maintenant() - instantDepart * 1000;
  let ouverte = false;

  let toile = toileDepart;
  const taille = () => ({ w: toile?.clientWidth || innerWidth, h: toile?.clientHeight || innerHeight });
  // la meme geometrie que le rendu
  const geometrie = () => {
    const { w, h } = taille();
    const petit = Math.min(w, h);
    return {
      w, h,
      centre: [0.5 * w, (w > h ? 0.47 : 0.42) * h],
      cote: Math.min(Math.max(petit * 0.3, 96), 150),
      k: Math.min(Math.max(petit / 400, 0.9), 1.7),
    };
  };
  // le rayon de l'onde a l'instant t (le meme calcul que le rendu)
  function rayonOnde(t) {
    const g = geometrie();
    const s = Math.min(Math.max((t - S.revelation) / S.dureeRevelation, 0), 1);
    const e = 1 - Math.pow(1 - s, 1.8);
    const bord = (80 + 160 * e) * g.k;
    const coin = Math.hypot(Math.max(g.centre[0], g.w - g.centre[0]), Math.max(g.centre[1], g.h - g.centre[1]));
    return g.cote * 0.6 + e * (coin + bord * 1.3) - bord * 0.6;
  }

  window.lancementDrop = {
    entree,
    revelation,
    fin,
    /** le temps (ms) avant que l'onde ouvre l'interface */
    reste: () => (ouverte ? 0 : Math.max(0, debut + S.revelation * 1000 - maintenant())),
    /** le temps (ms) avant que l'onde atteigne ce point de l'ecran */
    atteint(x, y) {
      const g = geometrie();
      const dist = Math.hypot(x - g.centre[0], y - g.centre[1]);
      let a = S.revelation, b = S.revelation + S.dureeRevelation;
      if (rayonOnde(b) < dist) return Math.max(0, debut + b * 1000 - maintenant());
      for (let i = 0; i < 18; i++) {
        const m = (a + b) / 2;
        if (rayonOnde(m) < dist) a = m;
        else b = m;
      }
      return Math.max(0, debut + b * 1000 - maintenant());
    },
  };

  const sansSequence = () => {
    toile?.remove();
    document.body.classList.remove("lancement", "lancement-marque");
    ouverte = true;
    revele();
    finit();
  };
  if (!toileDepart || !("WebGL2RenderingContext" in window)) {
    sansSequence();
    return;
  }

  // la definition de la toile : celle de l'ecran (2 au plus), dans un budget
  // de pixels -- sur un tres grand ecran, une lumiere douce n'a pas besoin de
  // 8 millions de points, et la meteorite garde ses 60 images par seconde
  const BUDGET = 4.2e6;
  const definition = (w, h) => Math.max(1, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(BUDGET / Math.max(w * h, 1))));
  let dpr = definition(innerWidth, innerHeight);

  // --- le rendu : dans un worker si possible, sinon sur le fil principal

  let worker = null;
  let rendu = null;
  let raf = 0;

  const allume = () => toile.classList.add("allumee");

  function surFilPrincipal() {
    // la toile a pu etre cedee au worker : on en pose une neuve
    if (toile.dataset.cedee) {
      const neuve = document.createElement("canvas");
      neuve.id = "lancement";
      toile.replaceWith(neuve);
      toile = neuve;
      toile.addEventListener("pointerdown", accelere);
    }
    const lance = () => {
      rendu = window.LancementDrop.creeRendu(toile);
      if (!rendu) {
        sansSequence();
        return;
      }
      const { w, h } = taille();
      rendu.taille(w, h, dpr);
      rendu.entree(instantDepart);
      let premiere = true;
      const image = () => {
        rendu.image(fige ?? (maintenant() - debut) / 1000);
        if (premiere) {
          premiere = false;
          allume();
        }
        raf = requestAnimationFrame(image);
      };
      raf = requestAnimationFrame(image);
    };
    if (window.LancementDrop) lance();
    else {
      const s = document.createElement("script");
      s.src = "lancement-rendu.js";
      s.onload = lance;
      s.onerror = sansSequence;
      document.head.appendChild(s);
    }
  }

  function demarre() {
    const { w, h } = taille();
    if (toile.transferControlToOffscreen && "Worker" in window) {
      try {
        worker = new Worker("lancement-worker.js");
        const ecran = toile.transferControlToOffscreen();
        toile.dataset.cedee = "1";
        worker.onmessage = (e) => {
          if (e.data.type === "premiere") allume();
          else if (e.data.type === "mesure") console.info(e.data.texte);
          else if (e.data.type === "echec") {
            worker.terminate();
            worker = null;
            surFilPrincipal();
          }
        };
        worker.onerror = () => {
          worker?.terminate();
          worker = null;
          surFilPrincipal();
        };
        worker.postMessage({ type: "init", toile: ecran, w, h, dpr, debut, fige, entree: instantDepart, mesure: params.has("introMesure") }, [ecran]);
        return;
      } catch {
        worker?.terminate();
        worker = null;
      }
    }
    surFilPrincipal();
  }

  // --- le logo : il se condense dans la lumiere du symbole, un reflet le
  // traverse, puis il vole jusqu'a la marque (ou se dissout s'il n'y en a pas)

  const logo = document.createElement("div");
  logo.className = "lancement-logo";
  logo.setAttribute("aria-hidden", "true");
  logo.innerHTML = '<span class="lancement-reflet"></span><svg class="icon"><use href="#i-logo"/></svg>';
  document.body.appendChild(logo);

  function placeLogo() {
    const g = geometrie();
    Object.assign(logo.style, {
      left: `${g.centre[0] - g.cote / 2}px`,
      top: `${g.centre[1] - g.cote / 2}px`,
      width: `${g.cote}px`,
      height: `${g.cote}px`,
      borderRadius: `${g.cote * 0.32}px`,
    });
  }
  placeLogo();

  const animations = [];
  const joue = (el, images, options) => {
    const a = el.animate(images, { fill: "both", ...options });
    animations.push(a);
    return a;
  };

  function montreLogo(deja = 0) {
    // la matiere du logo se condense sous les traits de lumiere : flou,
    // surexpose, puis net
    joue(logo, [
      { opacity: 0, transform: "scale(0.9)", filter: "blur(10px) brightness(2.2)" },
      { opacity: 1, transform: "scale(1.02)", filter: "blur(2px) brightness(1.5)", offset: 0.55 },
      { opacity: 1, transform: "scale(1)", filter: "blur(0) brightness(1)" },
    ], { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)", delay: -deja });
    joue(logo.querySelector(".lancement-reflet"), [{ transform: "translateX(-140%) rotate(20deg)" }, { transform: "translateX(260%) rotate(20deg)" }], {
      duration: 460, easing: "ease-in-out", delay: 140 - deja,
    });
  }

  function ouvre(deja = 0) {
    if (!ouverte) {
      ouverte = true;
      revele();
    }
    const marque = document.querySelector(".brand-mark");
    const r = marque?.getBoundingClientRect();
    const g = geometrie();
    if (r && r.width > 0) {
      // le vol, en arc : quelques etapes calculees le long de la courbe
      const dx = r.left + r.width / 2 - g.centre[0];
      const dy = r.top + r.height / 2 - g.centre[1];
      const s = r.width / g.cote;
      const etapes = [];
      for (let i = 0; i <= 12; i++) {
        const f = i / 12;
        const arc = Math.sin(Math.PI * f);
        etapes.push({
          offset: f,
          transform: `translate(${dx * f}px, ${dy * f - arc * 56 * g.k}px) scale(${(1 + (s - 1) * f) * (1 + 0.07 * arc)}) rotate(${-8 * arc}deg)`,
        });
      }
      const vol = joue(logo, etapes, { duration: S.vol * 1000, easing: "cubic-bezier(0.65, 0, 0.35, 1)", delay: -deja });
      vol.onfinish = () => {
        logo.remove();
        document.body.classList.remove("lancement-marque");
        marque.classList.add("pose");
        setTimeout(() => marque.classList.remove("pose"), 700);
      };
    } else {
      joue(logo, [{ opacity: 1, transform: "scale(1)", filter: "blur(0)" }, { opacity: 0, transform: "scale(1.35)", filter: "blur(14px)" }], {
        duration: 500, easing: "cubic-bezier(0.22, 1, 0.36, 1)", delay: -deja,
      }).onfinish = () => logo.remove();
    }
  }

  function termine() {
    worker?.postMessage({ type: "fin" });
    if (worker && params.has("introMesure")) setTimeout(() => worker.terminate(), 500);
    cancelAnimationFrame(raf);
    toile.remove();
    document.body.classList.remove("lancement");
    finit();
  }

  // --- le calendrier

  let minuteurs = [];
  const quand = (t, f) => minuteurs.push(setTimeout(f, Math.max(0, debut + t * 1000 - maintenant())));

  function planifie() {
    minuteurs.forEach(clearTimeout);
    minuteurs = [];
    const t = (maintenant() - debut) / 1000;
    if (t < S.logo) quand(S.logo, () => montreLogo());
    else if (t < S.revelation) montreLogo((t - S.logo) * 1000);
    quand(S.revelation, () => ouvre());
    quand(S.fin, termine);
  }

  // toucher pendant la sequence (ou une touche) : on passe au logo
  function accelere() {
    if (fige !== null) return;
    if ((maintenant() - debut) / 1000 < S.logo - 0.25) {
      debut = maintenant() - (S.logo - 0.25) * 1000;
      worker?.postMessage({ type: "debut", debut });
      planifie();
    }
  }
  toile.addEventListener("pointerdown", accelere);
  addEventListener("keydown", function touche(e) {
    if (ouverte) return removeEventListener("keydown", touche);
    if (!e.metaKey && !e.ctrlKey) accelere();
  });

  addEventListener("resize", () => {
    const { w, h } = taille();
    dpr = definition(w, h);
    if (worker) worker.postMessage({ type: "taille", w, h, dpr });
    else rendu?.taille(w, h, dpr);
    if (!ouverte) placeLogo();
  });

  demarre();
  if (fige === null) {
    planifie();
  } else {
    // une image arretee : l'etat de chaque piece a cet instant
    if (fige >= S.logo) montreLogo(Math.min(fige - S.logo, 0.6) * 1000);
    if (fige >= S.revelation) {
      document.addEventListener("DOMContentLoaded", () => {
        ouvre(Math.min(fige - S.revelation, S.vol - 0.01) * 1000);
        animations.forEach((a) => a.pause());
      });
    } else {
      animations.forEach((a) => a.pause());
    }
  }
})();
