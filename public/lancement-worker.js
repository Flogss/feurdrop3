/* Le lancement dessine hors du fil principal : la page se construit pendant
   que la meteorite file, sans la faire hoqueter. */
importScripts("lancement-rendu.js");

let rendu = null;
let debut = 0;
let fige = null;
let enCours = true;
let premiere = true;
// `?introMesure` : la regularite des images, rapportee a la fin
let mesure = null;

const prochaine = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);

function image(ts) {
  if (!enCours) return;
  // le temps absolu (le meme que la page) : timeOrigin + horloge du worker
  const t = fige ?? (performance.timeOrigin + ts - debut) / 1000;
  rendu.image(t);
  if (mesure && t < 4.9) mesure.push([ts, t]);
  if (premiere) {
    premiere = false;
    self.postMessage({ type: "premiere", geometrie: rendu.geometrie() });
  }
  prochaine(image);
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    rendu = self.LancementDrop.creeRendu(m.toile);
    if (!rendu) {
      self.postMessage({ type: "echec" });
      return;
    }
    rendu.taille(m.w, m.h, m.dpr);
    rendu.entree(m.entree || 0);
    debut = m.debut;
    fige = m.fige;
    if (m.mesure) mesure = [];
    prochaine(image);
  } else if (m.type === "taille" && rendu) {
    rendu.taille(m.w, m.h, m.dpr);
  } else if (m.type === "debut") {
    debut = m.debut;
  } else if (m.type === "fin") {
    if (mesure && mesure.length > 2) {
      const ecarts = mesure.slice(1).map(([v], i) => v - mesure[i][0]).sort((a, b) => a - b);
      // les images lentes, avec l'instant de la sequence ou elles tombent
      const lentes = mesure.slice(1).map(([v, t], i) => [t, v - mesure[i][0]]).filter(([, e]) => e > 20).map(([t, e]) => `${t.toFixed(2)}s:${e.toFixed(0)}ms`);
      self.postMessage({
        type: "mesure",
        texte: `lancement : ${mesure.length} images en ${((mesure.at(-1)[0] - mesure[0][0]) / 1000).toFixed(2)} s, moyenne ${(ecarts.reduce((a, b) => a + b, 0) / ecarts.length).toFixed(1)} ms, p95 ${ecarts[Math.floor((ecarts.length - 1) * 0.95)].toFixed(1)} ms, pire ${ecarts.at(-1).toFixed(1)} ms, >20 ms : ${ecarts.filter((e) => e > 20).length}${lentes.length ? ` (${lentes.join(", ")})` : ""}`,
      });
    }
    enCours = false;
    self.close();
  }
};
