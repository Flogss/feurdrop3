// /imprime : le menu des etiquettes a imprimer, la reimpression, et la
// fabrication du PDF fusionne (thermique 4x6 ou rouleau des LIT).
const {
  getPrintableColis,
  getPrintableSummary,
  countAlreadyPrinted,
  getLitPrintable,
  countLitPrintable,
  markPrinted,
  getPrintJobs,
  getPrintJobColis,
} = require("../db");
const { parseCarrier, carrierLabel } = require("../carrier");
const { paireDuColis } = require("../specials");
const { mergeLabels } = require("../printer");
const { buildRoll } = require("../rollPrinter");
const { avecReessais } = require("../throttle");
const { jourParis, heureParis, aujourdhuiParis, ajouteJours } = require("../dates");
const { AUTO_GROUP_CHAT_ID, acces } = require("./config");
const { replyEphemeral, escapeHtml, CARRIER_LIST_HINT } = require("./outils");
const { markButtonsPrinted } = require("./boutons");

// --- Impression ------------------------------------------------------------
// Fusionne les etiquettes en attente d'un transporteur en un seul PDF au
// format exact de l'imprimante thermique 4x6. Reserve au proprietaire et au
// tete-a-tete avec le bot : c'est un fichier qui contient toutes les
// etiquettes, il n'a rien a faire dans un groupe.
// Reserve a l'equipe (voir bot/acces.js), et pas n'importe ou : en
// tete-a-tete avec le bot, ou dans le groupe de travail. Le PDF regroupe
// toutes les etiquettes en attente du transporteur choisi, quel que soit
// l'expediteur -- noms et adresses des destinataires compris : il n'a rien a
// faire dans un groupe tiers ni chez un inconnu. Les commandes et les boutons
// sont deja filtres en amont ; on reverifie ici, sans appel reseau (la
// verification d'un membre vient d'etre faite et gardee en memoire).
function canPrint(msg) {
  const lieu = msg.chat.type === "private" || msg.chat.id === AUTO_GROUP_CHAT_ID;
  return lieu && acces.verdictImmediat(msg) === true;
}

function handlePrintCommand(bot, msg, rawName) {
  if (!canPrint(msg)) {
    return replyEphemeral(
      bot,
      msg,
      "La commande /imprime ne marche qu'en message prive avec le bot ou dans le groupe de travail.",
      {},
      8000
    );
  }

  if (rawName && rawName.trim()) {
    // "lit" n'est pas un transporteur mais une file d'impression a part
    if (/^lits?$/i.test(rawName.trim())) return sendMergedLabels(bot, msg, "LIT");
    // les speciaux non plus : /imprime special sort leur liasse a part
    if (/^sp[eé]ciaux?$|^sp[eé]cial$/i.test(rawName.trim())) return sendMergedLabels(bot, msg, "SPECIAL");
    const carrier = parseCarrier(rawName);
    if (!carrier) {
      return replyEphemeral(bot, msg, `Transporteur inconnu : "${rawName.trim()}".\nAu choix : ${CARRIER_LIST_HINT}`);
    }
    return sendMergedLabels(bot, msg, carrier.code);
  }

  sendPrintMenu(bot, msg.chat.id);
}

const CARRIER_DOTS = {
  MR: "🩷",
  LP: "🟡",
  CHRONO: "🟢",
  UPS: "🟤",
  DPD: "🔴",
  GLS: "🔵",
  DHL: "🟠",
  FEDEX: "🟣",
  BJ: "🟨",
  LIT: "🧻",
  SPECIAL: "⭐",
  Inconnu: "⚠️",
};

function carrierDot(code) {
  return CARRIER_DOTS[code] || "⬜";
}

// Menu des etiquettes a imprimer. Par defaut il ne montre que celles qui ne
// sont jamais sorties de l'imprimante : imprimer 10 MR, en recevoir 2 puis
// faire "Tout" ne doit ressortir que les 2. Le bouton de reglage donne acces
// aux deja imprimees.
function sendPrintMenu(bot, chatId) {
  const summary = getPrintableSummary().filter((row) => row.count > 0);
  const alreadyPrinted = countAlreadyPrinted() + countLitPrintable({ scope: "printed" });

  if (summary.length === 0 && countLitPrintable() === 0) {
    const text =
      alreadyPrinted > 0
        ? `🖨 <b>Rien de nouveau a imprimer</b>\n\n${alreadyPrinted} etiquette(s) en attente sont deja sorties de l'imprimante.`
        : "🖨 <b>Aucune etiquette a imprimer</b>\n\nTout est a jour.";
    const opts = { parse_mode: "HTML" };
    if (alreadyPrinted > 0) {
      opts.reply_markup = {
        inline_keyboard: [[{ text: `↻ Reimprimer (${alreadyPrinted})`, callback_data: "prmenu:all" }]],
      };
    }
    return bot.sendMessage(chatId, text, opts).catch((err) => console.error("[bot] menu impression", err.message));
  }

  const lit = countLitPrintable();
  const total = summary.reduce((sum, row) => sum + row.count, 0) + lit;
  const lines = summary.map(
    (row) => `${carrierDot(row.carrier)} <b>${carrierLabel(row.carrier)}</b> — ${row.count}`
  );
  if (lit > 0) lines.push(`🧻 <b>LIT</b> — ${lit} <i>(rouleau)</i>`);
  const text = `<b>${total} etiquette${total > 1 ? "s" : ""}</b>\n\n${lines.join("\n")}`;

  const keyboard = [];
  for (let i = 0; i < summary.length; i += 2) {
    keyboard.push(
      summary.slice(i, i + 2).map((row) => ({
        text: `${carrierDot(row.carrier)} ${carrierLabel(row.carrier)} · ${row.count}`,
        callback_data: `pr:${row.carrier}`,
      }))
    );
  }
  if (lit > 0) keyboard.push([{ text: `🧻 LIT · ${lit} — rouleau 210 mm`, callback_data: "pr:LIT" }]);
  if (summary.length > 0) {
    const thermiques = total - lit;
    keyboard.push([{ text: `🖨 Tout imprimer · ${thermiques}`, callback_data: "pr:*" }]);
  }
  if (alreadyPrinted > 0) {
    keyboard.push([{ text: `↻ Deja imprimees · ${alreadyPrinted}`, callback_data: "prmenu:all" }]);
  }

  bot
    .sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } })
    .catch((err) => console.error("[bot] clavier impression", err.message));
}

// Menu de reimpression : on y voit qui a imprime quoi et quand, parce qu'on
// est plusieurs a travailler sur les memes colis.
function sendReprintMenu(bot, chatId) {
  const jobs = getPrintJobs();
  const summary = getPrintableSummary({ scope: "printed" }).filter((row) => row.count > 0);
  const litPrinted = countLitPrintable({ scope: "printed" });
  const alreadyPrinted = countAlreadyPrinted() + litPrinted;

  if (alreadyPrinted === 0) {
    return bot
      .sendMessage(chatId, "↻ <b>Rien a reimprimer</b>\n\nAucune etiquette en attente n'est deja sortie.", {
        parse_mode: "HTML",
      })
      .catch(() => {});
  }

  const lines = jobs.map((job) => {
    const carriers = String(job.carriers || "")
      .split(",")
      .map((code) => `${carrierDot(code)} ${carrierLabel(code)}`)
      .join(", ");
    return `${jobIcon(job)} <b>${escapeHtml(job.printed_by)}</b> · ${jobWhen(job.printed_at)}\n     ${job.count} etiquette${
      job.count > 1 ? "s" : ""
    } — ${carriers}`;
  });

  const text =
    `↻ <b>Deja imprimees</b>\n\n${
      lines.length > 0 ? lines.join("\n\n") : `${alreadyPrinted} etiquette(s), impressions d'avant le suivi.`
    }\n\n<i>Choisis une fournee a refaire, ou passe par les compagnies.</i>`;

  const keyboard = jobs.map((job) => [
    {
      text: `${jobIcon(job)} ${job.printed_by} · ${jobWhen(job.printed_at)} · ${job.count}`,
      callback_data: `prjob:${job.job}`,
    },
  ]);

  for (let i = 0; i < summary.length; i += 2) {
    keyboard.push(
      summary.slice(i, i + 2).map((row) => ({
        text: `${carrierDot(row.carrier)} ${carrierLabel(row.carrier)} · ${row.count}`,
        callback_data: `pra:${row.carrier}`,
      }))
    );
  }
  if (litPrinted > 0) {
    keyboard.push([{ text: `🧻 LIT · ${litPrinted} — rouleau`, callback_data: "pra:LIT" }]);
  }
  if (summary.length > 0) {
    keyboard.push([{ text: `↻ Tout reimprimer · ${alreadyPrinted - litPrinted}`, callback_data: "pra:*" }]);
  }
  keyboard.push([{ text: "← Retour", callback_data: "prmenu:new" }]);

  bot
    .sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } })
    .catch((err) => console.error("[bot] clavier reimpression", err.message));
}

// L'agent du Mac imprime sans utilisateur : on le distingue d'un humain.
function jobIcon(job) {
  return /auto/i.test(job.printed_by || "") ? "🤖" : "👤";
}

// "14:32", "hier 18:40", "lun 09:15" a l'heure de Paris -- les dates SQLite
// sont en UTC, et le serveur aussi.
function jobWhen(sqlDate) {
  const jour = jourParis(sqlDate);
  if (!jour) return "?";
  const heure = heureParis(sqlDate);
  const aujourdhui = aujourdhuiParis();
  if (jour === aujourdhui) return heure;
  if (jour === ajouteJours(aujourdhui, -1)) return `hier ${heure}`;
  const date = new Date(`${jour}T12:00:00Z`);
  return `${date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", timeZone: "UTC" })} ${heure}`;
}

function handlePrintCallback(bot, query) {
  const msg = { chat: query.message.chat, from: query.from };
  if (!canPrint(msg)) {
    return bot.answerCallbackQuery(query.id, { text: "Pas ici." }).catch(() => {});
  }

  const data = query.data || "";
  bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});

  if (data === "prmenu:all") {
    bot.answerCallbackQuery(query.id).catch(() => {});
    return sendReprintMenu(bot, query.message.chat.id);
  }
  if (data === "prmenu:new") {
    bot.answerCallbackQuery(query.id).catch(() => {});
    return sendPrintMenu(bot, query.message.chat.id);
  }

  bot.answerCallbackQuery(query.id, { text: "Preparation..." }).catch(() => {});

  if (data.startsWith("prjob:")) {
    return sendMergedLabels(bot, msg, null, { job: data.slice(6) });
  }

  const includePrinted = data.startsWith("pra:");
  const code = data.slice(data.indexOf(":") + 1);
  sendMergedLabels(bot, msg, code, { includePrinted });
}

// Telecharge les etiquettes une par une (Telegram limite les rafales), les
// assemble, puis renvoie le PDF pret a imprimer.
async function sendMergedLabels(bot, msg, code, { includePrinted = false, job = null } = {}) {
  const chatId = msg.chat.id;
  const scope = { scope: includePrinted ? "printed" : "new" };
  const rows = job
    ? getPrintJobColis(job)
    : code === "LIT"
      ? getLitPrintable(scope)
      : code === "*"
        ? getPrintableSummary(scope).flatMap((row) => getPrintableColis(row.carrier, scope))
        : getPrintableColis(code, scope);

  // les LIT sortent sur le rouleau 210 mm, pas sur la thermique 4x6
  const onRoll = code === "LIT" || (job && rows.length > 0 && rows.every((r) => r.type === "lit"));

  if (rows.length === 0) {
    return replyEphemeral(bot, msg, `Aucune etiquette ${code === "*" ? "" : carrierLabel(code)} a imprimer.`, {}, 8000);
  }

  const progress = await startProgress(bot, chatId, rows.length);

  const { labels, missing } = await downloadLabels(bot, rows, () => progress.step());

  await progress.finish(onRoll ? "Mise en page du rouleau..." : "Assemblage du PDF...");
  const assembled = onRoll ? await buildRoll(labels) : await mergeLabels(labels);
  const { pdf, failed } = assembled;
  progress.remove();

  if (!pdf) {
    // dire POURQUOI : "rien a imprimer" tout seul ne laisse aucune prise
    const causes = [...new Set(failed.map((f) => f.reason))].slice(0, 3);
    const detail = failed.length > 0
      ? `\n${failed.length} fichier(s) illisible(s) :\n• ${causes.join("\n• ")}`
      : missing.length > 0
        ? `\n${missing.length} fichier(s) introuvable(s) sur Telegram (message supprime ou trop vieux).`
        : "";
    return bot.sendMessage(chatId, `Aucune etiquette lisible : rien a imprimer.${detail}`).catch(() => {});
  }

  const name = onRoll
    ? "lit-rouleau"
    : job
      ? "reimpression"
      : code === "*"
        ? "toutes"
        : carrierLabel(code).toLowerCase().replace(/\s+/g, "-");
  const printedIds = labels.filter((l) => !failed.some((f) => f.colisId === l.colisId)).map((l) => l.colisId);
  const caption =
    captionFor(rows, printedIds) +
    (onRoll
      ? `\n📏 ${(assembled.lengthMm / 10).toFixed(0)} cm de rouleau · ${assembled.rows} rangee${assembled.rows > 1 ? "s" : ""}` +
        (assembled.trimmed > 0
          ? ` · ${assembled.trimmed} bloc${assembled.trimmed > 1 ? "s" : ""} d'instructions retire${assembled.trimmed > 1 ? "s" : ""}`
          : "") +
        `\n✂️ Decoupe le long des pointilles`
      : "") +
    (missing.length > 0 ? `\n⚠️ ${missing.length} fichier(s) introuvable(s) sur Telegram.` : "") +
    (failed.length > 0 ? `\n⚠️ ${failed.length} fichier(s) illisible(s).` : "");

  try {
    await bot.sendDocument(
      chatId,
      pdf,
      { caption },
      { filename: `etiquettes-${name}.pdf`, contentType: "application/pdf" }
    );
    // le PDF est parti : ces etiquettes ne reviendront plus dans le menu, ni
    // dans la file de l'impression automatique
    markPrinted(printedIds, printerName(msg));
    // sous chaque fichier concerne, le bouton "Imprime" laisse la place a la
    // mention "deja imprime"
    markButtonsPrinted(bot, printedIds);
  } catch (err) {
    bot.sendMessage(chatId, `Envoi impossible : ${err.message}`).catch(() => {});
  }
}

// Recupere les fichiers aupres de Telegram. Un fichier introuvable (trop
// vieux, message supprime) n'interrompt pas le lot : il est juste signale.
async function downloadLabels(bot, rows, onStep) {
  const labels = [];
  const missing = [];

  for (const row of rows) {
    try {
      // un 429 ou un 502 de Telegram, une coupure : on reessaie au lieu de
      // sauter l'etiquette (elle manquait alors a la liasse sans bruit)
      const bytes = await avecReessais(async () => {
        const link = await bot.getFileLink(row.file_id);
        const res = await fetch(link);
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.response = { statusCode: res.status };
          throw err;
        }
        return new Uint8Array(await res.arrayBuffer());
      });
      labels.push({
        bytes,
        kind: row.file_kind === "image" ? "image" : "pdf",
        label: row.file_name || `colis #${row.id}`,
        colisId: row.id,
        // un special sort avec son numero de paire imprime en gros : c'est lui
        // qu'on lit sur le colis devant le locker
        numero: row.type === "special" ? paireDuColis(row.id)?.numero || null : null,
      });
    } catch (err) {
      missing.push({ id: row.id, label: row.file_name || `colis #${row.id}`, reason: err.message });
    }
    if (onStep) await onStep();
  }
  return { labels, missing };
}

// Barre de progression : un seul message, edite au fil des telechargements.
// Telegram limite les editions, d'ou le pas minimum d'une seconde entre deux
// mises a jour (la derniere etape est toujours affichee).
const PROGRESS_SLOTS = 12;
const PROGRESS_MIN_INTERVAL_MS = 1000;

function progressBar(done, total) {
  const ratio = total > 0 ? done / total : 1;
  const filled = Math.round(ratio * PROGRESS_SLOTS);
  return `${"█".repeat(filled)}${"░".repeat(PROGRESS_SLOTS - filled)} ${Math.round(ratio * 100)} %`;
}

async function startProgress(
  bot,
  chatId,
  total,
  { titre = "Preparation des etiquettes", unite = "recuperees", threadId = null } = {}
) {
  const text = (done, suffix) =>
    `${titre}\n${progressBar(done, total)}\n${suffix || `${done}/${total} ${unite}`}`;

  const opts = threadId ? { message_thread_id: threadId } : {};
  const message = await bot.sendMessage(chatId, text(0), opts).catch(() => null);
  let done = 0;
  let lastEdit = 0;

  const edit = async (suffix) => {
    if (!message) return;
    await bot
      .editMessageText(text(done, suffix), { chat_id: chatId, message_id: message.message_id })
      .catch(() => {});
    lastEdit = Date.now();
  };

  return {
    async step() {
      done += 1;
      const last = done >= total;
      if (!last && Date.now() - lastEdit < PROGRESS_MIN_INTERVAL_MS) return;
      await edit();
    },
    async finish(suffix) {
      await edit(suffix);
    },
    remove() {
      if (message) bot.deleteMessage(chatId, message.message_id).catch(() => {});
    },
  };
}

// Ce que contient le PDF, en une ligne : "🩷 6 MR · 🟤 3 UPS".
function captionFor(rows, printedIds) {
  const kept = new Set(printedIds);
  const counts = new Map();
  for (const row of rows) {
    if (!kept.has(row.id)) continue;
    const code = row.carrier_group || "Inconnu";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  if (counts.size === 0) return "Aucune etiquette lisible.";

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${carrierDot(code)} ${count} ${code === "Inconnu" ? "?" : code}`)
    .join("  ·  ");
}

// Nom affiche dans le menu de reimpression.
function printerName(msg) {
  const from = msg && msg.from;
  if (!from) return "Inconnu";
  return from.username ? `@${from.username}` : from.first_name || `#${from.id}`;
}

module.exports = {
  canPrint,
  handlePrintCommand,
  CARRIER_DOTS,
  carrierDot,
  sendPrintMenu,
  sendReprintMenu,
  jobIcon,
  jobWhen,
  handlePrintCallback,
  sendMergedLabels,
  downloadLabels,
  PROGRESS_SLOTS,
  PROGRESS_MIN_INTERVAL_MS,
  progressBar,
  startProgress,
  captionFor,
  printerName,
};
