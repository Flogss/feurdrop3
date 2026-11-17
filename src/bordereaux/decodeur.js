const path = require("path");
const { Worker } = require("worker_threads");

// Le thread du lecteur de codes : demarre a la premiere image, une image a la
// fois, arrete apres un moment sans travail (la memoire du WebAssembly ne
// redescend qu'a l'arret du thread ; le serveur tourne avec peu de memoire).

const INACTIF_MS = Number(process.env.BORDEREAUX_DECODEUR_INACTIF_MS || 20000);
const DELAI_MS = 60000;

// le lecteur lui-meme a cale (trop long, arrete) -- pas le fichier
class ErreurLecteur extends Error {}

let thread = null;
let pret = null;
let prochainId = 1;
const enCours = new Map(); // id -> { resolve, reject, minuteur }
let file = Promise.resolve();
let minuteurArret = null;

function arrete() {
  clearTimeout(minuteurArret);
  minuteurArret = null;
  const t = thread;
  thread = null;
  pret = null;
  for (const { reject, minuteur } of enCours.values()) {
    clearTimeout(minuteur);
    reject(new ErreurLecteur("lecteur de codes arrêté"));
  }
  enCours.clear();
  if (t) t.terminate().catch(() => {});
}

function demarre() {
  if (pret) return pret;
  const t = new Worker(path.join(__dirname, "decodeur-worker.mjs"));
  thread = t;
  pret = new Promise((resolve, reject) => {
    t.once("error", reject);
    t.on("message", (m) => {
      if (m.pret) return resolve(t);
      const attente = enCours.get(m.id);
      if (!attente) return;
      enCours.delete(m.id);
      clearTimeout(attente.minuteur);
      if (m.erreur) attente.reject(new Error(m.erreur));
      else attente.resolve(m.resultats);
    });
  });
  t.on("error", (err) => {
    console.error("[bordereaux] lecteur de codes :", err.message);
    if (thread === t) arrete();
  });
  t.on("exit", () => {
    if (thread === t) arrete();
  });
  return pret;
}

function planifieArret() {
  clearTimeout(minuteurArret);
  // au repos, le thread ne retient pas le processus (il le retient pendant
  // une lecture : voir lisCodes)
  if (thread && enCours.size === 0) thread.unref();
  minuteurArret = setTimeout(() => {
    if (enCours.size === 0) arrete();
  }, INACTIF_MS);
  minuteurArret.unref?.();
}

/**
 * Les codes d'une image (PGM, PNG ou JPEG, en octets). Une image a la fois :
 * la suivante attend la fin de la precedente.
 * -> [{ format, valide, texte, erreur, position, orientation, typeContenu }]
 */
function lisCodes(octets) {
  const tache = file.then(async () => {
    clearTimeout(minuteurArret);
    const t = await demarre();
    const id = prochainId++;
    const copie = new Uint8Array(octets); // transferee au thread
    return new Promise((resolve, reject) => {
      const minuteur = setTimeout(() => {
        enCours.delete(id);
        reject(new ErreurLecteur("lecture des codes trop longue"));
        // un thread bloque : on le remplace
        arrete();
      }, DELAI_MS);
      enCours.set(id, { resolve, reject, minuteur });
      t.ref();
      t.postMessage({ id, octets: copie }, [copie.buffer]);
    });
  });
  file = tache.catch(() => {}).finally(planifieArret);
  return tache;
}

const actif = () => thread !== null;

module.exports = { lisCodes, arrete, actif, ErreurLecteur };
