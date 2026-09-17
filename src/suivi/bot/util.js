import { readFile } from 'node:fs/promises';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Exécute `worker` sur chaque élément avec au plus `limit` tâches en vol.
 * Préserve l'ordre des résultats.
 */
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Espace les requêtes pour ne pas dépasser un débit (appels/minute).
 * Partagé entre workers concurrents : `next` est réservé de façon synchrone
 * avant tout await, donc N workers ne se marchent pas dessus.
 */
export class RateLimiter {
  constructor(maxPerMinute) {
    this.minInterval = maxPerMinute > 0 ? 60_000 / maxPerMinute : 0;
    this.next = 0;
  }
  async wait() {
    if (!this.minInterval) return;
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.minInterval;
    const delay = slot - now;
    if (delay > 0) await sleep(delay);
  }
}

/** Charge un .env minimal si les variables ne sont pas déjà présentes. */
export async function loadDotEnv(url = new URL('../.env', import.meta.url)) {
  try {
    const text = await readFile(url, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* pas de .env : on se rabat sur l'environnement */
  }
}

/** Formate une date ISO en JJ/MM/AAAA à HH:MM (heure locale). */
export function frDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} à ${p(d.getHours())}:${p(d.getMinutes())}`;
}
