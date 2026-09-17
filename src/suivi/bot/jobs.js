import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { interpret, rankOf } from './status.js';
import { mapPool } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  chat_id        TEXT NOT NULL,
  message_id     INTEGER,
  file_name      TEXT,
  total          INTEGER NOT NULL DEFAULT 0,
  invalid_count  INTEGER NOT NULL DEFAULT 0,
  duplicates     INTEGER NOT NULL DEFAULT 0,
  invalid_sample TEXT,
  checked        INTEGER NOT NULL DEFAULT 0,
  errors         INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'running',
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  error_message  TEXT
);
CREATE TABLE IF NOT EXISTS job_results (
  job_id          TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  milestone       TEXT NOT NULL,
  rank            INTEGER NOT NULL,
  found           INTEGER NOT NULL DEFAULT 1,
  last_label      TEXT,
  last_event_at   TEXT,
  event_ts        INTEGER,
  delivery_date   TEXT,
  PRIMARY KEY (job_id, tracking_number)
);
CREATE INDEX IF NOT EXISTS idx_results_sort ON job_results(job_id, found, rank, event_ts DESC);
`;

export const newJobId = () => randomBytes(4).toString('hex'); // 8 caractères : tient dans callback_data

export class JobStore {
  constructor(file = 'data/suivi.db') {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this._insert = this.db.prepare(
      `INSERT OR REPLACE INTO job_results
       (job_id, tracking_number, milestone, rank, found, last_label, last_event_at, event_ts, delivery_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  create({ id, chatId, fileName, total, invalidCount, duplicates, invalidSample }) {
    this.db
      .prepare(
        `INSERT INTO jobs (id, chat_id, file_name, total, invalid_count, duplicates, invalid_sample, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(chatId),
        fileName ?? null,
        total,
        invalidCount,
        duplicates,
        JSON.stringify((invalidSample ?? []).slice(0, 50)),
        new Date().toISOString(),
      );
    return id;
  }

  setMessageId(id, messageId) {
    this.db.prepare('UPDATE jobs SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  setProgress(id, checked, errors) {
    this.db.prepare('UPDATE jobs SET checked = ?, errors = ? WHERE id = ?').run(checked, errors, id);
  }

  finish(id, state, { errorMessage = null, checked, errors } = {}) {
    this.db
      .prepare(
        `UPDATE jobs SET state = ?, finished_at = ?, error_message = ?,
           checked = COALESCE(?, checked), errors = COALESCE(?, errors)
         WHERE id = ?`,
      )
      .run(state, new Date().toISOString(), errorMessage, checked ?? null, errors ?? null, id);
  }

  get(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  addResult(jobId, trackingNumber, status) {
    const ts = status.lastEventAt ? Date.parse(status.lastEventAt) : null;
    this._insert.run(
      jobId,
      trackingNumber,
      status.found ? status.milestone : 'not_found',
      status.found ? rankOf(status.milestone) : rankOf('not_found'),
      status.found ? 1 : 0,
      status.lastLabel ?? null,
      status.lastEventAt ?? null,
      Number.isFinite(ts) ? ts : null,
      status.deliveryDate ?? null,
    );
  }

  /** Compte par statut, dans l'ordre d'affichage. */
  countsByStatus(jobId, { found = 1 } = {}) {
    return this.db
      .prepare(
        `SELECT milestone, rank, COUNT(*) AS n FROM job_results
         WHERE job_id = ? AND found = ?
         GROUP BY milestone, rank ORDER BY rank ASC`,
      )
      .all(jobId, found);
  }

  countResults(jobId, { found = 1 } = {}) {
    return this.db
      .prepare('SELECT COUNT(*) AS n FROM job_results WHERE job_id = ? AND found = ?')
      .get(jobId, found).n;
  }

  /**
   * Page de résultats triés : par statut, puis de l'actualisation la plus récente
   * à la plus ancienne. Le tri utilise event_ts (millisecondes) et non la chaîne ISO,
   * car des fuseaux différents (+02:00 vs Z) ne se trient pas correctement en texte.
   */
  page(jobId, { found = 1, limit = 20, offset = 0 } = {}) {
    return this.db
      .prepare(
        `SELECT tracking_number, milestone, rank, last_label, last_event_at, event_ts, delivery_date
         FROM job_results
         WHERE job_id = ? AND found = ?
         ORDER BY rank ASC, (event_ts IS NULL) ASC, event_ts DESC, tracking_number ASC
         LIMIT ? OFFSET ?`,
      )
      .all(jobId, found, limit, offset);
  }

  /** Dernier job d'un chat (pour /export sur la dernière vérification). */
  latestJobForChat(chatId) {
    return (
      this.db
        .prepare('SELECT * FROM jobs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1')
        .get(String(chatId)) ?? null
    );
  }

  /** Toutes les lignes trouvées, avec event_ts, pour filtrage/tri côté JS. */
  resultsForExport(jobId, { found = 1 } = {}) {
    return this.db
      .prepare(
        `SELECT tracking_number, milestone, last_label, last_event_at, event_ts, delivery_date
         FROM job_results WHERE job_id = ? AND found = ?`,
      )
      .all(jobId, found);
  }

  /** Lignes d'une catégorie de statut donnée (found=1), avec event_ts. */
  resultsByMilestone(jobId, milestone) {
    return this.db
      .prepare(
        `SELECT tracking_number, milestone, last_label, last_event_at, event_ts, delivery_date
         FROM job_results WHERE job_id = ? AND found = 1 AND milestone = ?`,
      )
      .all(jobId, milestone);
  }

  /** Libellés de dernier événement distincts (found=1), avec compteur, ordre déterministe. */
  distinctLabels(jobId, { found = 1 } = {}) {
    return this.db
      .prepare(
        `SELECT last_label AS label, COUNT(*) AS n
         FROM job_results
         WHERE job_id = ? AND found = ? AND last_label IS NOT NULL AND last_label <> ''
         GROUP BY last_label
         ORDER BY n DESC, last_label ASC`,
      )
      .all(jobId, found);
  }

  /** Lignes dont le dernier événement correspond EXACTEMENT au libellé donné. */
  resultsByExactLabel(jobId, label, { found = 1 } = {}) {
    return this.db
      .prepare(
        `SELECT tracking_number, milestone, last_label, last_event_at, event_ts, delivery_date
         FROM job_results WHERE job_id = ? AND found = ? AND last_label = ?`,
      )
      .all(jobId, found, label);
  }

  allResults(jobId, { found = 1 } = {}) {
    return this.db
      .prepare(
        `SELECT tracking_number, milestone, last_label, last_event_at, delivery_date
         FROM job_results
         WHERE job_id = ? AND found = ?
         ORDER BY rank ASC, (event_ts IS NULL) ASC, event_ts DESC, tracking_number ASC`,
      )
      .all(jobId, found);
  }

  close() {
    this.db.close();
  }
}

/**
 * Exécute un job : interroge chaque numéro, stocke le résultat, publie la progression.
 *
 * @param {object} job        objet runtime mutable (checked, errors, counts, cancelled...)
 * @param {object} deps       { store, client, limiter }
 * @param {object} opts       { concurrency, onProgress }
 */
export async function runJob(job, { store, client, limiter }, { concurrency = 5, onProgress } = {}) {
  let sincePersist = 0;

  await mapPool(job.numbers, concurrency, async (number) => {
    if (job.cancelled) return;
    await limiter.wait();
    if (job.cancelled) return;

    try {
      const { shipment } = await client.track(number);
      const status = interpret(shipment);
      store.addResult(job.id, number, status);
      const key = status.found ? status.milestone : 'not_found';
      job.counts[key] = (job.counts[key] ?? 0) + 1;
    } catch (e) {
      if (e?.fatal) {
        job.cancelled = true;
        job.fatalError = e.message;
        return;
      }
      job.errors++;
      // Une erreur transitoire ne doit pas faire disparaître le numéro du rapport.
      store.addResult(job.id, number, { found: false, milestone: 'not_found', lastLabel: `Erreur : ${e.message}` });
      job.counts.not_found = (job.counts.not_found ?? 0) + 1;
    } finally {
      job.checked++;
      if (++sincePersist >= 25) {
        sincePersist = 0;
        store.setProgress(job.id, job.checked, job.errors);
      }
      onProgress?.(job);
    }
  });

  store.setProgress(job.id, job.checked, job.errors);
  const state = job.fatalError ? 'error' : job.cancelled ? 'cancelled' : 'done';
  job.state = state;
  job.finishedAt = Date.now();
  store.finish(job.id, state, { errorMessage: job.fatalError ?? null, checked: job.checked, errors: job.errors });
  return job;
}
