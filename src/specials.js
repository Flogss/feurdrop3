// Paires "special" : un code-barre (image) + une etiquette (PDF).
//
// Dans le topic special, chaque colis arrive avec un code-barre qui ouvre le
// locker. Le code n'est pas un colis -- il ne vaut rien, ne se drope pas, ne
// s'imprime pas dans la liasse -- mais il faut savoir a quel PDF il va : devant
// le locker, avec dix colis et dix codes, on doit retrouver le bon.
//
// Appairage : dans l'ordre d'arrivee, par expediteur. Le code peut arriver
// avant ou apres son PDF ; le premier des deux ouvre une paire, le suivant de
// l'autre sorte la complete. L'expediteur est celui d'origine (le client dont
// on transfere les fichiers), pas celui qui poste : deux clients qui envoient
// en meme temps ne melangent pas leurs codes.
//
// Numero : le plus petit libre parmi les paires en cours. Il reste donc court
// (1 a 10 pour dix colis), stable tant que le colis n'est pas drope, et se
// libere ensuite pour la fournee suivante.

// la table paires_special est creee avec le reste du schema, dans db.js
const { db, addColis, deleteColis, getColisById } = require("./db");

// --- Code ou colis ? -------------------------------------------------------------
// Le code qui ouvre le locker est le plus souvent une image, mais pas toujours :
// il arrive en PDF. Et le colis peut arriver en image. La legende tranche quand
// elle parle : "t'ouvres le locker avec ca" d'un cote, "et tu mets lui dedans"
// de l'autre. Sinon, a defaut d'indice, image = code et PDF = colis ; les
// commandes /special image N et /special pdf N corrigent a la main.
const OUVRE = /ouvr|ouverture|d[ée]verrouill/i;
// "fragile, ne pas ouvrir" parle d'un colis, pas d'un code
const OUVRE_NIE = /\bn['’]\s*ouvr|\bpas\s+(l['’]\s*)?ouvr/i;
const DEDANS = /dedans|[àa]\s*l['’]?\s*int[ée]rieur|\bmets?\b|\bmettre\b|d[ée]pos/i;

function roleSpecial(fileKind, legende) {
  const texte = legende || "";
  const ouvre = OUVRE.test(texte) && !OUVRE_NIE.test(texte);
  const dedans = DEDANS.test(texte);
  // une legende qui dit les deux ("ouvre avec ca et mets-le dedans") ne
  // tranche pas : on retombe sur la nature du fichier
  if (ouvre && !dedans) return "code";
  if (dedans && !ouvre) return "colis";
  return fileKind === "image" ? "code" : "colis";
}

// Une paire est en cours tant que son colis attend d'etre drope dans special.
// Un code encore seul attend son PDF une semaine : au-dela, c'est un code
// orphelin, et il ne doit pas bloquer un numero pour toujours.
const EN_COURS_SQL = `(
  (p.colis_id IS NULL AND p.created_at > datetime('now', '-7 days'))
  OR EXISTS (SELECT 1 FROM colis c
             WHERE c.id = p.colis_id AND c.status = 'pending' AND c.type = 'special')
)`;

function numeroLibre() {
  const pris = new Set(
    db.prepare(`SELECT numero FROM paires_special p WHERE ${EN_COURS_SQL}`).all().map((r) => r.numero)
  );
  let n = 1;
  while (pris.has(n)) n += 1;
  return n;
}

function getPaire(id) {
  return db.prepare("SELECT * FROM paires_special WHERE id = ?").get(id) || null;
}

// La paire en cours d'un colis special, ou null.
function paireDuColis(colisId) {
  return (
    db
      .prepare(`SELECT * FROM paires_special p WHERE p.colis_id = ? AND ${EN_COURS_SQL} ORDER BY id DESC`)
      .get(colisId) || null
  );
}

/**
 * Un PDF vient d'entrer dans special : il complete le plus ancien code seul du
 * meme expediteur, ou ouvre une paire en attendant le sien.
 * @returns {{ paire, completee: boolean }}
 */
function apparieColis(colisId, senderName) {
  const deja = paireDuColis(colisId);
  if (deja) return { paire: deja, completee: false };

  const attente = db
    .prepare(
      `SELECT * FROM paires_special p
       WHERE p.colis_id IS NULL AND p.seul = 0 AND p.sender_name IS ? AND ${EN_COURS_SQL}
       ORDER BY id LIMIT 1`
    )
    .get(senderName || null);

  if (attente) {
    db.prepare("UPDATE paires_special SET colis_id = ? WHERE id = ?").run(colisId, attente.id);
    return { paire: getPaire(attente.id), completee: true };
  }

  const info = db
    .prepare("INSERT INTO paires_special (numero, sender_name, colis_id) VALUES (?, ?, ?)")
    .run(numeroLibre(), senderName || null, colisId);
  return { paire: getPaire(info.lastInsertRowid), completee: false };
}

/**
 * Un code-barre vient d'entrer dans special : il rejoint le plus ancien PDF
 * sans code du meme expediteur, ou ouvre une paire en attendant le sien.
 * @returns {{ paire, completee: boolean }}
 */
function apparieCode(fileId, senderName, fileKind = "image") {
  const attente = db
    .prepare(
      `SELECT * FROM paires_special p
       WHERE p.code_file_id IS NULL AND p.colis_id IS NOT NULL AND p.sender_name IS ? AND ${EN_COURS_SQL}
       ORDER BY id LIMIT 1`
    )
    .get(senderName || null);

  if (attente) {
    db.prepare("UPDATE paires_special SET code_file_id = ?, code_file_kind = ? WHERE id = ?").run(
      fileId,
      fileKind,
      attente.id
    );
    return { paire: getPaire(attente.id), completee: true };
  }

  const info = db
    .prepare("INSERT INTO paires_special (numero, sender_name, code_file_id, code_file_kind) VALUES (?, ?, ?, ?)")
    .run(numeroLibre(), senderName || null, fileId, fileKind);
  return { paire: getPaire(info.lastInsertRowid), completee: false };
}

// Le message du code republie par le bot : pour mettre a jour son bouton
// quand son PDF arrive.
function setCodeMessage(paireId, chatId, messageId) {
  db.prepare("UPDATE paires_special SET code_chat_id = ?, code_message_id = ? WHERE id = ?").run(
    chatId,
    messageId,
    paireId
  );
}

// Un code republie qui echoue ne doit pas garder un numero pour rien.
function oublieCode(paireId) {
  const paire = getPaire(paireId);
  if (!paire) return;
  if (paire.colis_id) {
    db.prepare("UPDATE paires_special SET code_file_id = NULL WHERE id = ?").run(paireId);
  } else {
    db.prepare("DELETE FROM paires_special WHERE id = ?").run(paireId);
  }
}

// Numero et etat du code pour une liste de colis, en une requete : le site
// l'affiche sur chaque ligne de la categorie Speciaux.
function numerosDesColis(ids) {
  if (!ids.length) return new Map();
  const lignes = db
    .prepare(
      `SELECT p.colis_id, p.numero, p.code_file_id IS NOT NULL AS code
       FROM paires_special p
       WHERE p.colis_id IN (${ids.map(() => "?").join(",")}) AND ${EN_COURS_SQL}`
    )
    .all(...ids);
  return new Map(lignes.map((l) => [l.colis_id, { numero: l.numero, code: Boolean(l.code) }]));
}

// --- Retrouver, relier, retirer -------------------------------------------------

function paireParNumero(numero) {
  return (
    db
      .prepare(`SELECT * FROM paires_special p WHERE p.numero = ? AND ${EN_COURS_SQL} ORDER BY id DESC`)
      .get(numero) || null
  );
}

// La paire dont ce message est le code (le code republie par le bot, ou
// l'original quand le bot n'a pas pu l'effacer).
function paireDuCode(chatId, messageId) {
  return (
    db
      .prepare(
        `SELECT * FROM paires_special p
         WHERE p.code_chat_id = ? AND p.code_message_id = ? AND ${EN_COURS_SQL} ORDER BY id DESC`
      )
      .get(chatId, messageId) || null
  );
}

const PLACE_CODE = ["code_file_id", "code_file_kind", "code_chat_id", "code_message_id"];

function codeDe(paire) {
  if (!paire.code_file_id) return null;
  return {
    role: "code",
    paireId: paire.id,
    fileId: paire.code_file_id,
    fileKind: paire.code_file_kind || "image",
    chatId: paire.code_chat_id,
    messageId: paire.code_message_id,
    sender: paire.sender_name,
  };
}

function colisDe(paire) {
  const colis = paire.colis_id ? getColisById(paire.colis_id) : null;
  if (!colis) return null;
  return {
    role: "colis",
    paireId: paire.id,
    colisId: colis.id,
    fileId: colis.file_id,
    fileKind: colis.file_kind,
    fileName: colis.file_name,
    caption: colis.caption,
    chatId: colis.chat_id,
    messageId: colis.message_id,
    sender: colis.sender_name,
  };
}

function videPlace(paireId, role) {
  if (role === "code") {
    db.prepare(`UPDATE paires_special SET ${PLACE_CODE.map((c) => `${c} = NULL`).join(", ")} WHERE id = ?`).run(
      paireId
    );
  } else {
    db.prepare("UPDATE paires_special SET colis_id = NULL WHERE id = ?").run(paireId);
  }
}

// Un element qui change de role change de nature : un code devenu colis entre
// dans les comptes (prix, drop, impression), un colis devenu code en sort --
// le fichier, lui, reste ou il est.
function enRole(element, role) {
  if (role === "code") {
    if (element.role === "colis") deleteColis(element.colisId);
    return {
      code_file_id: element.fileId,
      code_file_kind: element.fileKind || "image",
      code_chat_id: element.chatId,
      code_message_id: element.messageId,
    };
  }
  if (element.role === "colis") return { colis_id: element.colisId };
  const colis = addColis(element.sender || "Inconnu", {
    chatId: element.chatId,
    messageId: element.messageId,
    type: "special",
    fileName: element.fileName || null,
    caption: element.caption || null,
    fileId: element.fileId,
    fileKind: element.fileKind,
  });
  return { colis_id: colis.id };
}

function remplitPlace(paireId, valeurs) {
  const cles = Object.keys(valeurs);
  db.prepare(`UPDATE paires_special SET ${cles.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(
    ...cles.map((c) => valeurs[c]),
    paireId
  );
}

function supprimeSiVide(paireId) {
  db.prepare("DELETE FROM paires_special WHERE id = ? AND colis_id IS NULL AND code_file_id IS NULL").run(paireId);
}

/**
 * /special image N (role "code") ou /special pdf N (role "colis") : place un
 * fichier dans la paire N, quel qu'il soit -- code, colis, ou fichier que le
 * bot ne suivait pas.
 *
 * Ce qui occupait deja cette place n'est pas perdu :
 *   - meme paire, roles inverses (le code etait en fait le colis) : les deux
 *     echangent leurs roles ;
 *   - le fichier venait d'une autre paire, a la meme place : les deux
 *     echangent leurs paires -- c'est la correction de deux codes croises ;
 *   - sinon l'occupant garde une paire a lui, avec son propre numero, pour
 *     etre relie plus tard.
 *
 * @param {object} element { role: "code"|"colis"|null, paireId, colisId,
 *   fileId, fileKind, fileName, caption, chatId, messageId, sender }
 * @returns {{ cible, deja?, deloge?: { numero, role } }}
 */
function relie(numero, role, element) {
  const cible = paireParNumero(numero);
  if (!cible) throw new Error(`Aucune paire #${numero} en cours.`);

  const source = element.paireId ? getPaire(element.paireId) : null;
  if (source && source.id === cible.id && element.role === role) {
    // deja relie ainsi -- mais confirme a la main : le re-appairage n'y
    // touchera plus
    db.prepare("UPDATE paires_special SET manuel = 1 WHERE id = ?").run(cible.id);
    return { cible: getPaire(cible.id), deja: true };
  }

  const occupant = role === "code" ? codeDe(cible) : colisDe(cible);
  if (source && element.role) videPlace(source.id, element.role);
  if (occupant) videPlace(cible.id, role);

  remplitPlace(cible.id, enRole(element, role));

  let deloge = null;
  if (occupant) {
    if (source && source.id === cible.id) {
      // les roles etaient inverses : l'occupant prend celui que l'element quitte
      remplitPlace(cible.id, enRole(occupant, element.role));
      deloge = { numero: cible.numero, role: element.role };
    } else if (source && element.role === role) {
      remplitPlace(source.id, enRole(occupant, role));
      deloge = { numero: source.numero, role };
    } else {
      const info = db
        .prepare("INSERT INTO paires_special (numero, sender_name) VALUES (?, ?)")
        .run(numeroLibre(), occupant.sender || cible.sender_name);
      remplitPlace(info.lastInsertRowid, enRole(occupant, role));
      deloge = { numero: getPaire(info.lastInsertRowid).numero, role };
    }
  }

  // relie a la main : le re-appairage automatique n'y touchera plus. Une paire
  // qui recoit un colis n'est plus un code seul.
  db.prepare(
    `UPDATE paires_special SET manuel = 1, seul = CASE WHEN colis_id IS NULL THEN seul ELSE 0 END WHERE id = ?`
  ).run(cible.id);
  if (deloge && source && deloge.numero === source.numero && source.id !== cible.id) {
    db.prepare("UPDATE paires_special SET manuel = 1 WHERE id = ?").run(source.id);
  }

  if (source && source.id !== cible.id) supprimeSiVide(source.id);
  return { cible: getPaire(cible.id), deloge };
}

// --- Codes seuls et re-appairage ---------------------------------------------------
// Il arrive qu'une image de special n'aille avec aucun PDF. L'appairage, qui
// suit l'ordre d'arrivee, lui donne pourtant le PDF suivant -- et decale d'un
// cran toutes les paires d'apres : codes A, X, B, C puis PDF a, b, c donnent
// A-a, X-b, B-c, et C reste seul.

/**
 * Remet dans l'ordre d'arrivee les paires d'un client. Ce sont les CODES qui
 * changent de paire : chaque PDF garde la sienne, donc son numero -- il est
 * peut-etre deja imprime sur l'etiquette. Les paires reliees a la main et les
 * codes seuls ne bougent pas.
 * @returns {number[]} les paires dont le code a change
 */
function reapparie(sender) {
  const paires = db
    .prepare(
      `SELECT p.*, c.message_id AS colis_message FROM paires_special p
       LEFT JOIN colis c ON c.id = p.colis_id
       WHERE p.sender_name IS ? AND p.seul = 0 AND p.manuel = 0 AND ${EN_COURS_SQL}`
    )
    .all(sender || null);
  if (paires.length === 0) return [];

  // l'ordre d'arrivee, c'est l'ordre des messages dans le groupe
  const parArrivee = (msgA, msgB, idA, idB) => (msgA ?? 0) - (msgB ?? 0) || idA - idB;
  const avecColis = paires
    .filter((p) => p.colis_id)
    .sort((a, b) => parArrivee(a.colis_message, b.colis_message, a.id, b.id));
  const sansColis = paires.filter((p) => !p.colis_id).sort((a, b) => a.id - b.id);
  const codes = paires
    .filter((p) => p.code_file_id)
    .sort((a, b) => parArrivee(a.code_message_id, b.code_message_id, a.id, b.id))
    .map((p) => ({
      code_file_id: p.code_file_id,
      code_file_kind: p.code_file_kind,
      code_chat_id: p.code_chat_id,
      code_message_id: p.code_message_id,
    }));

  const avant = new Map(paires.map((p) => [p.id, p.code_message_id || null]));
  for (const p of paires) videPlace(p.id, "code");

  // le i-eme code va au i-eme PDF ; ceux qui restent reprennent, dans l'ordre,
  // les paires qui n'avaient que leur code
  const libres = [...sansColis];
  const nouvelles = [];
  codes.forEach((code, i) => {
    let cible = i < avecColis.length ? avecColis[i].id : libres.shift()?.id;
    if (!cible) {
      cible = db
        .prepare("INSERT INTO paires_special (numero, sender_name) VALUES (?, ?)")
        .run(numeroLibre(), sender || null).lastInsertRowid;
      nouvelles.push(cible);
    }
    remplitPlace(cible, code);
  });

  const touchees = [...nouvelles];
  for (const p of paires) {
    supprimeSiVide(p.id);
    const apres = getPaire(p.id);
    if (apres && (apres.code_message_id || null) !== avant.get(p.id)) touchees.push(p.id);
  }
  return touchees;
}

/**
 * /special seul : ce fichier est un code qui n'attend aucun PDF. Il quitte sa
 * paire, les paires de son client se remettent dans l'ordre (c'est lui qui
 * les avait decalees), puis il prend un numero a lui.
 * @param {object} element meme forme que pour relie()
 * @returns {{ paire, touchees: number[], deja?: boolean }}
 */
function rendSeul(element) {
  const source = element.paireId ? getPaire(element.paireId) : null;
  if (source && element.role === "code") {
    if (source.seul) return { paire: source, touchees: [], deja: true };
    // un code qui n'avait pas encore de PDF n'a rien decale : il garde son
    // numero, il ne recevra simplement jamais de PDF
    if (!source.colis_id) {
      db.prepare("UPDATE paires_special SET seul = 1 WHERE id = ?").run(source.id);
      return { paire: getPaire(source.id), touchees: [] };
    }
  }

  const sender = element.sender ?? source?.sender_name ?? null;
  const touchees = new Set();
  if (source && element.role) {
    videPlace(source.id, element.role);
    touchees.add(source.id);
  }
  // un colis (une image prise pour un colis) devient un code
  const code = enRole(element, "code");
  if (source) supprimeSiVide(source.id);

  for (const id of reapparie(sender)) touchees.add(id);

  // le numero apres le re-appairage : celui qu'il a libere est repris
  const info = db
    .prepare("INSERT INTO paires_special (numero, sender_name, seul) VALUES (?, ?, 1)")
    .run(numeroLibre(), sender);
  remplitPlace(info.lastInsertRowid, code);

  return { paire: getPaire(info.lastInsertRowid), touchees: [...touchees].filter((id) => getPaire(id)) };
}

// "Fait" dans le mode locker, pour un code seul : il n'y a pas de colis a
// droper, la paire s'en va simplement.
function finiSeul(paireId) {
  const paire = getPaire(paireId);
  if (!paire || !paire.seul) return null;
  db.prepare("DELETE FROM paires_special WHERE id = ?").run(paireId);
  return paire;
}

// /del ou /clear sur un code : il sort de sa paire. Le colis, s'il y en a un,
// repasse "code en attente".
function retireCode(paireId) {
  videPlace(paireId, "code");
  supprimeSiVide(paireId);
  return getPaire(paireId);
}

// Toutes les paires en cours, dans l'ordre des numeros : c'est la liste du
// mode locker. Une paire peut etre incomplete -- un PDF dont le code n'est pas
// arrive, un code dont le PDF manque -- et doit se voir comme telle.
function listePaires() {
  return db
    .prepare(
      `SELECT p.id, p.numero, p.sender_name, p.code_file_id IS NOT NULL AS code, p.code_file_kind, p.seul,
              c.id AS colis_id, c.file_name, c.note, c.printed_at, c.price
       FROM paires_special p
       LEFT JOIN colis c ON c.id = p.colis_id
       WHERE ${EN_COURS_SQL}
       ORDER BY p.numero`
    )
    .all()
    .map((l) => ({ ...l, code: Boolean(l.code), seul: Boolean(l.seul) }));
}

module.exports = {
  roleSpecial,
  rendSeul,
  reapparie,
  finiSeul,
  paireParNumero,
  paireDuCode,
  relie,
  retireCode,
  listePaires,
  apparieColis,
  apparieCode,
  paireDuColis,
  getPaire,
  setCodeMessage,
  oublieCode,
  numerosDesColis,
};
