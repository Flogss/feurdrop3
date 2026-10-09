// /save : la sauvegarde JSON des donnees (voir sauvegarde.js), envoyee en
// document Telegram.
//
// Reservee a la liste blanche (TELEGRAM_ALLOWED_USERS) : le fichier contient
// les donnees de tous les expediteurs. Il ne part jamais dans le groupe : il
// va a la destination des sauvegardes (TELEGRAM_BACKUP_CHAT_ID), sinon en
// prive a la personne qui l'a demande.
const { creeSauvegarde, tailleLisible, CATEGORIES } = require("../sauvegarde");
const { replyEphemeral, threadOpts } = require("./outils");

// Telegram refuse les documents envoyes par un bot au-dela de 50 Mo
const TAILLE_MAX = 49 * 1024 * 1024;

let enCours = false;

function destinationSauvegarde(msg) {
  const configuree = Number(process.env.TELEGRAM_BACKUP_CHAT_ID);
  if (process.env.TELEGRAM_BACKUP_CHAT_ID && Number.isFinite(configuree)) return configuree;
  return msg.from?.id ?? null;
}

const nf = new Intl.NumberFormat("fr-FR");

function legende(s) {
  const libelles = Object.fromEntries(CATEGORIES.map((c) => [c.nom, c.libelle]));
  const categories = Object.entries(s.comptes)
    .map(([nom, n]) => `${libelles[nom] || nom} ${nf.format(n)}`)
    .join(" · ");
  return (
    "✅ Sauvegarde FeurDrop terminée\n" +
    `📅 ${s.date} (heure de Paris)\n` +
    `📦 ${tailleLisible(s.taille)} · JSON relu et vérifié : ${nf.format(s.total)} enregistrements, empreinte ${s.sha256Donnees.slice(0, 12)}\n` +
    `🗂 ${categories}\n` +
    "Sans PDF, images, jetons ni secrets."
  ).slice(0, 1024);
}

// Une erreur se dit dans le chat de la commande : elle ne contient aucune
// donnee.
function signaleErreur(bot, msg, texte) {
  console.error(`[save] ${texte}`);
  return bot.sendMessage(msg.chat.id, `❌ ${texte}`, threadOpts(msg)).catch(() => {});
}

async function handleSave(bot, msg) {
  if (enCours) return replyEphemeral(bot, msg, "Une sauvegarde est déjà en cours.", {}, 6000);
  const destination = destinationSauvegarde(msg);
  if (!destination) return signaleErreur(bot, msg, "Sauvegarde impossible : destination inconnue (TELEGRAM_BACKUP_CHAT_ID).");

  enCours = true;
  try {
    let sauvegarde;
    try {
      sauvegarde = creeSauvegarde();
    } catch (err) {
      return signaleErreur(bot, msg, `Sauvegarde impossible : ${err.message}`);
    }
    if (sauvegarde.taille > TAILLE_MAX) {
      return signaleErreur(bot, msg, `Sauvegarde trop lourde pour Telegram (${tailleLisible(sauvegarde.taille)}, maximum 49 Mo).`);
    }

    try {
      await bot.sendDocument(
        destination,
        sauvegarde.contenu,
        { caption: legende(sauvegarde) },
        { filename: sauvegarde.fichier, contentType: "application/json" }
      );
    } catch (err) {
      return signaleErreur(bot, msg, `Sauvegarde créée mais envoi impossible : ${err.message}`);
    }

    console.log(`[save] ${sauvegarde.fichier} envoyee (${sauvegarde.taille} octets, ${sauvegarde.total} enregistrements)`);
    // demandee ailleurs (le groupe) : on dit ou elle est partie, sans rien
    // montrer de son contenu
    if (destination !== msg.chat.id) {
      replyEphemeral(bot, msg, "✅ Sauvegarde envoyée sur la conversation des sauvegardes.", {}, 8000);
    }
  } finally {
    enCours = false;
  }
}

module.exports = { handleSave, destinationSauvegarde };
