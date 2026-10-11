#!/usr/bin/env node
// Les sessions ouvertes sur le dashboard, la ou tourne la base.
//
//   npm run sessions                  -> la liste (appareil, ouverture, fin)
//   npm run sessions -- --revoquer    -> les ferme toutes, tout de suite
//
// En ligne : Reglages > « Déconnecter tous les appareils » fait la meme chose
// depuis le site ou l'app. Changer le mot de passe (npm run mot-de-passe)
// ferme aussi toutes les sessions.

require("dotenv").config();
const { ouvreBase } = require("../src/db");

ouvreBase();
const sessions = require("../src/auth/sessions");

const date = (ms) => new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

if (process.argv.includes("--revoquer")) {
  const n = sessions.revoqueTout();
  console.log(`✓ ${n} session(s) fermée(s). Le mot de passe sera redemandé sur tous les appareils.`);
} else {
  const liste = sessions.actives();
  if (!liste.length) console.log("Aucune session ouverte.");
  for (const s of liste) console.log(`${s.type === "app" ? "app" : "site"} · ${s.appareil || "?"} · ouverte ${date(s.cree_le)} · fin ${date(s.expire_le)}`);
}
