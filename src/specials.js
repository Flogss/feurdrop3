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
const { db } = require("./db");

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
       WHERE p.colis_id IS NULL AND p.sender_name IS ? AND ${EN_COURS_SQL}
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
function apparieCode(fileId, senderName) {
  const attente = db
    .prepare(
      `SELECT * FROM paires_special p
       WHERE p.code_file_id IS NULL AND p.colis_id IS NOT NULL AND p.sender_name IS ? AND ${EN_COURS_SQL}
       ORDER BY id LIMIT 1`
    )
    .get(senderName || null);

  if (attente) {
    db.prepare("UPDATE paires_special SET code_file_id = ? WHERE id = ?").run(fileId, attente.id);
    return { paire: getPaire(attente.id), completee: true };
  }

  const info = db
    .prepare("INSERT INTO paires_special (numero, sender_name, code_file_id) VALUES (?, ?, ?)")
    .run(numeroLibre(), senderName || null, fileId);
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

module.exports = {
  apparieColis,
  apparieCode,
  paireDuColis,
  getPaire,
  setCodeMessage,
  oublieCode,
  numerosDesColis,
};
