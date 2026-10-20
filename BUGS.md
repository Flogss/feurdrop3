# Suivi des bugs — audit FeurDrop

Audit commencé le 20/10/2026 sur l'état `afbd9b9` (arbre propre, 189 tests serveur, 22 tests Swift).

Environnements réellement utilisés pour l'audit :

- **Serveur** : Node local + base de démonstration (`data/demo.db`, 141 colis en attente, 120 expéditeurs) ; tests `node --test`.
- **Site** : navigateur intégré, 1024×768, 1440×900 et 393×852 (taille iPhone 15 Pro). Le panneau du navigateur étant masqué, ses animations ne sont pas jouées image par image : les animations web sont jugées par mesure (code, minuterie) et non à l'œil.
- **Mac** : app compilée (Debug et Release), captures de la fenêtre (`-DropCapture`, `-DropFilm`), MacBook Air M4 (écran 60 Hz).
- **iOS** : simulateur « iPhone 15 Pro » (iOS 27) ; iPhone 16 : simulateur créé pour l'audit si l'environnement le permet. Les vrais iPhone ne sont pas branchés pendant l'audit.

Gravité : **Critique** (données, opérations sur les colis, accès, impression, sécurité) · **Élevée** (fonction importante inutilisable, chargement infini, suivi faux, synchro) · **Moyenne** (lenteur, comportement imprévisible, affichage faux) · **Mineure** (visuel, détail).

Statuts : `à corriger` · `corrigé, à vérifier` · `vérifié` (test exécuté, résultat noté) · `non reproduit` · `à tester sur l'appareil`.

## Tableau

| ID | Gravité | Plateforme | Écran / fonction | Résumé | Statut |
|---|---|---|---|---|---|
| B01 | Critique | Serveur (toutes) | Impression auto | Activer l'impression auto marque « imprimées » toutes les étiquettes en attente, sans les imprimer | vérifié (tests) |
| B02 | Moyenne | Site, iOS, Mac | Contrôle des dépôts | « Vérification bloquée 72 — dont 92 à constater » : le sous-ensemble dépasse le total | vérifié (site, Mac, iPhone) |
| B03 | Moyenne | Site, iOS, Mac | Dashboard (stock, compteurs) | Une lecture partie avant une action arrive après elle et ré-affiche l'ancienne valeur | vérifié (tests Swift ; site : scénario rejoué dans le navigateur) |
| B04 | Mineure | Site | Stats, revenus par jour | La plage de dates affichée compte un point à moitié caché (« 15 oct. » alors que le 1er point visible est le 16) | vérifié (« 16 oct. – 20 oct. » = premier et dernier points visibles) |
| B05 | Mineure | Site (1024 px) | Dashboard | Placeholder « Rechercher u… » tronqué ; titre « Contrôle des dépôts » sur deux lignes à cause de sa pastille | vérifié (« Rechercher » à 120 px ; titre sur une ligne) |
| B06 | Moyenne | Site | Réglages | Avec beaucoup d'expéditeurs, la page fait 50 000 px (dettes, espaces, prix, regroupement listés en entier, sans recherche) | vérifié (5 776 px, recherche, voir/replier) |
| B07 | Mineure | Site (mobile) | Contrôle des dépôts | Le numéro de suivi, information principale de la ligne, est tronqué | vérifié (deux moitiés égales) |
| B08 | Mineure | Serveur | Tarifs | Changer le tarif d'un expéditeur ne met pas à jour ses colis « spéciaux » en attente (ils suivent pourtant le tarif normal) | vérifié (test) |
| B09 | Moyenne | Serveur | Opérations rejouées | Les clés d'idempotence sont en mémoire : un renvoi après un redémarrage (déploiement) peut appliquer deux fois un ajout de colis | vérifié (test qui échoue avant, passe après) |
| B10 | Moyenne | iOS, Mac | Stats, gains par expéditeur | Anneau vide et « 0,00 € » tant que 40 % du bloc (anneau + légende) n'est pas à l'écran, alors que l'anneau est déjà visible | vérifié (iPhone 15 Pro) |
| B11 | Mineure | Mac | Réglages | Les interrupteurs activés (notifications) sont gris, comme éteints | vérifié (capture Mac) |
| B12 | Mineure | iOS | Contrôle des dépôts | Texte d'introduction et bandeaux « lecture coupée » écrasés à côté de leur bouton (6 à 8 lignes) | vérifié (iPhone 15 Pro ; Mac inchangé) |
| B13 | Mineure | iOS | Stats | « Revenus par semaine » passe sur deux lignes à cause de la plage de dates | vérifié (iPhone 15 Pro) |
| B14 | Mineure | Mac | Dashboard, expéditeurs | Une barre de défilement apparaît dans la liste alors que l'app les masque partout ailleurs | corrigé, à vérifier |
| N01 | — | Site | Navigation | La page s'est rechargée seule pendant l'audit | non reproduit : navigation lancée par le panneau du navigateur (type « navigate », sans référent), aucun code du site ne navigue vers `/` |
| N02 | — | Site | Lancement | Logo du lancement resté au milieu de l'écran | non reproduit : artefact du panneau masqué (aucune image dessinée), le logo se pose normalement (vérifié à 9 s) |

| B15 | Mineure | iOS | Contrôle des dépôts | Sous-titre des compteurs coupé (« inconnu, illisible ou en é… ») | corrigé, à vérifier |
| B16 | Moyenne | Serveur, site | Stock | « 1.5 » accepté : le stock pouvait contenir 1,5 pochette | vérifié (test) |
| B17 | Critique | iOS | Tournée (et toutes les confirmations) | La confirmation « Tout est posté ? » s'ouvre en bulle au-dessus de la barre d'onglets : un appui sur « Oui, tout est dropé » termine la tournée ET change d'onglet ; une fois, l'appui n'a atteint que la barre d'onglets (tournée non terminée) | vérifié (simulateur iPhone 15 Pro) |
| B18 | Moyenne | Serveur, site, iOS | Dettes « Payé » | Un colis drope entre l'affichage et l'appui sur « Payé » était marqué payé aussi : plus que le montant confirmé | vérifié (test) |
| B19 | Mineure | Serveur | Impression (app) | Confirmation d'impression renvoyée après un redémarrage : seconde fournée identique dans le menu de réimpression | vérifié (test) |
| B20 | Mineure | iOS, Mac | Dashboard | La bulle « +N € » des cartes « Aujourd'hui » / « Gagné au total » couvrait leur titre | vérifié (simulateur) |
| B21 | Mineure | iOS | Dashboard en tournée | « Annuler » : texte violet sur pastille violette sur carte violette, peu lisible | vérifié (simulateur) |
| N03 | — | iOS (simulateur) | Onglets, boutons | Des appuis semblaient ignorés | non reproduit : l'outil du simulateur applique les appuis avec retard (captures faites trop tôt) ; à confirmer sur l'iPhone |

## Détail

### B01 — Activer l'impression auto « imprime » tout le stock sans l'imprimer
- **Plateforme** : serveur, donc site, iOS et Mac (l'interrupteur est partout).
- **Reproduction** : avoir des étiquettes « À imprimer », activer l'impression auto → elles passent toutes « imprimées » (journal : « N étiquettes considérées comme imprimées »), disparaissent de « À imprimer » et comptent comme prêtes pour la tournée.
- **Cause** : `setAutoPrintEnabled` appelle `markPendingAsPrinted()` pour que l'agent ne sorte pas tout le stock d'un coup. Le moyen choisi falsifie l'état : rien n'a été imprimé.
- **Correction prévue** : à l'activation, mémoriser un point de départ (le dernier colis existant) ; la file automatique ne prend que les colis arrivés après. Le stock existant reste « À imprimer », à la main.

### B02 — Compteur « dont N à constater » incohérent
- **Reproduction** : contrôle des dépôts avec des colis UPS « à constater » en catégorie « non confirmé » → la carte « Vérification bloquée » affiche un « dont » plus grand que son total (72 / 92 dans la démo).
- **Cause** : le serveur compte `aConstater` sur toutes les catégories ; les interfaces l'affichent sous « bloquée ».
- **Correction prévue** : le serveur fournit aussi le nombre « à constater » parmi les bloqués ; les trois interfaces l'utilisent.

### B03 — Ancienne réponse qui écrase une action récente
- **Reproduction** (logique, fenêtre de quelques centaines de ms) : le rafraîchissement de fond (5 s) part, on appuie sur « + » du stock ou on drope un transporteur ; la réponse de l'action arrive, puis celle du rafraîchissement, partie avant : l'ancienne valeur revient jusqu'au rafraîchissement suivant.
- **Cause** : aucune lecture ne sait si une écriture est passée pendant qu'elle était en route (site : `loadStats`/`loadStock` ; app : `DashboardModel.refresh`).
- **Correction prévue** : un compteur d'écritures (celles qui modifient le dashboard) au niveau du client réseau ; une lecture qui a croisé une écriture est ignorée, celle qui suit l'écriture fait foi.

### B04 — Plage de dates du graphique « Revenus par jour »
- **Cause** : `visibleRange` arrondit au plus proche ; un point coupé par le bord compte comme visible.
- **Correction prévue** : ne compter que les points entièrement visibles.

### B05 — Textes tronqués sur le dashboard (1024 px)
- Placeholder « Rechercher u… » du champ expéditeurs ; « Contrôle des dépôts » passe sur deux lignes.

### B06 — Réglages interminable avec beaucoup d'expéditeurs
- Mesure : `document.scrollHeight` = 50 254 px en 393 px de large avec 120 expéditeurs (dettes 4 200 px, espaces 12 800 px, prix 24 000 px). En production (7 expéditeurs) la page reste courte, mais elle ne tient pas la croissance.
- **Correction prévue** : un champ de recherche commun aux sections par expéditeur, et la liste des dettes repliée au-delà de quelques lignes.

### B07 — Numéro de suivi tronqué (contrôle, mobile)
- « JJD014600010000… » : le numéro est ce qu'on cherche à lire.

### B08 — Tarif des spéciaux non suivi
- **Cause** : `updateSenderPrices` met à jour les types normal, LIT, BJ, pas « special ».

### B09 — Idempotence perdue au redémarrage
- **Cause** : `src/idempotence.js` garde les clés dans une `Map` du processus.
- **Correction prévue** : garder les clés (et la réponse) en base, 30 minutes, via une migration additive.

### Résultats des vérifications (lot 1)

- **B01** : `test/impression-auto.test.js` — l'étiquette d'avant l'activation reste `printed_at = NULL` et dans « À imprimer », l'agent ne la reçoit pas ; test « base déjà en impression auto » : au premier passage après déploiement, le repère se pose et rien d'ancien ne part.
- **B02** : serveur `aConstater 92 / aConstaterBloques 72 / bloque 72` ; site, Mac et iPhone affichent « dont 72 à constater ».
- **B03** : `LecturesTests.swift` — une lecture qui croise une écriture est déclarée périmée ; les écritures de fond (pages de suivi, « vu ») ne gèlent pas le dashboard.
- **B06** : hauteur de Réglages 50 254 → 5 776 px (393 px de large, 120 expéditeurs) ; recherche « lina » → 4 lignes ; « zzz » → message clair ; « Voir les 57 autres » / « Replier ».
- **B07** : « JJD0146000 / 100000429 » sur deux moitiés égales (coupure `<wbr>` au milieu, sans effet sur le copier-coller).
- **B08** : `test/poids.test.js` — un spécial à 4 € + 1 kg passe à 7 € quand le tarif normal passe à 6 €.
- **B09** : `test/blocages.test.js` — modules du serveur rechargés (redémarrage simulé), même clé renvoyée : réponse rejouée, 2 colis ajoutés et pas 4. Le test échoue sur l'ancien code.
- **B10–B13** : captures Mac (premier plan) et simulateur iPhone 15 Pro.
- Suite complète : 192 tests serveur, 24 tests Swift, lint OK.

### Résultats des vérifications (lot 2)

- **B16** : `test/operations.test.js` — `delta: 1.5` et `"abc"` → 400 ; `3` → 200.
- **B17** : reproduit deux fois sur le simulateur (une fois l'appui a changé d'onglet sans terminer la tournée, une fois il a terminé la tournée ET changé d'onglet). Les 15 confirmations de l'app passent en alerte centrée (`.alert`) : le fond et la barre d'onglets sont bloqués. Vérifié : « Oui, tout est dropé » termine la tournée (serveur : plus de tournée, 0 en attente) et l'app reste sur le Dashboard.
- **B18** : `test/operations.test.js` — l'écran a montré 4 €, un autre colis est dropé, « Payé » avec 4 € → 409 et rien n'est marqué ; avec 8 € → 2 colis marqués ; renvoyé → 0, sans erreur. L'app relit la liste après un refus.
- **B19** : `test/operations.test.js` — deux confirmations pour une fournée oubliée : une seule fournée.
- **B20** : captures image par image après un drop : la bulle se pose à cheval sur le coin de la carte, les titres restent lisibles.
- Opérations groupées ajoutées aux tests (aucun test ne les couvrait) : drop par transporteur, par expéditeur, sauf LIT, boîtes jaunes (stock BJ), drop en tournée limité au sac, modification et retrait d'un colis.

- **B03 (site)** : dans le navigateur, une lecture du stock ralentie de 1,2 s, « + » pendant ce temps : le serveur confirme −129, l'ancienne réponse (−130) arrive ensuite et est ignorée, l'écran reste à −129.
