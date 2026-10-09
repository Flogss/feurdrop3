// --- Reglages : dettes, prix, fusions -------------------------------------------

async function loadDebts() {
  const rows = await fetchJSON("/api/debts");
  if (!hasChanged("debts", rows)) return;

  const total = rows.reduce((sum, d) => sum + d.owed, 0);
  $("debts-total").textContent = total > 0 ? euro(total) : "";
  rendListe($("debts-rows"), rows, {
    cle: (d) => d.sender_name,
    videHtml: vide("check", "Personne ne vous doit rien", "", true),
    html: (d) => `
      <div class="lrow" data-key="${escapeAttr(d.sender_name)}">
        ${avatar(d.sender_name)}
        <div class="lrow-main">
          <div class="lrow-title">${escapeHtml(d.sender_name)}</div>
          <div class="lrow-sub"><span class="debt">${euro(d.owed)}</span> · ${pluriel(d.count, "colis", "colis")}</div>
        </div>
        <button class="btn btn-sm btn-tinted" data-mark-paid="${escapeAttr(d.sender_name)}" data-owed="${d.owed}" type="button">Payé</button>
      </div>`,
  });
}

function champPrix(s, colonne, champ, libelle, classe) {
  return `
    <label class="price-field">
      <span class="price-tag"><i class="dot dot-${classe}"></i>${libelle}</span>
      <input class="field price-input" type="number" inputmode="decimal" step="0.5" min="0" value="${s[colonne]}"
             data-sender-id="${s.id}" data-field="${champ}" aria-label="Prix ${libelle} de ${escapeAttr(s.name)}" />
    </label>`;
}

async function loadSenders() {
  const rows = await fetchJSON("/api/senders");
  const box = $("settings-rows");
  // une saisie en cours ne doit pas disparaitre sous le doigt
  if (box.contains(document.activeElement)) return;
  if (!hasChanged("settings", rows)) return;

  rendListe(box, rows, {
    cle: (s) => s.id,
    videHtml: vide("tag", "Aucun expéditeur", "Ajoute le premier ci-dessous."),
    // le nom occupe sa propre ligne : avec trois tarifs editables, tout mettre
    // sur une seule ligne rognait completement le nom de l'expediteur
    html: (s) => `
      <div class="lrow sender-price" data-key="${s.id}">
        <div class="sender-price-head">
          ${avatar(s.name)}
          <div class="lrow-title" title="${escapeAttr(s.name)}">${escapeHtml(s.name)}</div>
          <button class="btn btn-icon btn-sm btn-ghost" data-delete-sender="${s.id}" data-name="${escapeAttr(s.name)}" type="button" aria-label="Supprimer ${escapeAttr(s.name)}">${ico("trash")}</button>
        </div>
        <div class="sender-price-fields">
          ${champPrix(s, "price", "price", "Normal", "normal")}
          ${champPrix(s, "lit_price", "litPrice", "LIT", "lit")}
          ${champPrix(s, "bj_price", "bjPrice", "BJ", "bj")}
        </div>
      </div>`,
  });
  renderMergePairSelects(rows);
  renderPortails(rows);
}

// --- Espaces expediteurs -------------------------------------------------------
// Le lien prive de chaque expediteur : le creer, le copier, l'ouvrir, le
// regenerer (l'ancien cesse de marcher) ou le desactiver.
// le serveur donne le lien complet (domaine du portail) ; en local, un chemin
const lienPortail = (s) => (s.portail?.lien ? new URL(s.portail.lien, location.origin).href : null);

function renderPortails(rows) {
  const box = $("portail-rows");
  if (!box) return;
  const actifs = rows.filter((s) => s.portail?.lien).length;
  $("portail-total").textContent = actifs ? pluriel(actifs, "lien actif", "liens actifs") : "";
  rendListe(box, rows, {
    cle: (s) => s.id,
    videHtml: vide("tag", "Aucun expéditeur"),
    html: (s) => {
      const p = s.portail || {};
      const lien = lienPortail(s);
      const depuis = p.creeLe ? new Date(`${p.creeLe.replace(" ", "T")}Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : "";
      const sous = !p.possible
        ? "Regroupe plusieurs expéditeurs : pas d'espace privé"
        : lien
          ? `Lien actif${depuis ? ` depuis le ${depuis}` : ""}`
          : "Pas encore de lien";
      const nom = escapeAttr(s.name);
      const actions = !p.possible
        ? ""
        : lien
          ? `<button class="btn btn-sm btn-primary" data-portail-copie="${escapeAttr(lien)}" data-name="${nom}" type="button">${ico("copy")}<span>Copier</span></button>
             <a class="btn btn-icon btn-sm btn-ghost" href="${escapeAttr(lien)}" target="_blank" rel="noopener noreferrer" aria-label="Ouvrir l'espace de ${nom}">${ico("external")}</a>
             <button class="btn btn-icon btn-sm btn-ghost" data-portail-regenere="${s.id}" data-name="${nom}" type="button" aria-label="Régénérer le lien de ${nom}">${ico("refresh")}</button>
             <button class="btn btn-icon btn-sm btn-ghost" data-portail-coupe="${s.id}" data-name="${nom}" type="button" aria-label="Désactiver l'espace de ${nom}">${ico("x")}</button>`
          : `<button class="btn btn-sm btn-secondary" data-portail-cree="${s.id}" data-name="${nom}" type="button">${ico("plus")}<span>Créer le lien</span></button>`;
      return `
      <div class="lrow portail-row${lien ? " is-actif" : ""}" data-key="${s.id}">
        ${avatar(s.name)}
        <div class="lrow-main">
          <div class="lrow-title" title="${nom}">${escapeHtml(s.name)}</div>
          <div class="lrow-sub">${sous}</div>
        </div>
        <div class="portail-actions">${actions}</div>
      </div>`;
    },
  });
}

async function copieTexte(texte) {
  try {
    await navigator.clipboard.writeText(texte);
    return true;
  } catch {
    // Safari refuse parfois apres un appel reseau : la feuille de partage
    if (navigator.share) {
      try {
        await navigator.share({ url: texte });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-portail-copie], [data-portail-cree], [data-portail-regenere], [data-portail-coupe]");
  if (!b) return;
  const d = b.dataset;

  if (d.portailCopie) {
    haptique();
    if (await copieTexte(d.portailCopie)) {
      fait(b);
      toast(`Lien de ${d.name} copié`);
    } else {
      toast("Copie impossible : ouvre le lien et copie l'adresse", "error");
    }
    return;
  }

  if (d.portailCree) {
    return agir(
      b,
      async () => {
        const s = await postJSON(`/api/senders/${d.portailCree}/portail`);
        await loadSenders();
        const lien = lienPortail(s);
        if (lien && (await copieTexte(lien))) return `Espace de ${d.name} créé · lien copié`;
        return `Espace de ${d.name} créé`;
      },
      { succes: (texte) => texte, eclats: true }
    );
  }

  if (d.portailRegenere) {
    const ok = await confirmer({
      titre: `Nouveau lien pour ${d.name} ?`,
      message: "L'ancien lien cessera de marcher immédiatement. Il faudra lui envoyer le nouveau.",
      action: "Régénérer",
    });
    if (!ok) return;
    return agir(
      b,
      async () => {
        const s = await postJSON(`/api/senders/${d.portailRegenere}/portail`);
        await loadSenders();
        const lien = lienPortail(s);
        if (lien && (await copieTexte(lien))) return "Nouveau lien copié · l'ancien ne marche plus";
        return "Nouveau lien créé · l'ancien ne marche plus";
      },
      { succes: (texte) => texte }
    );
  }

  if (d.portailCoupe) {
    const ok = await confirmer({
      titre: `Désactiver l'espace de ${d.name} ?`,
      message: "Son lien cessera de marcher. Tu pourras en recréer un nouveau plus tard.",
      action: "Désactiver",
      danger: true,
    });
    if (!ok) return;
    return agir(
      b,
      async () => {
        await fetchJSON(`/api/senders/${d.portailCoupe}/portail`, { method: "DELETE" });
        await loadSenders();
      },
      { succes: `Espace de ${d.name} désactivé` }
    );
  }
});

// Remplit les deux listes deroulantes de fusion en conservant la selection
// courante si les noms existent toujours.
function renderMergePairSelects(rows) {
  for (const id of ["merge-source", "merge-target"]) {
    const select = $(id);
    if (!select) continue;
    const previous = select.value;
    select.innerHTML = rows.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
    if (rows.some((s) => String(s.id) === previous)) select.value = previous;
  }
  // deux fois le meme expediteur ne fusionne rien : la cible part sur un autre
  const source = $("merge-source");
  const cible = $("merge-target");
  if (rows.length > 1 && source.value === cible.value) cible.selectedIndex = source.selectedIndex === 0 ? 1 : 0;
}

async function loadMergeCandidates() {
  const rows = await fetchJSON("/api/senders/merge-candidates");
  if (!hasChanged("mergeCandidates", rows)) return;

  rendListe($("merge-rows"), rows, {
    cle: (s) => s.id,
    videHtml: vide("layers", "Aucun expéditeur pour le moment"),
    html: (s) => `
      <label class="lrow merge-row${s.mergeable ? "" : " is-protected"}" data-key="${s.id}">
        <input type="checkbox" class="check merge-check" value="${s.id}" ${s.mergeable ? "" : "disabled"} aria-label="${escapeAttr(s.name)}" />
        <div class="lrow-main">
          <div class="lrow-title">${escapeHtml(s.name)}</div>
          <div class="lrow-sub">${pluriel(s.colisCount, "colis", "colis")} · ${Math.round(s.pct * 100)} % du CA${s.mergeable ? "" : " · protégé"}</div>
        </div>
      </label>`,
  });
  updateMergeButtonState();
}

function updateMergeButtonState() {
  const checked = document.querySelectorAll(".merge-check:checked").length;
  const btn = $("merge-to-other-btn");
  btn.disabled = checked === 0;
  btn.textContent =
    checked > 0
      ? `Fusionner ${pluriel(checked, "expéditeur", "expéditeurs")} en « Autre »`
      : "Fusionner la sélection en « Autre »";
}

// --- Stock ------------------------------------------------------------------------

const LOW_STOCK_THRESHOLD = 5;
const STOCKS = {
  normal: { valeur: "stock-value", boite: "stock-normal", nom: "normal" },
  bj: { valeur: "stock-bj-value", boite: "stock-bj", nom: "BJ" },
};
// Le stock, appui par appui. L'affichage suit le doigt tout de suite ; le
// serveur recoit les appuis UN envoi a la fois par stock -- ceux faits pendant
// un envoi sont cumules et partent juste apres. Avant, chaque appui partait de
// son cote : les reponses revenaient parfois dans le desordre (la plus
// ancienne ecrasait alors la plus recente) et un echec remettait la valeur
// d'avant le clic, effacant au passage les autres appuis en route.
// Affiche = derniere valeur du serveur + ce qui est en cours d'envoi + ce qui
// attend : il converge toujours vers le serveur.
const stockEtat = {
  normal: { confirme: null, envoi: 0, attente: 0, boucle: null },
  bj: { confirme: null, envoi: 0, attente: 0, boucle: null },
};
let stockCharge = false;

async function loadStock() {
  rendStock(await fetchJSON("/api/stock"));
}

function afficheStock(kind, { premier = false } = {}) {
  const s = STOCKS[kind];
  const f = stockEtat[kind];
  const el = $(s.valeur);
  const value = (f.confirme ?? 0) + f.envoi + f.attente;
  const avant = el._valeur;
  if (value === avant) {
    // deja affiche : on ne touche a rien
  } else if (typeof avant === "number" && Math.abs(value - avant) <= 2) {
    el._valeur = value;
    roule(el, entier(value), value - avant);
  } else {
    el._texte = entier(value);
    compte(el, value, { depuis: premier && nouvelleSession ? 0 : undefined, delai: premier ? 520 : 0 });
  }
  $(s.boite).classList.toggle("is-low", value <= LOW_STOCK_THRESHOLD);
}

// Une valeur du serveur (rafraichissement, ou reponse d'un envoi) : elle fait
// foi pour un stock qui n'a rien en route.
function rendStock(stocks) {
  const premier = !stockCharge;
  stockCharge = true;
  for (const kind of Object.keys(STOCKS)) {
    const f = stockEtat[kind];
    if (f.envoi || f.attente) continue;
    f.confirme = stocks[kind] || 0;
    afficheStock(kind, { premier });
  }
}

// Ajoute `delta` au stock : affiche tout de suite, envoie quand c'est son tour.
// Renvoie vrai si TOUS les envois de cette serie ont abouti.
function adjustStock(delta, kind = "normal") {
  const f = stockEtat[kind];
  f.attente += delta;
  afficheStock(kind);
  if (!f.boucle) f.boucle = videStock(kind);
  return f.boucle;
}

async function videStock(kind) {
  const f = stockEtat[kind];
  let ok = true;
  while (f.attente !== 0) {
    f.envoi = f.attente;
    f.attente = 0;
    try {
      const stocks = await postOperation("/api/stock/adjust", { delta: f.envoi, kind });
      f.confirme = stocks[kind];
      f.envoi = 0;
      // l'autre stock, s'il n'a rien en route, prend la valeur du serveur
      const autre = kind === "bj" ? "normal" : "bj";
      const g = stockEtat[autre];
      if (!g.envoi && !g.attente && typeof stocks[autre] === "number") {
        g.confirme = stocks[autre];
        afficheStock(autre);
      }
    } catch (err) {
      // seul CET envoi est mis de cote : les appuis faits depuis restent
      f.envoi = 0;
      ok = false;
      secoue($(STOCKS[kind].boite));
      // une coupure ne dit pas si le serveur l'a applique : on revérifie
      toast(err instanceof ErreurReseau ? "Connexion instable : stock revérifié" : `Stock non enregistré : ${err.message}`, "error");
    }
    afficheStock(kind);
  }
  f.boucle = null;
  // apres un echec, la valeur du serveur fait foi tout de suite (sans
  // attendre le prochain rafraichissement)
  if (!ok) await loadStock().catch(() => {});
  return ok;
}

document.querySelectorAll("[data-stock]").forEach((btn) => {
  btn.addEventListener("click", () => {
    haptique();
    adjustStock(Number(btn.dataset.delta), btn.dataset.stock);
  });
});

document.querySelectorAll("[data-stock-form]").forEach((form) => {
  const input = form.querySelector("input");
  input.addEventListener("input", () => input.classList.remove("invalid"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = Number(input.value);
    if (!n) {
      rejoue(input, "invalid", 1400);
      return;
    }
    const kind = form.dataset.stockForm;
    input.value = "";
    input.blur();
    if (await adjustStock(n, kind)) {
      if (n > 0) eclat($(STOCKS[kind].valeur), { nombre: 10, force: 0.8 });
      toast(`${n > 0 ? "+" : "−"}${entier(Math.abs(n))} au stock ${STOCKS[kind].nom}`);
    }
  });
});

