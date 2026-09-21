// Cadence des ecritures vers Telegram.
//
// Telegram compte ce qu'un bot ecrit dans un meme groupe et repond 429 des
// qu'on va trop vite : dix etiquettes laches d'un coup suffisent, et les
// fichiers refuses sont perdus. Toutes les ecritures vers le groupe passent
// donc par ici -- une a la fois, espacees -- et quand Telegram demande malgre
// tout d'attendre, on attend exactement le temps qu'il indique plutot que
// d'abandonner le fichier.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Telegram met le delai dans les parametres de la reponse ; le message texte
// le repete ("retry after 5"), ce qui sert de filet si la forme change.
function delaiDemande(err) {
  const param = err?.response?.body?.parameters?.retry_after;
  if (Number.isFinite(param)) return param;
  const trouve = /retry after (\d+)/i.exec(err?.message || "");
  return trouve ? Number(trouve[1]) : null;
}

/**
 * Cree une file d'ecritures serialisees.
 * @param {object} options
 * @param {number} options.intervalMs ecart minimum entre deux appels
 * @param {number} options.retries nombre de 429 tolerees avant d'abandonner
 * @param {(secondes: number) => void} options.onWait appele avant chaque pause 429
 */
function createWriteQueue({ intervalMs = 1100, retries = 5, onWait = null } = {}) {
  let derniere = 0;
  let chaine = Promise.resolve();

  function enqueue(action) {
    const resultat = chaine.then(async () => {
      for (let essai = 0; ; essai++) {
        const attente = derniere + intervalMs - Date.now();
        if (attente > 0) await sleep(attente);
        try {
          const sortie = await action();
          derniere = Date.now();
          return sortie;
        } catch (err) {
          const secondes = delaiDemande(err);
          derniere = Date.now();
          // une erreur qui n'est pas un 429 ne se resout pas en attendant
          if (secondes === null || essai >= retries) throw err;
          if (onWait) onWait(secondes);
          await sleep(secondes * 1000 + 250);
        }
      }
    });
    // une ecriture ratee ne doit pas bloquer les suivantes
    chaine = resultat.then(
      () => {},
      () => {}
    );
    return resultat;
  }

  return enqueue;
}

module.exports = { createWriteQueue, delaiDemande };
