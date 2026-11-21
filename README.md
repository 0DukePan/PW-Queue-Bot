# PQB — bot de file d'attente TP

Bot Discord qui gère la file de passage d'un TP : inscription des étudiants,
file de rectification prioritaire, contrôles Prof/Délégué, et un panneau unique
qui se met à jour tout seul.

> **Note importante sur la fiabilité :** l'embed affiché est désormais borné
> (8 lignes par section + « … et N autres »). L'ancienne version affichait une
> ligne par étudiant : au-delà de ~30 inscrits, la limite Discord de 1024
> caractères par champ était dépassée, chaque clic levait une erreur et le
> panneau ne se mettait plus à jour. Voir [Ce qui a changé](#ce-qui-a-changé).

## Sommaire

- [Démarrage rapide](#démarrage-rapide)
- [Variables d'environnement](#variables-denvironnement)
- [Commandes et boutons](#commandes-et-boutons)
- [Architecture](#architecture)
- [Ce qui a changé](#ce-qui-a-changé)
- [Tests et mesures](#tests-et-mesures)
- [Déploiement](#déploiement)

## Démarrage rapide

Prérequis : Node.js 20.6 ou plus récent.

```sh
npm ci
cp .env.example .env      # ou, sous PowerShell : Copy-Item .env.example .env
```

Renseigne `DISCORD_TOKEN` et `DISCORD_CLIENT_ID` dans `.env`, puis :

```sh
npm start
```

Dans le portail développeur Discord, active **Server Members Intent** et invite
le bot avec les scopes `bot` + `applications.commands`, et les permissions
« Voir les salons », « Envoyer des messages », « Intégrer des liens »,
« Gérer les messages » (nécessaire pour éditer le panneau).

Tape `/tp-start` dans le salon voulu : le panneau s'y publie et devient le
panneau actif.

## Variables d'environnement

Toutes les variables sont optionnelles sauf les deux premières. Le fichier
`.env` est chargé automatiquement s'il existe ; les variables déjà définies dans
l'environnement (Railway, Docker) ont la priorité.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | **Obligatoire.** Token du bot. |
| `DISCORD_CLIENT_ID` | — | **Obligatoire.** Identifiant de l'application. |
| `STAFF_ROLES` | `Prof,Délégué` | Rôles (par nom) autorisés à piloter la file. |
| `STAFF_ROLE_IDS` | — | Variante par identifiant de rôle ; insensible au renommage. |
| `ADMIN_IDS` | — | Identifiants Discord toujours autorisés (dépannage). |
| `QUEUE_PAGE_SIZE` | `8` | Étudiants affichés par section (borné 3–20). |
| `QUEUE_MIN_EDIT_INTERVAL_MS` | `1500` | Intervalle minimal entre deux éditions du panneau. |
| `QUEUE_DATA_FILE` | `data/queue-state.json` | Fichier de sauvegarde de la file. |
| `QUEUE_PERSIST_DEBOUNCE_MS` | `1000` | Regroupement des écritures disque. |
| `QUEUE_RESTORE_BOARD` | `true` | Rattache le panneau au démarrage. |
| `QUEUE_CHANNEL_ID` | — | Salon du panneau (si le message sauvegardé a disparu). |
| `ENABLE_WELCOME` | `true` | Message de bienvenue à l'arrivée d'un membre. |
| `ENABLE_MEMBER_INTENT` | `true` | À mettre à `false` si l'intent privilégié est refusé. |
| `WELCOME_CHANNEL_ID` | — | Salon d'accueil (sinon recherche par nom). |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` ou `debug`. |
| `PORT` | — | Serveur `/health` (Railway le fournit). |

## Commandes et boutons

| Élément | Qui | Effet |
| --- | --- | --- |
| `/tp-start` | Prof/Délégué | Réinitialise la file et publie le panneau. |
| ✋ Rejoindre la file | Étudiant | Formulaire nom / prénom / groupe. |
| ⚡ Rectification finie | Étudiant | Repasse en file prioritaire. |
| ❌ Quitter la file | Étudiant | Retire des trois files. |
| ▶️ Suivant | Prof/Délégué | Fait passer l'étudiant suivant. |
| ↺ Renvoyer en rectification | Prof/Délégué | Envoie l'étudiant courant en rectification. |

Ta responsabilité pédagogique : le panneau est unique et se met à jour tout
seul, aucun message de texte n'est envoyé dans le salon.

## Architecture

```
bot.js                  point d'entrée : config, signaux, arrêt propre
src/env.js              configuration typée, parsing .env, journalisation
src/queue-store.js      modèle de la file (aucune dépendance Discord)
src/panel.js            rendu de l'embed et des boutons
src/board.js            panneau unique : coalescence, throttle, republication
src/interactions.js     handlers (boutons, formulaire, commande)
src/persistence.js      sauvegarde atomique et différée
src/health-server.js    GET /health pour la supervision
src/bot.js              assemblage (createBot/start/stop)
scripts/bench.js        comparaison ancienne vs nouvelle implémentation
test/*.test.js          tests node:test, sans réseau
```

Le découpage est volontaire : `queue-store.js` ne connaît pas Discord et se
teste en isolation ; `board.js` ne connaît que trois méthodes du client
Discord, ce qui rend la logique anti-rate-limit vérifiable hors ligne.

## Ce qui a changé

### Le vrai bug : le panneau cessait de fonctionner à ~30 inscrits

`buildEmbed()` d'origine affichait **une ligne par étudiant**. Or Discord limite
la valeur d'un champ d'embed à **1024 caractères**. Mesuré sur l'implémentation
d'origine :

| Noms | Erreur à partir de |
| --- | --- |
| `Doe / Jane` | 40 étudiants |
| `Benali / Yacine` | 34 étudiants |
| `Boumediene / Abdelkader` | 27 étudiants |

Passé ce seuil, `EmbedBuilder.addFields()` lève une exception à **chaque clic** :
plus aucune mise à jour, l'étudiant reste bloqué en tête et le staff clique dans
le vide. C'est exactement le symptôme « ça marche au début, puis ça se fige
quand beaucoup de monde rejoint ».

Le rendu est maintenant borné par construction : 8 lignes par section, suivies
de « … et N autres en attente ». Une recherche de nom très longue est aussi
tronquée. Le budget de 1024 caractères est respecté même avec 5000 inscrits.

### Performances

| Opération | Avant | Après |
| --- | --- | --- |
| Vérifier « suis-je déjà inscrit ? » | `some()` sur toute la file, **O(n)** | `Map.has()`, **O(1)** |
| Retirer un étudiant | 2 `filter()` sur toute la file, **O(n)** | 3 `delete()`, **O(1)** |
| Faire passer l'étudiant suivant | `shift()` sur tableau, **O(n)** | `Map.keys().next()`, **O(1)** |
| Rendu du panneau | tous les inscrits, **O(n)** | page de 8, **O(page)** |
| Éditions du panneau | 1 par clic | regroupées (1 par rafale) |
| Charge utile envoyée à Discord | croissante avec n | constante |

`npm run bench` compare les deux implémentations côte à côte. Sur 2000
recherches de doublon : ~4× de gain à 30 inscrits, ~23× à 500, ~176× à 1000.

### Robustesse

- **Coalescence des éditions** — quand 30 étudiants valident leur formulaire en
  même temps, le panneau est édité une fois, pas 30 (vérifié par test). C'est
  ce qui provoquait les `429 Too Many Requests` et les clics perdus.
- **Acquittement immédiat** — chaque interaction est acquittée avant toute
  attente réseau : plus de « Cette interaction a échoué ». Le code fait aussi
  la distinction entre `interaction.update` (1 requête, mise à jour instantanée
  pour les clics espacés) et `deferReply` (repli).
- **Panneau obsolète désactivé** — les boutons d'un ancien panneau expliquent
  qu'il faut utiliser le plus récent, au lieu de modifier la file en silence.
- **Reprise après redémarrage** — la file et l'identifiant du panneau sont
  sauvegardés (atomiquement, avec regroupement des écritures). Un redéploiement
  Railway ne vide plus la file.
- **Panneau supprimé** — republié automatiquement via la gestion du code
  d'erreur `10008`.
- **Arrêt propre** — `SIGTERM`/`SIGINT` : le panneau est neutralisé et l'état
  sauvegardé avant de quitter.
- **Disponibilité** — `/tp-start` réinitialise proprement : l'ancien panneau est
  archivé pour éviter deux panneaux concurrents.

## Tests et mesures

```sh
npm test        # 40 tests, aucun réseau requis
npm run bench   # ancienne vs nouvelle implémentation
```

Les tests couvrent le modèle de file (doublons, ordre FIFO/prioritaire,
sérialisation, état corrompu), le rendu (limites de Discord, troncature) et le
gestionnaire d'interactions avec un faux client Discord : rafale d'inscriptions,
bascule `update`/`deferReply`, panneau obsolète, erreurs métier.

## Déploiement

Le fichier `Procfile` déclare `web: node bot.js` pour Railway. Sur les
plateformes sans disque persistant, la file survit à un redémarrage du process
mais pas à la recréation du conteneur ; montez un volume et pointez
`QUEUE_DATA_FILE` dessus si la persistance doit être totale.

Pour enregistrer les commandes sans lancer le bot :

```sh
npm run deploy:commands
```

## Sécurité

Ne committez jamais `.env` (déjà dans `.gitignore`). Le token donne un contrôle
total du bot : s'il a fuité, révoquez-le dans le portail développeur.
