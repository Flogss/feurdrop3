const fs = require("fs");
const os = require("os");
const path = require("path");

// Chaque fichier de test tourne dans son propre processus (node --test) : il
// prepare ici une base jetable AVANT de charger le moindre module du serveur.
// Jamais la base de data/, jamais le vrai jeton du bot, jamais le reseau.
function environnementDeTest() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "drop-test-"));
  process.env.DB_PATH = path.join(dossier, "drop.db");
  process.env.SUIVI_DB_PATH = path.join(dossier, "suivi.db");
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.PORTAIL_URL;
  delete process.env.PRINT_TOKEN;
  // un faux jeton : le bot n'est jamais demarre par les tests, mais rien ne
  // doit pouvoir retomber sur le vrai
  process.env.TELEGRAM_BOT_TOKEN = "000000:jeton-de-test";
  process.env.SUIVI_BOT_TOKEN = "";
  process.env.OKAPI_KEY = "";
  // jamais les vraies API des transporteurs depuis les tests
  for (const v of ["UPS_CLIENT_ID", "UPS_CLIENT_SECRET", "UPS_API_URL", "DHL_API_KEY", "DHL_API_URL"]) delete process.env[v];
  // le mot de passe du dashboard, pour les tests seulement (empreinte
  // Argon2id allegee, pour aller vite) ; jamais le vrai
  process.env.DASHBOARD_PASSWORD_HASH = EMPREINTE_TEST;
  delete process.env.NODE_ENV;
  return dossier;
}

const MOT_DE_PASSE_TEST = "mot-de-passe-de-test";
const EMPREINTE_TEST = "$argon2id$v=19$m=8192,p=1,t=2$Xd8x7wX5iSg89kikjCSLWw$BE/X36cKMHDTR0XEHzyHP/IvXAXSDUdHlcFKFpySRiY";

// L'app du dashboard sur un port libre. `appel` : un fetch relatif a son
// adresse, AUTHENTIFIE par defaut -- comme l'app iOS, avec un jeton de
// session obtenu par une vraie connexion (mot de passe de test). Pour
// appeler sans session : { anonyme: true }.
async function demarreApp({ connecte = true } = {}) {
  const { creeApp } = require("../src/app");
  const app = creeApp();
  const serveur = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  let jeton = null;
  const appel = async (chemin, { methode = "GET", corps, entetes = {}, anonyme = false } = {}) => {
    const reponse = await fetch(base + chemin, {
      method: methode,
      redirect: "manual",
      headers: {
        ...(corps !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(jeton && !anonyme ? { Authorization: `Bearer ${jeton}` } : {}),
        ...entetes,
      },
      body: corps === undefined ? undefined : typeof corps === "string" ? corps : JSON.stringify(corps),
    });
    const texte = await reponse.text();
    let json = null;
    try {
      json = JSON.parse(texte);
    } catch {
      json = null;
    }
    return { status: reponse.status, json, texte, entetes: reponse.headers };
  };
  if (connecte) {
    const r = await appel("/api/auth/connexion", { methode: "POST", corps: { motDePasse: MOT_DE_PASSE_TEST, mode: "app", appareil: "tests" } });
    if (r.status !== 200) throw new Error(`connexion de test impossible : ${r.status} ${r.texte}`);
    jeton = r.json.jeton;
  }
  return { base, appel, jeton, ferme: () => new Promise((r) => serveur.close(r)) };
}

// Remet la base a zero entre deux tests d'un meme fichier (le module de base
// reste charge : on vide ses tables plutot que d'en ouvrir une autre).
function videBase() {
  const { db } = require("../src/db");
  const tables = db
    // (les sessions restent : la connexion de test sert a tout le fichier)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'sessions')")
    .all()
    .map((t) => t.name);
  for (const t of tables) db.prepare(`DELETE FROM "${t}"`).run();
}

module.exports = { environnementDeTest, demarreApp, videBase, MOT_DE_PASSE_TEST };
