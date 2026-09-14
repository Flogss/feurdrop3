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

// Longueur de rouleau consommee par une rangee, marges comprises.
function rowCost(fit) {
  return fit.height + MARGIN * 2;
}

// Rabotage : on reprend deux rangees, on remelange leurs bordereaux de toutes
// les facons possibles et on garde la meilleure. C'est ce qui rattrape les
// mauvais choix de la fusion gloutonne, qui apparie d'abord ce qui fait gagner
// le plus tout de suite et laisse parfois un bordereau seul alors qu'il tenait
// a cote d'un autre.
function refineRows(rows) {
  for (let guard = 0; guard < 200; guard += 1) {
    let best = null;
    for (let i = 0; i < rows.length && !best; i += 1) {
      for (let j = i + 1; j < rows.length && !best; j += 1) {
        const pool = [...rows[i].labels, ...rows[j].labels];
        if (pool.length > MAX_PER_ROW * 2) continue;
        const current = rowCost(rows[i].fit) + rowCost(rows[j].fit);

        for (let mask = 1; mask < 1 << pool.length; mask += 1) {
          const left = pool.filter((_, k) => (mask >> k) & 1);
          const right = pool.filter((_, k) => !((mask >> k) & 1));
          if (left.length > MAX_PER_ROW || right.length > MAX_PER_ROW) continue;

          const fitLeft = bestRow(left);
          if (!fitLeft) continue;
          const fitRight = right.length ? bestRow(right) : null;
          if (right.length && !fitRight) continue;

          const total = rowCost(fitLeft) + (fitRight ? rowCost(fitRight) : 0);
          if (total < current - 1 && (!best || total < best.total)) {
            best = { i, j, total, rows: [{ labels: left, fit: fitLeft }].concat(fitRight ? [{ labels: right, fit: fitRight }] : []) };
          }
        }
      }
    }
    if (!best) return rows;
    rows.splice(best.j, 1);
    rows.splice(best.i, 1, ...best.rows);
  }
  return rows;
}

// Regroupe les bordereaux en rangees. On part d'un bordereau par rangee, puis
// on fusionne a chaque tour les deux rangees qui font gagner le plus de
// papier, jusqu'a ce qu'aucune fusion ne fasse gagner quoi que ce soit.
function buildRows(labels) {
  const rows = labels.map((label) => ({
    labels: [label],
    fit: bestRow([label]) || bestRow([label], { allowSmall: true }),
  }));

  for (;;) {
    let merge = null;
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        if (rows[i].labels.length + rows[j].labels.length > MAX_PER_ROW) continue;
        const merged = bestRow([...rows[i].labels, ...rows[j].labels]);
        if (!merged) continue;
        // une rangee en moins, c'est aussi deux marges en moins
        const gain = rows[i].fit.height + rows[j].fit.height + MARGIN * 2 - merged.height;
        if (gain > 1 && (!merge || gain > merge.gain)) merge = { i, j, merged, gain };
      }
    }
    if (!merge) break;
    rows[merge.i] = { labels: [...rows[merge.i].labels, ...rows[merge.j].labels], fit: merge.merged };
    rows.splice(merge.j, 1);
  }

  return refineRows(rows);
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

  const rows = buildRows(prepared);
  let length = 0;

  for (const row of rows) {
    const { labels: items, fit } = row;
    const page = out.addPage([ROLL_WIDTH, fit.height + MARGIN * 2]);
    length += fit.height + MARGIN * 2;

    // la place en trop est repartie a parts egales entre les bords et les
    // intervalles : les bordereaux restent centres et le trait de coupe tombe
    // bien au milieu
    const drawn = items.map((label, i) => fit.forms[i].outW * fit.scales[i]);
    const spare = USABLE_WIDTH - drawn.reduce((a, b) => a + b, 0) - GAP * (items.length - 1);
    const extra = Math.max(0, spare) / (items.length + 1);

    let x = MARGIN + extra;
    items.forEach((label, i) => {
      const form = fit.forms[i];
      const scale = fit.scales[i];
      // centre verticalement : plus lisible quand les bordereaux d'une rangee
      // n'ont pas la meme hauteur
      const bottom = MARGIN + (fit.height - form.outH * scale) / 2;
      placeOn(page, label, form, scale, x, bottom);
      x += drawn[i];
      if (i < items.length - 1) {
        drawCutLine(page, x + (GAP + extra) / 2, fit.height + MARGIN, MARGIN);
        x += GAP + extra;
      }
    });
  }

  return {
    pdf: Buffer.from(await out.save()),
    pages: out.getPageCount(),
    rows: rows.length,
    lengthMm: Math.round(length / MM),
    trimmed: prepared.filter((l) => l.trimmed).length,
    labels: prepared.length,
    failed,
  };
}

module.exports = { buildRoll, ROLL_WIDTH };
