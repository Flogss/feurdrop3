// --- Heures de drop ---------------------------------------------------------------
// A cote de « En direct » : quand on compte aller poster, et quels
// transporteurs (« La Poste 16h », puis « Mondial Relay 19h30 »). Chaque
// heure se modifie ou se retire ; elle s'efface toute seule une fois ses
// colis postes. Les expediteurs concernes la voient sur leur espace.

const hd = {
  heures: [],
  transporteurs: [],
  enAttente: new Map(), // code -> colis a poster (la ligne « compagnies a poster »)
  edition: null, // l'heure modifiee, ou null pour une nouvelle
  selection: new Set(),
};

// « 16:00 » -> « 16h », « 19:30 » -> « 19h30 »
const heureCourte = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":");
  return h ? `${Number(h)}h${m && m !== "00" ? m : ""}` : "—";
};
const quandCourt = (h) => `${h.demain ? "Demain " : ""}${heureCourte(h.heure)}`;
const transporteursTexte = (h) => h.transporteurs.map((t) => t.label).join(", ");

function rendHeuresDrop(donnees, parTransporteur) {
  hd.heures = donnees?.heures || [];
  hd.transporteurs = donnees?.transporteurs || [];
  if (parTransporteur) hd.enAttente = new Map(parTransporteur.map((c) => [c.carrier, c.pending_count || 0]));

  const bouton = $("heure-drop-btn");
  const prochaine = hd.heures[0];
  bouton.classList.toggle("is-prevue", Boolean(prochaine));
  bouton.classList.toggle("is-passee", Boolean(prochaine?.passee));
  $("heure-drop-texte").textContent = prochaine ? quandCourt(prochaine) : "Heure de drop";
  $("heure-drop-plus").textContent = hd.heures.length > 1 ? `+${hd.heures.length - 1}` : "";
  const resume = hd.heures.map((h) => `${transporteursTexte(h)} à ${quandCourt(h)}`).join(" · ");
  bouton.title = resume ? `Heures de drop : ${resume}` : "Prévoir l'heure de drop";
  bouton.setAttribute("aria-label", resume ? `Heures de drop : ${resume}` : "Heure de drop");

  if (!$("heure-drop-sheet").hidden) rendListeHeures();
}

// une heure ronde a venir : la prochaine heure pleine
function heureParDefaut() {
  const d = new Date();
  return `${String((d.getHours() + 1) % 24).padStart(2, "0")}:00`;
}

function ouvreHeuresDrop() {
  editeHeure(null);
  rendListeHeures();
  const couche = $("heure-drop-sheet");
  couche.classList.remove("closing");
  couche.hidden = false;
  haptique();
}

function fermeHeuresDrop() {
  const couche = $("heure-drop-sheet");
  if (couche.hidden) return;
  couche.classList.add("closing");
  setTimeout(() => {
    couche.hidden = true;
    couche.classList.remove("closing");
  }, prefersReducedMotion ? 0 : 260);
}

function rendListeHeures() {
  $("hd-liste").innerHTML = hd.heures
    .map(
      (h) => `
    <div class="hd-ligne${h.id === hd.edition ? " is-edition" : ""}${h.passee ? " is-passee" : ""}" data-id="${escapeAttr(h.id)}">
      <span class="hd-ligne-heure">${escapeHtml(heureCourte(h.heure))}${h.demain ? "<small>demain</small>" : ""}</span>
      <span class="hd-ligne-puces">${h.transporteurs
        .map((t) => `<span class="hd-puce carrier" data-carrier="${escapeAttr(t.code)}"><i class="carrier-dot"></i>${escapeHtml(t.label)}</span>`)
        .join("")}</span>
      <button class="icon-btn hd-action" type="button" data-hd-modifier aria-label="Modifier ${escapeAttr(heureCourte(h.heure))}">
        <svg class="icon"><use href="#i-edit"/></svg>
      </button>
      <button class="icon-btn hd-action hd-retirer" type="button" data-hd-retirer aria-label="Supprimer ${escapeAttr(heureCourte(h.heure))}">
        <svg class="icon"><use href="#i-trash"/></svg>
      </button>
    </div>`
    )
    .join("");
  $("hd-liste").hidden = hd.heures.length === 0;
  rendFormulaireHeure();
}

// Nouvelle heure, ou modification de `id` : le formulaire se remplit.
function editeHeure(id) {
  const h = id ? hd.heures.find((x) => x.id === id) : null;
  hd.edition = h ? h.id : null;
  hd.selection = new Set(h ? h.transporteurs.map((t) => t.code) : []);
  $("hd-heure").value = h ? h.heure : heureParDefaut();
}

function rendFormulaireHeure() {
  // ceux qui ont des colis a poster d'abord, avec leur nombre
  const options = [...hd.transporteurs].sort((a, b) => (hd.enAttente.get(b.code) || 0) - (hd.enAttente.get(a.code) || 0));
  $("hd-transporteurs").innerHTML = options
    .map((t) => {
      const n = hd.enAttente.get(t.code) || 0;
      return `
    <button class="tour-puce carrier" type="button" data-code="${escapeAttr(t.code)}" data-carrier="${escapeAttr(t.code)}" aria-pressed="${hd.selection.has(t.code)}">
      <i class="carrier-dot"></i><span>${escapeHtml(t.label)}</span>${n ? `<b>${entier(n)}</b>` : ""}
    </button>`;
    })
    .join("");
  const edite = hd.edition ? hd.heures.find((x) => x.id === hd.edition) : null;
  $("hd-form-titre").textContent = edite ? `Modifier ${quandCourt(edite)}` : hd.heures.length ? "Une autre heure" : "Nouvelle heure";
  $("hd-secondaire").textContent = edite ? "Annuler" : "Fermer";
  $("hd-enregistrer").querySelector("span").textContent = edite ? "Enregistrer" : "Ajouter";
  $("hd-enregistrer").querySelector("use").setAttribute("href", edite ? "#i-check" : "#i-plus");
  const heure = $("hd-heure").value;
  const noms = hd.transporteurs.filter((t) => hd.selection.has(t.code)).map((t) => t.label);
  $("hd-resume").innerHTML = !noms.length
    ? "Choisis les transporteurs que tu vas poster."
    : !heure
      ? "Choisis l'heure."
      : `<b>${escapeHtml(noms.join(", "))}</b> à <b>${escapeHtml(heureCourte(heure))}</b><span class="tour-resume-note hd-note">Les expéditeurs concernés la voient sur leur espace ; elle s'efface une fois les colis postés.</span>`;
  $("hd-enregistrer").disabled = !noms.length || !heure;
}

async function enregistreHeure() {
  const bouton = $("hd-enregistrer");
  if (bouton.disabled || bouton.getAttribute("aria-busy") === "true") return;
  const corps = { heure: $("hd-heure").value, transporteurs: [...hd.selection] };
  occupe(bouton, true);
  try {
    const r = hd.edition
      ? await fetchJSON(`/api/heures-drop/${encodeURIComponent(hd.edition)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(corps),
        })
      : await postJSON("/api/heures-drop", corps);
    occupe(bouton, false);
    const noms = hd.transporteurs.filter((t) => hd.selection.has(t.code)).map((t) => t.label).join(", ");
    toast(`🕓 ${noms} à ${heureCourte(corps.heure)}${hd.edition ? " : modifié" : ""}`, "success");
    rendHeuresDrop(r, null);
    fermeHeuresDrop();
  } catch (err) {
    occupe(bouton, false);
    secoue(bouton);
    toast(err.message, "error");
  }
}

async function retireHeure(id, bouton) {
  const h = hd.heures.find((x) => x.id === id);
  if (!h) return;
  occupe(bouton, true);
  try {
    const r = await fetchJSON(`/api/heures-drop/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (hd.edition === id) editeHeure(null);
    rendHeuresDrop(r, null);
    rendListeHeures();
    toast(`Heure de ${heureCourte(h.heure)} supprimée`);
  } catch (err) {
    occupe(bouton, false);
    toast(err.message, "error");
  }
}

$("heure-drop-btn").addEventListener("click", ouvreHeuresDrop);
$("hd-transporteurs").addEventListener("click", (e) => {
  const puce = e.target.closest(".tour-puce");
  if (!puce) return;
  const code = puce.dataset.code;
  if (hd.selection.has(code)) hd.selection.delete(code);
  else hd.selection.add(code);
  haptique();
  rendFormulaireHeure();
});
$("hd-heure").addEventListener("input", rendFormulaireHeure);
$("hd-liste").addEventListener("click", (e) => {
  const ligne = e.target.closest(".hd-ligne");
  if (!ligne) return;
  const retirer = e.target.closest("[data-hd-retirer]");
  if (retirer) return retireHeure(ligne.dataset.id, retirer);
  // la ligne entiere modifie (le bouton crayon aussi)
  editeHeure(hd.edition === ligne.dataset.id ? null : ligne.dataset.id);
  haptique();
  rendListeHeures();
});
$("hd-enregistrer").addEventListener("click", enregistreHeure);
$("hd-secondaire").addEventListener("click", () => {
  if (hd.edition) {
    editeHeure(null);
    rendListeHeures();
  } else fermeHeuresDrop();
});
$("heure-drop-sheet").addEventListener("click", (e) => {
  if (e.target.closest("[data-hd-fermer]")) fermeHeuresDrop();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") fermeHeuresDrop();
});

// au lancement, quelle que soit la page ouverte (le dashboard les relit ensuite)
fetchJSON("/api/heures-drop")
  .then((r) => rendHeuresDrop(r, null))
  .catch(() => {});
