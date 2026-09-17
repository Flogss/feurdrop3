/**
 * Interprétation d'un `shipment` renvoyé par l'API Suivi v2 en un statut simple.
 * Fonctions pures, testables sans réseau.
 */

export const MILESTONE_FR = {
  pending: 'En attente',
  info_received: 'Pris en charge',
  in_transit: 'En transit',
  out_for_delivery: 'En cours de livraison',
  delivered: 'Livré',
  final_other: 'Clôturé (retour/échec)',
  expired: 'Expiré (sans suite)',
  not_found: 'Introuvable',
  unknown: 'Inconnu',
};

export const MILESTONE_ICON = {
  delivered: '✅',
  out_for_delivery: '🚚',
  in_transit: '📦',
  info_received: '📥',
  pending: '🕓',
  final_other: '↩️',
  expired: '⌛',
  not_found: '❓',
  unknown: '❔',
};

/** Ordre d'affichage des groupes de statut (le plus « abouti » d'abord). */
export const STATUS_RANK = {
  delivered: 1,
  out_for_delivery: 2,
  in_transit: 3,
  info_received: 4,
  pending: 5,
  final_other: 6,
  expired: 7,
  unknown: 8,
  not_found: 90,
};

export const rankOf = (milestone) => STATUS_RANK[milestone] ?? 50;

// Les codes événement « distribué/livré » de l'API commencent par DI.
const DELIVERED_CODE = /^DI/i;

/**
 * @param {object|null} shipment  bloc `shipment` de la réponse Okapi
 * @returns statut agrégé + indicateurs booléens
 */
export function interpret(shipment) {
  if (!shipment) {
    return {
      found: false,
      milestone: 'unknown',
      delivered: false,
      final: false,
      lastLabel: null,
      lastCode: null,
      lastEventAt: null,
      deliveryDate: null,
      stepId: 0,
      product: null,
      url: null,
    };
  }

  const events = Array.isArray(shipment.event) ? shipment.event : [];
  // On ne se fie pas à l'ordre : tri par date décroissante, puis par `order`.
  const sorted = [...events].sort(
    (a, b) =>
      (Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0) ||
      (b.order ?? 0) - (a.order ?? 0),
  );
  const last = sorted[0] ?? null;

  const timeline = Array.isArray(shipment.timeline) ? shipment.timeline : [];
  const maxStep = timeline.reduce((m, s) => (s?.status && s?.id > m ? s.id : m), 0);

  // Trois signaux convergents pour « livré », pour éviter les faux positifs :
  const deliveredByDate = Boolean(shipment.deliveryDate); // rempli seulement à la livraison réelle
  const deliveredByCode = sorted.some((e) => DELIVERED_CODE.test(e?.code ?? ''));
  const deliveredByStep = timeline.some(
    (s) => s?.status && (s.id === 5 || /livr/i.test(s.shortLabel ?? '') || /livr/i.test(s.longLabel ?? '')),
  );
  const delivered = deliveredByDate || deliveredByCode || deliveredByStep;

  const final = Boolean(shipment.isFinal) || delivered;

  let milestone;
  if (delivered) milestone = 'delivered';
  else if (final) milestone = 'final_other'; // isFinal sans signal de livraison => retour/échec/clôture
  else if (maxStep >= 4) milestone = 'out_for_delivery';
  else if (maxStep >= 2) milestone = 'in_transit';
  else if (maxStep >= 1) milestone = 'info_received';
  else milestone = 'pending';

  return {
    found: events.length > 0 || timeline.length > 0 || shipment.isFinal != null,
    milestone,
    delivered,
    final,
    lastLabel: last?.label ?? null,
    lastCode: last?.code ?? null,
    lastEventAt: last?.date ?? null,
    deliveryDate: shipment.deliveryDate ?? null,
    stepId: maxStep,
    product: shipment.product ?? null,
    url: shipment.url ?? shipment.urlDetail ?? null,
  };
}
