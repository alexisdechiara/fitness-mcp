# Audit des sources amont

Audit réalisé le 11 août 2026 avant l'implémentation de `fitness-mcp`.

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
  `93d82e47c202eee933a5bc9cdd91fabd004cade0` pour la version publiée auditée.

`yazio-mcp` est un serveur STDIO. Il ne contient pas son propre client HTTP : il instancie
directement `new Yazio({ credentials: { username, password } })`. `fitness-mcp` réutilise donc
la même bibliothèque au lieu de lancer ce serveur comme sous-processus.

Authentification réelle de la bibliothèque : échange username/password contre un jeton sur
`POST https://yzapi.yazio.com/v15/oauth/token`, puis cache du jeton en mémoire jusqu'à son
expiration. Les requêtes de données envoient ce jeton en Bearer. Aucun jeton Yazio n'est
renvoyé par les outils de ce projet.

Fonctions de lecture confirmées :

| Fonction de `yazio` | Endpoint utilisé |
| --- | --- |
| `user.get()` | `GET /user` |
| `user.getConsumedItems({ date })` | `GET /user/consumed-items?date=...` |
| `user.getDailySummary({ date })` | `GET /user/widgets/daily-summary?date=...` |
| `user.getWeight({ date? })` | `GET /user/bodyvalues/weight/last?date=...` |
| `user.getExercises({ date? })` | `GET /user/exercises?date=...` |
| `user.getWaterIntake({ date? })` | `GET /user/water-intake?date=...` |
| `user.getGoals({ date? })` | `GET /user/goals/unmodified?date=...` |
| `user.getSettings()` | `GET /user/settings` |
| `user.getDietaryPreferences()` | `GET /user/dietary-preferences` |
| `user.getSuggestedProducts(...)` | `GET /user/products/suggested?...` |
| `products.search(...)` | `GET /products/search?...` |
| `products.get(id)` | `GET /products/{id}` |

Les trois écritures présentes dans `yazio-mcp` (ajout/suppression d'aliment et ajout d'eau)
ne sont pas exposées. L'ajout d'eau y est notamment un monkey-patch sur un endpoint absent de
la bibliothèque.

Limites : Yazio ne publie aucune API officielle ; ces endpoints sont rétro-ingéniérés et
peuvent changer sans préavis. Les lectures par période nécessitent un appel par date. Le client
amont ne propose ni timeout ni injection de `fetch` ; `fitness-mcp` lui applique donc une
politique réseau globale bornée, sans journaliser URL sensible, en-têtes, identifiants ou jetons.
Le package `yazio` ne déclare pas de licence dans le dépôt audité ; il reste une dépendance npm
non copiée dans les sources de ce projet. Ce point doit être revérifié avant une distribution
publique.

## Décisions

- Aucun sous-processus MCP : un seul processus Node et un seul endpoint `/mcp`.
- Lecture seule pour toutes les intégrations.
- Les réponses sont nettoyées récursivement des champs de type credentials/token avant retour.
- Les erreurs sont normalisées et n'incluent jamais corps brut, en-têtes ou secrets.
- Une panne Lyfta ou Yazio devient une erreur d'outil ou une section `unavailable`, jamais un
  crash du serveur complet.
