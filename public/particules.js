// Les particules du fond, dessinees hors du fil principal : sur une toile
// transferee (OffscreenCanvas), dans un worker. Le fil principal reste libre
// pour le toucher, le defilement et les animations de l'interface.
// Meme dessin qu'avant : un halo et un coeur par point, qui montent
// lentement, scintillent, et glissent un peu avec le defilement.
let ctx = null;
let L = 0;
let H = 0;
let decalage = 0;
let pause = false;
const points = [];

function dimensionne(largeur, hauteur, dpr) {
  L = largeur;
  H = hauteur;
  ctx.canvas.width = L * dpr;
  ctx.canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const planifie = typeof self.requestAnimationFrame === "function"
  ? () => self.requestAnimationFrame(dessine)
  : () => setTimeout(() => dessine(performance.now()), 16);

function dessine(t) {
  planifie();
  if (pause || !ctx) return;
  ctx.clearRect(0, 0, L, H);
  for (const p of points) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.y < -12) {
      p.y = H + 12;
      p.x = Math.random() * L;
    }
    if (p.x < -12) p.x = L + 12;
    if (p.x > L + 12) p.x = -12;
    const y = (((p.y - decalage * p.profondeur) % (H + 24)) + H + 24) % (H + 24) - 12;
    const alpha = p.a * (0.55 + 0.45 * Math.sin(t / 900 + p.phase));
    // couleurs fixes, transparence par globalAlpha : aucune chaine creee par image
    ctx.globalAlpha = alpha * (p.blanc ? 0.25 : 0.22);
    ctx.fillStyle = p.blanc ? "#ffffff" : "#aa84ff";
    ctx.beginPath();
    ctx.arc(p.x, y, p.r * 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.blanc ? "#ffffff" : "#cebaff";
    ctx.beginPath();
    ctx.arc(p.x, y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

self.onmessage = ({ data }) => {
  if (data.type === "init") {
    ctx = data.toile.getContext("2d");
    dimensionne(data.L, data.H, data.dpr);
    for (let i = 0; i < data.nombre; i++) {
      points.push({
        x: Math.random() * L,
        y: Math.random() * H,
        r: 0.5 + Math.random() * 1.5,
        vx: (Math.random() - 0.5) * 0.08,
        vy: -(0.04 + Math.random() * 0.16),
        a: 0.18 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        profondeur: 0.3 + Math.random() * 0.7,
        blanc: Math.random() < 0.3,
      });
    }
    planifie();
  } else if (data.type === "taille") {
    dimensionne(data.L, data.H, data.dpr);
  } else if (data.type === "defilement") {
    decalage = data.y * 0.06;
  } else if (data.type === "pause") {
    pause = data.pause;
  }
};
