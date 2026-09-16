# Sécurité et OAuth

`fitness-mcp` propose trois modes d'accès à `POST /mcp` :

- `oauth`, recommandé en production et pour un connecteur Claude hébergé ;
- `bearer`, mode historique avec un secret fixe, utile pour Claude Code et l'Inspector ;
- `none`, uniquement pour le développement puisque ce mode est refusé avec
  `NODE_ENV=production`.

Les secrets Lyfta et Yazio restent dans l'environnement du serveur dans tous les modes. Un client
MCP ne reçoit jamais `LYFTA_API_KEY`, `YAZIO_PASSWORD`, les jetons Yazio ni leurs dérivés.

## Architecture OAuth intégrée

En mode `oauth`, le même processus joue le rôle d'Authorization Server OAuth 2.1 minimal et de
Resource Server MCP :

```text
Claude                     fitness-mcp                         APIs amont
  |                            |                                   |
  |-- découverte ------------>|                                   |
  |-- DCR ou client connu ---->|                                   |
  |-- Authorization Code -----|                                   |
  |      + PKCE S256           |                                   |
  |<-- login + consent --------|                                   |
  |-- code -> token ---------->|                                   |
  |-- Bearer fitness:read ---->|-- secrets serveur uniquement ---->|
```

Le jeton d'accès MCP est propre à `fitness-mcp`. Le serveur interdit son transfert à Lyfta ou
Yazio et vérifie qu'il a été émis pour la ressource exacte
`https://fitness.alexisdechiara.fr/mcp` avec le scope `fitness:read`.

### Endpoints publics

| Méthode et URL | Fonction |
| --- | --- |
| `POST /mcp` | endpoint MCP protégé ; renvoie un challenge OAuth `401` sans jeton valide |
| `GET /.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata RFC 9728, chemin prioritaire |
| `GET /.well-known/oauth-protected-resource` | même metadata, fallback racine |
| `GET /.well-known/oauth-authorization-server` | metadata RFC 8414 de l'Authorization Server |
| `GET /authorize` | démarrage d'Authorization Code avec PKCE S256 |
| `POST /token` | échange du code et rotation du refresh token, corps form-urlencoded |
| `POST /revoke` | révocation RFC 7009 d'un access token ou d'un refresh token |
| `POST /register` | Dynamic Client Registration RFC 7591, seulement si DCR est activé |
| `GET`, `POST /oauth/login` | formulaire de connexion de l'administrateur Fitness |
| `GET`, `POST /oauth/consent` | affichage puis acceptation/refus du client, de la ressource et des scopes |
| `POST /oauth/logout` | fermeture de la session administrateur dans le navigateur |
| `GET /healthz` | état minimal du service, sans tester ni exposer les credentials |

Avec l'issuer de production, les URLs complètes sont :

```text
https://fitness.alexisdechiara.fr/mcp
https://fitness.alexisdechiara.fr/healthz
https://fitness.alexisdechiara.fr/.well-known/oauth-protected-resource/mcp
https://fitness.alexisdechiara.fr/.well-known/oauth-protected-resource
https://fitness.alexisdechiara.fr/.well-known/oauth-authorization-server
https://fitness.alexisdechiara.fr/authorize
https://fitness.alexisdechiara.fr/token
https://fitness.alexisdechiara.fr/revoke
https://fitness.alexisdechiara.fr/register
https://fitness.alexisdechiara.fr/oauth/login
https://fitness.alexisdechiara.fr/oauth/consent
https://fitness.alexisdechiara.fr/oauth/logout
https://claude.ai/api/mcp/auth_callback
```

`/register` renvoie `404` et n'est pas annoncé lorsque DCR est désactivé.

Une requête MCP sans jeton reçoit au niveau HTTP :

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://fitness.alexisdechiara.fr/.well-known/oauth-protected-resource/mcp", scope="fitness:read"
```

Claude ignore un `WWW-Authenticate` enveloppé dans une réponse MCP `200`. Le challenge est donc
émis avant que la requête JSON-RPC n'atteigne le SDK MCP.

## Configuration exacte

| Variable | Défaut applicatif | Rôle et contrainte |
| --- | --- | --- |
| `MCP_AUTH_MODE` | `oauth` | `oauth`, `bearer`, ou `none` hors production |
| `OAUTH_ISSUER_URL` | `https://fitness.alexisdechiara.fr` | origine publique seule, HTTPS en production, sans chemin, query, fragment ni userinfo |
| `OAUTH_RESOURCE_URL` | issuer + `/mcp` | URL canonique, même origin que l'issuer et chemin exactement `/mcp` |
| `OAUTH_STORE_PATH` | `/data/oauth-store.json` | fichier persistant du serveur OAuth |
| `OAUTH_DCR_ENABLED` | `true` | active `/register` pour l'ajout Claude le plus simple |
| `OAUTH_ALLOWED_REDIRECT_URIS` | callback Claude hébergé | liste CSV de redirect URIs HTTPS exactes, sans fragment ni userinfo |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `900` | durée d'un access token, entre 60 et 3 600 secondes |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | durée d'un refresh token, entre 3 600 et 31 536 000 secondes |
| `OAUTH_AUTH_CODE_TTL_SECONDS` | `90` | durée d'un authorization code, entre 30 et 600 secondes |
| `OAUTH_SESSION_TTL_SECONDS` | `28800` | durée de la session navigateur, entre 300 et 604 800 secondes |
| `OAUTH_MAX_DYNAMIC_CLIENTS` | `100` | nombre maximal de clients DCR persistés, entre 1 et 10 000 |
| `FITNESS_ADMIN_USERNAME` | aucun | obligatoire en mode OAuth |
| `FITNESS_ADMIN_PASSWORD` | aucun | obligatoire en mode OAuth, 16 caractères minimum |
| `CLAUDE_CLIENT_ID` | aucun | client confidentiel pré-enregistré, à définir avec le secret |
| `CLAUDE_CLIENT_SECRET` | aucun | secret du client pré-enregistré, 32 caractères minimum, à définir avec l'identifiant |
| `MCP_ACCESS_TOKEN` | aucun | uniquement pour `MCP_AUTH_MODE=bearer`, 32 caractères minimum |
| `TRUST_PROXY_HOPS` | `0` (`1` dans Compose) | nombre exact de proxies de confiance utilisés pour déterminer l'IP des rate limits |

Lorsque `OAUTH_DCR_ENABLED=false`, la paire `CLAUDE_CLIENT_ID` et `CLAUDE_CLIENT_SECRET` est
obligatoire. Lorsqu'il vaut `true`, la paire reste optionnelle : le serveur peut accepter à la
fois le client pré-enregistré et les clients publics créés par DCR.

Les clients DCR sont publics et utilisent `token_endpoint_auth_method=none`. Le client
pré-enregistré est confidentiel : `/token` et `/revoke` acceptent son secret avec
`client_secret_basic` (HTTP Basic) ou `client_secret_post`. Le secret n'est jamais envoyé à
`/authorize` ni placé dans une URL.

## Ajouter le connecteur dans Claude

### Option recommandée pour un serveur personnel : DCR

Déployer avec au minimum :

```env
MCP_AUTH_MODE=oauth
OAUTH_ISSUER_URL=https://fitness.alexisdechiara.fr
OAUTH_RESOURCE_URL=https://fitness.alexisdechiara.fr/mcp
OAUTH_DCR_ENABLED=true
OAUTH_ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
FITNESS_ADMIN_USERNAME=un-identifiant-unique
FITNESS_ADMIN_PASSWORD=une-phrase-secrete-longue-et-unique
```

Dans Claude :

1. ouvrir **Customize > Connectors** puis **Add custom connector** ;
2. saisir uniquement `https://fitness.alexisdechiara.fr/mcp` ;
3. ne pas renseigner de Client ID/Secret ;
4. cliquer sur **Connect**, se connecter avec `FITNESS_ADMIN_USERNAME` et
   `FITNESS_ADMIN_PASSWORD`, vérifier le client, la ressource et le scope, puis consentir.

Claude découvre le Protected Resource Metadata, le serveur d'autorisation et `/register`, crée
un client public, puis utilise Authorization Code avec PKCE S256. La metadata de l'Authorization
Server annonce `offline_access`; Claude l'ajoute à la demande afin de recevoir un refresh token.

### Option sans DCR : client Claude pré-enregistré

Générer deux valeurs aléatoires indépendantes et configurer :

```env
OAUTH_DCR_ENABLED=false
CLAUDE_CLIENT_ID=fitness-claude
CLAUDE_CLIENT_SECRET=remplacer-par-un-secret-aleatoire-de-32-caracteres-minimum
```

Dans les réglages avancés du connecteur Claude, fournir exactement le même Client ID et le même
secret. Cette option évite la création de clients dynamiques et est préférable lorsque
l'Authorization Server doit rester fermé à toute inscription publique.

Le callback des surfaces Claude hébergées est exactement :

```text
https://claude.ai/api/mcp/auth_callback
```

Il doit être présent dans `OAUTH_ALLOWED_REDIRECT_URIS`. La comparaison est exacte : un slash,
un chemin ou une casse différente produit un refus.

L'Authorization Server intégré refuse volontairement toutes les redirect URIs HTTP, y compris
les loopbacks. Le flux OAuth loopback de Claude Code (`http://localhost:<port>/callback`) n'est
donc pas pris en charge par ce serveur minimal. Pour Claude Code, utiliser le mode Bearer et le
header documenté dans le README. Ajouter plus tard les règles RFC 8252 avec comparaison de port
spécifique si un flux OAuth natif devient nécessaire.

### Pourquoi DCR reste proposé

Claude prend officiellement DCR en charge et l'utilise automatiquement lorsqu'un
`registration_endpoint` est annoncé. MCP `2026-07-28` a toutefois déprécié DCR au profit des
Client ID Metadata Documents (CIMD). `fitness-mcp` conserve DCR pour l'interopérabilité Claude
documentée aujourd'hui ; une version future pourra ajouter CIMD sans changer les outils métier.

Pour un connecteur très diffusé, DCR crée de nombreux clients persistants. Le plafond
`OAUTH_MAX_DYNAMIC_CLIENTS` empêche une croissance illimitée, mais il ne remplace ni un contrôle
d'accès réseau ni une stratégie CIMD ou un client pré-enregistré. Une inscription qui n'atteint
jamais un consentement authentifié est automatiquement supprimée après une heure ; un client déjà
autorisé reste persistant pour ne pas casser une connexion Claude existante.

## Parcours de test OAuth complet

Ce parcours teste découverte, DCR, PKCE, login, consentement, échange, refresh et révocation.
L'Authorization Code est un flux avec navigateur : `curl` prépare et termine le flux, mais la
connexion et le consentement doivent être réalisés dans une fenêtre de navigateur pour conserver
les cookies, la protection CSRF et permettre une décision humaine.

Les exemples utilisent Bash, `openssl`, `curl` et `jq`. Pour ne pas envoyer un authorization code
à un tiers, choisir une redirect URI HTTPS sous votre contrôle. Pour un diagnostic ponctuel, on
peut autoriser `https://callback.invalid/oauth` : ce domaine réservé ne reçoit rien, le navigateur
affiche une erreur après le consentement et l'URL complète contenant `code` et `state` reste
copiable dans sa barre d'adresse. Ajouter temporairement cette URI à
`OAUTH_ALLOWED_REDIRECT_URIS`, redéployer, puis la retirer après le test.

### 1. Variables et découverte

```bash
umask 077
export ISSUER='https://fitness.alexisdechiara.fr'
export RESOURCE='https://fitness.alexisdechiara.fr/mcp'
export REDIRECT_URI='https://callback.invalid/oauth'
export SCOPE='fitness:read offline_access'

curl -fsS "$ISSUER/.well-known/oauth-protected-resource/mcp" | jq
curl -fsS "$ISSUER/.well-known/oauth-protected-resource" | jq
curl -fsS "$ISSUER/.well-known/oauth-authorization-server" | jq
curl -i -sS -X POST "$RESOURCE" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

La dernière commande doit répondre `401` avec `resource_metadata` et `scope="fitness:read"`.

### 2. Enregistrer un client public DCR

Cette étape nécessite `OAUTH_DCR_ENABLED=true` et la redirect URI dans l'allowlist.

Avec le client pré-enregistré, ignorer la commande DCR, exécuter
`export CLIENT_ID="$CLAUDE_CLIENT_ID"`, puis continuer à l'étape 3. Son secret ne doit intervenir
qu'aux endpoints `/token` et `/revoke`, jamais dans l'URL d'autorisation.

```bash
curl -fsS -X POST "$ISSUER/register" \
  -H 'Content-Type: application/json' \
  --data "$(jq -n \
    --arg redirect "$REDIRECT_URI" \
    --arg scope "$SCOPE" \
    '{client_name:"fitness-mcp curl test",application_type:"web",redirect_uris:[$redirect],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none",scope:$scope}')" \
  > /tmp/fitness-mcp-client.json

export CLIENT_ID="$(jq -r .client_id /tmp/fitness-mcp-client.json)"
test -n "$CLIENT_ID" && test "$CLIENT_ID" != null
```

Ne pas placer de données sensibles dans `client_name`. Le client DCR est public et n'obtient pas
de secret ; PKCE protège l'échange du code. `offline_access` est demandé explicitement afin que
la réponse `/token` contienne un refresh token ; sans ce scope, seul un access token est émis.

### 3. Générer PKCE S256 et ouvrir l'autorisation

```bash
export CODE_VERIFIER="$(openssl rand -base64 64 | tr -d '=+/' | cut -c1-64)"
export CODE_CHALLENGE="$(printf '%s' "$CODE_VERIFIER" \
  | openssl dgst -sha256 -binary \
  | openssl base64 -A \
  | tr '+/' '-_' \
  | tr -d '=')"
export STATE="$(openssl rand -hex 24)"

export AUTH_URL="$(python -c 'import os,urllib.parse; print(os.environ["ISSUER"]+"/authorize?"+urllib.parse.urlencode({"response_type":"code","client_id":os.environ["CLIENT_ID"],"redirect_uri":os.environ["REDIRECT_URI"],"scope":os.environ["SCOPE"],"state":os.environ["STATE"],"code_challenge":os.environ["CODE_CHALLENGE"],"code_challenge_method":"S256","resource":os.environ["RESOURCE"]}))')"
printf '%s\n' "$AUTH_URL"
```

Ouvrir `AUTH_URL` dans un navigateur :

1. `/authorize` dirige vers `GET /oauth/login?interaction=...`, qui rend des champs cachés
   `interaction` et `csrf` ;
2. saisir les credentials `FITNESS_ADMIN_*` puis soumettre `POST /oauth/login` en
   form-urlencoded ; le serveur pose le cookie `__Host-fitness_admin` avec `Secure`, `HttpOnly`
   et `SameSite=Lax` ;
3. vérifier le nom du client, l'hôte de retour, la ressource, `fitness:read` et
   `offline_access` sur
   `GET /oauth/consent?interaction=...`, qui émet une nouvelle valeur CSRF ;
4. choisir **Autoriser**, ce qui soumet `POST /oauth/consent` avec `decision=allow` et le cookie ;
5. le navigateur est redirigé vers `REDIRECT_URI?code=...&state=...&iss=...`.

Copier l'URL finale, vérifier manuellement que son `state` est identique à `$STATE`, puis extraire
le code sans le publier dans un terminal partagé :

```bash
export CALLBACK_URL='COLLER_ICI_L_URL_COMPLETE_DU_NAVIGATEUR'
export RETURNED_STATE="$(python -c 'import os,urllib.parse; print(urllib.parse.parse_qs(urllib.parse.urlsplit(os.environ["CALLBACK_URL"]).query)["state"][0])')"
test "$RETURNED_STATE" = "$STATE"
export RETURNED_ISSUER="$(python -c 'import os,urllib.parse; print(urllib.parse.parse_qs(urllib.parse.urlsplit(os.environ["CALLBACK_URL"]).query)["iss"][0])')"
test "$RETURNED_ISSUER" = "$ISSUER"
export AUTH_CODE="$(python -c 'import os,urllib.parse; print(urllib.parse.parse_qs(urllib.parse.urlsplit(os.environ["CALLBACK_URL"]).query)["code"][0])')"
```

Le code expire après `OAUTH_AUTH_CODE_TTL_SECONDS` et ne peut être utilisé qu'une fois.

### 4. Échanger le code

```bash
curl -fsS -X POST "$ISSUER/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code=$AUTH_CODE" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "code_verifier=$CODE_VERIFIER" \
  --data-urlencode "resource=$RESOURCE" \
  > /tmp/fitness-mcp-token.json
```

Avec le client pré-enregistré, authentifier `/token` et `/revoke` soit en Basic :

```bash
curl -fsS -X POST "$ISSUER/token" \
  --user "$CLAUDE_CLIENT_ID:$CLAUDE_CLIENT_SECRET" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "code=$AUTH_CODE" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "code_verifier=$CODE_VERIFIER" \
  --data-urlencode "resource=$RESOURCE" \
  > /tmp/fitness-mcp-token.json
```

soit avec `client_id` et `client_secret` dans le corps form-urlencoded. Ne jamais utiliser les
deux méthodes simultanément. Pour les commandes refresh et révocation ci-dessous avec ce client,
remplacer `--data-urlencode "client_id=$CLIENT_ID"` par
`--user "$CLAUDE_CLIENT_ID:$CLAUDE_CLIENT_SECRET"` ; le serveur refuse de mélanger Basic et des
credentials client dans le corps.

Après l'une des deux variantes, charger les jetons sans afficher le fichier :

```bash
export ACCESS_TOKEN="$(jq -r .access_token /tmp/fitness-mcp-token.json)"
export REFRESH_TOKEN="$(jq -r .refresh_token /tmp/fitness-mcp-token.json)"
```

Tester ensuite le MCP :

```bash
curl -i -sS -X POST "$RESOURCE" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

### 5. Rafraîchir avec rotation

```bash
curl -fsS -X POST "$ISSUER/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "refresh_token=$REFRESH_TOKEN" \
  --data-urlencode "resource=$RESOURCE" \
  > /tmp/fitness-mcp-refreshed.json

export ACCESS_TOKEN="$(jq -r .access_token /tmp/fitness-mcp-refreshed.json)"
export REFRESH_TOKEN="$(jq -r .refresh_token /tmp/fitness-mcp-refreshed.json)"
```

Chaque refresh token est à usage unique. Toujours remplacer les deux variables par les nouvelles
valeurs. Réutiliser un ancien refresh token est considéré comme une compromission et révoque le
grant associé.

### 6. Révoquer

Révoquer le refresh token coupe tout le grant associé, y compris ses access tokens :

```bash
curl -i -sS -X POST "$ISSUER/revoke" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "token=$REFRESH_TOKEN" \
  --data-urlencode 'token_type_hint=refresh_token' \
  --data-urlencode "client_id=$CLIENT_ID"
```

Une nouvelle requête MCP avec `$ACCESS_TOKEN` doit alors répondre `401`. La révocation d'un access
token seul ne révoque que ce token. RFC 7009 demande une réponse non révélatrice même lorsqu'un
token est déjà inconnu ou révoqué.

Supprimer enfin les réponses contenant les credentials de test :

```bash
rm -f /tmp/fitness-mcp-client.json /tmp/fitness-mcp-token.json /tmp/fitness-mcp-refreshed.json
unset AUTH_CODE ACCESS_TOKEN REFRESH_TOKEN CODE_VERIFIER CODE_CHALLENGE CALLBACK_URL
unset RETURNED_STATE RETURNED_ISSUER
```

`POST /oauth/logout` ferme seulement la session navigateur de l'administrateur. Il ne remplace
pas `/revoke` pour les jetons déjà délivrés. Dans Claude, **Disconnect** supprime la connexion côté
client ; pour une coupure immédiate côté serveur, révoquer aussi le refresh token ou supprimer le
store après avoir arrêté le conteneur, en acceptant que cette dernière opération invalide toutes
les connexions.

## Stockage des secrets OAuth

Les authorization codes, access tokens, refresh tokens, identifiants d'interaction, valeurs CSRF
et sessions sont aléatoires et opaques. Le serveur ne persiste que leur empreinte SHA-256 avec les
métadonnées nécessaires : client, ressource, scopes, expiration, état et identifiant de grant.
La valeur brute n'est renvoyée qu'au client concerné. Le secret du client pré-enregistré et le mot
de passe administrateur restent dans l'environnement du processus.

Le store JSON est écrit avec un fichier temporaire puis un renommage atomique, avec un mode POSIX
`0600` lorsque la plateforme le permet. Le volume Docker nommé monte `/data`, de sorte que les
connexions, clients DCR et révocations survivent au remplacement du conteneur.

Ce store est conçu pour **un seul processus et un seul conteneur** :

- ne pas lancer plusieurs replicas sur le même fichier ;
- ne pas placer le fichier sur un partage réseau sans mécanisme de verrouillage ;
- ne pas effectuer deux déploiements concurrents sur le même volume ;
- migrer vers une base transactionnelle ou un IdP externe avant tout scaling horizontal.

Le hachage protège les valeurs brutes, mais le fichier contient des métadonnées sensibles. Limiter
les accès au volume, protéger les sauvegardes, ne jamais le commiter et ne pas l'inclure dans les
logs ou artefacts de support.

## Bearer statique et `static_headers`

Le mode historique reste disponible :

```env
MCP_AUTH_MODE=bearer
MCP_ACCESS_TOKEN=un-secret-aleatoire-d-au-moins-32-caracteres
```

Claude Code et l'Inspector peuvent envoyer ce header directement. Les connecteurs personnalisés
Claude prennent aussi désormais en charge des headers fixes (`static_headers`) **en bêta et avec
un déploiement progressif**. L'administrateur saisit par exemple la valeur complète
`Bearer <MCP_ACCESS_TOKEN>` pour le header `Authorization`; la valeur est partagée par
l'organisation et envoyée à chaque requête.

Ce mode n'apporte ni identité par utilisateur, ni consentement individuel, ni refresh, ni
révocation sélective. OAuth reste le choix recommandé. Ne jamais placer un token dans l'URL ou un
paramètre de query.

## Limites et checklist de production

- L'Authorization Server intégré est volontairement minimal : un seul compte administrateur, un
  seul scope `fitness:read`, jetons opaques et stockage local.
- Il ne fournit pas encore CIMD, fédération SSO, MFA, administration des grants ni stockage
  distribué. Utiliser un IdP audité si ces propriétés sont nécessaires.
- Il vise les surfaces Claude hébergées et leur callback HTTPS. Il ne gère pas actuellement les
  callbacks loopback HTTP des clients natifs comme Claude Code.
- DCR est public lorsqu'il est activé. Conserver un plafond bas, surveiller les réponses `429` et
  préférer le client pré-enregistré si seul Claude doit accéder au serveur.
- Les limiteurs sont locaux au processus : 20 inscriptions par heure et par IP, 100 demandes
  d'autorisation par 15 minutes et par IP, 50 requêtes token par 15 minutes et par IP, et
  5 échecs de login par 15 minutes et par IP. Ils réduisent les abus
  simples mais ne remplacent pas un rate limiting distribué au niveau de Traefik/WAF.
- Le Compose suppose un unique saut Traefik avec `TRUST_PROXY_HOPS=1`. Utiliser `0` sans reverse
  proxy et ne jamais déclarer plus de sauts que la topologie réelle, sous peine de faire confiance
  à une adresse `X-Forwarded-For` contrôlée par le client.
- TLS doit être terminé par Dokploy/Traefik. Ne jamais exposer directement le port `3000` sur
  Internet.
- Traefik doit conserver `Host`, `Authorization`, `Content-Type` et les cookies OAuth, sans les
  journaliser.
- Vérifier que `OAUTH_ISSUER_URL`, `OAUTH_RESOURCE_URL` et l'URL saisie dans Claude sont exactement
  cohérents, sans slash final ajouté à `/mcp`.
- Protéger `FITNESS_ADMIN_PASSWORD`, `CLAUDE_CLIENT_SECRET`, `MCP_ACCESS_TOKEN` et les credentials
  amont dans les secrets Dokploy ; les faire tourner après toute exposition présumée.
- Sauvegarder le volume OAuth avant une migration. Restaurer simultanément ancienne et nouvelle
  copie sur deux containers créerait deux autorités divergentes et n'est pas supporté.
- Les logs structurés ne doivent contenir ni headers, ni corps OAuth/MCP, ni query d'autorisation,
  ni cookies.
- Le healthcheck indique uniquement si Lyfta et Yazio sont configurés et ne valide jamais leurs
  credentials.
- L'API Yazio reste non officielle et peut changer sans préavis. `YAZIO_BASE_URL`,
  `YAZIO_CLIENT_ID` et `YAZIO_CLIENT_SECRET` permettent d'y répondre sans redéploiement de code ;
  `YAZIO_CLIENT_SECRET` est rédigé des logs comme les autres secrets.

## Références officielles

- [MCP Authorization 2025-11-25, version prise en charge par Claude](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Découverte de l'Authorization Server MCP](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)
- [Enregistrement des clients MCP](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- [Authentification des connecteurs Claude](https://claude.com/docs/connectors/building/authentication)
- [Authentification différée et challenges Claude](https://claude.com/docs/connectors/building/lazy-authentication)
- [Headers fixes des connecteurs personnalisés Claude](https://claude.com/docs/connectors/custom/remote-mcp#authenticating-with-request-headers)
