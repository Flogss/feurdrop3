#!/usr/bin/env node
// Choisir (ou changer) le mot de passe du dashboard.
//
//   npm run mot-de-passe                 -> affiche l'empreinte a copier
//   npm run mot-de-passe -- --railway    -> la pose directement sur Railway
//                                           (variable DASHBOARD_PASSWORD_HASH
//                                           du service feurdrop3)
//   npm run mot-de-passe -- --local      -> l'ecrit dans le .env (en local)
//
// Le mot de passe est tape sans s'afficher, deux fois. Il ne quitte jamais
// cette machine : seule son empreinte Argon2id part (ou s'affiche). Changer
// l'empreinte ferme toutes les sessions ouvertes avec l'ancien mot de passe.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { empreinte, LONGUEUR_MIN } = require("../src/auth/motDePasse");

const SERVICE = process.env.RAILWAY_SERVICE_DASHBOARD || "feurdrop3";
const ENV = path.join(__dirname, "..", ".env");

// Une saisie masquee : rien ne s'affiche, pas meme des etoiles.
function demande(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error("lance ce script dans un terminal (saisie masquee impossible ici)"));
    stdout.write(question);
    let saisi = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const fin = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", lit);
      stdout.write("\n");
    };
    const lit = (morceau) => {
      for (const c of morceau) {
        if (c === "\r" || c === "\n") return fin(), resolve(saisi);
        if (c === "\u0003") return fin(), reject(new Error("annulé"));
        if (c === "\u007f" || c === "\b") saisi = saisi.slice(0, -1);
        else if (c >= " ") saisi += c;
      }
    };
    stdin.on("data", lit);
  });
}

function ecritEnvLocal(hash) {
  const ligne = `DASHBOARD_PASSWORD_HASH='${hash}'`;
  let contenu = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
  if (/^DASHBOARD_PASSWORD_HASH=.*$/m.test(contenu)) contenu = contenu.replace(/^DASHBOARD_PASSWORD_HASH=.*$/m, ligne);
  else contenu += `${contenu && !contenu.endsWith("\n") ? "\n" : ""}${ligne}\n`;
  fs.writeFileSync(ENV, contenu, { mode: 0o600 });
}

function poseSurRailway(hash) {
  // la valeur passe par l'entree standard : jamais dans la ligne de commande
  const r = spawnSync("railway", ["variable", "set", "DASHBOARD_PASSWORD_HASH", "--stdin", "--service", SERVICE], {
    input: hash,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.error || r.status !== 0) throw new Error("la commande railway a échoué (railway login ? railway link ?)");
}

(async () => {
  const options = new Set(process.argv.slice(2));
  console.log(`Mot de passe du dashboard FeurDrop (${LONGUEUR_MIN} caractères minimum ; une phrase est idéale).`);
  const premier = await demande("Nouveau mot de passe : ");
  if (premier.length < LONGUEUR_MIN) throw new Error(`trop court : ${LONGUEUR_MIN} caractères minimum`);
  const second = await demande("Encore une fois : ");
  if (premier !== second) throw new Error("les deux saisies ne correspondent pas");

  const hash = await empreinte(premier);

  if (options.has("--railway")) {
    poseSurRailway(hash);
    console.log(`\n✓ Empreinte posée sur Railway (service ${SERVICE}, variable DASHBOARD_PASSWORD_HASH).`);
    console.log("  Railway redéploie le dashboard ; toutes les anciennes sessions sont fermées.");
  } else if (options.has("--local")) {
    ecritEnvLocal(hash);
    console.log("\n✓ Empreinte écrite dans .env (DASHBOARD_PASSWORD_HASH). Redémarre le serveur local.");
  } else {
    console.log("\nEmpreinte Argon2id (à mettre dans la variable DASHBOARD_PASSWORD_HASH) :\n");
    console.log(hash);
    console.log("\nRailway : service feurdrop3 > Variables > DASHBOARD_PASSWORD_HASH = cette ligne entière.");
    console.log("Ou directement : npm run mot-de-passe -- --railway");
  }
})().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
