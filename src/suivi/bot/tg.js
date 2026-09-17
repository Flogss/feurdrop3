import { sleep } from './util.js';

const API = 'https://api.telegram.org';

/** Échappe le texte pour le parse_mode HTML de Telegram. */
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class TelegramError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/**
 * Client bas niveau de l'API Bot Telegram.
 * Gère les 429 (retry_after) et ignore l'erreur bénigne « message is not modified »,
 * qui survient dès qu'on ré-édite un message avec un contenu identique.
 */
export class TelegramApi {
  constructor(token, { timeoutMs = 20_000, maxRetries = 3 } = {}) {
    if (!token) throw new TelegramError('TELEGRAM_BOT_TOKEN manquant.');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  async call(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res;
      try {
        res = await fetch(`${API}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastErr = new TelegramError(`Réseau (${method}) : ${e.message}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }

      const body = await res.json().catch(() => null);
      if (body?.ok) return body.result;

      const desc = body?.description ?? `HTTP ${res.status}`;

      // Ré-édition avec un contenu identique : sans gravité, on considère que c'est fait.
      if (/message is not modified/i.test(desc)) return null;

      if (res.status === 429) {
        const wait = (body?.parameters?.retry_after ?? 2) * 1000;
        lastErr = new TelegramError(`Telegram 429 (${method})`, { status: 429, body });
        await sleep(wait + 250);
        continue;
      }

      if (res.status >= 500) {
        lastErr = new TelegramError(`Telegram ${res.status} (${method})`, { status: res.status, body });
        await sleep(1000 * (attempt + 1));
        continue;
      }

      throw new TelegramError(`${method} : ${desc}`, { status: res.status, body, code: body?.error_code });
    }
    throw lastErr ?? new TelegramError(`${method} : échec après plusieurs tentatives.`);
  }

  getMe() {
    return this.call('getMe');
  }

  /** Long polling. `timeout` en secondes côté Telegram. */
  getUpdates(offset, timeout = 30) {
    return this.call(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message', 'callback_query'] },
      { timeoutMs: (timeout + 15) * 1000 },
    );
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  answerCallbackQuery(id, text = undefined) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  /** Télécharge un fichier envoyé au bot et le renvoie en texte. */
  async downloadFileText(filePath, { maxBytes = 20 * 1024 * 1024 } = {}) {
    const res = await fetch(`${API}/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new TelegramError(`Téléchargement impossible (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new TelegramError('Fichier trop volumineux.');
    return buf.toString('utf8');
  }

  /** Envoie un document généré à la volée (multipart). */
  async sendDocument(chatId, filename, content, caption = undefined) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    form.append('document', new Blob([content], { type: 'text/csv' }), filename);

    const res = await fetch(`${API}/bot${this.token}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => null);
    if (!body?.ok) throw new TelegramError(`sendDocument : ${body?.description ?? res.status}`);
    return body.result;
  }
}
