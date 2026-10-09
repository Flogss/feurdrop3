// --- Rafraichissement ----------------------------------------------------------

// Tant que le dashboard est ouvert et visible, on previent le serveur : le
// "+N" des notifications compte les colis arrives depuis la derniere fois
// qu'on l'a regarde. Une fois toutes les 30 s suffit pour le "+N".
let dernierVu = 0;
function markSeen(force = false) {
  if (document.visibilityState !== "visible") return;
  // "revenir sur l'app" arrive souvent deux fois (visibilite + focus) : une
  // seule requete suffit
  if (Date.now() - dernierVu < (force ? 2000 : 30000)) return;
  dernierVu = Date.now();
  // le "vu" est celui de CET appareil : les autres gardent leur "+N"
  monAbonnement()
    .then((endpoint) => {
      if (!endpoint) return;
      fetch("/api/push/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      }).catch(() => {});
      // la notification "+N" deja affichee sur cet appareil n'a plus lieu d'etre
      swRegistration?.getNotifications?.({ tag: "colis" }).then((l) => l.forEach((n) => n.close())).catch(() => {});
    })
    .catch(() => {});
}

// Rafraichissement de fond (le tour de 5 s, le retour sur l'app) : deux
// declencheurs qui tombent ensemble ne font qu'un seul rafraichissement.
let dernierRafraichissement = 0;
function rafraichitEnFond() {
  if (Date.now() - dernierRafraichissement < 1500) return;
  dernierRafraichissement = Date.now();
  refreshAll().catch(() => {});
}

// Revenir sur l'app : on previent, et on rafraichit tout de suite plutot que
// d'attendre le prochain tour de 5 s. Les chiffres qui ont bouge pendant
// l'absence montent alors avec leur bulle "+N".
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  markSeen(true);
  rafraichitEnFond();
});
window.addEventListener("focus", () => markSeen(true));

// Ce que chaque ecran relit. Le rafraichissement ne recharge que l'ecran
// affiche. Les rafraichissements de fond n'animent jamais les graphiques : la
// revelation des Stats ne se joue qu'en arrivant sur l'onglet.
const CHARGEMENTS_PAR_VUE = {
  dashboard: () => [loadStats(false), loadStock(), loadSpecialCount(), loadJournal()],
  // les chiffres d'abord : ils disent si les revenus ont pu changer
  stats: () => [loadStats(false).then(() => loadRevenueStats(false))],
  colis: () => [loadStats(false), loadDebts(), loadSenders(), loadMergeCandidates()],
  // ailleurs, on guette seulement les nouveaux colis (et la pastille)
  imprime: () => [verifieCommandes()],
  special: () => [verifieCommandes()],
  suivi: () => [verifieCommandes()],
  "suivi-detail": () => [verifieCommandes()],
};

async function verifieCommandes() {
  const s = await fetchJSON("/api/stats", {}, { essais: 1 });
  majPastilleImprime(s.aImprimer);
  // de nouvelles etiquettes : l'onglet Imprime les montre tout de suite
  if (noteEnAttente(s.pendingCount) && currentView === "imprime") loadImprime().catch(() => {});
}

async function refreshAll() {
  // app en arriere-plan : rien a afficher, rien a recharger
  if (document.visibilityState !== "visible") return;
  markSeen();
  const charge = CHARGEMENTS_PAR_VUE[currentView];
  if (!charge) return;
  try {
    await Promise.all(charge());
    enLigne(true);
  } catch (err) {
    // une erreur reseau, c'est le serveur injoignable ; une erreur HTTP, c'est
    // une requete refusee : le site reste en ligne
    enLigne(!(err instanceof ErreurReseau));
    throw err;
  }
}

// Rejoue la revelation animee de la page Stats, avec des donnees fraiches.
async function playStatsReveal(riche = true) {
  await Promise.all([loadStats(true, true, riche), loadRevenueStats(true, true, riche)]).catch(() => {});
}

// --- Gestes du dashboard et des reglages -----------------------------------------

document.addEventListener("click", async (e) => {
  const goto = e.target.closest("[data-goto]");
  if (goto) return switchView(goto.dataset.goto);

  const cible = e.target.closest(
    "[data-drop-sender], [data-drop-carrier], [data-delete-sender], [data-quick-add], [data-quick-remove], [data-mark-paid], .drop-all-btn, .drop-except-lit-btn"
  );
  if (!cible) return;
  const d = cible.dataset;

  if (d.markPaid) {
    const ok = await confirmer({
      titre: `${d.markPaid} a payé ?`,
      message: `${euro(d.owed)} seront marqués comme payés.`,
      action: "Marquer payé",
    });
    if (!ok) return;
    return agir(
      cible,
      async () => {
        await postJSON(`/api/debts/${encodeURIComponent(d.markPaid)}/pay`);
        await refreshAll();
      },
      { succes: `Paiement de ${d.markPaid} enregistré`, eclats: true }
    );
  }

  if (d.dropSender) {
    return agir(
      cible,
      async () => {
        const r = await postJSON(`/api/colis/drop-sender/${encodeURIComponent(d.dropSender)}`);
        await refreshAll();
        return r;
      },
      { succes: (r) => messageDrop(r, ` pour ${d.dropSender}`), eclats: true }
    );
  }

  if (d.dropCarrier) {
    const nom = CARRIER_LABELS[d.dropCarrier] || d.dropCarrier;
    return agir(
      cible,
      async () => {
        const r = await postJSON(`/api/colis/drop-carrier/${encodeURIComponent(d.dropCarrier)}`);
        await refreshAll();
        return r;
      },
      { succes: (r) => messageDrop(r, ` · ${nom}`), eclats: true }
    );
  }

  if (d.deleteSender) {
    const ok = await confirmer({
      titre: `Supprimer ${d.name} ?`,
      message: "Ses tarifs personnalisés seront perdus. Ses colis restent dans l'historique.",
      action: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    return agir(
      cible,
      async () => {
        await sortLigne(cible.closest(".lrow"));
        await fetchJSON(`/api/senders/${d.deleteSender}`, { method: "DELETE" });
        await refreshAll();
      },
      { succes: `${d.name} supprimé` }
    );
  }

  if (d.quickAdd || d.quickRemove) {
    haptique();
    return colisALaMain(d.quickAdd || d.quickRemove, d.quickAdd ? 1 : -1, cible);
  }

  if (cible.classList.contains("drop-except-lit-btn")) {
    // les LIT partent sur une autre imprimante, souvent un autre jour
    const ok = await confirmer({
      titre: "Tout dropper sauf les LIT ?",
      message: "Les colis déjà imprimés seront marqués dropés, sauf les LIT. Ceux pas encore imprimés restent en attente.",
      action: "Dropper",
    });
    if (!ok) return;
    return agir(
      cible,
      async () => {
        const r = await postJSON("/api/colis/drop-all-except-lit");
        await refreshAll();
        return r;
      },
      {
        succes: (r) => messageDrop(r),
        eclats: { nombre: 16 },
      }
    );
  }

  if (cible.classList.contains("drop-all-btn")) {
    const { count, value } = bagSummary;
    const ok = await confirmer({
      titre: "Tout marquer comme dropé ?",
      message: `${pluriel(count, "colis en attente", "colis en attente")} · ${euro(value)}. Seuls ceux déjà imprimés seront dropés.`,
      action: "Tout dropper",
    });
    if (!ok) return;
    return agir(
      cible,
      async () => {
        const r = await postJSON("/api/colis/drop-all");
        await refreshAll();
        return r;
      },
      { succes: (r) => messageDrop(r), eclats: { nombre: 20, force: 1.3 } }
    );
  }
});

// Prix d'un expediteur : enregistre a la sortie du champ, avec un eclair
// violet pour dire que c'est fait.
document.addEventListener("change", async (e) => {
  if (e.target.classList.contains("merge-check")) {
    if (e.target.checked) haptique();
    updateMergeButtonState();
    return;
  }

  const input = e.target;
  const senderId = input.dataset.senderId;
  if (!senderId) return;

  const allowedFields = ["price", "litPrice", "bjPrice"];
  const field = allowedFields.includes(input.dataset.field) ? input.dataset.field : "price";
  const valeur = Number(String(input.value).replace(",", "."));
  if (input.value === "" || !Number.isFinite(valeur) || valeur < 0) {
    rejoue(input, "invalid", 1400);
    return;
  }
  try {
    await fetchJSON(`/api/senders/${senderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: valeur }),
    });
    rejoue(input, "is-saved", 1100);
    haptique();
    refreshAll().catch(() => {});
  } catch (err) {
    rejoue(input, "invalid", 1400);
    toast(err.message, "error");
  }
});

$("merge-pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bouton = e.submitter || e.target.querySelector("[type=submit]");
  const source = $("merge-source");
  const target = $("merge-target");
  const sourceId = Number(source.value);
  const targetId = Number(target.value);
  if (!sourceId || !targetId) return;
  if (sourceId === targetId) {
    secoue(bouton);
    toast("Choisis deux expéditeurs différents.", "error");
    return;
  }
  const sourceName = source.options[source.selectedIndex].textContent;
  const targetName = target.options[target.selectedIndex].textContent;
  const ok = await confirmer({
    titre: `Fusionner « ${sourceName} » dans « ${targetName} » ?`,
    message: `Tous ses colis et gains seront transférés, et « ${sourceName} » sera supprimé.`,
    action: "Fusionner",
    danger: true,
  });
  if (!ok) return;
  await agir(
    bouton,
    async () => {
      const r = await postJSON("/api/senders/merge", { sourceId, targetId });
      renderCache.clear();
      await refreshAll();
      return r;
    },
    { succes: (r) => `${pluriel(r.moved, "colis transféré", "colis transférés")} vers « ${r.target} »`, eclats: true }
  );
});

$("merge-to-other-btn").addEventListener("click", async (e) => {
  const bouton = e.currentTarget;
  const senderIds = [...document.querySelectorAll(".merge-check:checked")].map((el) => Number(el.value));
  if (senderIds.length === 0) return;
  const ok = await confirmer({
    titre: `Regrouper ${pluriel(senderIds.length, "expéditeur", "expéditeurs")} en « Autre » ?`,
    message: "Leur historique de colis sera regroupé. Cette action est irréversible.",
    action: "Regrouper",
    danger: true,
  });
  if (!ok) return;
  await agir(
    bouton,
    async () => {
      await postJSON("/api/senders/merge-to-other", { senderIds });
      await refreshAll();
    },
    { succes: "Expéditeurs regroupés en « Autre »" }
  );
});

$("add-sender-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = $("new-sender-name").value.trim();
  const price = Number($("new-sender-price").value);
  const litPrice = Number($("new-sender-lit-price").value);
  const bjPrice = Number($("new-sender-bj-price").value);
  await agir(
    e.submitter || form.querySelector("[type=submit]"),
    async () => {
      await postJSON("/api/senders", { name, price, litPrice, bjPrice });
      form.reset();
      await refreshAll();
    },
    { succes: `${name} ajouté`, eclats: true }
  );
});

// --- Reglage du son ----------------------------------------------------------------
function afficheReglageSon() {
  const actif = sonActif();
  $("son-switch").setAttribute("aria-checked", String(actif));
  const etat = $("son-state");
  etat.textContent = actif ? "Activé" : "Désactivé";
  etat.classList.toggle("is-on", actif);
}
afficheReglageSon();
$("son-switch").addEventListener("click", () => {
  const actif = !sonActif();
  localStorage.setItem("drop.son", actif ? "1" : "0");
  afficheReglageSon();
  haptique();
  if (actif) chaChing({ force: true });
});
$("son-test").addEventListener("click", (e) => {
  fait(e.currentTarget);
  chaChing({ force: true });
});

// --- Notifications push -----------------------------------------------------------
// Sur iOS, le push web n'existe QUE dans une PWA installee sur l'ecran
// d'accueil (Safari 16.4+). Dans un onglet Safari classique, PushManager
// n'existe simplement pas : on affiche alors la marche a suivre.
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
let swRegistration = null;
let pushError = null;

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

// l'adresse d'abonnement de cet appareil : c'est elle qui l'identifie
async function monAbonnement() {
  if (!pushSupported) return null;
  const sub = await currentSubscription();
  return sub ? sub.endpoint : null;
}

async function currentSubscription() {
  if (!swRegistration) return null;
  return swRegistration.pushManager.getSubscription();
}

async function updatePushUI() {
  const panel = $("push-panel");
  if (!panel) return;
  const etat = $("push-state");
  const hint = $("push-hint");
  const sw = $("push-switch");
  const extra = $("push-extra");
  const dis = (texte) => {
    hint.textContent = texte;
    hint.hidden = !texte;
  };

  panel.hidden = false;

  const indisponible = (texte) => {
    etat.textContent = "Indisponible";
    etat.classList.remove("is-on");
    sw.disabled = true;
    sw.setAttribute("aria-checked", "false");
    extra.hidden = true;
    dis(texte);
  };

  if (!pushSupported) {
    return indisponible(
      isIOS
        ? "Sur iPhone, les notifications ne marchent que si le site est ajouté à l'écran d'accueil : bouton Partager → « Sur l'écran d'accueil », puis rouvre l'app depuis cette icône."
        : "Ce navigateur ne gère pas les notifications push."
    );
  }
  if (pushError) return indisponible(`Les notifications n'ont pas pu démarrer sur cet appareil (${pushError}).`);

  const sub = await currentSubscription();
  const granted = Notification.permission === "granted" && Boolean(sub);
  const bloquees = Notification.permission === "denied";

  etat.textContent = granted ? "Activées sur cet appareil" : bloquees ? "Bloquées" : "Désactivées";
  etat.classList.toggle("is-on", granted);
  sw.disabled = bloquees;
  sw.setAttribute("aria-checked", String(granted));
  extra.hidden = !granted;

  dis(
    bloquees
      ? isIOS
        ? "Notifications refusées. Réglages iOS → Notifications → DROP pour les réautoriser."
        : "Notifications refusées. Réautorise-les dans les réglages du navigateur pour ce site."
      : ""
  );
}

async function subscribePush() {
  const { publicKey } = await fetchJSON("/api/push/key");
  let sub = await currentSubscription();
  if (!sub) {
    sub = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON();
  await postJSON("/api/push/subscribe", {
    endpoint: json.endpoint,
    keys: json.keys,
    label: `${isIOS ? "iOS" : "web"}${isStandalone ? " (app)" : ""}`,
  });
}

async function initPush() {
  if (!pushSupported) return updatePushUI();
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    // iOS revoque parfois l'abonnement en silence : on se reabonne a chaque
    // ouverture tant que la permission est accordee.
    if (Notification.permission === "granted") await subscribePush();
    // l'appareil est identifie : on peut dire au serveur qu'il a regarde
    markSeen(true);
  } catch (err) {
    console.error("[push] init", err);
    pushError = err.message || String(err);
  }
  updatePushUI();
}

$("push-switch").addEventListener("click", async (e) => {
  const sw = e.currentTarget;
  const actif = sw.getAttribute("aria-checked") === "true";
  sw.setAttribute("aria-checked", String(!actif));
  sw.setAttribute("aria-busy", "true");
  haptique();
  try {
    if (actif) {
      const sub = await currentSubscription();
      if (sub) {
        await postJSON("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      toast("Notifications désactivées");
    } else {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        await subscribePush();
        eclat(sw, { nombre: 8, force: 0.7 });
        toast("Notifications activées");
      }
    }
  } catch (err) {
    toast(`Impossible d'activer les notifications : ${err.message}`, "error");
  } finally {
    sw.removeAttribute("aria-busy");
    await updatePushUI();
  }
});

$("push-test").addEventListener("click", (e) =>
  agir(
    e.currentTarget,
    async () => {
      const r = await postJSON("/api/push/test");
      if (r.sent === 0) throw new Error("Aucun appareil abonné n'a pu être joint.");
    },
    { succes: "Notification de test envoyée" }
  )
);

