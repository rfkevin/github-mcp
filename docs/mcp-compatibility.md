# Compatibilité MCP/OAuth entre clients

Le même serveur et les mêmes contrats d’outils servent tous les clients MCP
compatibles. Aucune marque de client n’est reconnue ni privilégiée dans le code.
Un chatbot sans support MCP distant/OAuth nécessite un client ou une passerelle :
la conformité du serveur ne peut pas lui ajouter cette capacité.

## Contrat commun

- Transport Streamable HTTP sur `/mcp`, avec le mode de compatibilité du SDK
  conservé. Le client annonce les formats JSON et SSE ; une réponse SSE est
  normale et ne signifie pas que le serveur exige l’ancien transport `/sse`.
- Initialisation et négociation de version gérées par le SDK. Les tests couvrent
  `2025-03-26`, `2025-06-18` et `2025-11-25` avec initialisation, notification,
  découverte et appel d’outil. Ce n’est pas une promesse sur les versions futures.
- OAuth avec PKCE et jetons liés à la ressource. Enregistrement dynamique (DCR)
  et documents de métadonnées de client (CIMD) passent par le fournisseur OAuth.
- Chaque outil expose un `inputSchema`, un `outputSchema` objet et des annotations.
  Les réponses conservent le JSON texte et `structuredContent` pour les clients
  anciens et récents. Le SDK valide les succès contre le schéma déclaré ; les
  erreurs d’outil portent `isError: true` et `structuredContent.error`.
- Les capacités visibles dépendent uniquement des réglages et du consentement,
  pas du nom du client : 15 outils de lecture, jusqu’à 24 avec tous les modes.
  Une reconnexion n’accorde pas implicitement de nouveaux droits.

## Vérification de l’en-tête Origin

La norme exige de vérifier `Origin` lorsqu’il est présent. Notre politique
applicative, après validation du jeton et de l’utilisateur, accepte :

1. L’absence de cet en-tête, courante pour les clients natifs et serveur-à-serveur.
2. L’origine HTTPS du serveur lui-même.
3. L’origine exacte d’une adresse de retour OAuth du **client du jeton validé**.
   Schéma, hôte et port doivent correspondre ; `null`, chemins, identifiants,
   listes d’origines et domaines ressemblants sont refusés.

Le fournisseur résout le client DCR/CIMD ; aucun accès réseau n’est réalisé vers
l’URL de l’en-tête Origin. Sans en-tête ou pour l’origine du serveur, cette
recherche supplémentaire n’est pas nécessaire. Une métadonnée inaccessible
produit un 503, jamais une autorisation par défaut. Une origine refusée produit
un 403 et un motif fermé, sans jeton ni URL dans le journal applicatif.

Cette correspondance avec les adresses de retour est notre politique de sécurité,
**pas une obligation OAuth universelle** : un client dont l’interface et les
retours OAuth sont sur des origines différentes peut être refusé. Il faut alors
examiner ses métadonnées et définir une politique explicite, sans liste par marque,
sans joker global et sans retirer l’authentification. Les prérequêtes CORS OPTIONS
sont traitées par le fournisseur sans donner accès aux outils ; les vraies
requêtes restent authentifiées et soumises à la vérification ci-dessus.

## « Authentication succeeded, action discovery failed »

Une connexion OAuth réussie ne prouve pas que `initialize` ou `tools/list` a
réussi. Lors du diagnostic du 1er octobre 2026, le transport précédent refusait
localement une origine externe avec 403 ; les réponses structurées des outils
ne déclaraient pas de schéma de sortie. Le correctif traite ces deux points,
mais **la cause exacte du message de l’application en production n’a pas été
établie** : les statuts des POST concernés n’ont pas été récupérés.

Pour vérifier après une publication autorisée :

1. Relever le SHA publié via `/ready`. `sha: null` ne permet pas d’identifier le code.
2. Recommencer la connexion depuis le client, pas depuis `/authorize` sans paramètres.
3. Relever l’heure, la méthode et le statut des requêtes POST `/mcp` correspondantes.
   Un GET sans jeton renvoyant 401 est normal ; le niveau `info` seul ne prouve rien.
4. En cas de 403, rechercher `origin_not_allowed`. En cas de 503, rechercher
   `client_metadata_unavailable`. Pour une réponse 200, examiner aussi l’erreur
   JSON-RPC éventuelle et la phase en échec, sans publier le corps complet des outils.
5. Vérifier la liste d’outils et une lecture sur un dépôt de test. Refaire aussi
   l’essai avec un client déjà fonctionnel. Les tests locaux utilisent GitHub simulé.

Ne jamais partager Authorization, cookies, codes OAuth, refresh tokens, secrets,
clés privées ou traces complètes contenant ces données. Ne pas rendre `tools/list`
public ni donner tous les droits pour résoudre un problème de découverte.

## Travail d’équipe

Les applications actives peuvent collaborer via les PR et leurs commentaires,
avec missions et branches distinctes : voir [le protocole commun](team-workflow.md).
`AGENT_MEMORY.md` transmet les conseils ; `TOOL_IMPROVEMENTS.md` centralise les
propositions d’amélioration. Les échanges en cours restent dans les PR. Aucun
réveil de client, messagerie temps réel ou orchestration autonome n’est ajouté
par cette correction de transport. La production conserve sa validation humaine.

## Références

- [Transport MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Outils et schémas MCP](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Transport du SDK Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/)
- [Référence des outils OpenAI](https://developers.openai.com/plugins/reference)

`outputSchema` est optionnel dans MCP ; le déclarer rend le contrat vérifiable et
répond aussi à l’exigence documentée par OpenAI pour les sorties structurées.
La conformité à ces points ne constitue pas une certification universelle des clients.
