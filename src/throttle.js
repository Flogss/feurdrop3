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

/**
 * Cree une file d'ecritures serialisees.
 * @param {object} options
 * @param {number} options.intervalMs ecart minimum entre deux appels
 * @param {number} options.retries nombre de 429 tolerees avant d'abandonner
 * @param {number} options.envoisParMinute plafond des envois (0 : pas de plafond)
 * @param {number} options.fenetreMs duree de la fenetre glissante (une minute)
 * @param {(secondes: number) => void} options.onWait appele avant chaque pause 429
 */
function createWriteQueue({
  intervalMs = 1100,
  retries = 5,
  envoisParMinute = 0,
  fenetreMs = 60000,
  onWait = null,
} = {}) {
  let derniere = 0;
  let chaine = Promise.resolve();

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

  function enqueue(action, { envoi = false } = {}) {
    const resultat = chaine.then(async () => {
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
          // une erreur qui n'est pas un 429 ne se resout pas en attendant
          if (secondes === null || essai >= retries) throw err;
          if (onWait) onWait(secondes);
          await sleep(secondes * 1000 + Math.min(250, intervalMs));
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
