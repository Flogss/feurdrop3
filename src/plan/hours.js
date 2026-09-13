// Horaires. Regle unique de ce fichier : dans le doute, on dit "inconnu".
// Une plage qu'on ne sait pas lire ne devient jamais un "ouvert" affiche en
// vert. C'est le seul moyen de ne pas envoyer quelqu'un devant un rideau
// baisse.

const DAYS = ["su", "mo", "tu", "we", "th", "fr", "sa"];

function toMinutes(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
}

function toClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseRange(range) {
  const [from, to] = String(range).split("-");
  const start = toMinutes(from);
  const end = toMinutes(to);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

// --- Horaires OpenStreetMap --------------------------------------------------
// La syntaxe opening_hours est tres riche (vacances, semaines paires, "Su[1]"
// ...). On ne traite que les formes simples et sans ambiguite ; tout le reste
// renvoie null, c'est-a-dire "horaires inconnus".

function parseOsmHours(spec, date) {
  const clean = String(spec || "").trim().toLowerCase();
  if (!clean) return null;
  if (clean === "24/7") return [{ start: 0, end: 24 * 60 }];
  // toute mention de regle avancee : on ne tente pas de deviner
  if (/ph|su\[|week|easter|:\s*"|"|\||>|,\s*\d{4}/.test(clean)) return null;

  const wanted = DAYS[date.getDay()];
  let result = null;

  for (const rule of clean.split(";")) {
    const part = rule.trim();
    if (!part) continue;

    const match = /^((?:mo|tu|we|th|fr|sa|su)(?:\s*-\s*(?:mo|tu|we|th|fr|sa|su))?(?:\s*,\s*(?:mo|tu|we|th|fr|sa|su)(?:\s*-\s*(?:mo|tu|we|th|fr|sa|su))?)*)?\s*(off|closed|[\d:\-\s,]+)$/.exec(
      part
    );
    if (!match) return null; // une regle incomprise rend tout le spec douteux

    const [, daySpec, timeSpec] = match;
    if (daySpec && !dayMatches(daySpec, wanted)) continue;

    if (/^(off|closed)$/.test(timeSpec.trim())) {
      result = [];
      continue;
    }

    const ranges = timeSpec
      .split(",")
      .map((r) => parseRange(r.trim()))
      .filter(Boolean);
    if (ranges.length === 0) return null;
    result = ranges;
  }

  return result;
}

function dayMatches(daySpec, wanted) {
  for (const group of daySpec.split(",")) {
    const [from, to] = group.trim().split("-").map((d) => d.trim());
    const start = DAYS.indexOf(from);
    if (start < 0) return false;
    if (!to) {
      if (from === wanted) return true;
      continue;
    }
    const end = DAYS.indexOf(to);
    if (end < 0) return false;
    const index = DAYS.indexOf(wanted);
    // la semaine boucle : "sa-mo" contient dimanche
    if (start <= end ? index >= start && index <= end : index >= start || index <= end) return true;
  }
  return false;
}

// --- Etat d'un point a une heure donnee --------------------------------------

// Le dernier moment utile pour deposer : la fermeture, ou l'heure limite de
// depot du transporteur si elle est plus tot. Un relais ouvert jusqu'a 22h qui
// arrete les colis a 15h ferme a 15h pour nous.
function deadline(hours, carrier) {
  if (!hours || !hours.ranges || hours.ranges.length === 0) return null;
  const parsed = hours.ranges.map(parseRange).filter(Boolean);
  if (parsed.length === 0) return null;

  const close = Math.max(...parsed.map((r) => r.end));
  const cutoff = toMinutes(carrier === "CHRONO" ? hours.cutoffChrono : hours.cutoffColis);
  return cutoff !== null ? Math.min(close, cutoff) : close;
}

// Etat affichable pour un passage prevu a `minutes` (minutes depuis minuit).
// "unknown" n'est pas un echec : c'est l'information honnete quand la source
// ne dit rien.
function statusAt(hours, minutes, carrier) {
  if (!hours || !hours.ranges) return { state: "unknown", label: "horaires inconnus" };

  const parsed = hours.ranges.map(parseRange).filter(Boolean);
  if (parsed.length === 0) return { state: "closed", label: "ferme ce jour-la" };

  const limit = deadline(hours, carrier);
  const open = parsed.find((r) => minutes >= r.start && minutes < r.end);
  const cutoff = toMinutes(carrier === "CHRONO" ? hours.cutoffChrono : hours.cutoffColis);

  if (open && limit !== null && minutes >= limit) {
    return {
      state: "closed",
      label: `depot ferme depuis ${toClock(limit)}`,
      cutoff: cutoff !== null ? toClock(cutoff) : null,
    };
  }
  if (open) {
    return {
      state: "open",
      label: `ouvert jusqu'a ${toClock(limit ?? open.end)}`,
      until: toClock(limit ?? open.end),
      cutoff: cutoff !== null ? toClock(cutoff) : null,
    };
  }

  const next = parsed.find((r) => r.start > minutes);
  if (next) return { state: "closed", label: `ouvre a ${toClock(next.start)}`, opensAt: toClock(next.start) };
  return { state: "closed", label: "ferme pour aujourd'hui" };
}

module.exports = { parseOsmHours, statusAt, deadline, toMinutes, toClock };
