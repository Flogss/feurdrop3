import { frDate } from './util.js';
import { TelegramApi, TelegramError, esc } from './tg.js';

export { TelegramError, esc };

/**
 * Notificateur simple utilisé par le poller (`poll.js`) pour signaler une livraison.
 * Le bot interactif, lui, utilise directement TelegramApi (voir bot.js).
 */
export class Telegram {
  constructor(token, chatId, opts = {}) {
    this.chatId = chatId;
    this.enabled = Boolean(token && chatId);
    this.api = this.enabled ? new TelegramApi(token, opts) : null;
  }

  async send(text) {
    if (!this.enabled) throw new TelegramError('Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).');
    return this.api.sendMessage(this.chatId, text, { disable_web_page_preview: false });
  }
}

/** Compose le message de livraison. `parcel` = ligne DB, `status` = interpret(). */
export function deliveredMessage(parcel, status) {
  const lines = ['✅ <b>Colis livré</b>', `📦 <code>${esc(parcel.tracking_number)}</code>`];
  if (parcel.label) lines.push(`🏷️ ${esc(parcel.label)}`);
  lines.push(`🕒 ${esc(frDate(status.deliveryDate ?? status.lastEventAt))}`);
  if (status.lastLabel) lines.push(`\n${esc(status.lastLabel)}`);
  if (status.url) lines.push(`\n🔗 ${esc(status.url)}`);
  return lines.join('\n');
}
