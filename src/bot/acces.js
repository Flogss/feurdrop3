// Qui peut se servir du bot.
//
// Avant, n'importe quel compte Telegram tombant sur le bot pouvait lui
// envoyer des fichiers en prive (comptes comme colis, republies dans le
// groupe, imprimes automatiquement), demander /imprime (le PDF de TOUTES les
// etiquettes en attente, noms et adresses compris) ou effacer les regles
// apprises (/regles_reset).
//
// Trois sources d'autorisation, de la plus forte a la plus faible :
//   1. la liste blanche TELEGRAM_ALLOWED_USERS (identifiants Telegram separes
//      par des virgules) -- c'est aussi la seule qui ouvre les commandes
//      d'administration (/regles_reset) ;
//   2. le groupe de travail lui-meme : tout ce qui s'y passe est autorise,
//      Telegram en controle deja l'entree. Le fonctionnement du groupe ne
//      change donc pas ;
//   3. en prive, un membre du groupe de travail (verifie aupres de Telegram,
//      garde en memoire un moment) : l'equipe peut continuer a envoyer ses
//      fichiers au bot en tete-a-tete sans figurer dans la liste.
// Tout le reste est refuse, poliment en prive, en silence ailleurs.
//
// Sans TELEGRAM_ALLOWED_USERS, la liste reprend les identifiants
// d'utilisateurs de SUIVI_ALLOWED_CHATS (ceux du bot de suivi), pour ne
// fermer la porte a personne au premier deploiement.

const MEMBRE_TTL_MS = 60 * 60 * 1000; // un membre reste reconnu une heure
const INCONNU_TTL_MS = 5 * 60 * 1000; // un refus est reverifie apres 5 min
const STATUTS_MEMBRE = new Set(["creator", "administrator", "member"]);

function lisListe(texte) {
  return String(texte || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s)); // des utilisateurs : identifiants positifs
}

function listeDepuisEnvironnement(env = process.env) {
  const propre = lisListe(env.TELEGRAM_ALLOWED_USERS);
  if (propre.length) return { utilisateurs: propre, source: "TELEGRAM_ALLOWED_USERS" };
  const suivi = lisListe(env.SUIVI_ALLOWED_CHATS);
  if (suivi.length) return { utilisateurs: suivi, source: "SUIVI_ALLOWED_CHATS" };
  return { utilisateurs: [], source: null };
}

// Les acteurs d'un message ou d'un appui sur un bouton.
function acteurs(entree) {
  if (entree?.message && entree?.from && entree?.data !== undefined) {
    // callback_query : le chat est celui du message qui porte le bouton
    return { userId: entree.from.id, chat: entree.message.chat };
  }
  return { userId: entree?.from?.id ?? null, chat: entree?.chat ?? {} };
}

function creeControleAcces({
  groupeId,
  utilisateurs = [],
  membresDuGroupe = true,
  maintenant = () => Date.now(),
} = {}) {
  const liste = new Set(utilisateurs.map(String));
  const memoire = new Map(); // userId -> { ok, jusqua }

  const estAdmin = (userId) => userId != null && liste.has(String(userId));

  function enMemoire(userId) {
    const m = memoire.get(String(userId));
    if (!m) return null;
    if (m.jusqua < maintenant()) {
      memoire.delete(String(userId));
      return null;
    }
    return m.ok;
  }

  // true / false quand la reponse est connue sans rien demander a Telegram ;
  // null quand il faut verifier l'appartenance au groupe.
  function verdictImmediat(entree, { niveau = "equipe" } = {}) {
    const { userId, chat } = acteurs(entree);
    if (niveau === "admin") return estAdmin(userId);
    if (estAdmin(userId)) return true;
    if (chat?.id === groupeId) return true;
    if (chat?.type !== "private" || userId == null) return false;
    if (!membresDuGroupe) return false;
    return enMemoire(userId);
  }

  async function estMembre(bot, userId) {
    const deja = enMemoire(userId);
    if (deja !== null) return deja;
    let ok = false;
    let fiable = true;
    for (let essai = 1; essai <= 2; essai++) {
      try {
        const membre = await bot.getChatMember(groupeId, userId);
        ok = STATUTS_MEMBRE.has(membre?.status) || (membre?.status === "restricted" && membre?.is_member === true);
        fiable = true;
        break;
      } catch (err) {
        // "user not found" / "participant not found" : pas membre, c'est une
        // reponse ; le reste (reseau, 5xx) n'en est pas une
        fiable = /not found|PARTICIPANT|USER_ID_INVALID|member not found/i.test(err?.message || "");
        if (fiable) break;
        if (essai === 1) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (fiable) memoire.set(String(userId), { ok, jusqua: maintenant() + (ok ? MEMBRE_TTL_MS : INCONNU_TTL_MS) });
    return ok;
  }

  async function autorise(bot, entree, options = {}) {
    const verdict = verdictImmediat(entree, options);
    if (verdict !== null) return verdict;
    return estMembre(bot, acteurs(entree).userId);
  }

  return {
    verdictImmediat,
    autorise,
    estAdmin,
    // pour les journaux de demarrage et les tests
    taille: () => liste.size,
    oublie: () => memoire.clear(),
  };
}

module.exports = { creeControleAcces, listeDepuisEnvironnement, lisListe, acteurs };
