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
  return dossier;
}

// L'app du dashboard sur un port libre. `fetch` relatif a son adresse.
async function demarreApp() {
  const { creeApp } = require("../src/app");
  const app = creeApp();
  const serveur = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${serveur.address().port}`;
  const appel = async (chemin, { methode = "GET", corps, entetes = {} } = {}) => {
    const reponse = await fetch(base + chemin, {
      method: methode,
      headers: { ...(corps !== undefined ? { "Content-Type": "application/json" } : {}), ...entetes },
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
  return { base, appel, ferme: () => new Promise((r) => serveur.close(r)) };
}

// Remet la base a zero entre deux tests d'un meme fichier (le module de base
// reste charge : on vide ses tables plutot que d'en ouvrir une autre).
function videBase() {
  const { db } = require("../src/db");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'")
    .all()
    .map((t) => t.name);
  for (const t of tables) db.prepare(`DELETE FROM "${t}"`).run();
}

module.exports = { environnementDeTest, demarreApp, videBase };
