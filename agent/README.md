# Agent d'impression DROP

Petit service qui tourne en tâche de fond sur le Mac relié à l'imprimante. Il
demande au serveur toutes les 20 secondes s'il y a des étiquettes qui ne sont
pas encore sorties, récupère un PDF déjà au format 4×6, l'imprime, puis
confirme au serveur.

Rien n'est marqué comme imprimé tant que `lp` n'a pas accepté le travail : si le
Mac perd le réseau au mauvais moment, l'étiquette repartira au tour suivant.

## Installation

**1. Récupérer le jeton.** Il apparaît dans les logs Railway au démarrage :

```
[print] jeton de l'agent d'impression : 4f3a...
```

**2. Trouver le nom de l'imprimante.**

```bash
lpstat -p
```

**3. Créer la configuration** dans `~/.drop-print.json` :

```json
{
  "server": "https://feurdrop3-production.up.railway.app",
  "token": "le-jeton-copié-depuis-Railway",
  "printer": "MUNBYN_ITPP941",
  "pollSeconds": 20
}
```

`"printer": null` utilise l'imprimante par défaut du Mac.

**4. Installer le service.**

```bash
./agent/install.sh
```

Il se lance immédiatement, redémarre tout seul s'il plante, et repart à chaque
ouverture de session.

**5. Activer depuis le dashboard**, onglet Colis → *Impression auto*.

> Au moment où tu actives, les colis **déjà** en attente sont considérés comme
> déjà imprimés : seuls les suivants partiront à l'imprimante. Sinon la première
> exécution sortirait tout le stock d'un coup. Pour le retard, utilise
> `/imprime`.

## Le Mac fermé

Un MacBook dont on rabat l'écran se met en veille et l'agent s'arrête avec lui.
Pour qu'il continue capot fermé :

```bash
sudo pmset -a disablesleep 1
```

Laisse-le branché sur secteur. Pour revenir au comportement normal :

```bash
sudo pmset -a disablesleep 0
```

Ces deux commandes demandent ton mot de passe, à toi de les lancer.

## Allumer / éteindre

Deux niveaux, indépendants :

| | Où | Effet |
|---|---|---|
| **Interrupteur du dashboard** | Onglet Colis, depuis le téléphone | Le serveur ne donne plus rien à imprimer. L'agent continue de tourner à vide. |
| **Agent local** | `./agent/agent.sh off` | L'agent s'arrête sur le Mac. |

Au quotidien, c'est l'interrupteur du dashboard qu'on utilise : il marche depuis
le téléphone, même capot fermé.

```bash
./agent/agent.sh status   # en route ou arrêté
./agent/agent.sh log      # suivre le journal en direct
./agent/agent.sh off      # arrêter
./agent/agent.sh on       # redémarrer
```

Journal complet : `~/Library/Logs/drop-print.log`.

## Ce qui n'est jamais imprimé automatiquement

- les colis **LIT** (tu les fais à la main) ;
- les colis déjà imprimés une fois ;
- les colis sans fichier (ajoutés à la main avec le bouton +).
