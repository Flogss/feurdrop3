const fs = require("fs");
const path = require("path");
const store = require("./store");

// Listes de points fournies par l'utilisateur, livrees avec le code. Elles
// sont chargees en base au premier demarrage : sans ca il faudrait les
// reimporter a la main apres chaque deploiement.
//
// Le reseau Mondial Relay n'a aucune source publique fiable -- leur API
// demande un compte marchand, et OpenStreetMap n'en connait qu'une poignee.
// Cette liste est donc la seule qu'on ait, et elle vient de quelqu'un qui y
// depose vraiment : c'est ce qui la rend fiable.

const SEEDS = [
  { file: "mondial-relay-idf.json", source: "mr-idf", label: "Mondial Relay (ta liste)" },
];

function loadSeeds() {
  const loaded = [];

  for (const seed of SEEDS) {
    const full = path.join(__dirname, "seed", seed.file);
    if (!fs.existsSync(full)) continue;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      console.error(`[plan] liste ${seed.file} illisible :`, err.message);
      continue;
    }

    const points = data.points || [];
    // deja chargee : on ne repasse pas 1200 lignes a chaque demarrage
    if (store.countBySource(seed.source) >= points.length) continue;

    let count = 0;
    for (const point of points) {
      if (!point.lat || !point.lng) continue;
      store.upsertPoint({
        source: seed.source,
        source_ref: point.ref,
        name: point.name,
        address: point.address,
        postal_code: point.postal_code,
        city: point.city,
        lat: point.lat,
        lng: point.lng,
        kind: point.kind,
        locker: point.kind === "Locker",
        carriers: [data.reseau],
        trust: point.trust === "verified" ? store.TRUST.verified : store.TRUST.unverified,
      });
      count += 1;
    }
    loaded.push(`${count} ${seed.label}`);
  }

  if (loaded.length > 0) console.log(`[plan] listes chargees : ${loaded.join(", ")}`);
}

module.exports = { loadSeeds, SEEDS };
