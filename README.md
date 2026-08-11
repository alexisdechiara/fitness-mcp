# fitness-mcp

Serveur MCP distant, unique et **lecture seule**, qui agrège les entraînements Lyfta, la
nutrition Yazio et l'évolution du poids derrière `POST /mcp`.

Il est écrit en Node.js/TypeScript avec le SDK officiel `@modelcontextprotocol/sdk`, utilise le
transport Streamable HTTP stateless, écoute sur le port interne `3000` et est prêt pour un
déploiement Docker Compose Raw dans Dokploy. TLS reste géré par Dokploy/Traefik.

L'accès distant utilise par défaut un flux OAuth 2.1 Authorization Code avec PKCE S256, DCR ou
client Claude pré-enregistré, jetons opaques révocables et stockage persistant local. Le mode
Bearer fixe reste disponible pour les clients capables d'ajouter un header.

La version `1.30.0` du package demandé est épinglée. Le SDK officiel propose aussi depuis 2026
une ligne v2 découpée en plusieurs packages ; la séparation transport/outils de ce projet prépare
une migration sans toucher aux intégrations métier.

## Ce qui est exposé

### Lyfta

- `lyfta_list_workouts`
- `lyfta_list_workout_summaries`
- `lyfta_list_exercises`
- `lyfta_get_exercise_progress`
- `lyfta_search_exercise_library`
- `lyfta_list_clients` (comptes Coach/Scale uniquement)

### Yazio

- `yazio_get_daily_summary`
- `yazio_get_consumed_items`
- `yazio_get_weight`
- `yazio_get_exercises`
- `yazio_get_water_intake`
- `yazio_get_goals`
- `yazio_get_settings`
- `yazio_search_products`
- `yazio_get_product`
- `yazio_get_dietary_preferences`
- `yazio_get_suggested_products`

### Agrégations Fitness

- `fitness_daily_summary`
- `fitness_weekly_summary`
- `fitness_training_nutrition_summary`
- `fitness_muscle_volume`
- `fitness_exercise_progress`

Les agrégations calculent des indicateurs objectifs. Elles ne produisent aucun diagnostic
médical et laissent l'interprétation à l'IA cliente. Chaque outil retourne du JSON texte pour
compatibilité et `structuredContent` pour les clients qui le prennent en charge.

## Audit des APIs

Le code a été précédé d'un audit du code réel de `jkronlachner/lyfta-mcp`,
`fliptheweb/yazio-mcp`, du client `yazio@1.1.3` et de la documentation Lyfta. Les endpoints,
fonctions réutilisées, limites et écarts sont détaillés dans [docs/UPSTREAMS.md](docs/UPSTREAMS.md).
L'architecture est décrite dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

En bref : Lyfta utilise `Authorization: Bearer LYFTA_API_KEY`. Yazio utilise une API v15 non
officielle et rétro-ingéniérée ; le client échange username/password contre un token en mémoire.
Aucun sous-processus STDIO n'est lancé.

## Configuration

Copier `.env.example` vers `.env` pour le développement, sans jamais commiter ce fichier.

| Variable | Requise | Défaut | Rôle |
| --- | --- | --- | --- |
| `LYFTA_API_KEY` | recommandée | — | clé Bearer Lyfta côté serveur |
| `LYFTA_BASE_URL` | non | `https://my.lyfta.app` | origine HTTPS de l'API Lyfta |
| `YAZIO_USERNAME` | avec le password | — | identifiant Yazio côté serveur |
| `YAZIO_PASSWORD` | avec le username | — | mot de passe Yazio côté serveur |
| `MCP_AUTH_MODE` | oui en prod | `oauth` | `oauth` recommandé, `bearer`, ou `none` hors production seulement |
| `MCP_ACCESS_TOKEN` | en mode bearer | — | secret fixe historique de `/mcp`, 32 caractères minimum |
| `PORT` | non | `3000` | port HTTP interne |
| `LOG_LEVEL` | non | `info` | `debug`, `info`, `warn`, `error` |
| `MCP_ALLOWED_HOSTS` | non | domaine cible + local | allowlist Host, séparée par virgules |
| `MCP_ALLOWED_ORIGINS` | non | vide | allowlist d'origines complètes (`https://...`) pour clients navigateur directs |
| `TRUST_PROXY_HOPS` | non | `0` (`1` dans Compose) | nombre exact de proxies de confiance pour les limites par IP |
| `UPSTREAM_TIMEOUT_MS` | non | `15000` | timeout par appel upstream |
| `UPSTREAM_RETRIES` | non | `2` | retries réseau temporaires maximum |
| `UPSTREAM_CONCURRENCY` | non | `4` | parallélisme des lectures par date |
| `FITNESS_MAX_RANGE_DAYS` | non | `366` | période maximale inclusive |
| `FITNESS_MAX_WORKOUTS` | non | `1000` | borne de pagination Lyfta |

Variables du mode OAuth :

| Variable | Requise | Défaut | Rôle |
| --- | --- | --- | --- |
| `OAUTH_ISSUER_URL` | non | `https://fitness.alexisdechiara.fr` | origine publique HTTPS seule, sans chemin, userinfo, query ni fragment |
| `OAUTH_RESOURCE_URL` | non | issuer + `/mcp` | audience canonique, même origin et chemin exactement `/mcp` |
| `OAUTH_STORE_PATH` | non | `/data/oauth-store.json` | store OAuth persistant mono-conteneur |
| `OAUTH_DCR_ENABLED` | non | `true` | expose `/register` pour l'ajout Claude automatique |
| `OAUTH_ALLOWED_REDIRECT_URIS` | non | callback Claude | redirect URIs HTTPS exactes séparées par des virgules |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | non | `900` | durée de l'access token, en secondes |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | non | `2592000` | durée du refresh token, en secondes |
| `OAUTH_AUTH_CODE_TTL_SECONDS` | non | `90` | durée du code à usage unique, en secondes |
| `OAUTH_SESSION_TTL_SECONDS` | non | `28800` | durée de session login/consent, en secondes |
| `OAUTH_MAX_DYNAMIC_CLIENTS` | avec DCR | `100` | plafond de clients dynamiques persistés |
| `FITNESS_ADMIN_USERNAME` | oui | — | compte humain des pages login/consent |
| `FITNESS_ADMIN_PASSWORD` | oui | — | mot de passe du compte, 16 caractères minimum |
| `CLAUDE_CLIENT_ID` | si DCR désactivé | — | client Claude confidentiel pré-enregistré |
| `CLAUDE_CLIENT_SECRET` | avec le Client ID | — | secret du client pré-enregistré, 32 caractères minimum |

Le callback des surfaces Claude hébergées est exactement :

```text
https://claude.ai/api/mcp/auth_callback
```

`CLAUDE_CLIENT_ID` et `CLAUDE_CLIENT_SECRET` se configurent toujours ensemble. Ils sont
obligatoires lorsque `OAUTH_DCR_ENABLED=false` et facultatifs lorsque DCR est actif.

Générer un secret avec OpenSSL :

```bash
openssl rand -base64 48
```

PowerShell :

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Une intégration peut être laissée non configurée : ses outils renverront une erreur claire et
les agrégations continueront avec les données disponibles. Le healthcheck ne tente jamais de
se connecter avec les credentials.

## Développement

Prérequis : Node.js 20+ et pnpm.

```bash
pnpm install
pnpm dev
```

Commandes de vérification :

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

Pour un test local sans Bearer, utiliser uniquement :

```env
NODE_ENV=development
MCP_AUTH_MODE=none
```

Ce réglage est refusé en production.

## Docker

Valider puis lancer :

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 fitness-mcp
```

Vérifier le healthcheck depuis le conteneur (le port est seulement exposé au réseau Docker) :

```bash
docker compose exec fitness-mcp node -e \
  "fetch('http://127.0.0.1:3000/healthz').then(async r => { console.log(await r.text()); if (!r.ok) process.exit(1) })"
```

Réponse attendue :

```json
{
  "status": "ok",
  "services": {
    "lyfta": "configured",
    "yazio": "configured"
  }
}
```

Le conteneur est multi-stage, tourne avec l'utilisateur non privilégié `node` et inclut son
healthcheck sans ajouter `curl` à l'image. Le volume déclaré `fitness-mcp-oauth` est monté sur
`/data`; ne pas le supprimer lors d'un redéploiement, sinon clients DCR, grants, refresh tokens
et révocations seront perdus. Le store fichier ne supporte qu'un replica à la fois.

## Déploiement Dokploy (Docker Compose Raw)

1. Créer un projet puis un service **Docker Compose** dans Dokploy.
2. Choisir le dépôt GitHub contenant ce projet, ou coller `docker-compose.yml` en mode Raw.
3. Ajouter les variables `LYFTA_API_KEY`, `YAZIO_USERNAME`, `YAZIO_PASSWORD`,
   `FITNESS_ADMIN_USERNAME` et un `FITNESS_ADMIN_PASSWORD` unique d'au moins 16 caractères dans
   les secrets/environnements Dokploy.
4. Conserver `NODE_ENV=production`, `MCP_AUTH_MODE=oauth`,
   `OAUTH_ISSUER_URL=https://fitness.alexisdechiara.fr`,
   `OAUTH_RESOURCE_URL=https://fitness.alexisdechiara.fr/mcp`,
   `OAUTH_STORE_PATH=/data/oauth-store.json` et `OAUTH_DCR_ENABLED=true` pour l'ajout Claude
   automatique. Pour fermer DCR, définir à la place la paire `CLAUDE_CLIENT_ID` /
   `CLAUDE_CLIENT_SECRET`.
5. Associer le domaine `fitness.alexisdechiara.fr` au service `fitness-mcp`.
6. Router ce domaine vers le port conteneur `3000` ; ne pas publier directement ce port sur
   l'hôte.
7. Activer HTTPS et le certificat Let's Encrypt dans Dokploy.
8. Vérifier `https://fitness.alexisdechiara.fr/healthz`.
9. Vérifier que `POST /mcp` sans jeton répond `401` avec `resource_metadata`, puis ouvrir les
   trois documents de découverte décrits ci-dessous.
10. Confirmer que le volume `/data` reste attaché après un redeploy avant de connecter Claude.

Traefik doit conserver le header `Host`. Le Compose fixe `TRUST_PROXY_HOPS=1` pour son unique saut
Traefik ; remettre `0` si le conteneur est exposé directement, et ne jamais surestimer ce nombre.
Si Dokploy utilise un nom différent pour ses probes, l'ajouter à `MCP_ALLOWED_HOSTS`.

## Test MCP

### Ajouter simplement Claude

Avec le mode OAuth et DCR du Compose fourni :

1. ouvrir **Customize > Connectors > Add custom connector** dans Claude ;
2. saisir `https://fitness.alexisdechiara.fr/mcp` ;
3. laisser les champs OAuth Client ID/Secret vides ;
4. cliquer sur **Connect** ;
5. se connecter avec le compte `FITNESS_ADMIN_*`, vérifier la demande puis consentir.

Claude découvre automatiquement :

```text
https://fitness.alexisdechiara.fr/.well-known/oauth-protected-resource/mcp
https://fitness.alexisdechiara.fr/.well-known/oauth-protected-resource
https://fitness.alexisdechiara.fr/.well-known/oauth-authorization-server
```

Si DCR est désactivé, renseigner dans les réglages avancés du connecteur les mêmes
`CLAUDE_CLIENT_ID` et `CLAUDE_CLIENT_SECRET` que sur le serveur.

Vérifier la découverte sans afficher de secret :

```bash
curl -fsS https://fitness.alexisdechiara.fr/.well-known/oauth-protected-resource/mcp
curl -fsS https://fitness.alexisdechiara.fr/.well-known/oauth-protected-resource
curl -fsS https://fitness.alexisdechiara.fr/.well-known/oauth-authorization-server
```

Le parcours reproductible complet — génération PKCE, DCR, interaction navigateur sur
`/oauth/login` et `/oauth/consent`, échange `/token`, refresh avec rotation et révocation
`/revoke` — est dans
[docs/SECURITY_AND_OAUTH.md](docs/SECURITY_AND_OAUTH.md#parcours-de-test-oauth-complet).

### Mode Bearer historique

Pour un client qui accepte un header fixe, configurer `MCP_AUTH_MODE=bearer` et utiliser :

```text
https://fitness.alexisdechiara.fr/mcp
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

Claude Code :

```bash
claude mcp add --transport http fitness \
  https://fitness.alexisdechiara.fr/mcp \
  --header "Authorization: Bearer VOTRE_MCP_ACCESS_TOKEN"
```

Avec l'Inspector officiel :

```bash
npx -y @modelcontextprotocol/inspector
```

Choisir **Streamable HTTP**, saisir l'URL, ajouter le header Bearer, puis appeler `tools/list` et
un outil simple comme `yazio_get_settings`.

Pour diagnostiquer le handshake manuellement :

```bash
curl -i -X POST https://fitness.alexisdechiara.fr/mcp \
  -H "Authorization: Bearer VOTRE_MCP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Les connecteurs personnalisés Claude proposent aussi les headers fixes en bêta, avec un
déploiement progressif. Cette option partage le secret au niveau de l'organisation et n'offre ni
consentement par utilisateur ni révocation sélective ; OAuth reste recommandé. Ne jamais mettre
un token dans l'URL.

## Méthodes de calcul

- Calories, protéines, glucides et lipides : somme des quatre repas du résumé Yazio.
- Volume d'une série : `poids × répétitions`, uniquement si les deux valeurs sont numériques et
  que la série n'est pas explicitement incomplète.
- Volume de séance : somme calculée, ou `total_volume` Lyfta comme repli.
- Séries directes : muscles de `Target_muscles_id` ; indirectes :
  `Synergist_muscles_id`, d'après les métadonnées officielles Lyfta.
- Aucun coefficient arbitraire n'est appliqué. Un volume attribué à plusieurs muscles est une
  exposition non additive, explicitement signalée dans la sortie.
- Les moyennes nutritionnelles ignorent les jours indisponibles et indiquent leur couverture.

## Limites connues

- L'API Yazio n'est pas officielle et peut cesser de fonctionner sans préavis.
- La version auditée du client utilise `/v15`; l'amont discute déjà d'autres versions.
- Yazio ne fournit pas de véritable endpoint de période : une synthèse appelle un jour à la fois.
- Lyfta ne documente pas de filtre de date pour les workouts ; le serveur pagine puis filtre
  localement, avec une borne explicite.
- La progression Lyfta officielle donne les meilleurs résultats par date ; l'historique complet
  des séries est reconstruit depuis les workouts disponibles.
- Les écritures Yazio/Lyfta sont volontairement absentes.
- Le serveur ne délivre aucun avis médical.
- `yazio@1.1.3` ne déclarait pas de licence lors de l'audit ; voir
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Sécurité

Les logs sont des objets JSON minimaux et n'incluent ni headers ni corps. Les réponses sont
nettoyées des credentials/tokens et les erreurs sont redigées. Les jetons OAuth sont opaques ;
seules leurs empreintes sont persistées dans `/data/oauth-store.json`, avec écritures atomiques et
permissions restrictives. Ce store est mono-processus : ne pas augmenter le nombre de replicas
sans le remplacer par un stockage transactionnel partagé.

Voir [docs/SECURITY_AND_OAUTH.md](docs/SECURITY_AND_OAUTH.md) pour le flux complet, les commandes
PKCE/token/refresh/revoke, les règles de rotation, les limites DCR et la checklist de production.

## Licence

MIT. Les notices des composants amont adaptés ou inspectés sont dans
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
