// La page de connexion du dashboard. Le mot de passe part au serveur (en
// HTTPS) et n'est garde nulle part ; le serveur repond par un cookie de
// session HttpOnly que cette page ne peut meme pas lire.
(() => {
  const $ = (id) => document.getElementById(id);
  const formulaire = $("connexion");
  const champ = $("mot-de-passe");
  const bouton = $("entrer");
  const erreur = $("erreur");
  let attenteFin = 0;
  let minuteur = null;

  function dit(texte) {
    erreur.textContent = texte || "";
  }

  function secoue() {
    formulaire.classList.remove("secoue");
    void formulaire.offsetWidth;
    formulaire.classList.add("secoue");
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
        dit("");
        return;
      }
      bouton.disabled = true;
      dit(`Trop d'essais. Réessaie dans ${reste < 60 ? `${reste} s` : `${Math.ceil(reste / 60)} min`}.`);
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

  formulaire.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (bouton.disabled) return;
    const motDePasse = champ.value;
    if (!motDePasse) {
      dit("Entre le mot de passe.");
      secoue();
      return;
    }
    bouton.disabled = true;
    bouton.setAttribute("aria-busy", "true");
    dit("");
    try {
      const reponse = await fetch("/api/auth/connexion", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motDePasse, mode: "web" }),
      });
      const corps = await reponse.json().catch(() => ({}));
      if (reponse.ok) {
        champ.value = "";
        location.replace("/");
        return;
      }
      champ.select();
      secoue();
      if (reponse.status === 429) return attends(Number(corps.attente || reponse.headers.get("retry-after")) || 30);
      dit(corps.error || "Connexion impossible");
    } catch {
      dit("Serveur injoignable. Vérifie ta connexion et réessaie.");
    } finally {
      bouton.removeAttribute("aria-busy");
      if (Date.now() >= attenteFin) bouton.disabled = false;
    }
  });

  // le fond vivant du dashboard (particules dessinees dans un worker)
  const toile = $("particules");
  const reduit = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
