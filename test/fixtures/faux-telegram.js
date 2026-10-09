// Un faux serveur de l'API Telegram, pour faire tourner le vrai bot (et la
// vraie bibliotheque node-telegram-bot-api) sans toucher a Telegram : il sert
// les mises a jour qu'on lui donne et note chaque appel du bot.
const http = require("http");

function lisCorps(req) {
  return new Promise((resolve) => {
    const morceaux = [];
    req.on("data", (c) => morceaux.push(c));
    req.on("end", () => resolve(Buffer.concat(morceaux)));
  });
}

// application/x-www-form-urlencoded, JSON, ou multipart (envoi de fichier)
function analyse(type, brut) {
  if (/json/.test(type)) return JSON.parse(brut.toString() || "{}");
  if (/x-www-form-urlencoded/.test(type)) {
    const params = Object.fromEntries(new URLSearchParams(brut.toString()));
    for (const [k, v] of Object.entries(params)) {
      if (/^[[{]/.test(v)) {
        try {
          params[k] = JSON.parse(v);
        } catch {
          /* texte */
        }
      }
    }
    return params;
  }
  if (/multipart/.test(type)) {
    const texte = brut.toString("latin1");
    const champs = {};
    const fichiers = {};
    for (const m of texte.matchAll(/name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: ([^\r]+)\r\n)?\r\n([\s\S]*?)\r\n--/g)) {
      if (m[2]) fichiers[m[1]] = { nom: m[2], type: m[3], taille: Buffer.byteLength(m[4], "latin1"), debut: m[4].slice(0, 5) };
      else champs[m[1]] = m[4];
    }
    return { ...champs, _fichiers: fichiers };
  }
  return {};
}

function creeFauxTelegram({ membres = {} } = {}) {
  const appels = [];
  const aServir = [];
  let prochainId = 1000;
  let prochaineMaj = 1;
  const reponsesForcees = new Map(); // methode -> [ {status, corps} ]
  const fichiers = new Map(); // file_id -> octets servis au telechargement

  const serveur = http.createServer(async (req, res) => {
    // telechargement d'un fichier : /file/bot<jeton>/<chemin>
    const telechargement = /^\/file\/bot[^/]+\/documents\/([^/]+)\.bin$/.exec(req.url);
    if (telechargement) {
      const octets = fichiers.get(decodeURIComponent(telechargement[1]));
      res.writeHead(octets ? 200 : 404, { "Content-Type": "application/octet-stream" });
      return res.end(octets || "");
    }
    const m = /^\/bot[^/]+\/(\w+)/.exec(req.url);
    const methode = m ? m[1] : null;
    // la bibliotheque met les parametres dans l'adresse quand le corps porte
    // un fichier (multipart)
    const query = Object.fromEntries(new URL(req.url, "http://x").searchParams);
    const params = { ...query, ...analyse(req.headers["content-type"] || "", await lisCorps(req)) };
    const envoie = (status, corps) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(corps));
    };
    if (!methode) return envoie(404, { ok: false, error_code: 404, description: "Not Found" });
    if (methode !== "getUpdates") appels.push({ methode, params });

    const forcee = reponsesForcees.get(methode)?.shift();
    if (forcee) return envoie(forcee.status, forcee.corps);

    switch (methode) {
      case "getUpdates": {
        const lot = aServir.splice(0);
        // pas de longue attente : le bot repasse dans 300 ms
        return setTimeout(() => envoie(200, { ok: true, result: lot }), lot.length ? 0 : 40);
      }
      case "getFile":
        return envoie(200, {
          ok: true,
          result: { file_id: params.file_id, file_unique_id: `u${params.file_id}`, file_path: `documents/${encodeURIComponent(params.file_id)}.bin` },
        });
      case "getMe":
        return envoie(200, { ok: true, result: { id: 42, is_bot: true, first_name: "Drop", username: "drop_test_bot" } });
      case "getChatMember": {
        const statut = membres[String(params.user_id)] || "left";
        if (statut === "introuvable") {
          return envoie(400, { ok: false, error_code: 400, description: "Bad Request: user not found" });
        }
        return envoie(200, { ok: true, result: { status: statut, user: { id: Number(params.user_id) } } });
      }
      case "sendMessage":
      case "sendDocument":
      case "sendPhoto":
      case "copyMessage":
        return envoie(200, {
          ok: true,
          result: {
            message_id: prochainId++,
            chat: { id: Number(params.chat_id), type: Number(params.chat_id) < 0 ? "supergroup" : "private" },
            date: Math.floor(Date.now() / 1000),
            text: params.text,
          },
        });
      default:
        return envoie(200, { ok: true, result: true });
    }
  });

  return {
    demarre: () =>
      new Promise((resolve) => {
        serveur.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${serveur.address().port}`));
      }),
    ferme: () => new Promise((r) => serveur.close(r)),
    // un fichier que le bot pourra telecharger (getFile puis /file/...)
    fichier: (fileId, octets) => fichiers.set(fileId, Buffer.from(octets)),
    // une mise a jour a livrer au prochain getUpdates
    livre: (maj) => aServir.push({ update_id: prochaineMaj++, ...maj }),
    appels,
    appelsDe: (methode) => appels.filter((a) => a.methode === methode),
    // la prochaine reponse a `methode` sera celle-ci (ex. un 429)
    forceReponse: (methode, status, corps) => {
      if (!reponsesForcees.has(methode)) reponsesForcees.set(methode, []);
      reponsesForcees.get(methode).push({ status, corps });
    },
    // attend qu'une condition sur les appels devienne vraie
    attends: async (condition, delaiMs = 4000) => {
      const fin = Date.now() + delaiMs;
      while (Date.now() < fin) {
        if (condition()) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return condition();
    },
  };
}

module.exports = { creeFauxTelegram };
