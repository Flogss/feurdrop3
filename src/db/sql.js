// Fragments SQL partages par plusieurs domaines (impression, tournee,
// drops, statistiques) : une seule definition de chaque regle.

// Statut des anciennes images de "special", qui valaient 0 EUR. Depuis que le
// code-barre d'un locker n'est plus un colis du tout (voir specials.js), plus
// rien n'est cree avec ce statut ; il reste pour les lignes d'avant, qui
// sortent de tous les comptes puisque tout filtre sur status = 'pending'.
const FREE_STATUS = "free";

// Jour comptable : rien ne se poste le dimanche, donc l'argent fait ce jour-la
// est compte sur le lundi qui suit. La courbe quotidienne n'a d'ailleurs pas de
// colonne dimanche : sans ce report, ces gains disparaissaient purement et
// simplement des statistiques. Le jour est celui de Paris (dropped_at est en
// UTC) : un drop de 23 h 30 compte pour ce jour-la, pas pour le lendemain.
const BUSINESS_DAY_SQL =
  "date(jour_paris(dropped_at), CASE strftime('%w', jour_paris(dropped_at)) WHEN '0' THEN '+1 day' ELSE '+0 day' END)";

// Etiquettes en attente pour un transporteur donne, dans l'ordre d'arrivee.
// Les LIT ont leur propre file : colis trop gros pour l'imprimante thermique,
// ils sortent sur le rouleau 210 mm. Les deux files sont donc disjointes.
const HAS_FILE_SQL = "status = 'pending' AND file_id IS NOT NULL";
const PRINTABLE_SQL = `${HAS_FILE_SQL} AND type != 'lit'`;
const LIT_PRINTABLE_SQL = `${HAS_FILE_SQL} AND type = 'lit'`;

// Un colis annote sort le premier : la note dit qu'il y a quelque chose a
// faire avec celui-la, autant l'avoir en haut de la pile.
const PRINT_ORDER_SQL = "ORDER BY note IS NULL, id";

// Colis en attente groupes par transporteur detecte (nom de fichier /
// description). "Autre" regroupe les colis dont le transporteur n'a pas pu
// etre determine.
// Les colis BJ forment leur propre ligne dans "compagnies a poster" : ils se
// deposent differemment, meme s'ils portent un numero de suivi transporteur.
// "Inconnu" ne devrait quasiment jamais apparaitre : le bot previent sur
// Telegram des qu'un fichier n'est pas reconnu, pour affiner les regles.
const CARRIER_GROUP_SQL = "CASE WHEN type = 'bj' THEN 'BJ' ELSE COALESCE(carrier, 'Inconnu') END";

// La file d'impression range en plus les speciaux a part, comme les LIT : on
// veut pouvoir les sortir seuls. Seulement ici -- sur le dashboard, un special
// reste range sous son transporteur, puisque c'est la qu'on le poste.
const PRINT_GROUP_SQL = `CASE WHEN type = 'special' THEN 'SPECIAL' ELSE ${CARRIER_GROUP_SQL} END`;
// le transporteur d'un colis tel que la tournee le range
const CODE_TOURNEE_SQL = "CASE WHEN type = 'bj' THEN 'BJ' ELSE COALESCE(carrier, 'Inconnu') END";

// Un drop groupe (tout, tout sauf les LIT, un transporteur, un expediteur, la
// fin de tournee) ne solde que ce qui est pret a partir : les etiquettes deja
// imprimees, et les colis sans fichier (comptes a la main : rien a imprimer).
// Une etiquette qui n'est jamais sortie de l'imprimante ne peut pas etre dans
// le sac : elle reste en attente, et la reponse dit combien (`restants`).
const PRET_SQL = "(printed_at IS NOT NULL OR file_id IS NULL)";

// Les images de "special" ont le statut "free" : elles ne comptent nulle part,
// mais on doit pouvoir les retirer comme les autres.
const VIVANT_SQL = `status IN ('pending', '${FREE_STATUS}')`;

// Un message designe un colis de deux facons : c'est sa copie dans le groupe,
// ou c'est le fichier d'origine envoye au bot en prive. Les deux doivent
// repondre a /lit, /normal, /note... sinon repondre a son propre envoi en prive
// ne trouve rien.
const PAR_MESSAGE_SQL =
  "((chat_id = ? AND message_id = ?) OR (source_chat_id = ? AND source_message_id = ?))";

// --- Impression automatique -------------------------------------------------
// L'agent installe sur le Mac vient chercher ici ce qui n'est pas encore
// sorti de l'imprimante. Les LIT en sont exclus comme pour /imprime : ils se
// font a la main.
const AUTOPRINT_SQL = `${PRINTABLE_SQL} AND printed_at IS NULL`;

module.exports = {
  FREE_STATUS,
  BUSINESS_DAY_SQL,
  HAS_FILE_SQL,
  PRINTABLE_SQL,
  LIT_PRINTABLE_SQL,
  PRINT_ORDER_SQL,
  CARRIER_GROUP_SQL,
  PRINT_GROUP_SQL,
  CODE_TOURNEE_SQL,
  PRET_SQL,
  VIVANT_SQL,
  PAR_MESSAGE_SQL,
  AUTOPRINT_SQL,
};
