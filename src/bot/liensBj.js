// /bj et /stopbj : des fichiers de boite jaune (« BOITEJAUNE6N00034692547.pdf »)
// dont on veut seulement les liens de suivi La Poste. Comme /fusion, les
// fichiers envoyes pendant le mode ne sont pas des colis -- rien n'est compte,
// rien n'est republie --, on n'en garde que le numero.
// /stopbj : tous les liens d'un bloc, un par ligne, dans l'ordre d'envoi
//   https://www.laposte.fr/outils/suivre-vos-envois?code=6N00034692547
// L'etat est garde en base : un redemarrage en plein envoi ne perd rien.
const { getSetting, setSetting } = require("../db");
const { batchKey, replyEphemeral, threadOpts, queueReaction } = require("./outils");
const { fusionPermise } = require("./fusion");

const LIEN_LA_POSTE = "https://www.laposte.fr/outils/suivre-vos-envois?code=";
// un numero de suivi : majuscules et chiffres, au moins un chiffre
const NUMERO = /^(?=[A-Z0-9]*\d)[A-Z0-9]{8,30}$/;
// un message Telegram s'arrete a 4096 caracteres : au-dela, la suite part a part
const MAX_MESSAGE = 3900;

const minuteurs = new Map(); // cle -> minuteur de mise a jour du compteur

const cleBj = (msg) => `liens_bj:${batchKey(msg.chat.id, msg.message_thread_id)}`;

function lisBj(msg) {
  const brut = getSetting(cleBj(msg), "");
  if (!brut) return null;
  try {
    return JSON.parse(brut);
  } catch {
    return null;
  }
}

function ecrisBj(msg, etat) {
  setSetting(cleBj(msg), etat ? JSON.stringify(etat) : "");
}

/** « BOITEJAUNE6N00034692547.pdf » -> « 6N00034692547 » ; null si aucun numero. */
function numeroDuFichier(nom) {
  const base = String(nom || "")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .toUpperCase()
    .replace(/^BO[IÎ]TE[\s_-]*JAUNE[\s_-]*/, "")
    .replace(/^BJ[\s_-]+/, "")
    .replace(/[\s_-]+/g, "");
  return NUMERO.test(base) ? base : null;
}

const lienDe = (numero) => `${LIEN_LA_POSTE}${encodeURIComponent(numero)}`;
const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

function texteCompteur(etat) {
  const n = etat.numeros.length;
  const illisibles = etat.illisibles.length;
  return (
    `📮 Mode BJ\n` +
    `${n === 0 && !illisibles ? "Envoie tes fichiers BOITEJAUNE…" : `${pluriel(n, "numéro lu", "numéros lus")}`}` +
    `${illisibles ? ` · ${pluriel(illisibles, "fichier sans numéro", "fichiers sans numéro")}` : ""} : ils ne comptent pas.\n` +
    `/stopbj pour recevoir les liens La Poste.`
  );
}

async function handleBj(bot, msg) {
  if (!fusionPermise(msg)) return;
  const deja = lisBj(msg);
  if (deja) {
    replyEphemeral(bot, msg, `Déjà en mode BJ (${pluriel(deja.numeros.length, "numéro", "numéros")}). /stopbj pour recevoir les liens.`, {}, 8000);
    return;
  }
  // l'etat d'abord : un fichier envoye juste apres la commande est deja pris
  ecrisBj(msg, { debut: Date.now(), numeros: [], illisibles: [], doublons: 0, messageId: null });
  const envoye = await bot.sendMessage(msg.chat.id, texteCompteur(lisBj(msg)), threadOpts(msg)).catch(() => null);
  const etat = lisBj(msg);
  if (etat && envoye) {
    etat.messageId = envoye.message_id;
    ecrisBj(msg, etat);
    if (etat.numeros.length || etat.illisibles.length) majCompteur(bot, msg);
  } else if (envoye) {
    // /stopbj est arrive entre-temps
    bot.deleteMessage(msg.chat.id, envoye.message_id).catch(() => {});
  }
}

// Vrai si le fichier a ete pris par le mode BJ en cours.
function ajouteABj(bot, msg, attachment) {
  if (!fusionPermise(msg)) return false;
  const etat = lisBj(msg);
  if (!etat) return false;
  const numero = numeroDuFichier(attachment.fileName);
  if (!numero) etat.illisibles.push(attachment.fileName || `message ${msg.message_id}`);
  else if (etat.numeros.some((n) => n.numero === numero)) etat.doublons += 1;
  else etat.numeros.push({ numero, messageId: msg.message_id });
  ecrisBj(msg, etat);
  // ✍ et non 👍 : on voit tout de suite qu'il n'est pas compte
  queueReaction(bot, msg.chat.id, msg.message_id, numero ? "✍" : "🤔", "👌");
  majCompteur(bot, msg);
  return true;
}

// Le compteur, mis a jour une fois la rafale passee (30 fichiers : une seule
// edition).
function majCompteur(bot, msg) {
  const cle = cleBj(msg);
  clearTimeout(minuteurs.get(cle));
  minuteurs.set(
    cle,
    setTimeout(() => {
      minuteurs.delete(cle);
      const etat = lisBj(msg);
      if (!etat?.messageId) return;
      bot.editMessageText(texteCompteur(etat), { chat_id: msg.chat.id, message_id: etat.messageId }).catch(() => {});
    }, 800)
  );
}

// Les lignes en messages de moins de 4096 caracteres.
function enBlocs(entete, lignes) {
  const blocs = [];
  let courant = entete;
  for (const ligne of lignes) {
    if (courant.length + 1 + ligne.length > MAX_MESSAGE) {
      blocs.push(courant);
      courant = ligne;
    } else {
      courant = courant ? `${courant}\n${ligne}` : ligne;
    }
  }
  if (courant) blocs.push(courant);
  return blocs;
}

async function handleStopBj(bot, msg) {
  if (!fusionPermise(msg)) return;
  const etat = lisBj(msg);
  if (!etat) {
    replyEphemeral(bot, msg, "Pas de mode BJ en cours. /bj pour en commencer un.", {}, 8000);
    return;
  }
  // fin du mode : les fichiers suivants redeviennent des colis
  ecrisBj(msg, null);
  clearTimeout(minuteurs.get(cleBj(msg)));
  minuteurs.delete(cleBj(msg));
  if (etat.messageId) bot.deleteMessage(msg.chat.id, etat.messageId).catch(() => {});

  // dans l'ordre d'envoi (un album arrive parfois dans le desordre)
  const numeros = [...etat.numeros].sort((a, b) => a.messageId - b.messageId).map((n) => n.numero);
  const notes = [
    etat.doublons ? `${pluriel(etat.doublons, "doublon ignoré", "doublons ignorés")}` : null,
    etat.illisibles.length ? `⚠️ sans numéro : ${etat.illisibles.slice(0, 5).join(", ")}${etat.illisibles.length > 5 ? "…" : ""}` : null,
  ].filter(Boolean);
  if (numeros.length === 0) {
    bot
      .sendMessage(msg.chat.id, `Mode BJ arrêté : aucun numéro lu.${notes.length ? `\n${notes.join("\n")}` : ""}`, threadOpts(msg))
      .catch(() => {});
    return;
  }

  const entete = `📮 ${pluriel(numeros.length, "lien La Poste", "liens La Poste")} (boîte jaune)${notes.length ? `\n${notes.join("\n")}` : ""}\n`;
  for (const bloc of enBlocs(entete, numeros.map(lienDe))) {
    // pas d'apercu : 30 liens donneraient une grande carte inutile
    await bot
      .sendMessage(msg.chat.id, bloc, { ...threadOpts(msg), disable_web_page_preview: true })
      .catch((err) => bot.sendMessage(msg.chat.id, `Envoi impossible : ${err.message}`, threadOpts(msg)).catch(() => {}));
  }
}

module.exports = { handleBj, handleStopBj, ajouteABj, numeroDuFichier, lienDe, enBlocs };
