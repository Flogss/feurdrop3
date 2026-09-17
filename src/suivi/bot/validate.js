/**
 * Validation du format des numéros de suivi.
 * Source des formats : cahier des charges Colissimo « Web Service Suivi TL » (§II.1).
 */

const FORMATS = [
  // Colis nationaux Colissimo : 6-9 + lettre + 11 chiffres (ex. 8R50218823724)
  { name: 'colissimo', re: /^[6-9][A-Z]\d{11}$/ },
  // Colis nationaux : 5 + lettre N-Z + 11 chiffres
  { name: 'colissimo', re: /^5[N-Z]\d{11}$/ },
  // Format postal universel (UPU) : 2 alphanum + 9 chiffres + code pays (ex. LU680211095FR)
  { name: 'upu', re: /^[0-9A-Z]{2}\d{9}[A-Z]{2}$/ },
  // International : 12 chiffres (DE)
  { name: 'de', re: /^\d{12}$/ },
  // International : 3S + 4 alphanum + 7 chiffres (NL)
  { name: 'nl', re: /^3S[0-9A-Z]{4}\d{7}$/ },
];

/** Retire espaces, tirets et points, passe en majuscules. */
export const compact = (s) => String(s).replace(/[\s.\-_]/g, '').toUpperCase();

/** @returns {string|null} le nom du format reconnu, ou null si invalide. */
export function formatOf(candidate) {
  return FORMATS.find((f) => f.re.test(candidate))?.name ?? null;
}

export const isValid = (candidate) => formatOf(candidate) !== null;

/**
 * Analyse le contenu d'un fichier texte et en extrait les numéros.
 *
 * Tolérant aux formats réels : un numéro par ligne, séparés par virgules/points-virgules/
 * tabulations, ou plusieurs par ligne séparés par des espaces. Les numéros écrits avec
 * des espaces internes ("8R 5021 8823 724") sont recollés.
 *
 * @returns {{valid:string[], invalid:string[], duplicates:number, total:number}}
 */
export function parseNumbers(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;

  const push = (candidate) => {
    if (!candidate) return;
    if (isValid(candidate)) {
      if (seen.has(candidate)) {
        duplicates++;
        return;
      }
      seen.add(candidate);
      valid.push(candidate);
    } else {
      invalid.push(candidate.slice(0, 40));
    }
  };

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    for (const rawField of line.split(/[,;\t]+/)) {
      const field = rawField.trim();
      if (!field) continue;

      // 1) Le champ entier, espaces internes retirés ("8R 5021 8823 724").
      const whole = compact(field);
      if (isValid(whole)) {
        push(whole);
        continue;
      }
      // 2) Sinon, plusieurs numéros séparés par des espaces sur la même ligne.
      const parts = field.split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        for (const p of parts) push(compact(p));
      } else {
        push(whole);
      }
    }
  }

  return { valid, invalid, duplicates, total: valid.length + invalid.length + duplicates };
}
