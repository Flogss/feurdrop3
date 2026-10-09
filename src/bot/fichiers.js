// Ce qu'un message apporte : son expediteur d'origine, son fichier (PDF,
// image, photo) et le type impose par le topic ou il arrive.
const { AUTO_GROUP_CHAT_ID, AUTO_LIT_TOPIC_IDS, AUTO_NORMAL_TOPIC_IDS, AUTO_BJ_TOPIC_IDS, AUTO_SPECIAL_TOPIC_IDS } = require("./config");

// Le topic "1" (t.me/c/.../1) correspond au topic General par defaut d'un
// forum Telegram, qui n'a pas de vrai message_thread_id cote Bot API : il ne
// faut pas en passer un pour y poster.

function extractSenderName(msg) {
  const origin = msg.forward_origin;
  if (origin) {
    if (origin.type === "user" && origin.sender_user) {
      return origin.sender_user.username
        ? `@${origin.sender_user.username}`
        : origin.sender_user.first_name;
    }
    if (origin.type === "hidden_user" && origin.sender_user_name) {
      return origin.sender_user_name;
    }
    if (origin.type === "chat" && origin.sender_chat) {
      return origin.sender_chat.title || origin.sender_chat.username || "Chat inconnu";
    }
    if (origin.type === "channel" && origin.chat) {
      return origin.chat.title || "Canal inconnu";
    }
  }

  if (msg.forward_from) {
    return msg.forward_from.username
      ? `@${msg.forward_from.username}`
      : msg.forward_from.first_name;
  }
  if (msg.forward_sender_name) return msg.forward_sender_name;
  if (msg.forward_from_chat) {
    return msg.forward_from_chat.title || msg.forward_from_chat.username || "Chat inconnu";
  }

  // pas de trace de transfert : le PDF a ete poste directement, il vient donc
  // de nous et non d'un expediteur tiers
  return "Moi";
}

function isPdf(document) {
  if (!document) return false;
  if (document.mime_type === "application/pdf") return true;
  return /\.pdf$/i.test(document.file_name || "");
}

function isImageDocument(document) {
  if (!document) return false;
  if ((document.mime_type || "").startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(document.file_name || "");
}

// Un colis peut arriver en PDF, en fichier image, ou en photo Telegram
// (compressee : dans ce cas il n'y a pas de nom de fichier, seule la
// legende peut porter le numero de suivi).
function colisAttachment(msg) {
  if (isPdf(msg.document)) {
    return { fileName: msg.document.file_name || null, fileId: msg.document.file_id, kind: "pdf" };
  }
  if (isImageDocument(msg.document)) {
    return { fileName: msg.document.file_name || null, fileId: msg.document.file_id, kind: "image" };
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    // on garde la plus grande taille : c'est celle qui imprime correctement
    const best = msg.photo[msg.photo.length - 1];
    return { fileName: null, fileId: best.file_id, kind: "image" };
  }
  return null;
}

// Chats inconnus deja signales, pour ne pas repeter le meme avertissement.
const ignoredChatsLogged = new Set();

// Determine le type impose par le topic Telegram, ou null si le fichier ne
// doit pas etre compte du tout.
// Deux sources sont legitimes et deux seulement :
//   - le groupe configure, dans un des topics suivis ;
//   - un transfert direct au bot en message prive.
// Tout le reste (autre groupe, autre canal, ancien groupe ou l'on est encore
// membre, topic non suivi) est ignore : sinon la moindre photo postee ailleurs
// se retrouvait comptee comme un colis.
function resolveForcedType(msg) {
  if (msg.chat.id === AUTO_GROUP_CHAT_ID) {
    const threadId = msg.message_thread_id;
    if (AUTO_LIT_TOPIC_IDS.includes(threadId)) return "lit";
    if (AUTO_NORMAL_TOPIC_IDS.includes(threadId)) return "normal";
    if (AUTO_BJ_TOPIC_IDS.includes(threadId)) return "bj";
    if (AUTO_SPECIAL_TOPIC_IDS.includes(threadId)) return "special";
    return null; // bon groupe, mais topic non suivi
  }

  if (msg.chat.type === "private") return undefined; // transfert direct au bot

  if (!ignoredChatsLogged.has(msg.chat.id)) {
    ignoredChatsLogged.add(msg.chat.id);
    console.log(
      `[bot] fichiers ignores dans "${msg.chat.title || msg.chat.id}" (id ${msg.chat.id}) :` +
        ` ce n'est pas le groupe configure (${AUTO_GROUP_CHAT_ID}).`
    );
  }
  return null;
}

module.exports = {
  extractSenderName,
  isPdf,
  isImageDocument,
  colisAttachment,
  ignoredChatsLogged,
  resolveForcedType,
};
