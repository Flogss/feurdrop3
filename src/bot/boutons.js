// Les boutons sous chaque etiquette republiee (Imprime, Clean, Del, Drop...)
// et leur mise a jour, toujours deduite de l'etat du colis en base.
const { getColisById, FREE_STATUS } = require("../db");
const { paireDuColis } = require("../specials");
const { ecritureGroupe } = require("./outils");

// --- Aiguillage des fichiers envoyes en prive --------------------------------
//
// Le fichier est republie tel quel dans le topic qui lui revient : copyMessage
// conserve le document et sa legende a l'octet pres, contrairement a un renvoi
// qui ajouterait un en-tete "transfere de". Le colis est ensuite rattache au
// message REPUBLIE, pour que /del et les boutons agissent la ou le fichier se
// trouve vraiment.

// Boutons sous un PDF republie. Ils font exactement ce que font les commandes
// /clear et /del, plus un "Imprime" qui sort l'etiquette de la file de
// /imprime sans rien effacer.
// Trois etats, dans l'ordre de la vie d'une etiquette :
//   a imprimer : Imprime / Clean / Del
//   imprimee   : Drop -- une liasse imprimee ne part pas forcement d'un bloc,
//                on doit pouvoir solder les colis un par un a mesure qu'on
//                les poste
//   dropee     : "Drope" -- un nouvel appui annule le drop (colis remis en
//                attente, de retour dans la file d'impression s'il n'avait pas
//                ete imprime)
function fileButtons(colisId, { printed = false, dropped = false, note = null, special = null } = {}) {
  const lignes = [];
  // un PDF de special porte le numero de sa paire : c'est ce qui le relie a
  // son code-barre devant le locker
  if (special) {
    lignes.push([
      {
        text: `⭐ #${special.numero} · ${special.code ? "🔑 code lie" : "🔑 code en attente"}`,
        callback_data: `c:s:${colisId}`,
      },
    ]);
  }
  // La note se lit sous le fichier sans y toucher : la legende reste celle de
  // l'expediteur. Le texte entier s'affiche en tapant dessus.
  if (note) {
    lignes.push([{ text: `📝 ${tronque(note, 40)}`, callback_data: `c:m:${colisId}` }]);
  }
  if (dropped) {
    lignes.push([{ text: "✅ Drope · annuler", callback_data: `c:k:${colisId}` }]);
  } else if (printed) {
    lignes.push([{ text: "📮 Drop", callback_data: `c:x:${colisId}` }]);
  } else {
    lignes.push([
      { text: "🖨 Imprime", callback_data: `c:p:${colisId}` },
      { text: "🧹 Clean", callback_data: `c:c:${colisId}` },
      { text: "🗑 Del", callback_data: `c:d:${colisId}` },
    ]);
  }
  return { inline_keyboard: lignes };
}

// Les boutons d'un colis se deduisent de son etat en base : un seul endroit
// pour les calculer, quel que soit le geste qui vient de le modifier.
function boutonsDe(colis) {
  const paire = colis.type === "special" ? paireDuColis(colis.id) : null;
  return fileButtons(colis.id, {
    printed: Boolean(colis.printed_at),
    dropped: colis.status === "dropped",
    note: colis.note,
    special: paire ? { numero: paire.numero, code: Boolean(paire.code_file_id) } : null,
  });
}

// Une image de "special" vaut 0 EUR et ne se drope pas : elle n'a rien a
// faire de boutons. Tout le reste, PDF ou image, est un vrai colis.
function aDesBoutons(colis) {
  return Boolean(colis) && colis.status !== FREE_STATUS;
}

function tronque(texte, max) {
  const propre = String(texte).replace(/\s+/g, " ").trim();
  return propre.length > max ? `${propre.slice(0, max - 1)}…` : propre;
}

// --- Pose des boutons ---------------------------------------------------------
// Le dernier clavier pose sur chaque message, pour ne jamais renvoyer a
// Telegram ce qu'il affiche deja. Un drop fait depuis le bouton Telegram, puis
// signale par la base, ne fait ainsi qu'une edition, pas deux -- et chaque
// edition evitee est une place de plus pour les envois.
const boutonsAffiches = new Map(); // "chat:message" -> clavier en JSON
const BOUTONS_MEMOIRE = 5000;

function retiensBoutons(chatId, messageId, clavier) {
  const cle = `${chatId}:${messageId}`;
  boutonsAffiches.delete(cle); // le plus recent passe en fin de liste
  boutonsAffiches.set(cle, JSON.stringify(clavier || { inline_keyboard: [] }));
  if (boutonsAffiches.size > BOUTONS_MEMOIRE) boutonsAffiches.delete(boutonsAffiches.keys().next().value);
}

function dejaAffiches(chatId, messageId, clavier) {
  return boutonsAffiches.get(`${chatId}:${messageId}`) === JSON.stringify(clavier);
}

// Pose un clavier par la file d'ecriture. `clavier` peut etre une fonction :
// il est alors calcule au moment de l'envoi, l'etat du colis ayant pu changer
// pendant l'attente.
function poseBoutons(bot, chatId, messageId, clavier, { priorite = "normale" } = {}) {
  const calcule = () => (typeof clavier === "function" ? clavier() : clavier);
  const avant = calcule();
  if (!avant || dejaAffiches(chatId, messageId, avant)) return Promise.resolve();

  return ecritureGroupe(() => edite(bot, chatId, messageId, calcule()), { priorite });
}

// Pour un bouton presse : l'edition part tout de suite, hors file -- c'est
// la reponse au doigt, elle ne doit pas attendre derriere des envois.
function poseBoutonsMaintenant(bot, chatId, messageId, clavier) {
  return edite(bot, chatId, messageId, clavier).catch(() => {});
}

// Le clavier est note comme affiche AU DEPART de l'edition, pas a son retour :
// deux editions identiques lancees ensemble (le bouton presse, et le signal de
// drop qui suit) n'en font qu'une. Si Telegram refuse, on l'oublie -- un 429
// reessaye par la file doit repartir pour de bon.
async function edite(bot, chatId, messageId, clavier) {
  if (!clavier || dejaAffiches(chatId, messageId, clavier)) return;
  const cle = `${chatId}:${messageId}`;
  const precedent = boutonsAffiches.get(cle);
  retiensBoutons(chatId, messageId, clavier);
  try {
    await bot.editMessageReplyMarkup(clavier, { chat_id: chatId, message_id: messageId });
  } catch (err) {
    // deja ce clavier-la : Telegram le dit, ce n'est pas un echec
    if (/not modified/i.test(err.message)) return;
    if (precedent === undefined) boutonsAffiches.delete(cle);
    else boutonsAffiches.set(cle, precedent);
    throw err;
  }
}

// Repose les boutons d'un colis en relisant son etat : appele apres /note, un
// drop, une correction depuis le site.
function refreshFileButtons(bot, colis, { priorite = "normale" } = {}) {
  if (!colis || !colis.chat_id || !colis.message_id) return;
  const id = colis.id;
  poseBoutons(
    bot,
    colis.chat_id,
    colis.message_id,
    () => {
      const frais = getColisById(id);
      return frais && aDesBoutons(frais) ? boutonsDe(frais) : null;
    },
    { priorite }
  )
    // le message n'a pas forcement de boutons (colis d'avant cette version)
    .catch(() => {});
}

// Une etiquette sortie par /imprime ne doit plus proposer le bouton : on
// remplace les boutons par la mention "deja imprime" sous le fichier concerne.
// Une liasse de 30 etiquettes, c'est 30 editions dans le groupe : elles passent
// par la file cadencee, sinon Telegram en refuse la moitie (429) et les
// boutons Drop n'apparaissent que sous une partie des fichiers.
function markButtonsPrinted(bot, ids) {
  for (const id of ids) refreshFileButtons(bot, getColisById(id));
}

module.exports = {
  fileButtons,
  boutonsDe,
  aDesBoutons,
  tronque,
  boutonsAffiches,
  BOUTONS_MEMOIRE,
  retiensBoutons,
  dejaAffiches,
  poseBoutons,
  poseBoutonsMaintenant,
  edite,
  refreshFileButtons,
  markButtonsPrinted,
};
