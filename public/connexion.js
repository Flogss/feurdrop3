// La page de connexion du dashboard. Le mot de passe part au serveur (en
// HTTPS) et n'est garde nulle part ; le serveur repond par un cookie de
// session HttpOnly que cette page ne peut meme pas lire. Les animations ne
// decident de rien : seule la reponse du serveur ouvre le dashboard.
(() => {
  const $ = (id) => document.getElementById(id);
  const formulaire = $("connexion");
  const champ = $("mot-de-passe");
  const boite = $("champ");
  const bouton = $("entrer");
  const erreur = $("erreur");
  const reduit = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let attenteFin = 0;
  let minuteur = null;
  let calme = null;

  function dit(texte, { attente = false } = {}) {
    $("erreur-texte").textContent = texte || "";
    erreur.classList.toggle("visible", Boolean(texte));
    erreur.classList.toggle("attente", attente);
  }

  // le champ vibre a peine, se teinte, puis revient au calme
  function refuse() {
    boite.classList.remove("erreur");
    void boite.offsetWidth;
    boite.classList.add("erreur");
    clearTimeout(calme);
    calme = setTimeout(() => boite.classList.remove("erreur"), 1600);
    if (navigator.vibrate) navigator.vibrate([12, 40, 12]);
  }

  // « Réessaie dans 8 s » : le bouton se rouvre de lui-meme
  function attends(secondes) {
    attenteFin = Date.now() + secondes * 1000;
    clearInterval(minuteur);
    const tic = () => {
      const reste = Math.ceil((attenteFin - Date.now()) / 1000);
      if (reste <= 0) {
        clearInterval(minuteur);
        bouton.disabled = false;
        bouton.classList.remove("attente");
        dit("");
        return;
      }
      bouton.disabled = true;
      bouton.classList.add("attente");
      dit(`Trop d'essais. Réessaie dans ${reste < 60 ? `${reste} s` : `${Math.ceil(reste / 60)} min`}.`, { attente: true });
    };
    tic();
    minuteur = setInterval(tic, 1000);
  }

  $("voir").addEventListener("click", (e) => {
    const visible = champ.type === "password";
    champ.type = visible ? "text" : "password";
    e.currentTarget.setAttribute("aria-pressed", String(visible));
    e.currentTarget.setAttribute("aria-label", visible ? "Masquer le mot de passe" : "Afficher le mot de passe");
    champ.focus();
  });

  // chaque frappe fait respirer la lueur du champ ; corriger efface l'erreur
  champ.addEventListener("input", () => {
    if (reduit) return;
    boite.classList.remove("frappe");
    void boite.offsetWidth;
    boite.classList.add("frappe");
    if (boite.classList.contains("erreur") && Date.now() >= attenteFin) {
      boite.classList.remove("erreur");
      dit("");
    }
  });

  // --- la sortie : la sphere du bouton devient le coeur de la meteorite, la
  // carte s'y dissout, l'ecran s'eteint sur le graphite du lancement ; le
  // dashboard reprend la sequence a cet instant (lancement.js, "connexion")
  function entre() {
    try {
      sessionStorage.setItem("drop-entree", "connexion");
    } catch {
      /* pas de stockage : le dashboard jouera son entree normale */
    }
    if (reduit) return location.replace("/");
    formulaire.classList.add("ouvre");
    const w = innerWidth, h = innerHeight;
    const petit = Math.min(w, h);
    const cote = Math.min(Math.max(petit * 0.3, 96), 150);
    // la meme place et la meme taille que la roche du lancement
    const cible = [0.5 * w, (w > h ? 0.47 : 0.42) * h];
    const echelle = (cote * 0.25 * 2) / 54;
    const r = bouton.getBoundingClientRect();
    const depart = [r.left + r.width / 2, r.top + r.height / 2];

    const orbe = document.createElement("span");
    orbe.className = "orbe";
    document.body.appendChild(orbe);
    const images = [];
    for (let i = 0; i <= 12; i++) {
      const f = i / 12;
      const e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
      const arc = Math.sin(Math.PI * f) * 70;
      images.push({
        offset: f,
        transform: `translate(${depart[0] + (cible[0] - depart[0]) * e}px, ${depart[1] + (cible[1] - depart[1]) * e - arc}px) scale(${1 + (echelle - 1) * e + 0.18 * Math.sin(Math.PI * f)})`,
      });
    }
    orbe.animate(images, { duration: 760, delay: 180, easing: "linear", fill: "both" });
    orbe.animate(
      [{ filter: "brightness(1)" }, { filter: "brightness(1.5)", offset: 0.85 }, { filter: "brightness(1.15)" }],
      { duration: 1000, delay: 180, fill: "both" }
    );
    bouton.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: 170, fill: "both" });

    // la carte se dissout : sa matiere est aspiree dans la sphere
    const rc = formulaire.getBoundingClientRect();
    formulaire.animate(
      [
        { opacity: 1, transform: "rotateX(0) scale(1)", filter: "blur(0)" },
        { opacity: 0, transform: "translateZ(-80px) scale(0.92)", filter: "blur(10px)" },
      ],
      { duration: 620, delay: 260, easing: "cubic-bezier(0.55, 0, 0.75, 0)", fill: "both" }
    );
    const nombre = w < 600 ? 26 : 40;
    for (let i = 0; i < nombre; i++) {
      const p = document.createElement("span");
      p.className = "poussiere";
      document.body.appendChild(p);
      const x0 = rc.left + Math.random() * rc.width, y0 = rc.top + Math.random() * rc.height;
      const dx = cible[0] - x0, dy = cible[1] - y0;
      const tourne = (Math.random() < 0.8 ? 1 : -1) * (0.25 + Math.random() * 0.25);
      const etapes = [];
      for (let j = 0; j <= 8; j++) {
        const f = j / 8;
        const e = f * f * (3 - 2 * f);
        const s = Math.sin(Math.PI * e) * tourne;
        etapes.push({
          offset: f,
          opacity: j === 0 ? 0 : j === 8 ? 0 : 1,
          transform: `translate(${x0 + dx * e - dy * s}px, ${y0 + dy * e + dx * s}px) scale(${1.4 - e})`,
        });
      }
      p.animate(etapes, { duration: 520 + Math.random() * 300, delay: 240 + Math.random() * 260, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "both" });
    }
    $("noir").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 640, delay: 380, easing: "ease-in", fill: "both" });
    document.querySelector(".horizon")?.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(6vh)" }], { duration: 600, delay: 200, fill: "both" });
    setTimeout(() => location.replace("/"), 1060);
  }

  formulaire.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (bouton.disabled || bouton.classList.contains("envoi")) return;
    const motDePasse = champ.value;
    if (!motDePasse) {
      dit("Entre le mot de passe.");
      refuse();
      champ.focus();
      return;
    }
    bouton.classList.add("envoi");
    bouton.setAttribute("aria-busy", "true");
    dit("");
    const debut = Date.now();
    // la sphere tourne au moins un instant : un refus instantane ne doit pas
    // donner l'impression que rien ne s'est passe
    const auMoins = () => new Promise((r) => setTimeout(r, Math.max(0, 420 - (Date.now() - debut))));
    try {
      const reponse = await fetch("/api/auth/connexion", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motDePasse, mode: "web" }),
      });
      const corps = await reponse.json().catch(() => ({}));
      await auMoins();
      if (reponse.ok) {
        champ.value = "";
        entre();
        return;
      }
      bouton.classList.remove("envoi");
      refuse();
      champ.focus();
      champ.select();
      if (reponse.status === 429) return attends(Number(corps.attente || reponse.headers.get("retry-after")) || 30);
      dit(corps.error || "Connexion impossible");
    } catch {
      await auMoins();
      bouton.classList.remove("envoi");
      refuse();
      dit("Serveur injoignable. Vérifie ta connexion et réessaie.");
    } finally {
      bouton.removeAttribute("aria-busy");
      if (Date.now() >= attenteFin) bouton.disabled = false;
    }
  });

  // --- la carte suit le pointeur : un reflet, une legere inclinaison
  if (!reduit && matchMedia("(hover: hover) and (pointer: fine)").matches) {
    let image = 0;
    addEventListener("pointermove", (e) => {
      cancelAnimationFrame(image);
      image = requestAnimationFrame(() => {
        const r = formulaire.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        formulaire.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
        formulaire.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
        const bx = Math.max(-1, Math.min(1, x * 2 - 1)), by = Math.max(-1, Math.min(1, y * 2 - 1));
        formulaire.style.setProperty("--ry", `${(bx * 3.2).toFixed(2)}deg`);
        formulaire.style.setProperty("--rx", `${(-by * 2.6).toFixed(2)}deg`);
      });
    });
    document.addEventListener("pointerleave", () => {
      formulaire.style.setProperty("--rx", "0deg");
      formulaire.style.setProperty("--ry", "0deg");
    });
  }

  // le fond vivant du dashboard (particules dessinees dans un worker)
  const toile = $("particules");
  if (!reduit && toile && toile.transferControlToOffscreen && window.Worker) {
    try {
      const hors = toile.transferControlToOffscreen();
      const travailleur = new Worker("/particules.js");
      const dpr = () => Math.min(devicePixelRatio || 1, 2);
      travailleur.postMessage({ type: "init", toile: hors, L: innerWidth, H: innerHeight, dpr: dpr(), nombre: innerWidth < 700 ? 24 : 44 }, [hors]);
      addEventListener("resize", () => travailleur.postMessage({ type: "taille", L: innerWidth, H: innerHeight, dpr: dpr() }));
      document.addEventListener("visibilitychange", () => travailleur.postMessage({ type: "pause", pause: document.hidden }));
    } catch {
      /* pas de particules : la page reste utilisable */
    }
  }
})();
