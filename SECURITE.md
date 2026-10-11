# Sécurité du dashboard FeurDrop

Le dashboard (site et app iPhone/Mac) n'est accessible qu'avec le mot de passe.
Chaque appareil garde sa propre session, et le mot de passe est redemandé
**72 heures après chaque connexion**, quoi qu'il arrive. Le serveur vérifie
la session à **chaque requête** : sans session valable, l'API répond
`401 Unauthorized` et le site renvoie à la page de connexion.

## Choisir ou changer le mot de passe

Le mot de passe n'est écrit nulle part : ni dans le code, ni dans GitHub, ni
dans la base, ni sur Railway. Le serveur ne connaît que son **empreinte
Argon2id**, dans la variable `DASHBOARD_PASSWORD_HASH`.

**En ligne (Railway)**, depuis le dossier du projet sur ton Mac :

```bash
npm run mot-de-passe -- --railway
```

Le script demande le mot de passe deux fois sans l'afficher (12 caractères
minimum ; une phrase est idéale). Il calcule l'empreinte et la pose sur le
service `feurdrop3` par la CLI Railway, via l'entrée standard (jamais dans la
ligne de commande). Railway redéploie tout seul.

Sans la CLI : `npm run mot-de-passe` affiche l'empreinte. Colle-la dans
Railway > feurdrop3 > Variables > `DASHBOARD_PASSWORD_HASH`.

**En local** : `npm run mot-de-passe -- --local` l'écrit dans `.env`, qui
n'est jamais versionné. Redémarre ensuite le serveur.

Tant que `DASHBOARD_PASSWORD_HASH` est absente ou invalide, le dashboard reste
**fermé**. Il ne s'ouvre jamais par défaut.

## Révoquer les sessions

- **Se déconnecter** : Réglages > Connexion > « Se déconnecter » (site ou
  app). La session est fermée côté serveur : l'ancien cookie ou jeton ne vaut
  plus rien.
- **Tout fermer** (accès suspect, appareil perdu) : Réglages > « Déconnecter
  tous les appareils ».
- **Changer le mot de passe** (`npm run mot-de-passe -- --railway`) ferme
  aussi toutes les sessions ouvertes avec l'ancien.
- Là où tourne la base : `npm run sessions` liste les sessions,
  `npm run sessions -- --revoquer` les ferme toutes.

## Qui peut entrer, et par où

| Accès | Routes | Contrôle |
|---|---|---|
| Public (rien de privé) | `GET /connexion`, `POST /api/auth/connexion`, `POST /api/auth/deconnexion`, fichiers de la page de connexion (`styles.css`, `connexion.js`, icônes, `manifest.json`, `sw.js`, `particules.js`) | — |
| Portail expéditeur | `GET /api/portail/:jeton` | le jeton de l'expéditeur : ses colis, rien d'autre (limite d'essais par adresse) |
| Agent d'impression | `GET /api/print/queue`, `GET /api/print/next`, `POST /api/print/done` | son jeton, en-tête `X-Print-Token` (et rien d'autre ne l'accepte) |
| Bot Telegram | aucune route | il interroge Telegram lui-même (polling) |
| **Dashboard** | **tout le reste** : la page, `app.js`, et les 78 routes de l'API ci-dessous | session valable (cookie du site ou jeton de l'app) ; écritures du site : jeton anti-CSRF + même origine |

Routes de l'API protégées par la session. Le test `test/securite.test.js`
les relit dans le code et vérifie que chacune répond 401 sans session :

- **Colis et drops** : `GET /api/colis`, `GET /api/colis/nouveaux`, `POST /api/colis/:id/drop|undrop|type`, `POST /api/colis/drop-all`, `drop-all-except-lit`, `drop-sender/:name`, `drop-carrier/:carrier`, `quick-add/:sender`, `quick-remove/:sender`
- **Étiquettes et impression** : `GET /api/print/resume`, `GET /api/print/colis`, `POST /api/print/build`, `GET /api/print/job/:id.pdf`, `POST /api/print/job/:id/imprime`, `PATCH|DELETE /api/print/colis/:id`, `POST /api/print/colis/:id/drop`, `POST /api/print/auto`
- **Expéditeurs, liens privés et fusions** : `GET|POST /api/senders`, `PUT|DELETE /api/senders/:id`, `POST|DELETE /api/senders/:id/portail`, `GET /api/senders/merge-candidates`, `POST /api/senders/merge`, `POST /api/senders/merge-to-other`
- **Stock** : `GET /api/stock`, `POST /api/stock/adjust`
- **Statistiques et montants** : `GET /api/stats`, `GET /api/stats/revenue`, `.../daily-series`, `.../weekly-series`, `GET /api/journal`
- **Dettes** : `GET /api/debts`, `POST /api/debts/:sender/pay`
- **Tournées** : `GET /api/tour/choix`, `POST /api/tour/start|finish|end|dismiss-summary`
- **Codes spéciaux** : `GET /api/special/paires`, `POST /api/special/paires/:id/fini`, `GET /api/special/code/:id`
- **Suivi** : `GET /api/suivi/overview|live|recheck|label|search|ip-sortie`, `POST /api/suivi/recheck|verifier|annuler`
- **Contrôle des dépôts** : `GET /api/depots`, `GET /api/depots/resume`, `GET /api/depots/:colisId`, `POST /api/depots/relancer`, `POST /api/depots/:colisId/verifier|constat`, « Tout vérifier » : `POST /api/depots/campagne`, `GET /api/depots/campagne`, `POST /api/depots/campagne/annuler`, `GET /api/depots/agent`, `GET /api/depots/campagne/travail` et `POST /api/depots/campagne/resultats` (l'app Drop du Mac, avec sa session), `POST /api/depots/lecture/:code`
- **Notifications et réglages** : `GET /api/push/key`, `POST /api/push/subscribe|unsubscribe|seen|test`, `GET /api/config`, `GET /api/diagnostic`
- **Sessions** : `GET /api/auth/session`, `GET /api/auth/sessions`, `POST /api/auth/deconnexion-partout`

Toute autre adresse sous `/api` répond aussi 401 sans session, puis 404 avec.

## Ce qui protège

- **Mot de passe** : empreinte Argon2id (64 Mio, 3 passes), vérification à
  temps constant. Toute valeur qui n'est pas une empreinte Argon2id est
  refusée (pas de mot de passe en clair possible).
- **Sessions** : jeton aléatoire de 256 bits. La base n'en garde que
  l'empreinte SHA-256. Une session neuve à chaque connexion (pas de fixation
  de session). Expiration **absolue** à 72 h, vérifiée par le serveur à chaque
  requête et jamais repoussée par l'activité. Révocation côté serveur.
- **Site** : cookie `HttpOnly`, `Secure`, `SameSite=Lax`, préfixé `__Host-`
  en HTTPS, persistant mais jamais au-delà de la fin de session. Rien dans
  `localStorage`.
- **App iPhone/Mac** : jeton `Bearer` dans le trousseau (Keychain), propre à
  l'appareil et jamais synchronisé.
- **CSRF** : toute écriture faite avec le cookie doit porter le jeton
  anti-CSRF (HMAC de la session, lu dans un second cookie) et venir de la
  même origine (`Origin` / `Sec-Fetch-Site`). Sinon : 403.
- **Essais de connexion** : 3 essais libres par adresse, puis une attente qui
  double à chaque échec (2 s, 4 s, 8 s… 15 min au plus). Au-delà de 60 échecs
  en 15 min toutes adresses confondues, plus aucun essai n'est accepté
  pendant la fenêtre. Chaque échec attend aussi 300 à 700 ms. Le message
  d'échec est le même quelle que soit la cause.
- **HTTPS obligatoire** en production : redirection 301, refus 403 des
  écritures en clair, HSTS. Seule exception : le réseau privé de Railway,
  par lequel le portail demande les colis.
- **En-têtes** : CSP stricte (aucun script en ligne), `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy`, `Cache-Control: no-store` sur l'API et les
  pages privées.
- **Journaux** : jamais le mot de passe, son empreinte, un jeton ou un cookie
  (vérifié par les tests).
- **Sauvegardes** (`/save`) : ni les sessions, ni le secret anti-CSRF.

## Tests

`npm test` exécute notamment `test/securite.test.js` :
1. le site sans connexion ;
2. toutes les routes privées sans session, avec un faux jeton et avec un faux
   cookie ;
3. la session gardée après fermeture du navigateur ;
4. un autre appareil ;
5. l'expiration à 72 h malgré une activité continue (horloge simulée côté
   serveur) ;
6. un ancien cookie après expiration ;
7. les PDF d'étiquettes ;
8. les modifications et suppressions sans session, et le CSRF ;
9. la déconnexion, « tout déconnecter » et le changement de mot de passe ;
10. l'agent d'impression, le portail et l'app.

Ils couvrent aussi la limite d'essais, la régénération de session, les
journaux, le dashboard fermé sans mot de passe configuré et le HTTPS.
