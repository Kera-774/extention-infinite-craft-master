# Infinite Craft Explorer (extension Chrome MV3)

Automatise [Infinite Craft](https://neal.fun/infinite-craft/) : l'extension choisit les paires d'éléments les plus prometteuses, les fusionne en boucle et ajoute les découvertes à votre inventaire. Elle mémorise chaque paire testée, y compris les échecs, pour ne jamais envoyer deux fois la même requête.

## Installation

1. Téléchargez ou clonez ce dépôt.
2. Ouvrez `chrome://extensions`, activez le **Mode développeur** (en haut à droite).
3. Cliquez sur **Charger l'extension non empaquetée** et sélectionnez le dossier racine, celui qui contient `manifest.json`.
4. Ouvrez (ou rechargez) https://neal.fun/infinite-craft/.
5. Cliquez sur l'icône de l'extension : le **side panel** s'ouvre. Choisissez un niveau, puis **Démarrer**.

Chrome 116 ou plus récent est requis (content scripts `world: "MAIN"` et side panel).

> Premier lancement conseillé : exportez votre partie avec l'export intégré au jeu, puis lancez 2 à 3 minutes en **ÉCO** et vérifiez que les nouveaux éléments apparaissent dans l'inventaire.

## Nouveautés de la v1.1

- **Arrêt / relance corrigés.** Trois causes rendaient la relance lente, ou la bloquaient :
  1. le délai de backoff gonflé par d'anciens 429 était conservé après l'arrêt. Il est maintenant remis au plancher du niveau à chaque relance ; la concurrence et le plafond appris sur le serveur sont conservés ;
  2. une génération confiée à un worker terminé entre-temps (changement de niveau, garde-fou thermique) n'aboutissait jamais. Chaque demande a désormais un délai de garde de 8 s, avec repli sur le calcul local ;
  3. au Stop, les instances temporaires étaient retirées pendant que le jeu fusionnait encore. Elles sont maintenant retirées **à la fin** de la fusion.

  Une relance demandée pendant l'écriture de l'arrêt attend la fin de celui-ci.
- **Bug corrigé : des paires étaient perdues définitivement.** Une paire réservée puis libérée dans le même lot restait réservée à jamais côté worker, qui ne la proposait plus. L'état est désormais transmis net, clé par clé. Filet de sécurité : si la file et les requêtes en vol sont vides, toute réservation restante est libérée.
- **Mode « One object »** : voir la section 3 bis.
- **Efficacité** :
  - nouvelle pénalité « même famille » : fusionner un élément avec l'un de ses propres ingrédients redonne souvent un élément déjà connu (poids réglable) ;
  - recherche des éléments du jeu en O(1) grâce à un index, au lieu de deux parcours complets de l'inventaire par requête ;
  - horloge de la boucle confiée à un Web Worker, moins bridé par Chrome quand l'onglet est en arrière-plan (repli automatique sur `setTimeout`).

---

## 0. Investigation : ce qui diffère de vos hypothèses

⚠️ **Je n'ai pas pu inspecter le site réel.** La politique réseau de l'environnement où le code a été écrit bloque `neal.fun` (proxy : `CONNECT 403`). L'investigation s'appuie donc sur des sources récentes et publiques :

- [InfiniteCraftCommunity/userscripts](https://github.com/InfiniteCraftCommunity/userscripts) : scripts maintenus par la communauté, dernier commit en juillet 2026. C'est la meilleure référence sur la structure interne actuelle du jeu.
- [ActiveTutorial/ic-server-js-unofficial](https://github.com/ActiveTutorial/ic-server-js-unofficial) et [ic-proxy](https://github.com/ActiveTutorial/ic-proxy) : une réimplémentation du serveur et un proxy.
- [GabeMillikan/infinite-craft-explorer](https://github.com/GabeMillikan/infinite-craft-explorer) et [sqdnoises/infinite-craft](https://github.com/sqdnoises/infinite-craft).

| Point | Votre hypothèse | Ce qui ressort de l'investigation | Conséquence dans le code |
|---|---|---|---|
| Endpoint | `GET /api/infinite-craft/pair?first=X&second=Y` → `{result, emoji, isNew}` | **Confirmé.** L'endpoint est protégé par Cloudflare : les requêtes hors navigateur (Python, curl…) sont bloquées. Il faut les cookies et l'empreinte TLS du navigateur. | Toutes les requêtes partent **de la page** (même origine, mêmes cookies). Le service worker n'en envoie aucune. |
| Sauvegarde | `localStorage["infinite-craft-data"]` = `{elements:[{text,emoji,discovered}]}` | **Obsolète.** Le jeu actuel sauvegarde dans **IndexedDB `infinite-craft`**, store `items`, avec la clé `[idSauvegarde, idÉlément]`. Chaque élément contient `recipes` (liste de `[idA, idB]`). Le jeu gère **plusieurs sauvegardes** (`currSave`, `switchSave`). | Lecture via l'API du jeu. Écriture dans IndexedDB seulement si nécessaire, avec sauvegarde de secours. L'ancien format `localStorage` reste pris en charge s'il est présent. |
| État du jeu | — | Le jeu expose `window.IC` (`getItems`, `createInstance`, `craft`, `removeInstances`…) et une instance Vue 2 `document.querySelector('.container').__vue__` avec `items` et `craftApi(a, b)`. `craftApi` renvoie **`{text, emoji, discovery}`** (et non `result`/`isNew`), ou `null` en cas d'erreur. | Les deux formats de réponse sont normalisés. La méthode principale passe par le jeu lui-même (voir plus bas). |
| Ordre X,Y / Y,X | — | Le serveur met les noms en « Title Case » puis **trie la paire** : le résultat est **commutatif** et ne dépend pas de la casse. Les scripts communautaires trient aussi `[a, b]` avant `craftApi`. | Clé de paire = noms normalisés (minuscules) et triés, `"a\|b"`. Envoi dans l'ordre trié. |
| Échec | `"Nothing"` | `{result: "Nothing", emoji: "", isNew: false}`. D'après la réimplémentation, les noms de **plus de 30 caractères** donnent toujours `Nothing`. | Les échecs sont mémorisés comme les succès. Les éléments de plus de 30 caractères sont exclus (réglable). |
| Limitation | 429 | Réponse 429 (Cloudflare / limite de débit) ou 403 (challenge). `craftApi` renvoie alors `null` sans le code HTTP. | Un observateur réseau, injecté **avant** le jeu, lit le statut HTTP et `Retry-After`. C'est lui qui alimente l'AIMD. |

**Bonus découvert pendant l'investigation :** les `recipes` de la sauvegarde du jeu sont importées au démarrage comme paires déjà connues. Elles servent aussi à calculer la profondeur de chaque élément. Aucune de ces paires n'est jamais retestée.

---

## 1. Architecture

```
manifest.json
icons/                      icônes 16/32/48/128
src/
  shared/                   modules UMD (page, worker et Node pour les tests)
    pairkey.js              clé de paire non ordonnée, normalisation des noms
    heap.js                 file de priorité (tas binaire max, trimTo)
    aimd.js                 contrôle de débit AIMD + délai adaptatif + plafond mémorisé
    scoring.js              Planner : valeur des éléments (bandit) et génération des paires
  page/                     monde MAIN (même contexte JS que le jeu)
    net-hook.js             [document_start] observe les statuts HTTP de /pair (429, 403…)
    bridge.js               pont postMessage vers le content script
    store.js                cache IndexedDB « icx-cache », écritures par lots, journal d'urgence
    workers.js              PlannerService : Planner local + 0 à 2 Web Workers miroirs
    game.js                 adaptateur du jeu : 4 méthodes de fusion + ajout à l'inventaire
    power.js                niveaux ÉCO/NORMAL/TURBO/MAX, batterie, retard de boucle, refroidissement
    engine.js               boucle principale, résultats, graphe, import/export
    main.js                 démarrage et routage des commandes
  content/bridge-content.js monde ISOLÉ : relais chrome.runtime ⇄ page, code des workers, secours chrome.storage
  worker/scorer-worker.js   Web Worker de scoring (TURBO/MAX)
  background/service-worker.js  minimal : ouvre le side panel au clic
  sidepanel/                interface (HTML/CSS/JS)
tests/
  *.test.js                 tests unitaires (node --test)
  e2e/run-e2e.js            test de bout en bout : Chromium + extension + maquette du jeu
  e2e/mock-game.html        maquette du jeu (tests uniquement)
```

**Où tourne la boucle ?** Dans la page du jeu (monde MAIN), jamais dans le service worker, que MV3 arrête après environ 30 s d'inactivité. Un document offscreen ne conviendrait pas non plus : il ne peut pas envoyer de requêtes avec les cookies Cloudflare de l'onglet, ni accéder à l'état du jeu.

**Les quatre méthodes de fusion** (réglage « Méthode de fusion » ; `auto` choisit la première disponible) :

1. **`game`** (défaut) : le jeu fusionne lui-même, via `IC.craft`, deux instances temporaires aussitôt retirées du canevas. Le jeu fait la requête (en-têtes et cookies corrects), puis ajoute l'élément à l'inventaire **et** à sa propre sauvegarde. L'extension n'écrit rien dans la sauvegarde, donc aucun risque de corruption, et l'affichage se met à jour sans rechargement. Le résultat brut, y compris `Nothing`, est capturé grâce à une enveloppe posée sur `craftApi`.
2. **`api`** : appel de `craftApi(a, b)` du jeu, puis ajout à l'inventaire par l'extension (voir plus bas).
3. **`fetch`** : `GET /api/infinite-craft/pair` direct, puis ajout à l'inventaire par l'extension.
4. **`dom`** : secours par glisser-déposer simulé (événements pointer/mouse).

En cas d'échecs répétés (403, réponses invalides, API absente), le moteur **bascule automatiquement** sur la méthode suivante.

**Ajout à l'inventaire pour `api` et `fetch`** (dans `game.js`, section « Materializer ») :

1. **Sauvegarde de secours** des éléments de la sauvegarde courante (base `icx-cache`, store `backups`, 3 dernières conservées). Elle est faite avant la première écriture.
2. **Écriture atomique** : une seule transaction IndexedDB par lot. Le schéma est recopié sur un enregistrement existant, et un élément déjà présent (même texte) n'est jamais réécrit. Pour l'ancien format `localStorage`, une copie `infinite-craft-data.icx-backup` est faite, le JSON est validé, puis écrit en un seul `setItem`.
3. **Mise à jour à chaud** de `items` (tableau réactif Vue). Si ce n'est pas possible, un bouton « Recharger le jeu » apparaît (option : rechargement automatique à l'arrêt).

**Bonus :** les fusions que vous faites à la main pendant que l'extension tourne sont aussi enregistrées dans le cache.

## 2. Mémoire (cache persistant)

- **Paires** : clé `a|b` (noms normalisés, triés, `|` et `\` échappés) → `{r: résultat ou null pour Nothing, e: emoji, n: isNew, t: horodatage}`. Aucune paire connue n'est jamais retestée : ni les succès, ni les échecs, ni les recettes importées du jeu, ni les paires déjà en file ou en cours.
- **Graphe des éléments** : pour chacun, sa profondeur (voir ci-dessous), le nombre de paires testées, de nouveaux résultats produits, de premières découvertes et d'échecs, un rendement récent (moyenne exponentielle) et le nombre de paires connues.
  - Profondeur = `1 + max(profondeur des parents)`. Elle est recalculée par relaxation à partir des recettes du jeu, avec 0 pour les 4 éléments de base.
- **Stockage** : IndexedDB `icx-cache` dans l'origine neal.fun. Si IndexedDB est indisponible, l'extension passe par `chrome.storage.local`.
  - Écritures par lots : 20, 50 ou 200 selon le niveau, et au plus toutes les 2 s.
  - Au `pagehide`, le buffer est copié de façon **synchrone** dans un journal `localStorage`, rejoué au démarrage suivant. Un rechargement ne perd donc aucun résultat.
- **Listes noire et blanche** dans les réglages : un élément par ligne. La liste noire exclut l'élément ; la liste blanche lui donne un fort bonus.
- **Import / export JSON** du cache complet (format `icx-cache` v1). L'import fusionne sans doublon.

## 3. Algorithme de sélection

**Objectif :** maximiser le nombre de nouveaux éléments par requête.

L'espace compte N(N+1)/2 paires : environ 50 millions pour 10 000 éléments. Il n'est donc **jamais matérialisé**.

**Idée clé.** Le score d'une paire se décompose presque entièrement en une **valeur par élément** : `score(a,b) = ½·(v(a)+v(b)) + bruit`.

Pour une ancre donnée, les meilleurs partenaires sont donc simplement les éléments de plus forte valeur. L'algorithme les parcourt dans l'ordre et saute les paires déjà connues. Coût : O(N log N) pour le classement, puis O(k) par ancre.

**Valeur d'un élément** (`scoring.js`, `elementValue`) :

| Terme | Formule | Poids par défaut |
|---|---|---|
| Rendement bandit | **UCB1** : `(produits+1)/(essais+2) + C·√(ln T / (essais+1))`. En option, **Thompson** : tirage dans `Beta(produits+1, échecs+1)` | `yield` 1.0, `C` 0.5 |
| Fraîcheur | `exp(−âge/τ)`, âge compté en nombre de découvertes depuis l'élément | `fresh` 0.8, `τ` 60 |
| Faible profondeur | `1/(1+profondeur)` | `depth` 0.35 |
| Pénalité « mort » | ≥ 15 essais et 0 résultat nouveau | `dead` 1.5 |
| Pénalité nom long / spécifique | `(longueur−18)/12 + 0,25·(mots au-delà de 3)` | `length` 0.5 |
| Pénalité saturation | ≥ 10 essais et rendement récent < 4 % | `saturation` 0.6 |
| Bonus zone fertile | `min(1, 0,5·isNew produits + 2·rendement récent)` | `fertile` 0.6 |
| Liste blanche | bonus fixe | 3.0 |
| Même famille (terme de paire) | pénalité si l'un est un ingrédient direct de l'autre | `family` 0.3 |
| Bruit | uniforme `[0, 0.08)` par paire | `noise` 0.08 |

**Déroulement de la boucle :**

- **Frontière.** Chaque nouvel élément devient une ancre prioritaire. On ne génère **que ses paires** avec les éléments existants (mise à jour incrémentale). La sélection générale mélange environ 40 % d'éléments récents, 40 % de meilleures valeurs et le reste au hasard.
- **File de priorité.** Un tas binaire de taille bornée (le lookahead) est rempli quand il descend sous la moitié.
- **Re-scoring paresseux.** Au moment de dépiler, le score est recalculé avec les statistiques à jour. Si la paire a trop baissé, elle est remise dans le tas, au plus deux fois.
- **Saturation globale.** Le rendement global (moyenne exponentielle) pilote le mode :
  - rendement < 6 % → mode **exploration** : C × 1,8 et fraîcheur × 1,2 ;
  - rendement > 25 % → mode **exploitation** : C × 0,5 et bonus fertile × 2 ;
  - entre les deux, avec hystérésis → mode **équilibré**.
- **Deux compteurs distincts :** les **nouveaux éléments** (nouveaux pour vous) et les **premières découvertes** (`isNew`/`discovery`, marquées ★ dans le panneau).

Tous les poids et seuils se règlent dans l'interface.

## 3 bis. Mode « One object »

Dans le side panel, section **One object** :

1. Tapez quelques lettres : la liste propose vos éléments possédés.
2. Choisissez un objet, puis cliquez sur **Fusionner avec tout**.

L'objet est alors fusionné avec **chaque élément découvert** :

- **Ordre :** les partenaires les plus prometteurs d'abord (même classement que l'exploration), puis tous les autres, sans limite de parcours.
- **Nouveaux éléments :** ceux découverts pendant l'opération, y compris par ces fusions mêmes, sont ajoutés à la liste des partenaires.
- **Déjà connu :** les paires déjà connues (succès ou « Nothing ») ne sont **jamais** renvoyées. Relancer le même objet plus tard ne teste donc que les nouveaux éléments.
- **Exclusions :** les éléments en liste noire, non possédés, ou au nom trop long sont exclus. L'objet choisi est accepté même s'il est lui-même dans l'un de ces cas.
- **Pendant l'opération :** seules les paires contenant l'objet sont envoyées. Le niveau de puissance, l'AIMD et les garde-fous s'appliquent normalement.
- **Suivi :** une barre de progression indique les éléments traités sur le total, les nouveaux éléments, les premières découvertes (★) et les « Nothing ». La liste des découvertes affiche le partenaire utilisé.
- **À la fin :** arrêt automatique ou, si la case est cochée, reprise de l'exploration normale. Le bouton **Annuler** revient à l'exploration normale sans arrêter.

## 4. Niveaux de puissance

| | Concurrence | Délai plancher | Workers | Lookahead | Lot IndexedDB | Rafraîchissement UI |
|---|---|---|---|---|---|---|
| **ÉCO** | 1 | 1 500 ms | 0 | 100 | 20 | 2 Hz |
| **NORMAL** | 2 | 600 ms | 0 | 300 | 50 | 2 Hz |
| **TURBO** | AIMD 2 → 6 | 200 ms | 1 | 1 000 | 50 | 2 Hz |
| **MAX** | AIMD 4 → 12 | 80 ms | ≤ 2 (≤ threads/3) | 2 000 | 200 | 1 Hz |

**Adaptation au matériel.** Au démarrage, l'extension lit `hardwareConcurrency` et `deviceMemory` :

- sur un Intel U300 (6 threads, 16 Go), le niveau par défaut est TURBO et MAX a droit à 2 workers ;
- avec 4 Go de mémoire ou moins, le lookahead est divisé par deux ;
- les plafonds du tableau ne sont jamais dépassés.

**AIMD** (`aimd.js`) :

- **Montée :** environ +1 requête simultanée par fenêtre de succès.
- **Sur un 429 :** la concurrence est multipliée par 0,5, le délai est doublé et le `Retry-After` est respecté. Il y a au plus une réduction par fenêtre de 2 s.
- **Mémoire du plafond** (comme le `ssthresh` de TCP) : le niveau qui a provoqué le 429 est retenu. À son approche, la montée est 10 fois plus lente, et ce plafond remonte lentement pour pouvoir re-sonder le serveur. En simulation, cela divise par plus de deux la fréquence des 429 par rapport à un AIMD pur.
- **Timeouts et erreurs 5xx :** concurrence × 0,8. Après 20 erreurs consécutives, pause de 30 s.

**Garde-fous :**

- **Batterie.** Sur batterie sous 30 %, TURBO et MAX passent en NORMAL. Le niveau choisi revient automatiquement dès que l'ordinateur charge.
- **Retard de la boucle d'événements.** Il est mesuré toutes les 100 ms (moyenne exponentielle). S'il dépasse 100 ms pendant plus de 5 s, la concurrence baisse d'un cran et un worker est suspendu. Après 60 s de calme, un cran est rétabli.
- **Refroidissement.** En MAX, pause de 10 s toutes les 10 min (option activée par défaut).
- **Rythme par jetons.** Dans un onglet en arrière-plan, Chrome regroupe les timers à un réveil par seconde. Le moteur lance alors plusieurs requêtes par réveil pour garder le même débit moyen, sauf juste après un 429.

Changer de niveau ne perd aucun état : cache, file, statistiques et concurrence courante sont conservés, simplement bornés aux nouvelles limites.

## 5. Robustesse

- **Délai d'attente** de 20 s par requête. Une erreur réseau, un 5xx ou un timeout est **rejoué** jusqu'à 3 fois. Un 429 est rejoué sans compter comme une tentative.
- **Réponses invalides** (JSON illisible, page Cloudflare) : comptées comme erreurs. Si elles se répètent, le moteur change de méthode de fusion.
- **Stop instantané.** Les requêtes en vol sont annulées (`AbortController`), la file est vidée, le cache est écrit et les instances temporaires sont retirées du canevas.
- **Reprise automatique** si l'onglet est rechargé pendant l'exécution. Option activée par défaut.
- **Sauvegarde du jeu protégée.** Avec la méthode `game`, l'extension n'y écrit jamais. Avec `api` ou `fetch`, elle fait une sauvegarde de secours, écrit en une transaction atomique et ne crée jamais de migration de base.

## 6. Interface (side panel)

- Boutons Démarrer, Pause et Stop, et choix du niveau. Le panneau indique aussi le niveau réellement appliqué, le matériel détecté et le bridage éventuel.
- Statistiques en direct :
  - éléments possédés, paires testées, échecs mémorisés ;
  - nouveaux éléments de la session, premières découvertes ;
  - requêtes par seconde, concurrence en cours et autorisée, délai actuel ;
  - erreurs 429 et autres erreurs ;
  - rendement récent et mode ;
  - taille de la file, méthode de fusion, retard de boucle, batterie, type de stockage.
- Les 20 dernières découvertes (★ = première découverte), avec leur recette.
- Import, export et effacement du cache.
- Réglages : méthode de fusion, délais par niveau, bandit UCB1 ou Thompson, seuils, poids, options, listes noire et blanche. Le journal des événements est à côté.

## 7. Tests

```bash
npm test          # tests unitaires : clé de paire, tas, AIMD (dont convergence), planificateur
npm run test:e2e  # Chromium + extension chargée + maquette du jeu (Playwright requis)
```

**Tests unitaires : 29 sur 29 passent.** Ils couvrent :

- la commutativité et l'échappement de la clé de paire ;
- l'ordre du tas, `trimTo` et la ré-insertion ;
- l'AIMD : montée, baisse sur 429, fenêtre de refroidissement, `Retry-After`, **convergence vers le plafond d'un serveur simulé**, changement de niveau à chaud ;
- la remise à zéro du backoff à la relance ;
- le planificateur : exactement N(N+1)/2 paires, aucune paire connue ou réservée proposée, génération incrémentale, exclusions, ordre des scores, bonus UCB, ancre forcée sans limite de parcours (One object), pénalité « même famille ».

**Test de bout en bout : 41 vérifications sur 41 passent.** Il charge l'extension non empaquetée dans Chromium. La page `https://neal.fun/infinite-craft/` et l'API `/pair` sont interceptées par Playwright, qui sert une **maquette** du jeu. Il vérifie :

- le démarrage depuis le side panel et la découverte d'éléments, ajoutés à l'inventaire par le jeu ;
- que **aucune paire n'est envoyée deux fois** ;
- le passage de NORMAL à MAX à chaud, et la réaction de l'AIMD aux 429 ;
- les workers, le Stop instantané et le nettoyage des instances ;
- **trois cycles arrêt/relance** : débit rétabli à chaque relance, délai revenu au plancher, aucun doublon, aucune instance oubliée ;
- **One object** : recherche, fusion de l'objet avec chaque élément possédé, aucune autre paire envoyée, aucun doublon, arrêt automatique, progression affichée ;
- la **reprise après rechargement sans aucune paire retestée** ;
- la méthode `fetch` : ajout dans la mémoire du jeu et dans IndexedDB, avec sauvegarde de secours ;
- l'export et l'import ;
- la batterie simulée sous 30 %, qui force NORMAL, et le retard de boucle simulé, qui fait baisser la concurrence d'un cran.

## ⚠️ Ce qui n'a PAS pu être vérifié sur le vrai site

Le site est inaccessible depuis l'environnement de développement. Les tests de bout en bout tournent sur une **maquette** qui imite l'interface interne décrite par les scripts communautaires. À vérifier lors du premier essai réel :

1. **Signature exacte de `IC.createInstance` / `IC.craft` / `IC.removeInstances`**, et le fait que `IC.craft` passe bien par `craftApi` (hypothèse tirée de plusieurs userscripts). Si ce n'est pas le cas, les `Nothing` et le drapeau `isNew` peuvent être mal capturés en méthode `game` : choisissez alors `api` dans les réglages.
2. **Observateur réseau** : le client HTTP du jeu doit bien utiliser le `fetch` enveloppé, injecté à `document_start`. Sinon les 429 ne sont pas vus en méthodes `game` et `api` ; la méthode `fetch`, elle, les voit toujours.
3. **Schéma réel du store IndexedDB `items`** pour l'ajout par `api`/`fetch`. Le schéma est recopié sur un enregistrement existant et une sauvegarde de secours est faite avant, mais cela n'a pas été testé sur une vraie sauvegarde. La méthode `game`, par défaut, n'écrit rien.
4. **Méthode `dom`** (glisser-déposer) : les sélecteurs (`.sidebar .item`, `.sidebar-input`) sont des suppositions. **Non testée.**
5. **CSP de neal.fun** pour les Web Workers créés depuis un Blob. S'ils sont bloqués, le scoring bascule automatiquement dans le thread principal, et un avertissement s'affiche dans le panneau.
6. **Limites réelles du serveur** : l'AIMD s'y adapte, mais les délais plancher de TURBO et MAX peuvent mériter un ajustement.
7. **La règle « plus de 30 caractères → Nothing »** vient de la réimplémentation communautaire. Si elle est fausse, montez « Longueur max. des noms » dans les réglages.
8. **L'ouverture du side panel par l'icône.** En test, le panneau a été ouvert comme page d'extension.
9. **Le gain de l'horloge en worker** pour un onglet en arrière-plan : Chromium headless ne bride pas les onglets cachés, donc ce gain n'a pas pu être mesuré.
10. **L'effet réel de la pénalité « même famille »** sur le rendement. La maquette produit des recettes aléatoires ; le poids (0.3) est une estimation, réglable dans les réglages.

Si quelque chose ne fonctionne pas, le **Journal** du panneau et la console de l'onglet du jeu (préfixe `[ICX]`) indiquent la méthode utilisée et les erreurs.

## Remarques

- Utilisez l'extension avec modération : le serveur de neal.fun est un service gratuit. Les niveaux ÉCO et NORMAL respectent des délais proches d'un joueur rapide.
- Pour un débit maximal, gardez l'onglet du jeu visible, par exemple dans sa propre fenêtre. En arrière-plan, Chrome bride les timers.
