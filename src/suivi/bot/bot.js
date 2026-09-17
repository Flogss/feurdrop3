import { TelegramApi, esc } from './tg.js';
import { OkapiClient } from './okapi.js';
import { JobStore, runJob, newJobId } from './jobs.js';
import { parseNumbers } from './validate.js';
import { RateLimiter, sleep } from './util.js';
import {
  renderStatus,
  renderResults,
  keyboard,
  toCsv,
  filterAndSortByDate,
  exportMenuKeyboard,
  labelMenuKeyboard,
  PAGE_SIZE,
} from './views.js';
import { MILESTONE_FR } from './status.js';

const REFRESH_MS = 3000; // Telegram n'aime pas les éditions trop fréquentes
const MAX_NUMBERS = 50_000;

const HELP = `
👋 <b>Bot de suivi Colissimo</b>

Envoie-moi un fichier <b>.txt</b> contenant tes numéros de suivi
(un par ligne, ou séparés par des virgules / espaces).
De 10 à 10 000 numéros, ça passe.

Je vérifie chaque colis auprès de La Poste et je te rends :
• <b>📊 Résultats</b> — triés par statut, du plus récemment actualisé au plus ancien
• <b>⏳ Statut</b> — progression en direct, temps écoulé et temps restant
• <b>❓ Introuvables</b> — les numéros sans données côté La Poste

Les numéros au format invalide sont automatiquement exclus.
Tu peux aussi coller directement une liste de numéros dans un message.

<b>Export</b> — après une vérification :
• Bouton <b>📄 Export CSV</b> → choisis la <b>catégorie</b> à exporter
  (Livré, En transit, Retour/clôturé, Introuvables…), triée par date.
• Ou par libellé : <code>/export retour</code>, <code>/export mis à disposition</code>
  (ajoute <code>asc</code> pour trier du plus ancien au plus récent).
`.trim();

export class Bot {
  constructor({ token, allowedChats, okapiKey, dbFile = 'data/suivi.db', maxPerSec = 8, concurrency = 5 }) {
    this.api = new TelegramApi(token);
    this.store = new JobStore(dbFile);
    this.client = new OkapiClient(okapiKey);
    this.limiter = new RateLimiter(maxPerSec * 60);
    this.maxPerSec = maxPerSec;
    this.concurrency = concurrency;
    this.allowed = new Set((allowedChats ?? []).map(String).filter(Boolean));
    this.jobs = new Map(); // jobId -> job runtime
    this.activeByChat = new Map(); // chatId -> jobId
    this.running = false;
    this.offset = undefined;
  }

  isAllowed(chatId) {
    return this.allowed.size === 0 || this.allowed.has(String(chatId));
  }

  /* ----------------------------------------------------------------- boucle */

  async start() {
    const me = await this.api.getMe();
    console.log(`Bot démarré : @${me.username} (chats autorisés : ${this.allowed.size || 'tous ⚠'})`);
    this.running = true;

    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, 30);
        for (const u of updates ?? []) {
          this.offset = u.update_id + 1;
          this.handleUpdate(u).catch((e) => console.error('handleUpdate:', e.message));
        }
      } catch (e) {
        console.error('getUpdates:', e.message);
        await sleep(3000);
      }
    }
  }

  stop() {
    this.running = false;
  }

  async handleUpdate(u) {
    if (u.message) return this.handleMessage(u.message);
    if (u.callback_query) return this.handleCallback(u.callback_query);
  }

  /* ---------------------------------------------------------------- messages */

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    if (!this.isAllowed(chatId)) {
      await this.api.sendMessage(chatId, '⛔ Ce bot est privé.');
      return;
    }

    const text = msg.text ?? '';
    if (/^\/(start|help)/.test(text)) return void (await this.api.sendMessage(chatId, HELP));

    const exportMatch = text.match(/^\/export\b\s*(.*)$/is);
    if (exportMatch) return this.handleExport(chatId, exportMatch[1]);

    if (msg.document) return this.handleDocument(chatId, msg.document);

    if (text.trim()) {
      const parsed = parseNumbers(text);
      if (parsed.valid.length > 0) return this.startJob(chatId, parsed, null);
      return void (await this.api.sendMessage(chatId, "Aucun numéro valide détecté. Envoie-moi un fichier <b>.txt</b> ou tape /help."));
    }
  }

  async handleDocument(chatId, doc) {
    const name = doc.file_name ?? 'fichier';
    if (!/\.(txt|csv)$/i.test(name)) {
      await this.api.sendMessage(chatId, `❌ Format non supporté (<b>${esc(name)}</b>). Envoie un fichier <b>.txt</b>.`);
      return;
    }

    await this.api.sendChatAction(chatId, 'typing');
    let text;
    try {
      const file = await this.api.getFile(doc.file_id);
      text = await this.api.downloadFileText(file.file_path);
    } catch (e) {
      await this.api.sendMessage(chatId, `❌ Lecture du fichier impossible : ${esc(e.message)}`);
      return;
    }

    const parsed = parseNumbers(text);
    if (parsed.valid.length === 0) {
      await this.api.sendMessage(
        chatId,
        `❌ Aucun numéro valide dans <b>${esc(name)}</b>.\n` +
          `${parsed.invalid.length} entrée(s) non reconnue(s).`,
      );
      return;
    }
    await this.startJob(chatId, parsed, name);
  }

  /* -------------------------------------------------------------------- jobs */

  async startJob(chatId, parsed, fileName) {
    if (this.activeByChat.has(chatId)) {
      await this.api.sendMessage(chatId, '⏳ Une vérification est déjà en cours. Attends la fin ou annule-la.');
      return;
    }
    if (parsed.valid.length > MAX_NUMBERS) {
      await this.api.sendMessage(chatId, `❌ Trop de numéros (${parsed.valid.length}). Maximum ${MAX_NUMBERS}.`);
      return;
    }

    const id = newJobId();
    this.store.create({
      id,
      chatId,
      fileName,
      total: parsed.valid.length,
      invalidCount: parsed.invalid.length,
      duplicates: parsed.duplicates,
      invalidSample: parsed.invalid,
    });

    const job = {
      id,
      chatId,
      fileName,
      numbers: parsed.valid,
      total: parsed.valid.length,
      invalidCount: parsed.invalid.length,
      duplicates: parsed.duplicates,
      checked: 0,
      errors: 0,
      counts: {},
      state: 'running',
      cancelled: false,
      fatalError: null,
      startedAt: Date.now(),
      finishedAt: null,
      plannedRate: this.maxPerSec,
      lastEdit: 0,
      editing: false,
      view: { tab: 'status', page: 0 },
    };
    this.jobs.set(id, job);
    this.activeByChat.set(chatId, id);

    const sent = await this.api.sendMessage(
      chatId,
      renderStatus(job, { counts: {}, invalidCount: job.invalidCount, duplicates: job.duplicates }),
      { reply_markup: keyboard({ jobId: id, tab: 'status', running: true }) },
    );
    job.messageId = sent.message_id;
    this.store.setMessageId(id, sent.message_id);

    // Détaché : la boucle de polling doit rester réactive pendant le traitement.
    runJob(job, { store: this.store, client: this.client, limiter: this.limiter }, {
      concurrency: this.concurrency,
      onProgress: () => this.refresh(job),
    })
      .catch((e) => {
        job.state = 'error';
        job.fatalError = e.message;
        this.store.finish(id, 'error', { errorMessage: e.message });
      })
      .finally(() => {
        this.activeByChat.delete(chatId);
        this.refresh(job, { force: true });
      });
  }

  /* ------------------------------------------------------------------- rendu */

  /** Reconstruit un job depuis la base (boutons d'un ancien message après redémarrage). */
  hydrate(jobId) {
    if (this.jobs.has(jobId)) return this.jobs.get(jobId);
    const row = this.store.get(jobId);
    if (!row) return null;
    const counts = Object.fromEntries(this.store.countsByStatus(jobId).map((r) => [r.milestone, r.n]));
    const nf = this.store.countsByStatus(jobId, { found: 0 });
    for (const r of nf) counts[r.milestone] = (counts[r.milestone] ?? 0) + r.n;
    return {
      id: row.id,
      chatId: row.chat_id,
      messageId: row.message_id,
      fileName: row.file_name,
      total: row.total,
      invalidCount: row.invalid_count,
      duplicates: row.duplicates,
      checked: row.checked,
      errors: row.errors,
      counts,
      state: row.state,
      fatalError: row.error_message,
      startedAt: Date.parse(row.started_at),
      finishedAt: row.finished_at ? Date.parse(row.finished_at) : null,
      view: { tab: 'results', page: 0 },
      lastEdit: 0,
      editing: false,
      persisted: true,
    };
  }

  buildView(job) {
    const { tab, page } = job.view;
    const running = job.state === 'running';
    const notFoundCount = this.store.countResults(job.id, { found: 0 });

    if (tab === 'status') {
      return {
        text: renderStatus(job, {
          counts: job.counts,
          invalidCount: job.invalidCount,
          duplicates: job.duplicates,
        }),
        markup: keyboard({ jobId: job.id, tab, running, notFoundCount }),
      };
    }

    const found = tab === 'notfound' ? 0 : 1;
    const totalRows = this.store.countResults(job.id, { found });
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    job.view.page = safePage;

    const rows = this.store.page(job.id, { found, limit: PAGE_SIZE, offset: safePage * PAGE_SIZE });
    const counts = Object.fromEntries(this.store.countsByStatus(job.id, { found }).map((r) => [r.milestone, r.n]));

    return {
      text: renderResults(rows, {
        page: safePage,
        totalPages,
        totalRows,
        counts,
        notFound: tab === 'notfound',
      }),
      markup: keyboard({ jobId: job.id, tab, page: safePage, totalPages, running, notFoundCount }),
    };
  }

  async refresh(job, { force = false } = {}) {
    if (!job.messageId) return;
    if (!force && Date.now() - job.lastEdit < REFRESH_MS) return;
    if (job.editing) return;
    job.editing = true;
    job.lastEdit = Date.now();
    try {
      const { text, markup } = this.buildView(job);
      await this.api.editMessageText(job.chatId, job.messageId, text, { reply_markup: markup });
    } catch (e) {
      console.error('refresh:', e.message);
    } finally {
      job.editing = false;
    }
  }

  /* --------------------------------------------------------------- callbacks */

  async handleCallback(cq) {
    const chatId = cq.message?.chat?.id;
    const data = cq.data ?? '';

    if (!this.isAllowed(chatId)) return void (await this.api.answerCallbackQuery(cq.id, 'Bot privé'));
    if (data === 'noop') return void (await this.api.answerCallbackQuery(cq.id));

    const [action, jobId, arg] = data.split(':');
    const job = this.hydrate(jobId);
    if (!job) return void (await this.api.answerCallbackQuery(cq.id, 'Vérification introuvable (trop ancienne ?)'));

    job.messageId = cq.message.message_id;
    job.chatId = chatId;

    switch (action) {
      case 'r':
        job.view = { tab: 'results', page: Number(arg) || 0 };
        break;
      case 'n':
        job.view = { tab: 'notfound', page: Number(arg) || 0 };
        break;
      case 's':
        job.view = { tab: 'status', page: 0 };
        break;
      case 'x': {
        const live = this.jobs.get(jobId);
        if (live && live.state === 'running') {
          live.cancelled = true;
          await this.api.answerCallbackQuery(cq.id, 'Annulation demandée…');
        } else {
          await this.api.answerCallbackQuery(cq.id, 'Déjà terminé');
        }
        return;
      }
      case 'c': {
        // Ouvre le menu de sélection de catégorie (dans un message séparé).
        const countsFound = this.store.countsByStatus(job.id, { found: 1 });
        const notFoundCount = this.store.countResults(job.id, { found: 0 });
        if (countsFound.length === 0 && !notFoundCount) {
          return void (await this.api.answerCallbackQuery(cq.id, 'Rien à exporter'));
        }
        await this.api.answerCallbackQuery(cq.id);
        await this.api.sendMessage(
          job.chatId,
          '📄 <b>Quelle catégorie exporter ?</b>\n<i>CSV trié par date, plus récent d’abord.</i>',
          { reply_markup: exportMenuKeyboard(job.id, countsFound, notFoundCount) },
        );
        return;
      }
      case 'e':
        await this.api.answerCallbackQuery(cq.id, 'Export en cours…');
        return this.exportCategory(job, arg);
      case 'L': {
        // Affiche la liste des derniers événements exacts (édite le message du menu).
        const labels = this.store.distinctLabels(job.id, { found: 1 });
        if (labels.length === 0) return void (await this.api.answerCallbackQuery(cq.id, 'Aucun événement'));
        await this.api.answerCallbackQuery(cq.id);
        await this.api.editMessageText(
          job.chatId,
          cq.message.message_id,
          '🏷️ <b>Choisis le dernier événement à exporter</b>\n<i>Correspondance exacte, CSV trié par date.</i>',
          { reply_markup: labelMenuKeyboard(job.id, labels) },
        );
        return;
      }
      case 'l': {
        const labels = this.store.distinctLabels(job.id, { found: 1 });
        const label = labels[Number(arg)]?.label;
        if (!label) return void (await this.api.answerCallbackQuery(cq.id, 'Événement introuvable'));
        await this.api.answerCallbackQuery(cq.id, 'Export en cours…');
        return this.exportExactLabel(job, label);
      }
      default:
        return void (await this.api.answerCallbackQuery(cq.id));
    }

    await this.api.answerCallbackQuery(cq.id);
    await this.refresh(job, { force: true });
  }

  /** /export [libellé] [asc] : filtre la dernière vérification par libellé, trie par date, envoie le CSV. */
  async handleExport(chatId, argRaw) {
    const jobRow = this.store.latestJobForChat(chatId);
    if (!jobRow) {
      await this.api.sendMessage(chatId, "Aucune vérification récente. Envoie d'abord un fichier <b>.txt</b>.");
      return;
    }

    let arg = argRaw.trim();
    let direction = 'desc';
    if (/(^|\s)(asc|croissant|ancien)$/i.test(arg)) {
      direction = 'asc';
      arg = arg.replace(/(^|\s)(asc|croissant|ancien)$/i, '').trim();
    } else if (/(^|\s)(desc|recent|récent)$/i.test(arg)) {
      arg = arg.replace(/(^|\s)(desc|recent|récent)$/i, '').trim();
    }
    const labelContains = arg;

    const rows = this.store.resultsForExport(jobRow.id, { found: 1 });
    const filtered = filterAndSortByDate(rows, { labelContains, direction });

    if (filtered.length === 0) {
      await this.api.sendMessage(
        chatId,
        labelContains
          ? `Aucun colis dont le statut contient « ${esc(labelContains)} » dans la dernière vérification.`
          : 'Aucun résultat à exporter.',
      );
      return;
    }

    const tag = labelContains ? labelContains.replace(/[^a-z0-9]+/gi, '-').slice(0, 30).replace(/^-|-$/g, '') : 'tous';
    const order = direction === 'asc' ? 'plus ancien → plus récent' : 'plus récent → plus ancien';
    await this.api.sendDocument(
      chatId,
      `export-${tag}-${jobRow.id}.csv`,
      toCsv(filtered),
      `📄 ${filtered.length} colis` +
        (labelContains ? ` · filtre « ${esc(labelContains)} »` : '') +
        ` · triés par date (${order})`,
    );
  }

  /** Exporte une catégorie choisie dans le menu : un milestone, ou __all / __nf. */
  async exportCategory(job, key) {
    let rows;
    let tag;
    if (key === '__all') {
      rows = this.store.resultsForExport(job.id, { found: 1 });
      tag = 'tous';
    } else if (key === '__nf') {
      rows = this.store.resultsForExport(job.id, { found: 0 });
      tag = 'introuvables';
    } else {
      rows = this.store.resultsByMilestone(job.id, key);
      tag = MILESTONE_FR[key] ?? key;
    }

    const sorted = filterAndSortByDate(rows, {}); // tri par date, plus récent d'abord
    if (sorted.length === 0) {
      await this.api.sendMessage(job.chatId, 'Aucun colis dans cette catégorie.');
      return;
    }

    const safeTag = tag
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 30);

    await this.api.sendDocument(
      job.chatId,
      `export-${safeTag}-${job.id}.csv`,
      toCsv(sorted),
      `📄 ${sorted.length} colis · ${esc(tag)} · triés par date`,
    );
  }

  /** Exporte les colis dont le dernier événement correspond EXACTEMENT au libellé. */
  async exportExactLabel(job, label) {
    const rows = this.store.resultsByExactLabel(job.id, label, { found: 1 });
    const sorted = filterAndSortByDate(rows, {});
    if (sorted.length === 0) {
      await this.api.sendMessage(job.chatId, 'Aucun colis pour cet événement.');
      return;
    }
    const safeTag = label
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 30);
    await this.api.sendDocument(
      job.chatId,
      `export-${safeTag}-${job.id}.csv`,
      toCsv(sorted),
      `📄 ${sorted.length} colis · « ${esc(label)} » · triés par date`,
    );
  }
}
