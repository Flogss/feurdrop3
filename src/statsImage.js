const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const FONT_DIR = path.join(__dirname, "fonts");

const euro = (n) => `${Number(n || 0).toFixed(2)} EUR`;

function buildStatsSVG({ pendingCount, pendingValue, addedCount }) {
  const W = 900, H = 500;
  return `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="80%">
      <stop offset="0%" stop-color="#38f7ff" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#38f7ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="border-cyan" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#38f7ff"/>
      <stop offset="100%" stop-color="#1b8fa0"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="#05060a"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- grid -->
  ${Array.from({ length: 20 }, (_, i) => `<line x1="${i * 45}" y1="0" x2="${i * 45}" y2="${H}" stroke="#38f7ff" stroke-opacity="0.04"/>`).join("")}
  ${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 45}" x2="${W}" y2="${i * 45}" stroke="#38f7ff" stroke-opacity="0.04"/>`).join("")}

  <!-- header -->
  <circle cx="46" cy="50" r="7" fill="#38f7ff"/>
  <text x="66" y="58" font-family="JetBrains Mono" font-size="30" font-weight="700" fill="#e8ebf5">DROP<tspan fill="#38f7ff">.ctrl</tspan></text>
  <circle cx="${W - 46}" cy="50" r="6" fill="#b6ff3e"/>
  <text x="${W - 60}" y="57" font-family="JetBrains Mono" font-size="16" fill="#7a819c" text-anchor="end">bot en ligne</text>

  <!-- stat card: a dropper -->
  <rect x="40" y="120" width="380" height="170" rx="18" fill="#0b0d14" stroke="url(#border-cyan)" stroke-width="2"/>
  <rect x="40" y="120" width="380" height="170" rx="18" fill="#ff3ecb" fill-opacity="0.05"/>
  <text x="66" y="165" font-family="JetBrains Mono" font-size="16" letter-spacing="2" fill="#7a819c">A DROPPER</text>
  <text x="66" y="235" font-family="JetBrains Mono" font-size="64" font-weight="700" fill="#ff3ecb">${pendingCount}</text>
  <text x="66" y="270" font-family="JetBrains Mono" font-size="18" fill="#7a819c">colis en attente</text>

  <!-- stat card: valeur en attente -->
  <rect x="480" y="120" width="380" height="170" rx="18" fill="#0b0d14" stroke="#38f7ff" stroke-width="2"/>
  <rect x="480" y="120" width="380" height="170" rx="18" fill="#38f7ff" fill-opacity="0.05"/>
  <text x="506" y="165" font-family="JetBrains Mono" font-size="16" letter-spacing="2" fill="#7a819c">VALEUR EN ATTENTE</text>
  <text x="506" y="235" font-family="JetBrains Mono" font-size="52" font-weight="700" fill="#38f7ff">${euro(pendingValue)}</text>
  <text x="506" y="270" font-family="JetBrains Mono" font-size="18" fill="#7a819c">potentiels une fois drope</text>

  <!-- stat card: derniere mise a jour -->
  <rect x="40" y="320" width="820" height="140" rx="18" fill="#0b0d14" stroke="#b6ff3e" stroke-width="2"/>
  <rect x="40" y="320" width="820" height="140" rx="18" fill="#b6ff3e" fill-opacity="0.05"/>
  <text x="66" y="365" font-family="JetBrains Mono" font-size="16" letter-spacing="2" fill="#7a819c">DERNIER AJOUT</text>
  <text x="66" y="430" font-family="JetBrains Mono" font-size="52" font-weight="700" fill="#b6ff3e">+${addedCount} colis</text>

  <text x="${W / 2}" y="${H - 20}" font-family="JetBrains Mono" font-size="13" fill="#4a5068" text-anchor="middle">Mis a jour le ${new Date().toLocaleString("fr-FR")}</text>
</svg>`;
}

async function renderStatsImage(stats) {
  const svg = buildStatsSVG(stats);
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [
        path.join(FONT_DIR, "JetBrainsMono-Regular.ttf"),
        path.join(FONT_DIR, "JetBrainsMono-Bold.ttf"),
      ],
      loadSystemFonts: false,
      defaultFontFamily: "JetBrains Mono",
    },
  });
  return resvg.render().asPng();
}

module.exports = { renderStatsImage };
