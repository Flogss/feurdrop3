import { sleep } from './util.js';

const BASE = 'https://api.laposte.fr/suivi/v2';

export class OkapiError extends Error {
  constructor(message, { status, body, fatal = false } = {}) {
    super(message);
    this.name = 'OkapiError';
    this.status = status;
    this.body = body;
    this.fatal = fatal; // fatal => inutile d'insister sur les autres colis
  }
}

/**
 * Client pour l'API Suivi v2 de La Poste (plateforme Okapi).
 * Doc : https://developer.laposte.fr/products/suivi/latest
 */
export class OkapiClient {
  constructor(apiKey, { maxRetries = 4, timeoutMs = 20_000 } = {}) {
    if (!apiKey) throw new OkapiError('Clé Okapi manquante (OKAPI_KEY).', { fatal: true });
    this.apiKey = apiKey;
    this.maxRetries = maxRetries;
    // la clé a-t-elle déjà répondu une fois ? voir le traitement des 401
    this.everWorked = false;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Suit un colis. Un seul numéro par appel : la syntaxe multi-numéros de l'API
   * (jusqu'à 10 séparés par des virgules) est réputée peu fiable — plusieurs
   * intégrateurs constatent que seul le 1er colis est renvoyé. On parallélise
   * plutôt des appels unitaires (voir poll.js), c'est l'approche robuste.
   *
   * @returns {{httpStatus:number, returnCode:number|null, idShip:string, shipment:object|null, raw:object}}
   */
  async track(idShip, lang = 'fr_FR') {
    const url = `${BASE}/idships/${encodeURIComponent(idShip)}?lang=${encodeURIComponent(lang)}`;
    let lastErr;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = lastErr?.retryAfterMs ?? Math.min(2 ** attempt * 700, 20_000) + Math.random() * 400;
        await sleep(wait);
      }

      let res;
      try {
        res = await fetch(url, {
          headers: { Accept: 'application/json', 'X-Okapi-Key': this.apiKey },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastErr = new OkapiError(`Réseau : ${e.message}`);
        continue; // erreur réseau => on réessaie
      }

      const text = await res.text();
      const body = text ? safeJson(text) : null;

      // 401/403 : deux causes très différentes derrière le même code.
      //
      // Clé réellement mauvaise : ça échoue dès le premier appel. Mais La Poste
      // renvoie AUSSI 401 quand on a tapé trop vite — et pas seulement sur
      // l'appel fautif : la clé reste refusée plusieurs minutes ensuite. Une
      // clé qui a déjà répondu 200 n'est donc pas devenue invalide, elle est
      // au piquet. La traiter comme morte arrêtait tout le lot en accusant à
      // tort la clé.
      // 403 : la clé est connue mais l'appel est interdit. En pratique c'est
      // presque toujours une restriction d'adresse IP configurée sur
      // l'application dans la console La Poste. Insister n'y changera rien,
      // mais le message doit dire où regarder.
      if (res.status === 403) {
        throw new OkapiError(
          "Appel interdit (HTTP 403) : l'application La Poste restreint sans doute les adresses IP autorisées. " +
            'Retire la restriction dans la console (une machine hébergée change d\'IP sans prévenir).',
          { status: res.status, body, fatal: true },
        );
      }

      // 401 : soit la clé est mauvaise, soit on a tapé trop vite. La Poste
      // renvoie le même code dans les deux cas, et pas seulement sur l'appel
      // fautif : la clé reste refusée plusieurs minutes ensuite. Une clé qui a
      // déjà répondu 200 n'est donc pas devenue invalide, elle est au piquet.
      // La traiter comme morte arrêtait tout le lot en accusant à tort la clé.
      if (res.status === 401) {
        if (!this.everWorked) {
          throw new OkapiError('Clé Okapi refusée (HTTP 401) — vérifie/régénère OKAPI_KEY.', {
            status: res.status,
            body,
            fatal: true,
          });
        }
        lastErr = new OkapiError(
          "Trop d'appels : La Poste met la clé au piquet (HTTP 401). Reprise automatique.",
          { status: res.status, body },
        );
        lastErr.retryAfterMs = Math.min(2 ** attempt * 5_000, 60_000) + Math.random() * 2_000;
        continue;
      }

      // 429 : quota (100 appels/min en offre gratuite). On respecte Retry-After.
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        lastErr = new OkapiError('Quota atteint (429, 100 appels/min).', { status: 429, body });
        lastErr.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3_000 + Math.random() * 2_000;
        continue;
      }

      if (res.status >= 500) {
        lastErr = new OkapiError(`Serveur La Poste indisponible (HTTP ${res.status}).`, { status: res.status, body });
        continue;
      }

      // 200 (OK), 207 (multi-statut) et 404 (numéro inconnu) portent un corps exploitable.
      // À partir d'ici la clé a fait ses preuves : un 401 plus tard ne pourra
      // plus lui être imputé.
      this.everWorked = true;
      const shipment = body?.shipment ?? null;
      const returnCode = body?.returnCode ?? body?.shipment?.returnCode ?? (res.ok ? 200 : res.status);

      return {
        httpStatus: res.status,
        returnCode,
        idShip: body?.idShip ?? shipment?.idShip ?? idShip,
        shipment,
        raw: body,
      };
    }

    throw lastErr ?? new OkapiError('Échec après plusieurs tentatives.');
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
