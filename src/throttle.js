// Cadence des ecritures vers Telegram.
//
// Telegram compte ce qu'un bot ecrit dans un meme groupe et repond 429 des
// qu'on va trop vite : dix etiquettes laches d'un coup suffisent, et les
// fichiers refuses sont perdus. Toutes les ecritures vers le groupe passent
// donc par ici -- une a la fois, espacees -- et quand Telegram demande malgre
// tout d'attendre, on attend exactement le temps qu'il indique plutot que
// d'abandonner le fichier.
//
// Les ENVOIS (un nouveau message dans le groupe) ont en plus leur propre
// plafond : Telegram en accepte 20 par minute et par groupe. Plutot que de
// foncer jusqu'au refus -- et a une penalite qui s'allonge si on insiste -- on
// tient le compte sur une minute glissante : jamais plus de 20 envois dans les
// 60 dernieres secondes. Les editions et suppressions n'y entrent pas.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Telegram met le delai dans les parametres de la reponse ; le message texte
// le repete ("retry after 5"), ce qui sert de filet si la forme change.
function delaiDemande(err) {
  const param = err?.response?.body?.parameters?.retry_after;
  if (Number.isFinite(param)) return param;
  const trouve = /retry after (\d+(?:\.\d+)?)/i.exec(err?.message || "");
  return trouve ? Number(trouve[1]) : null;
}

// Une erreur passagere : Telegram indisponible un instant (502, 503, 504,
// 500) ou le reseau coupe (connexion reinitialisee, delai depasse, DNS).
// Elle se resout en reessayant -- contrairement a un 400 (message introuvable,
// requete invalide) ou un 403 (bot retire du groupe).
function erreurPassagere(err) {
  const code = err?.response?.statusCode ?? err?.response?.status;
  if (code >= 500 && code < 600) return true;
  const texte = `${err?.code || ""} ${err?.message || ""}`;
  return /EFATAL|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|fetch failed|Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error/i.test(
    texte
  );
}

// Le delai avant de reessayer une erreur passagere : 1 s, 2 s, 4 s, 8 s, 15 s
// (THROTTLE_ATTENTES_MS="10,20,40" pour les tests).
const ATTENTES_PASSAGERES = (process.env.THROTTLE_ATTENTES_MS || "1000,2000,4000,8000,15000")
  .split(",")
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);

/**
 * Cree une file d'ecritures serialisees.
 * @param {object} options
 * @param {number} options.intervalMs ecart minimum entre deux appels
 * @param {number} options.retries nombre de 429 tolerees avant d'abandonner (Telegram
 *   dit combien attendre : on attend, et on ne lache qu'apres beaucoup d'essais)
 * @param {number} options.envoisParMinute plafond des envois (0 : pas de plafond)
 * @param {number} options.fenetreMs duree de la fenetre glissante (une minute)
 * @param {(secondes: number) => void} options.onWait appele avant chaque pause 429
 */
function createWriteQueue({
  intervalMs = 1100,
  retries = 12,
  envoisParMinute = 0,
  fenetreMs = 60000,
  onWait = null,
} = {}) {
  let derniere = 0;

  // horodatage des derniers envois, sur une minute glissante
  const envois = [];

  async function attendsCreneau() {
    if (!envoisParMinute) return;
    for (;;) {
      const maintenant = Date.now();
      while (envois.length && maintenant - envois[0] >= fenetreMs) envois.shift();
      if (envois.length < envoisParMinute) {
        envois.push(maintenant);
        return;
      }
      // le plus ancien sort de la minute : un creneau se libere
      await sleep(fenetreMs - (maintenant - envois[0]) + 20);
    }
  }

  // Deux voies. La voie normale passe dans l'ordre d'arrivee ; la voie basse
  // (remettre "Drope" sous cinquante fichiers apres un drop groupe sur le
  // site) n'avance que quand la normale est vide. Un fichier envoye pendant
  // ce temps passe donc devant, au lieu d'attendre derriere cinquante
  // editions de boutons.
  const normales = [];
  const basses = [];
  let enCours = false;

  async function execute({ action, envoi }) {
    let passageres = 0;
    for (let essai = 0; ; essai++) {
      if (envoi) await attendsCreneau();
      const attente = derniere + intervalMs - Date.now();
      if (attente > 0) await sleep(attente);
      try {
        const sortie = await action();
        derniere = Date.now();
        return sortie;
      } catch (err) {
        const secondes = delaiDemande(err);
        derniere = Date.now();
        if (secondes !== null) {
          // 429 : Telegram dit combien attendre ; on attend, plusieurs fois
          // s'il le faut (une rafale de 429 de 25 a 40 s arrive vraiment)
          if (essai >= retries) throw err;
          if (onWait) onWait(secondes);
          await sleep(secondes * 1000 + Math.min(250, intervalMs));
          continue;
        }
        // 502, coupure reseau : on reessaie un peu plus tard. Le reste (400,
        // 403...) ne se resout pas en attendant.
        if (!erreurPassagere(err) || passageres >= ATTENTES_PASSAGERES.length) throw err;
        if (onWait) onWait(ATTENTES_PASSAGERES[passageres] / 1000, err);
        await sleep(ATTENTES_PASSAGERES[passageres]);
        passageres += 1;
      }
    }
  }

  async function pompe() {
    if (enCours) return;
    enCours = true;
    while (normales.length || basses.length) {
      const tache = normales.shift() || basses.shift();
      try {
        tache.resolve(await execute(tache));
      } catch (err) {
        // une ecriture ratee ne bloque pas les suivantes
        tache.reject(err);
      }
    }
    enCours = false;
  }

  function enqueue(action, { envoi = false, priorite = "normale" } = {}) {
    return new Promise((resolve, reject) => {
      (priorite === "basse" ? basses : normales).push({ action, envoi, resolve, reject });
      pompe();
    });
  }

  return enqueue;
}

// Reessaie une lecture (telechargement d'un fichier...) sur un 429 ou une
// erreur passagere, avec les memes attentes que la file.
async function avecReessais(action, { essais = 5 } = {}) {
  let passageres = 0;
  for (let essai = 0; ; essai++) {
    try {
      return await action();
    } catch (err) {
      const secondes = delaiDemande(err);
      if (secondes !== null && essai < essais) {
        await sleep(secondes * 1000 + 200);
        continue;
      }
      if (!erreurPassagere(err) || passageres >= Math.min(essais, ATTENTES_PASSAGERES.length)) throw err;
      await sleep(ATTENTES_PASSAGERES[passageres]);
      passageres += 1;
    }
  }
}

module.exports = { createWriteQueue, delaiDemande, erreurPassagere, avecReessais };
