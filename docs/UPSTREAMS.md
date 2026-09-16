# Audit des sources amont

Audit réalisé le 11 août 2026 avant l'implémentation de `fitness-mcp`, et mis à jour le
16 septembre 2026 lors du remplacement du client Yazio.

## Lyfta

Sources vérifiées :

- [`jkronlachner/lyfta-mcp`](https://github.com/jkronlachner/lyfta-mcp), commit `8f82bc59fba4b29a0089a8904eeda1e7ee112ea2`, version `0.3.1`, licence MIT ;
- [documentation officielle Lyfta Community API](https://my.lyfta.app/community/api).

Le projet amont contient un client `fetch` TypeScript très fin. Il utilise la base
`https://my.lyfta.app` et transmet `LYFTA_API_KEY` dans l'en-tête
`Authorization: Bearer <clé>`. La clé n'est ni un paramètre de requête ni un cookie.

Fonctions confirmées dans le client amont :

| Fonction | Endpoint | Lecture |
| --- | --- | --- |
| `listWorkouts` | `GET /api/v1/workouts` | oui |
| `listWorkoutSummaries` | `GET /api/v1/workouts/summary` | oui |
| `listExercises` | `GET /api/v1/exercises` | oui |
| `getExerciseProgress` | `GET /api/v1/exercises/progress` | oui |
| `listClients` | `GET /api/v1/clients` | oui, comptes coach |
| `createCollection` | `POST /api/v1/collections` | non |
| `createTemplate` | `POST /api/v1/templates` | non |

La documentation officielle expose aussi
`GET /api/v1/exercises/library`, absent de la version auditée du serveur amont. Il est
ajouté ici comme outil de lecture, avec ses seuls paramètres documentés : `search`,
`limit` et `offset`.

Réutilisation : même authentification, mêmes chemins, mêmes paramètres et même traitement
de `{ status: false }`, complétés par un timeout, des retries bornés pour les seules erreurs
temporaires et des types locaux. Les opérations d'écriture ne sont pas exposées.

Limites confirmées : 60 requêtes/minute, 5 000/jour, 100 workouts détaillés par page et
1 000 résumés par page. Les identifiants peuvent être des chaînes ou des nombres. Les champs
`equipment_id`, `body_part_id`, `Target_muscles_id` et `Synergist_muscles_id` sont des tableaux
encodés dans des chaînes JSON. Les tables officielles de muscles sont reprises sans ajouter
de correspondance arbitraire.

## Yazio

Sources vérifiées :

- [`fliptheweb/yazio-mcp`](https://github.com/fliptheweb/yazio-mcp), code de la publication
  npm `0.0.14` au commit `dd8d115a00f9acf7f2f91d7f0419d04ec1553863`, licence MIT ;
- package npm [`yazio`](https://www.npmjs.com/package/yazio) `1.1.3`, dépôt
  [`juriadams/yazio`](https://github.com/juriadams/yazio), commit
  `93d82e47c202eee933a5bc9cdd91fabd004cade0` pour la version publiée auditée ;
- [`saganos/yazio_public_api`](https://github.com/saganos/yazio_public_api), commit
  `9902893cf8b0329f544b176e4f4885e1e5930ee2`, licence MIT : description publique de l'API v15,
  `swagger.json` et exemples de connexion.

`yazio-mcp` est un serveur STDIO. Il ne contient pas son propre client HTTP : il instancie
directement `new Yazio({ credentials: { username, password } })`. `fitness-mcp` n'a jamais lancé
ce serveur comme sous-processus.

### Pourquoi le package `yazio` a été remplacé

Le package npm n'est plus publié depuis avril 2024. Sa fonction d'authentification appelle
`POST /v15/oauth/token` avec `JSON.stringify(...)` comme corps et **sans en-tête
`Content-Type`** : `fetch` envoie donc `text/plain`. L'endpoint Yazio ne lit que des paramètres
`application/x-www-form-urlencoded` — c'est explicite dans `saganos/yazio_public_api`, dont
`examples/login.js` poste un `URLSearchParams`. La requête arrive vide côté serveur et chaque
connexion échoue, ce qui rend l'intégration entière inutilisable.

`src/clients/yazio.ts` est donc un client de première main, écrit dans le style de
`LyftaClient` et sans dépendance npm supplémentaire :

- échange form-encodé sur `POST /v15/oauth/token` avec les identifiants publics de l'application
  Yazio (`client_id` `1_4hiy…`, `client_secret` `6rok…`), surchargeables par `YAZIO_CLIENT_ID` et
  `YAZIO_CLIENT_SECRET` si Yazio les fait tourner ;
- jeton gardé en mémoire, renouvelé via `grant_type=refresh_token` avec repli sur le mot de passe,
  et **une seule connexion partagée** entre les lectures concurrentes d'une période ;
- rejeu unique d'une lecture après un `401`, puis erreurs normalisées portant le statut HTTP et le
  code d'erreur amont, ce qui rend la prochaine panne diagnosticable ;
- `baseUrl`, `fetchImpl` et `timeoutMs` injectables, donc testables sans réseau.

Aucun jeton Yazio n'est renvoyé par les outils de ce projet.

Fonctions de lecture confirmées :

| Méthode de `YazioClient` | Endpoint utilisé |
| --- | --- |
| `getConsumedItems(date)` | `GET /user/consumed-items?date=...` |
| `getDailySummary(date)` | `GET /user/widgets/daily-summary?date=...` |
| `getExercises(date)` | `GET /user/exercises?date=...` |
| `getWaterIntake(date)` | `GET /user/water-intake?date=...` |
| `getGoals(date?)` | `GET /user/goals/unmodified?date=...` |
| `getSettings()` | `GET /user/settings` |
| `getDietaryPreferences()` | `GET /user/dietary-preferences` |
| `getSuggestedProducts(date, daytime)` | `GET /user/products/suggested?...` |
| `searchProducts(...)` | `GET /products/search?...` |
| `getProduct(id)` | `GET /products/{id}` |

`GET /user/bodyvalues/weight/last` et `GET /user` ne sont pas appelés : le poids corporel est
fourni par un autre serveur MCP et n'a donc plus ni outil, ni champ d'agrégation ici.

Les trois écritures présentes dans `yazio-mcp` (ajout/suppression d'aliment et ajout d'eau)
ne sont pas exposées. L'ajout d'eau y est notamment un monkey-patch sur un endpoint absent de
la bibliothèque.

Limites : Yazio ne publie aucune API officielle ; ces endpoints sont rétro-ingéniérés et
peuvent changer sans préavis. Les lectures par période nécessitent un appel par date. Le client
local applique son propre timeout, en plus de la politique réseau globale bornée, sans journaliser
URL sensible, en-têtes, identifiants ou jetons.

## Décisions

- Aucun sous-processus MCP : un seul processus Node et un seul endpoint `/mcp`.
- Lecture seule pour toutes les intégrations.
- Les réponses sont nettoyées récursivement des champs de type credentials/token avant retour.
- Les erreurs sont normalisées et n'incluent jamais corps brut, en-têtes ou secrets.
- Une panne Lyfta ou Yazio devient une erreur d'outil ou une section `unavailable`, jamais un
  crash du serveur complet.
