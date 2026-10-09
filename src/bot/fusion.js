// /fusion et /stopfusion : des fichiers mis de cote (ils ne comptent pas),
// puis rendus fusionnes en un seul PDF au format etiquette.
const { getSetting, setSetting, journalise } = require("../db");
const { mergeLabels } = require("../printer");
const { AUTO_GROUP_CHAT_ID } = require("./config");
const { batchKey, replyEphemeral, threadOpts, queueReaction } = require("./outils");
const { downloadLabels, startProgress } = require("./impression");

// --- Mode fusion ---------------------------------------------------------------
// /fusion : les fichiers envoyes ensuite dans ce chat (ou ce topic) ne sont pas
// des colis -- rien n'est compte, rien n'est republie -- ils sont mis de cote.
// /stopfusion : le bot les fusionne en un seul PDF, au format etiquette comme
// /imprime, et le renvoie. L'etat est garde en base : un redemarrage du bot en
// pleine fusion ne perd aucun fichier.

const minuteursFusion = new Map(); // cle -> minuteur de mise a jour du message

function cleFusion(msg) {
  return `fusion:${batchKey(msg.chat.id, msg.message_thread_id)}`;
}

function lisFusion(msg) {
  const brut = getSetting(cleFusion(msg), "");
  if (!brut) return null;
  try {
    return JSON.parse(brut);
  } catch {
    return null;
  }
}

function ecrisFusion(msg, etat) {
  setSetting(cleFusion(msg), etat ? JSON.stringify(etat) : "");
}

// les deux seules sources legitimes, comme pour les colis : le prive et le
// groupe configure
function fusionPermise(msg) {
  return msg.chat.type === "private" || msg.chat.id === AUTO_GROUP_CHAT_ID;
}

const fichiers = (n) => `${n} fichier${n > 1 ? "s" : ""}`;

function texteFusion(n) {
  return (
    `🔀 Mode fusion\n` +
    `${n === 0 ? "Envoie tes colis" : `${fichiers(n)} recu${n > 1 ? "s" : ""}`} : ils ne comptent pas.\n` +
    `/stopfusion pour recevoir le PDF fusionne.`
  );
}

async function handleFusion(bot, msg) {
  if (!fusionPermise(msg)) return;
  const deja = lisFusion(msg);
  if (deja) {
    replyEphemeral(bot, msg, `Deja en mode fusion (${fichiers(deja.fichiers.length)}). /stopfusion pour recevoir le PDF.`, {}, 8000);
    return;
  }
  // l'etat d'abord : un fichier envoye juste apres la commande est deja pris
  ecrisFusion(msg, { debut: Date.now(), fichiers: [], messageId: null });
  const envoye = await bot.sendMessage(msg.chat.id, texteFusion(0), threadOpts(msg)).catch(() => null);
  const etat = lisFusion(msg);
  if (etat && envoye) {
    etat.messageId = envoye.message_id;
    ecrisFusion(msg, etat);
    if (etat.fichiers.length > 0) majMessageFusion(bot, msg);
  } else if (envoye) {
    // /stopfusion est arrive entre-temps
    bot.deleteMessage(msg.chat.id, envoye.message_id).catch(() => {});
  }
}

// Vrai si le fichier a ete pris par une fusion en cours.
function ajouteAFusion(bot, msg, attachment) {
  if (!fusionPermise(msg)) return false;
  const etat = lisFusion(msg);
  if (!etat) return false;
  etat.fichiers.push({ fileId: attachment.fileId, kind: attachment.kind, nom: attachment.fileName, messageId: msg.message_id });
  ecrisFusion(msg, etat);
  // ✍ et non 👍 : on voit tout de suite qu'il n'est pas compte
  queueReaction(bot, msg.chat.id, msg.message_id, "✍", "👌");
  majMessageFusion(bot, msg);
  return true;
}

// Le compteur du message de fusion, mis a jour une fois la rafale passee (un
// album arrive en plusieurs messages : une seule edition pour tous).
function majMessageFusion(bot, msg) {
  const cle = cleFusion(msg);
  clearTimeout(minuteursFusion.get(cle));
  minuteursFusion.set(
    cle,
    setTimeout(() => {
      minuteursFusion.delete(cle);
      const etat = lisFusion(msg);
      if (!etat?.messageId) return;
      bot
        .editMessageText(texteFusion(etat.fichiers.length), { chat_id: msg.chat.id, message_id: etat.messageId })
        .catch(() => {});
    }, 800)
  );
}

async function handleStopFusion(bot, msg) {
  if (!fusionPermise(msg)) return;
  const etat = lisFusion(msg);
  if (!etat) {
    replyEphemeral(bot, msg, "Pas de fusion en cours. /fusion pour en commencer une.", {}, 8000);
    return;
  }
  // fin du mode : les fichiers suivants redeviennent des colis
  ecrisFusion(msg, null);
  clearTimeout(minuteursFusion.get(cleFusion(msg)));
  minuteursFusion.delete(cleFusion(msg));
  if (etat.messageId) bot.deleteMessage(msg.chat.id, etat.messageId).catch(() => {});

  // dans l'ordre d'envoi
  const recus = [...etat.fichiers].sort((a, b) => a.messageId - b.messageId);
  if (recus.length === 0) {
    replyEphemeral(bot, msg, "Mode fusion arrete : aucun fichier recu.", {}, 8000);
    return;
  }

  const progression = await startProgress(bot, msg.chat.id, recus.length, {
    titre: "🔀 Fusion des colis",
    unite: "recuperes",
    threadId: msg.message_thread_id || null,
  });
  const lignes = recus.map((f, i) => ({
    id: i + 1,
    file_id: f.fileId,
    file_kind: f.kind,
    file_name: f.nom || `fichier ${i + 1}`,
    type: "fusion",
  }));
  const { labels, missing } = await downloadLabels(bot, lignes, () => progression.step());
  const { pdf, pages, failed } = await mergeLabels(labels);
  progression.remove();

  if (!pdf) {
    bot
      .sendMessage(msg.chat.id, `Fusion impossible : aucun des ${fichiers(recus.length)} n'a pu etre lu.`, threadOpts(msg))
      .catch(() => {});
    return;
  }

  const fusionnes = labels.length - failed.length;
  journalise("fusion", `${fichiers(fusionnes)} fusionné${fusionnes > 1 ? "s" : ""} (/fusion)`, {
    detail: "hors suivi : ne comptent pas",
    nombre: fusionnes,
  });
  const caption =
    `🔀 ${fichiers(fusionnes)} fusionne${fusionnes > 1 ? "s" : ""} · ${pages} page${pages > 1 ? "s" : ""}\n` +
    `Ils ne comptent pas.` +
    (missing.length > 0 ? `\n⚠️ ${fichiers(missing.length)} introuvable${missing.length > 1 ? "s" : ""} sur Telegram.` : "") +
    (failed.length > 0 ? `\n⚠️ ${fichiers(failed.length)} illisible${failed.length > 1 ? "s" : ""}.` : "");
  // l'heure de Paris dans le nom (le serveur est en UTC) : fusion-2026-10-05-16h31.pdf
  const morceaux = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date())
      .map((m) => [m.type, m.value])
  );
  const jour = `${morceaux.year}-${morceaux.month}-${morceaux.day}-${morceaux.hour}h${morceaux.minute}`;
  await bot
    .sendDocument(msg.chat.id, pdf, { caption, ...threadOpts(msg) }, { filename: `fusion-${jour}.pdf`, contentType: "application/pdf" })
    .catch((err) => bot.sendMessage(msg.chat.id, `Envoi impossible : ${err.message}`, threadOpts(msg)).catch(() => {}));
}

module.exports = {
  minuteursFusion,
  cleFusion,
  lisFusion,
  ecrisFusion,
  fusionPermise,
  fichiers,
  texteFusion,
  handleFusion,
  ajouteAFusion,
  majMessageFusion,
  handleStopFusion,
};
