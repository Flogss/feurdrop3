import { OkapiError } from './okapi.js';
import { interpret, MILESTONE_FR } from './status.js';
import { deliveredMessage } from './telegram.js';
import { mapPool, RateLimiter } from './util.js';

/**
 * Un passage complet : interroge les colis « dus », met à jour la base,
 * et envoie une notification Telegram pour chaque NOUVELLE livraison.
 *
 * @param {{db, client, telegram}} deps
 * @param {object} opts { maxPerMin, concurrency, dryRun, limit, onProgress }
 */
export async function pollOnce({ db, client, telegram }, opts = {}) {
  const { maxPerMin = 90, concurrency = 5, dryRun = false, limit = 100_000, onProgress } = opts;
  const now = Date.now();

  // Dry-run = aperçu en lecture seule : aucune écriture en base.
  const expired = dryRun ? 0 : db.expireStale(now);
  const due = db.due(now, limit);

  const limiter = new RateLimiter(maxPerMin);
  const summary = { due: due.length, expired, checked: 0, delivered: 0, notified: 0, errors: 0, notifications: [] };

  await mapPool(due, concurrency, async (parcel) => {
    await limiter.wait();
    try {
      const { shipment } = await client.track(parcel.tracking_number);
      const status = interpret(shipment);
      if (!dryRun) db.markResult(parcel.tracking_number, status, shipment, Date.now());

      if (status.delivered) {
        summary.delivered++;
        // Idempotence : on ne notifie qu'une fois, seulement si pas déjà fait.
        if (!parcel.notified_at) {
          const text = deliveredMessage(parcel, status);
          summary.notifications.push({ number: parcel.tracking_number, text });
          if (!dryRun && telegram?.enabled) {
            await telegram.send(text);
            db.markNotified(parcel.tracking_number, Date.now());
            summary.notified++;
          }
        }
      }
    } catch (e) {
      if (e instanceof OkapiError && e.fatal) throw e; // clé HS => on stoppe tout
      summary.errors++;
      if (!dryRun) db.markError(parcel.tracking_number, e.message, undefined, Date.now());
    } finally {
      summary.checked++;
      onProgress?.(summary);
    }
  });

  return summary;
}

export { MILESTONE_FR };
