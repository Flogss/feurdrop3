const { suiviDbPath } = require("./paths");

// Lancer des verifications depuis le site, avec le moteur du bot.
//
// runJob() ne connait ni Telegram ni le dashboard : il prend un store, un
// client et un limiteur, et previent a chaque numero. On s'en sert tel quel.
//
// Un seul limiteur pour tout le processus : le bot et le site tapent la meme
// cle Okapi, et La Poste met une cle au piquet plusieurs minutes quand on
// depasse. Deux limiteurs a 10/s feraient 20/s et donc un blocage.

const PER_SECOND = Number(process.env.SUIVI_MAX_PER_SEC) || 10;
const CONCURRENCY = Number(process.env.SUIVI_CONCURRENCY) || 5;
const FINDS_KEPT = 60; // de quoi alimenter l'animation sans gonfler la memoire

let modules = null;
let limiter = null;
let store = null;
let client = null;

let current = null; // job en cours, cote runtime
let finds = []; // dernieres trouvailles, pour l'animation
let seq = 0;

async function load() {
  if (modules) return modules;
  const [jobs, okapi, util, validate, status] = await Promise.all([
    import("./bot/jobs.js"),
    import("./bot/okapi.js"),
    import("./bot/util.js"),
    import("./bot/validate.js"),
    import("./bot/status.js"),
  ]);
  modules = { jobs, okapi, util, validate, status };
  return modules;
}

// Le limiteur est cree une fois et partage avec le bot (voir runner.js).
async function sharedLimiter() {
  if (limiter) return limiter;
  const { util } = await load();
  limiter = new util.RateLimiter(PER_SECOND * 60);
  return limiter;
}

async function resources() {
  const { jobs, okapi } = await load();
  if (!store) store = new jobs.JobStore(suiviDbPath());
  if (!client) {
    const key = process.env.OKAPI_KEY;
    if (!key) throw new Error("OKAPI_KEY absente : impossible de verifier quoi que ce soit.");
    client = new okapi.OkapiClient(key);
  }
  return { store, client, limiter: await sharedLimiter(), jobs };
}

function isRunning() {
  return Boolean(current && !current.done);
}

// Les numeros retenus d'un texte colle ou d'un fichier envoye.
async function parse(text) {
  const { validate } = await load();
  return validate.parseNumbers(text || "");
}

async function startCheck({ numbers, source = "dashboard" }) {
  if (isRunning()) throw new Error("une verification tourne deja");
  if (!Array.isArray(numbers) || numbers.length === 0) throw new Error("aucun numero a verifier");

  const { store: st, client: cl, limiter: lim, jobs } = await resources();
  const id = jobs.newJobId();
  st.create({
    id,
    chatId: "dashboard",
    fileName: source,
    total: numbers.length,
    invalidCount: 0,
    duplicates: 0,
    invalidSample: [],
  });

  const job = {
    id,
    numbers,
    checked: 0,
    errors: 0,
    counts: {},
    cancelled: false,
    source,
    total: numbers.length,
    startedAt: Date.now(),
    done: false,
  };
  current = job;
  finds = [];
  seq = 0;

  // On intercale un store qui previent a chaque resultat : c'est ce qui
  // alimente les notifications de l'ecran de chargement.
  const tap = {
    addResult(jobId, number, status) {
      st.addResult(jobId, number, status);
      seq += 1;
      finds.push({
        seq,
        number,
        milestone: status.found ? status.milestone : "not_found",
        found: Boolean(status.found),
        label: status.lastLabel || null,
      });
      if (finds.length > FINDS_KEPT) finds = finds.slice(-FINDS_KEPT);
    },
    setProgress: (...args) => st.setProgress(...args),
    finish: (...args) => st.finish(...args),
  };

  jobs
    .runJob(job, { store: tap, client: cl, limiter: lim }, { concurrency: CONCURRENCY })
    .catch((err) => {
      job.fatalError = err.message;
      job.state = "error";
    })
    .finally(() => {
      job.done = true;
    });

  return { jobId: id, total: numbers.length };
}

function cancel() {
  if (!isRunning()) return false;
  current.cancelled = true;
  return true;
}

// Etat instantane, pour l'ecran de chargement. `since` permet au navigateur de
// ne recevoir que les trouvailles qu'il n'a pas encore affichees.
function live({ since = 0 } = {}) {
  if (!current) return { running: false, job: null, finds: [], seq: 0 };

  // runJob horodate la fin : sans ca, le chrono d'un passage termine
  // continuerait de tourner a l'ecran
  const stop = current.finishedAt || Date.now();
  const elapsed = Math.max(0, Math.round((stop - current.startedAt) / 1000));
  const rate = elapsed > 0 ? current.checked / elapsed : 0;
  const left = Math.max(0, current.total - current.checked);

  return {
    running: !current.done,
    seq,
    job: {
      id: current.id,
      source: current.source,
      total: current.total,
      checked: current.checked,
      errors: current.errors,
      counts: current.counts,
      percent: current.total > 0 ? (current.checked / current.total) * 100 : 0,
      elapsed,
      rate: Math.round(rate * 10) / 10,
      // pas d'estimation tant qu'aucun debit n'a ete mesure
      eta: !current.done && rate > 0 ? Math.round(left / rate) : null,
      state: current.done ? current.state || "done" : "running",
      fatalError: current.fatalError || null,
      cancelled: current.cancelled,
    },
    finds: finds.filter((f) => f.seq > since),
  };
}

module.exports = { startCheck, cancel, live, isRunning, parse, sharedLimiter, PER_SECOND };
