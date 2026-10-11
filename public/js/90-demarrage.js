// --- Demarrage --------------------------------------------------------------------
// La sequence d'entree : le fond se leve, les barres arrivent (CSS), puis des
// que les premiers chiffres sont la -- ou au plus tard apres un court instant
// -- le contenu entre en cascade et les compteurs se mettent a monter.

document.querySelectorAll("[data-skeleton], .stock-value").forEach((el) => el.classList.add("is-loading"));
$("carrier-rows").innerHTML = squelettes(3);
$("sender-rows").innerHTML = squelettes(3);

async function demarre() {
  // la page demandee dans l'adresse (#imprime, #stats...) s'ouvre directement :
  // c'est ce qui fait marcher les raccourcis de l'app installee
  const demandee = location.hash.slice(1);
  const initiale = VUES.includes(demandee) ? demandee : "dashboard";
  const page = $(`view-${initiale}`);
  if (initiale !== "dashboard") {
    const dash = $("view-dashboard");
    dash.classList.remove("active", "attente");
    page.classList.add("active", "attente");
    currentView = initiale;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === (VUE_PARENT[initiale] || initiale)));
  }
  requestAnimationFrame(() => placeIndicateur(VUE_PARENT[initiale] || initiale, { instantane: true }));
  vuesVisitees.add(initiale);

  // la sequence de lancement (lancement.js) : la meteorite file pendant que
  // les premiers chiffres arrivent ; son onde ouvre l'interface
  const lancement = window.lancementDrop;
  const chargement =
    initiale === "stats"
      ? (lancement?.revelation ?? Promise.resolve()).then(() => Promise.all([loadStats(true, true, true), loadRevenueStats(true, true, true)]))
      : initiale === "imprime"
        ? loadImprime()
        : initiale === "special"
          ? loadSpecial()
          : initiale === "suivi"
            ? loadSuivi()
            : initiale === "depots"
              ? loadDepots(true)
              : initiale === "historique"
                ? loadJournal()
                : refreshAll();
  if (["imprime", "special", "suivi", "depots", "historique"].includes(initiale)) refreshAll().catch(() => {});

  if (lancement) {
    await lancement.revelation;
  } else {
    // on n'attend jamais plus d'un instant : au-dela, la cascade part avec les
    // squelettes et les chiffres suivront
    await Promise.race([chargement.catch(() => {}), attends(1100)]);
    await attends(140);
  }
  // les barres arrivent (CSS body.boot), le contenu entre en cascade
  document.body.classList.add("boot");
  page.classList.remove("attente");
  // les barres du haut et du bas naissent aussi quand l'onde les atteint
  const onde = lancement && lancement.entree !== undefined ? (x, y) => lancement.atteint(x, y) : null;
  if (onde) {
    for (const el of document.querySelectorAll(".topbar > .brand, .topbar > .topbar-end, .tabbar")) {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--delai-onde", `${Math.max(0, Math.round(onde(r.left + r.width / 2, r.top + r.height / 2) - 120))}ms`);
    }
  }
  entreePage(page, true, true, onde);
  setTimeout(() => document.body.classList.remove("boot"), onde ? 2600 : 2200);
}

initPush();
demarre();
setInterval(rafraichitEnFond, 5000);
