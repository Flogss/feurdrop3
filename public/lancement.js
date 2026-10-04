/* La sequence de lancement du site, la meme que l'app : une meteorite violette
   plonge du fond de l'espace, s'ecrase au centre, ses fragments reviennent
   dessiner le symbole de DROP, la lumiere se condense en logo, puis une onde
   ouvre l'interface et le logo rejoint sa place dans la barre.

   La lumiere est dessinee en WebGL dans un worker (lancement-worker.js) :
   la page se construit dessous sans la faire hoqueter. Ici : le calendrier,
   le logo (un element de la page, net) et son vol jusqu'a la marque.
   Toucher l'ecran passe directement au logo. `?introFige=1.3` arrete la
   sequence a cet instant (pour les photos). */

(() => {
  "use strict";

  const S = { point: 0.12, depart: 0.3, impact: 1.3, logo: 2.12, revelation: 2.45, dureeRevelation: 0.8, vol: 0.62, fin: 3.3 };
  const toileDepart = document.getElementById("lancement");
  const params = new URLSearchParams(location.search);
  const fige = params.has("introFige") ? parseFloat(params.get("introFige")) : null;
  const reduit = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const maintenant = () => performance.timeOrigin + performance.now();

  let revele, finit;
  const revelation = new Promise((r) => (revele = r));
  const fin = new Promise((r) => (finit = r));
  // mouvements reduits : pas de meteorite, le logo puis l'onde
  let debut = maintenant() - (reduit ? S.logo * 1000 : 0);
  let ouverte = false;

  window.lancementDrop = {
    revelation,
    fin,
    /** le temps (ms) avant que l'onde ouvre l'interface */
    reste: () => (ouverte ? 0 : Math.max(0, debut + S.revelation * 1000 - maintenant())),
  };

  const sansSequence = () => {
    toileDepart?.remove();
    document.body.classList.remove("lancement", "lancement-marque");
    ouverte = true;
    revele();
    finit();
  };
  if (!toileDepart || !("WebGL2RenderingContext" in window)) {
    sansSequence();
    return;
  }

  let toile = toileDepart;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const taille = () => ({ w: toile.clientWidth || innerWidth, h: toile.clientHeight || innerHeight });
  // la meme geometrie que le rendu
  const geometrie = () => {
    const { w, h } = taille();
    const petit = Math.min(w, h);
    return {
      centre: [0.5 * w, (w > h ? 0.47 : 0.42) * h],
      cote: Math.min(Math.max(petit * 0.3, 96), 150),
      k: Math.min(Math.max(petit / 400, 0.9), 1.7),
    };
  };

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
        worker.postMessage({ type: "init", toile: ecran, w, h, dpr, debut, fige, mesure: params.has("introMesure") }, [ecran]);
        return;
      } catch {
        worker?.terminate();
        worker = null;
      }
    }
    surFilPrincipal();
  }

  // --- le logo : il se condense, un reflet le traverse, puis il vole jusqu'a
  // la marque (ou se dissout s'il n'y en a pas)

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
    joue(logo, [{ opacity: 0, transform: "scale(0.86)" }, { opacity: 1, transform: "scale(1)" }], {
      duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)", delay: -deja,
    });
    joue(logo.querySelector(".lancement-reflet"), [{ transform: "translateX(-140%) rotate(20deg)" }, { transform: "translateX(260%) rotate(20deg)" }], {
      duration: 420, easing: "ease-in-out", delay: 120 - deja,
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
      for (let i = 0; i <= 10; i++) {
        const f = i / 10;
        const arc = Math.sin(Math.PI * f);
        etapes.push({
          offset: f,
          transform: `translate(${dx * f}px, ${dy * f - arc * 50 * g.k}px) scale(${(1 + (s - 1) * f) * (1 + 0.06 * arc)})`,
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

  // toucher pendant la sequence : on passe au logo
  function accelere() {
    if (fige !== null) return;
    if ((maintenant() - debut) / 1000 < S.logo - 0.05) {
      debut = maintenant() - S.logo * 1000;
      worker?.postMessage({ type: "debut", debut });
      planifie();
    }
  }
  toile.addEventListener("pointerdown", accelere);

  addEventListener("resize", () => {
    const { w, h } = taille();
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
