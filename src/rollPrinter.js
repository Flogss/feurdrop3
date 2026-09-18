const { PDFDocument, degrees, rgb } = require("pdf-lib");
const { labelRegion } = require("./labelRegion");

// Impression des LIT sur rouleau continu (papier fax Exacompta, 210 mm de
// large). Les colis LIT sont trop gros pour l'imprimante thermique 4x6, on les
// sort donc sur rouleau. Sur un rouleau, la seule chose qui coute c'est la
// LONGUEUR : tout l'objectif est de la reduire.
//
//   - chaque bordereau est recadre sur son encre utile (voir labelRegion) ;
//   - on en pose autant que possible cote a cote, quitte a les reduire un peu,
//     avec un trait de coupe entre eux ;
//   - chaque rangee devient une page a sa hauteur exacte : sur un rouleau, une
//     page n'est qu'une longueur de papier.

const MM = 72 / 25.4;
const ROLL_WIDTH = Number(process.env.ROLL_WIDTH_MM || 210) * MM;
const MARGIN = 3 * MM; // bord du rouleau, l'entrainement du papier n'est jamais parfait
const GAP = 4 * MM; // de quoi passer les ciseaux entre deux bordereaux
const USABLE_WIDTH = ROLL_WIDTH - MARGIN * 2;
const MIN_SCALE = 0.75; // en-dessous, les barres du code-barres deviennent douteuses
const MAX_PER_ROW = 3;

// Les deux orientations possibles d'un bordereau, avec son encombrement sur le
// rouleau (outW : en travers, outH : dans la longueur).
function orientations(label) {
  return [
    { rotation: 0, outW: label.width, outH: label.height },
    { rotation: 90, outW: label.height, outH: label.width },
  ];
}

// Met une rangee a l'echelle. On cherche la hauteur commune t la plus petite :
// a hauteur t, un bordereau occupe t x (outW / outH) de largeur, donc
// t = largeur disponible / somme des rapports. Un bordereau qui voudrait
// depasser sa taille naturelle est plafonne a 1 et la place qu'il n'utilise
// pas est redistribuee aux autres.
function fitRow(forms) {
  const available = USABLE_WIDTH - GAP * (forms.length - 1);
  if (available <= 0) return null;

  const scales = forms.map(() => 1);
  const capped = forms.map(() => false);

  for (let pass = 0; pass <= forms.length; pass += 1) {
    let width = available;
    let ratios = 0;
    forms.forEach((form, i) => {
      if (capped[i]) width -= form.outW;
      else ratios += form.outW / form.outH;
    });
    if (ratios === 0) break; // tout le monde est a sa taille naturelle
    if (width <= 0) return null;

    const t = width / ratios;
    let changed = false;
    forms.forEach((form, i) => {
      if (!capped[i] && t > form.outH) {
        capped[i] = true;
        scales[i] = 1;
        changed = true;
      }
    });
    if (!changed) {
      forms.forEach((form, i) => {
        if (!capped[i]) scales[i] = t / form.outH;
      });
      break;
    }
  }

  const used = forms.reduce((sum, form, i) => sum + form.outW * scales[i], 0) + GAP * (forms.length - 1);
  if (used > USABLE_WIDTH + 0.5) return null;

  return {
    scales,
    height: Math.max(...forms.map((form, i) => form.outH * scales[i])),
    minScale: Math.min(...scales),
  };
}

// Meilleure mise en page d'une rangee : on essaie les orientations (2 par
// bordereau, donc 8 combinaisons au plus) et on garde la plus courte.
function bestRow(labels, { allowSmall = false } = {}) {
  if (labels.length > MAX_PER_ROW) return null;
  const choices = labels.map(orientations);
  let best = null;

  const explore = (index, forms) => {
    if (index === labels.length) {
      const fit = fitRow(forms);
      if (!fit) return;
      if (!allowSmall && fit.minScale < MIN_SCALE) return;
      if (!best || fit.height < best.height - 0.5) best = { ...fit, forms: [...forms] };
      return;
    }
    for (const form of choices[index]) explore(index + 1, [...forms, form]);
  };
  explore(0, []);

  return best;
}

// Un bordereau photographie est aussi valable qu'un PDF : beaucoup de LIT
// arrivent en photo Telegram. On l'emballe dans un PDF d'une page a sa taille
// exacte, et tout le reste de la chaine -- recadrage sur l'encre, rotation,
// mise en rangee -- s'applique sans changement.
async function imageToPdf(bytes) {
  const header = Buffer.from(bytes.slice(0, 4));
  const isPng = header[0] === 0x89 && header[1] === 0x50;

  const doc = await PDFDocument.create();
  const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return doc.save();
}

// Prepare un bordereau : page source, zone utile, taille une fois recadree.
async function prepareLabel(out, item) {
  const bytes = item.kind === "image" ? await imageToPdf(item.bytes) : item.bytes;
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const prepared = [];

  for (let i = 0; i < source.getPageCount(); i += 1) {
    const region = await labelRegion(bytes, i).catch(() => null);
    const page = source.getPage(i);
    const media = page.getMediaBox();
    const box = region || {
      left: media.x,
      bottom: media.y,
      right: media.x + media.width,
      top: media.y + media.height,
      trimmed: false,
    };

    const width = box.right - box.left;
    const height = box.top - box.bottom;
    if (width < 10 || height < 10) continue;

    const embedded = await out.embedPage(page, {
      left: box.left,
      bottom: box.bottom,
      right: box.right,
      top: box.top,
    });

    prepared.push({ embedded, width, height, trimmed: box.trimmed });
  }
  return prepared;
}

// Pose un bordereau ; la rotation se fait autour de (x, y), donc l'ancre
// change de coin.
function placeOn(page, label, form, scale, left, bottom) {
  const scaledW = label.width * scale;
  const scaledH = label.height * scale;
  const anchor = form.rotation === 90 ? { x: left + scaledH, y: bottom } : { x: left, y: bottom };

  page.drawPage(label.embedded, {
    x: anchor.x,
    y: anchor.y,
    width: scaledW,
    height: scaledH,
    rotate: degrees(form.rotation),
  });
}

// Trait de coupe horizontal, entre deux bordereaux empiles.
function drawCutLineH(page, y, left, right) {
  page.drawLine({
    start: { x: left, y },
    end: { x: right, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
    dashArray: [3, 3],
  });
}

// Trait de coupe discret entre deux bordereaux.
function drawCutLine(page, x, top, bottom) {
  page.drawLine({
    start: { x, y: bottom },
    end: { x, y: top },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
    dashArray: [3, 3],
  });
}

// --- Mise en colonnes ---------------------------------------------------------
//
// Les rangees gaspillaient : une rangee fait la hauteur de son plus grand
// bordereau, donc un petit bordereau a cote d'un grand laissait un trou sous
// lui. On empile desormais VERTICALEMENT dans deux colonnes, et le rouleau ne
// mesure plus que la plus haute des deux.
//
// La decoupe reste simple : un trait vertical sur toute la longueur pour
// separer les colonnes, puis un trait horizontal entre deux bordereaux d'une
// meme colonne.

const COLUMNS = 2;
const COLUMN_WIDTH = (USABLE_WIDTH - GAP) / COLUMNS;
// au-dela, la feuille devient ingerable a manipuler ; on repart sur une page
const MAX_PAGE = 1200 * MM;

// Place un bordereau dans une colonne : orientation qui remplit le mieux la
// largeur disponible sans jamais agrandir.
function fitColumn(label, width) {
  const options = orientations(label).map((form) => {
    const scale = Math.min(1, width / form.outW);
    return { form, scale, w: form.outW * scale, h: form.outH * scale };
  });
  const lisibles = options.filter((o) => o.scale >= MIN_SCALE);
  const retenues = lisibles.length > 0 ? lisibles : options;
  // a lisibilite egale, l'orientation la plus courte sur le rouleau
  return retenues.reduce((a, b) => (b.h < a.h - 0.5 ? b : a));
}

// Repartit les bordereaux entre les colonnes. On place le plus grand d'abord
// dans la colonne la moins chargee : c'est la regle qui equilibre le mieux
// deux piles, et ici equilibrer, c'est raccourcir le rouleau.
function packColumns(labels) {
  const pleine = [];
  const colonnables = [];

  for (const label of labels) {
    const demi = fitColumn(label, COLUMN_WIDTH);
    // trop large meme reduit : il prendra toute la laize, seul
    if (demi.scale < MIN_SCALE) pleine.push({ label, ...fitColumn(label, USABLE_WIDTH) });
    else colonnables.push({ label, ...demi });
  }

  const colonnes = Array.from({ length: COLUMNS }, () => ({ items: [], height: 0 }));
  for (const item of colonnables.sort((a, b) => b.h - a.h)) {
    const cible = colonnes.reduce((a, b) => (b.height < a.height ? b : a));
    cible.items.push(item);
    cible.height += item.h + (cible.items.length > 1 ? GAP : 0);
  }

  return { colonnes, pleine };
}

// Assemble les bordereaux sur le rouleau. `labels` : [{ bytes, label }].
async function buildRoll(labels) {
  const out = await PDFDocument.create();
  const failed = [];
  const prepared = [];

  for (const item of labels) {
    try {
      prepared.push(...(await prepareLabel(out, item)));
    } catch (err) {
      failed.push({ label: item.label, reason: err.message });
    }
  }

  if (prepared.length === 0) return { pdf: null, pages: 0, rows: 0, trimmed: 0, failed };

  const { colonnes, pleine } = packColumns(prepared);
  let length = 0;
  let rangees = 0;

  // --- les deux colonnes, sur une meme bande de rouleau ---------------------
  const hauteur = Math.max(...colonnes.map((c) => c.height), 0);
  if (hauteur > 0) {
    // au-dela d'une certaine longueur la feuille devient ingerable : on coupe
    const bandes = Math.max(1, Math.ceil(hauteur / MAX_PAGE));
    const parBande = hauteur / bandes;

    for (let b = 0; b < bandes; b += 1) {
      const debut = b * parBande;
      const fin = debut + parBande;
      const dansBande = colonnes.map((c) => {
        let y = 0;
        return c.items.filter((item) => {
          const haut = y + item.h;
          const dedans = y >= debut - 0.5 && haut <= fin + 0.5;
          y = haut + GAP;
          return dedans;
        });
      });

      const hauteurBande = Math.max(
        ...dansBande.map((items) => items.reduce((sum, it) => sum + it.h, 0) + GAP * Math.max(0, items.length - 1)),
        0
      );
      if (hauteurBande <= 0) continue;

      const page = out.addPage([ROLL_WIDTH, hauteurBande + MARGIN * 2]);
      length += hauteurBande + MARGIN * 2;
      rangees += 1;

      dansBande.forEach((items, col) => {
        const x = MARGIN + col * (COLUMN_WIDTH + GAP);
        // empile du haut vers le bas : l'ordre de lecture d'une pile
        let y = MARGIN + hauteurBande;
        items.forEach((item, i) => {
          y -= item.h;
          // centre dans la largeur de colonne : un bordereau etroit ne colle
          // pas au trait de coupe
          placeOn(page, item.label, item.form, item.scale, x + (COLUMN_WIDTH - item.w) / 2, y);
          if (i < items.length - 1) {
            drawCutLineH(page, y - GAP / 2, x, x + COLUMN_WIDTH);
          }
          y -= GAP;
        });
      });

      // un seul trait vertical, sur toute la bande : une coupe et deux piles
      if (dansBande.every((items) => items.length > 0)) {
        drawCutLine(page, MARGIN + COLUMN_WIDTH + GAP / 2, hauteurBande + MARGIN, MARGIN);
      }
    }
  }

  // --- les bordereaux trop larges pour une colonne, chacun sur sa bande -----
  for (const item of pleine) {
    const page = out.addPage([ROLL_WIDTH, item.h + MARGIN * 2]);
    length += item.h + MARGIN * 2;
    rangees += 1;
    placeOn(page, item.label, item.form, item.scale, (ROLL_WIDTH - item.w) / 2, MARGIN);
  }

  return {
    pdf: Buffer.from(await out.save()),
    pages: out.getPageCount(),
    rows: rangees,
    lengthMm: Math.round(length / MM),
    trimmed: prepared.filter((l) => l.trimmed).length,
    labels: prepared.length,
    failed,
  };
}

module.exports = { buildRoll, ROLL_WIDTH };
