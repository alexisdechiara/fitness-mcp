# Architecture proposée

```text
fitness-mcp/
├── src/
│   ├── auth/                 # garde MCP, indépendante des credentials amont
│   ├── clients/              # LyftaClient et façade Yazio
│   ├── config/               # validation stricte de l'environnement
│   ├── domain/               # types, dates, muscles, normalisation
│   ├── oauth/                # Authorization Server, pages HTML et store opaque persistant
│   ├── services/             # agrégations fitness
│   ├── tools/                # outils Lyfta, Yazio et Fitness
│   ├── app.ts                # application Express + Streamable HTTP
│   ├── mcp-server.ts         # construction d'un McpServer par requête
│   └── index.ts              # démarrage et arrêt gracieux
├── test/                     # tests unitaires et transport MCP
├── docs/                     # audit, architecture et sécurité OAuth
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── README.md
```

Le transport MCP est stateless : chaque `POST /mcp` reçoit un serveur/transport isolé, ce qui
évite un état de session MCP en mémoire et fonctionne derrière Traefik sans affinité. `GET` et
`DELETE` sur `/mcp` répondent `405`. Les résultats sont disponibles en contenu texte JSON et en
`structuredContent`.

L'Authorization Server conserve en revanche l'état OAuth nécessaire entre les requêtes : clients
DCR, interactions login/consent, codes, grants, empreintes des jetons, sessions et révocations.
Cet état est persisté dans `OAUTH_STORE_PATH`, monté sur `/data` dans Docker. « MCP stateless » ne
signifie donc pas que le conteneur OAuth peut être répliqué ou remplacé sans son volume.

Le projet épingle `@modelcontextprotocol/sdk@1.30.0` afin de respecter le package demandé. Au
moment de l'audit, cette branche officielle v1 était maintenue mais le SDK greenfield recommandé
avait migré vers les packages v2 séparés (`@modelcontextprotocol/server`, `node` et `express`).
Une migration ultérieure pourra remplacer le câblage du transport sans modifier les adaptateurs
Lyfta/Yazio ni les services métier.

## Frontières de sécurité

Les secrets amont restent exclusivement dans l'environnement du conteneur. Ils ne sont ni des
credentials OAuth MCP ni des jetons acceptés sur `/mcp` :

```text
Client MCP -- access token fitness-mcp --> Resource Server /mcp
                                             |-- LYFTA_API_KEY --> Lyfta
                                             `-- credentials --> Yazio OAuth amont
```

Trois gardes interchangeables protègent le transport :

- `oauth` valide un jeton opaque actif, son expiration, la ressource exacte et `fitness:read` ;
- `bearer` compare `MCP_ACCESS_TOKEN` en temps constant ;
- `none` est limité au développement et interdit en production.

Le mode OAuth intègre un Authorization Server minimal dans le même processus. La découverte RFC
9728/RFC 8414, DCR facultatif, Authorization Code avec PKCE S256, login, consentement, échange,
refresh avec rotation et révocation sont des routes HTTP séparées du SDK MCP. Le middleware
d'authentification répond `401` et `WWW-Authenticate` avant de déléguer la requête au transport.

## Cycle OAuth et persistance

Le flux nominal est :

1. le client appelle `/mcp` et reçoit l'URL du Protected Resource Metadata ;
2. il découvre l'issuer et les endpoints OAuth ;
3. il utilise le client Claude pré-enregistré ou crée un client public via `/register` ;
4. `/authorize` vérifie `client_id`, redirect URI exacte, `resource`, scope et PKCE S256 ;
5. l'administrateur se connecte et consent dans le navigateur ;
6. un code opaque, court et à usage unique est échangé sur `/token` ;
7. l'access token protège `/mcp`, le refresh token est rotatif et `/revoke` invalide le token ou
   le grant associé.

Les valeurs brutes des interactions, CSRF, sessions, codes et jetons sont générées avec un CSPRNG
et remises seulement à leur destinataire. Le store écrit leurs empreintes SHA-256 et les
métadonnées d'autorisation. Chaque mutation est sérialisée dans un fichier temporaire créé avec
des permissions restrictives, puis renommé atomiquement ; le fichier final reçoit le mode `0600`
quand la plateforme le permet.

Ce modèle vise un seul processus Node.js et un seul conteneur. Il n'existe ni verrou distribué,
ni transaction entre replicas, ni réplication du store. Le volume Docker rend les redéploiements
du même service durables, mais ne permet pas le scaling horizontal. Avant plusieurs replicas,
remplacer le store fichier par une base transactionnelle/IdP partagé et tester la cohérence des
rotations et révocations.

Le secret du client Claude pré-enregistré, le mot de passe administrateur et les secrets amont
restent dans les secrets d'environnement Dokploy. Le store contient des hashes, mais aussi des
métadonnées sensibles ; ses sauvegardes doivent être protégées comme des données
d'authentification.

## Compatibilité MCP et Claude

Le serveur reste sur la famille protocolaire avec handshake prise en charge par
`@modelcontextprotocol/sdk@1.30.0`. Claude documente les spécifications d'autorisation
`2025-03-26`, `2025-06-18` et `2025-11-25` ; le projet cible `2025-11-25` pour les exemples.

La spécification MCP courante `2026-07-28` déprécie DCR au profit de CIMD. DCR reste activable et
recommandé dans le Compose personnel parce que Claude le supporte nativement et qu'il permet
l'ajout par URL sans distribuer un Client ID/Secret. Le plafond de clients dynamiques borne son
coût. Pour une diffusion large, ajouter CIMD ou utiliser un client pré-enregistré.

## Agrégations

Les agrégations travaillent sur des dates civiles `YYYY-MM-DD`, sans conversion implicite par le
fuseau de la machine. Elles bornent la longueur d'une période et la quantité de workouts chargée.
Les calories/macros viennent de la somme des quatre repas du résumé Yazio. Les volumes Lyfta sont
calculés avec `poids × répétitions` pour les séries terminées ; la valeur officielle du workout
sert de repli.

Les séries directes/indirectes utilisent exclusivement les tableaux officiels
`Target_muscles_id` et `Synergist_muscles_id`. Un volume attribué à plusieurs muscles est une
mesure d'exposition et n'est pas additif ; cette méthode est incluse dans chaque résultat.
