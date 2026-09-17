import { MILESTONE_FR, MILESTONE_ICON } from './status.js';
import { esc } from './tg.js';

export const PAGE_SIZE = 20;

const nf = new Intl.NumberFormat('fr-FR');

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function progressBar(pct, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** "13/09 10:22" — compact, pour tenir sur une ligne. */
function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const trunc = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const label = (m) => `${MILESTONE_ICON[m] ?? '•'} ${MILESTONE_FR[m] ?? m}`;

/* ------------------------------------------------------------------ Onglet STATUT */

export function renderStatus(job, { counts, invalidCount, duplicates }) {
  const now = job.finishedAt ?? Date.now();
  const elapsed = now - job.startedAt;
  const total = job.total;
  const pct = total ? job.checked / total : 0;
  const rate = elapsed > 0 ? job.checked / (elapsed / 1000) : 0;
  const remaining = rate > 0 ? ((total - job.checked) / rate) * 1000 : NaN;

  const head =
    job.state === 'done'
      ? '✅ <b>Vérification terminée</b>'
      : job.state === 'cancelled'
        ? '⏹ <b>Vérification annulée</b>'
        : job.state === 'error'
          ? '❌ <b>Vérification interrompue</b>'
          : '⏳ <b>Vérification en cours…</b>';

  const lines = [head];
  if (job.fileName) lines.push(`📄 <i>${esc(job.fileName)}</i>`);
  lines.push('');

  if (job.state === 'running') {
    // Sur les toutes premières mesures, le débit observé est aberrant (1 colis en 2 ms
    // => 500/s). Tant que l'échantillon est trop faible, on affiche l'estimation
    // théorique basée sur le débit configuré plutôt qu'un chiffre fantaisiste.
    const reliable = elapsed > 2000 && job.checked >= 5;
    const planned = job.plannedRate ?? 8;
    const eta = reliable ? remaining : ((total - job.checked) / planned) * 1000;

    lines.push(`<code>[${progressBar(pct)}] ${String(Math.round(pct * 100)).padStart(3)} %</code>`);
    lines.push(`<b>${nf.format(job.checked)}</b> / ${nf.format(total)} numéros`);
    lines.push('');
    lines.push(`⏱ Écoulé   <b>${formatDuration(elapsed)}</b>`);
    lines.push(`⏳ Restant  <b>~${formatDuration(eta)}</b>${reliable ? '' : ' <i>(estimation)</i>'}`);
    lines.push(`⚡ Débit    ${reliable ? `<b>${rate.toFixed(1)}</b> /s` : '<i>mesure en cours…</i>'}`);
  } else {
    lines.push(`${nf.format(job.checked)} numéros vérifiés en <b>${formatDuration(elapsed)}</b>`);
    if (job.fatalError) lines.push(`\n⚠️ ${esc(job.fatalError)}`);
  }

  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length) {
    lines.push('');
    lines.push(job.state === 'running' ? '<b>Répartition provisoire</b>' : '<b>Répartition</b>');
    const width = Math.max(...entries.map(([m]) => label(m).length));
    for (const [m, n] of entries) {
      lines.push(`<code>${esc(label(m).padEnd(width))}  ${nf.format(n).padStart(6)}</code>`);
    }
  }

  const notes = [];
  if (invalidCount) notes.push(`⛔ ${nf.format(invalidCount)} invalide(s) exclu(s)`);
  if (duplicates) notes.push(`♻️ ${nf.format(duplicates)} doublon(s)`);
  if (job.errors) notes.push(`⚠️ ${nf.format(job.errors)} erreur(s) réseau`);
  if (notes.length) {
    lines.push('');
    lines.push(`<i>${notes.join(' · ')}</i>`);
  }

  return lines.join('\n');
}

/* --------------------------------------------------------------- Onglet RÉSULTATS */

/**
 * @param rows   page de résultats déjà triée (statut, puis maj la plus récente)
 * @param counts totaux par statut, pour afficher la taille des groupes
 */
export function renderResults(rows, { page, totalPages, totalRows, counts, notFound = false }) {
  const title = notFound ? '❓ <b>Introuvables</b>' : '📊 <b>Résultats</b>';

  if (totalRows === 0) {
    return `${title}\n\n<i>${notFound ? 'Aucun numéro introuvable.' : 'Aucun résultat.'}</i>`;
  }

  const lines = [
    `${title} · ${nf.format(totalRows)} colis · page ${page + 1}/${totalPages}`,
    notFound
      ? '<i>Aucune donnée côté La Poste : numéro inconnu, pas encore pris en charge, ou trop ancien.</i>'
      : '<i>Triés par statut, puis de l’actualisation la plus récente à la plus ancienne</i>',
  ];

  if (notFound) {
    // Pas de date ni de statut à grouper ici : une ligne par numéro, motif si connu.
    lines.push('');
    for (const r of rows) {
      const reason = trunc(r.last_label, 38);
      lines.push(`<code>${esc(r.tracking_number)}</code>${reason ? ` · ${esc(reason)}` : ''}`);
    }
    return lines.join('\n');
  }

  let currentGroup = null;
  for (const r of rows) {
    if (r.milestone !== currentGroup) {
      currentGroup = r.milestone;
      const n = counts[r.milestone];
      lines.push('');
      lines.push(`<b>${label(r.milestone)}</b>${n ? ` <i>(${nf.format(n)})</i>` : ''}`);
    }
    lines.push(
      `<code>${esc(r.tracking_number)}</code> · ${shortDate(r.last_event_at)} · ${esc(trunc(r.last_label, 38))}`,
    );
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------- Claviers */

export function keyboard({ jobId, tab, page = 0, totalPages = 1, running, notFoundCount = 0 }) {
  const rows = [];

  rows.push([
    { text: tab === 'results' ? '📊 ·Résultats·' : '📊 Résultats', callback_data: `r:${jobId}:0` },
    { text: tab === 'status' ? '⏳ ·Statut·' : '⏳ Statut', callback_data: `s:${jobId}` },
    {
      text: (tab === 'notfound' ? '❓ ·Introuv.·' : '❓ Introuv.') + (notFoundCount ? ` ${notFoundCount}` : ''),
      callback_data: `n:${jobId}:0`,
    },
  ]);

  if ((tab === 'results' || tab === 'notfound') && totalPages > 1) {
    const prefix = tab === 'results' ? 'r' : 'n';
    const first = Math.max(0, page - 1);
    const last = Math.min(totalPages - 1, page + 1);
    rows.push([
      { text: '⏮', callback_data: `${prefix}:${jobId}:0` },
      { text: '◀', callback_data: `${prefix}:${jobId}:${first}` },
      { text: `${page + 1}/${totalPages}`, callback_data: 'noop' },
      { text: '▶', callback_data: `${prefix}:${jobId}:${last}` },
      { text: '⏭', callback_data: `${prefix}:${jobId}:${totalPages - 1}` },
    ]);
  }

  const bottom = [{ text: '📄 Export CSV', callback_data: `c:${jobId}` }];
  if (running) bottom.push({ text: '⏹ Annuler', callback_data: `x:${jobId}` });
  rows.push(bottom);

  return { inline_keyboard: rows };
}

/**
 * Menu de sélection de la catégorie à exporter.
 * @param counts        [{milestone, n}] pour found=1, déjà ordonnés par rang
 * @param notFoundCount nombre d'introuvables (found=0)
 */
export function exportMenuKeyboard(jobId, counts, notFoundCount) {
  const rows = counts.map((c) => [
    {
      text: `${MILESTONE_ICON[c.milestone] ?? '•'} ${MILESTONE_FR[c.milestone] ?? c.milestone} (${c.n})`,
      callback_data: `e:${jobId}:${c.milestone}`,
    },
  ]);

  // Sélection fine : par libellé de dernier événement exact.
  rows.push([{ text: '🏷️ Par dernier événement', callback_data: `L:${jobId}` }]);

  const totalFound = counts.reduce((a, c) => a + c.n, 0);
  const last = [{ text: `📦 Tout (${totalFound})`, callback_data: `e:${jobId}:__all` }];
  if (notFoundCount) last.push({ text: `❓ Introuvables (${notFoundCount})`, callback_data: `e:${jobId}:__nf` });
  rows.push(last);

  return { inline_keyboard: rows };
}

/**
 * Menu de sélection par dernier événement exact.
 * @param labels [{label, n}] ordonnés de façon déterministe ; l'index sert de clé compacte
 *               dans callback_data (les libellés sont trop longs pour y tenir).
 */
export function labelMenuKeyboard(jobId, labels) {
  const rows = labels.map((l, i) => [
    { text: `${trunc(l.label, 40)} — ${l.n}`, callback_data: `l:${jobId}:${i}` },
  ]);
  rows.push([{ text: '⬅️ Catégories', callback_data: `c:${jobId}` }]);
  return { inline_keyboard: rows };
}

/* ------------------------------------------------------------------------ CSV */

/**
 * Filtre les résultats sur un libellé (sous-chaîne, insensible à la casse et aux accents)
 * et les trie par date d'actualisation. Les lignes sans date sont placées à la fin.
 *
 * @param direction 'desc' = plus récent d'abord (défaut), 'asc' = plus ancien d'abord
 */
export function filterAndSortByDate(rows, { labelContains = '', direction = 'desc' } = {}) {
  const fold = (s) =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''); // retire les accents pour un filtre tolérant
  const needle = fold(labelContains.trim());

  const filtered = needle ? rows.filter((r) => fold(r.last_label).includes(needle)) : rows.slice();

  filtered.sort((a, b) => {
    const ta = a.event_ts;
    const tb = b.event_ts;
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return direction === 'asc' ? ta - tb : tb - ta;
  });
  return filtered;
}

export function toCsv(rows) {
  const headers = ['numero', 'statut', 'derniere_maj', 'dernier_evenement', 'date_livraison'];
  const q = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) =>
    [r.tracking_number, MILESTONE_FR[r.milestone] ?? r.milestone, r.last_event_at, r.last_label, r.delivery_date]
      .map(q)
      .join(';'),
  );
  // BOM UTF-8 : sans lui, Excel (FR) casse les accents.
  return '﻿' + [headers.join(';'), ...body].join('\r\n');
}
