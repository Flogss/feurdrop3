const path = require("path");

// Un seul endroit decide ou vit la base du bot de suivi : celui qui ecrit
// (le bot) et celui qui lit (le dashboard) doivent designer le meme fichier,
// sinon l'onglet reste vide sans que rien ne signale d'erreur.
function suiviDbPath() {
  if (process.env.SUIVI_DB_PATH) return process.env.SUIVI_DB_PATH;
  // sur Railway, le volume monte est le seul endroit qui survit a un
  // deploiement : ecrire ailleurs reviendrait a tout perdre a chaque mise a
  // jour, exactement comme pour la base du dashboard
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "suivi.db");
  }
  return path.resolve(__dirname, "..", "..", "data", "suivi.db");
}

module.exports = { suiviDbPath };
