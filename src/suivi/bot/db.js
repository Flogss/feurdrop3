import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const H = 3_600_000;
const D = 24 * H;

/**
 * Cadence de vérification selon l'âge du colis, pour garder le volume d'appels bas :
 * on interroge souvent au début, de plus en plus rarement ensuite, et on
 * abandonne au bout de 30 jours. Un colis « final » (livré/retourné) n'est plus jamais requêté.
 */
export function intervalMs(addedAtIso, now = Date.now()) {
  const age = now - Date.parse(addedAtIso);
  if (age < 1 * D) return 8 * H;
  if (age < 5 * D) return 6 * H;
  if (age < 15 * D) return 12 * H;
  return 24 * H;
}
export const EXPIRE_MS = 30 * D;
const FIRST_CHECK_DELAY = 4 * H; // laisser le temps à La Poste d'enregistrer la prise en charge

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parcels (
  tracking_number TEXT PRIMARY KEY,
  label           TEXT,
  added_at        TEXT NOT NULL,
  milestone       TEXT NOT NULL DEFAULT 'pending',
  last_label      TEXT,
  last_code       TEXT,
  last_event_at   TEXT,
  delivery_date   TEXT,
  is_final        INTEGER NOT NULL DEFAULT 0,
  check_count     INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  next_check_at   TEXT NOT NULL,
  notified_at     TEXT,
  last_error      TEXT,
  raw             TEXT
);
CREATE INDEX IF NOT EXISTS idx_due ON parcels(is_final, next_check_at);
`;

export class DB {
  constructor(file = 'data/suivi.db') {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  /** Ajoute un colis (ignore s'il existe déjà). @returns true si inséré. */
  add(trackingNumber, label = null, now = Date.now()) {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO parcels (tracking_number, label, added_at, next_check_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(trackingNumber, label, new Date(now).toISOString(), new Date(now + FIRST_CHECK_DELAY).toISOString());
    return info.changes > 0;
  }

  get(trackingNumber) {
    return this.db.prepare('SELECT * FROM parcels WHERE tracking_number = ?').get(trackingNumber) ?? null;
  }

  /** Colis à vérifier maintenant (non finaux et dont l'échéance est passée). */
  due(now = Date.now(), limit = 100_000) {
    return this.db
      .prepare(
        `SELECT * FROM parcels
         WHERE is_final = 0 AND next_check_at <= ?
         ORDER BY next_check_at ASC
         LIMIT ?`,
      )
      .all(new Date(now).toISOString(), limit);
  }

  /** Marque « expirés » les colis non finaux trop vieux. @returns nb de colis. */
  expireStale(now = Date.now()) {
    const cutoff = new Date(now - EXPIRE_MS).toISOString();
    return this.db
      .prepare(
        `UPDATE parcels SET is_final = 1, milestone = 'expired', last_checked_at = ?
         WHERE is_final = 0 AND added_at < ?`,
      )
      .run(new Date(now).toISOString(), cutoff).changes;
  }

  /** Enregistre le résultat d'une interrogation. */
  markResult(trackingNumber, status, raw, now = Date.now()) {
    const added = this.get(trackingNumber)?.added_at ?? new Date(now).toISOString();
    const next = new Date(now + intervalMs(added, now)).toISOString();
    this.db
      .prepare(
        `UPDATE parcels SET
           milestone = ?, last_label = ?, last_code = ?, last_event_at = ?, delivery_date = ?,
           is_final = ?, check_count = check_count + 1, last_checked_at = ?, next_check_at = ?,
           last_error = NULL, raw = ?
         WHERE tracking_number = ?`,
      )
      .run(
        status.milestone,
        status.lastLabel,
        status.lastCode,
        status.lastEventAt,
        status.deliveryDate,
        status.final ? 1 : 0,
        new Date(now).toISOString(),
        next,
        raw ? JSON.stringify(raw) : null,
        trackingNumber,
      );
  }

  /** Enregistre une erreur transitoire et replanifie une nouvelle tentative. */
  markError(trackingNumber, message, retryInMs = 6 * H, now = Date.now()) {
    this.db
      .prepare(
        `UPDATE parcels SET last_error = ?, last_checked_at = ?, next_check_at = ?
         WHERE tracking_number = ?`,
      )
      .run(String(message).slice(0, 300), new Date(now).toISOString(), new Date(now + retryInMs).toISOString(), trackingNumber);
  }

  markNotified(trackingNumber, now = Date.now()) {
    this.db
      .prepare('UPDATE parcels SET notified_at = ? WHERE tracking_number = ?')
      .run(new Date(now).toISOString(), trackingNumber);
  }

  list({ milestone } = {}) {
    if (milestone) {
      return this.db
        .prepare('SELECT * FROM parcels WHERE milestone = ? ORDER BY added_at DESC')
        .all(milestone);
    }
    return this.db.prepare('SELECT * FROM parcels ORDER BY added_at DESC').all();
  }

  stats() {
    return this.db
      .prepare('SELECT milestone, COUNT(*) AS n FROM parcels GROUP BY milestone ORDER BY n DESC')
      .all();
  }

  close() {
    this.db.close();
  }
}
