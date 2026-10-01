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
- Chaque outil expose un titre lisible, un `inputSchema`, un `outputSchema` objet et des annotations.
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

## Complément du 2 octobre 2026 : documents OpenAI et titres

Les trois documents joints par le propriétaire sont identiques et décrivent
notamment les outils `search`/`fetch` pour deep research et company knowledge.
Ce contrat documentaire n'est pas une obligation pour tous les plugins de code.
Le [guide MCP des plugins OpenAI](https://developers.openai.com/plugins/build/mcp-server)
demande un nom d'action et un titre lisible pour chaque outil. Le catalogue local
n'avait pas de titres : les 24 outils en possèdent désormais, sans changer leurs
noms, paramètres, résultats ni droits.

Le client SDK MCP indépendant lit bien les 24 titres avec `tools/list` en mémoire.
Types et 75 tests OAuth/origine passent. Ce changement n'est pas encore publié et
ne démontre pas que l'absence de titre causait l'erreur OpenAI réelle.
La transmission et les preuves complémentaires figurent dans
[l'issue #11](https://github.com/rfkevin/github-mcp/issues/11).

## Adaptation des déclarations OAuth et diagnostic Responses API

Le catalogue annonce désormais les portées nécessaires à chaque outil dans
`_meta.securitySchemes`, champ de compatibilité documenté par OpenAI et transmis
par notre SDK MCP v2. La version du catalogue passe à `0.7.1`. Les outils de
lecture déclarent `mcp:read`, les écritures ajoutent `mcp:write`, les vérifications
ajoutent `mcp:automation` ou `mcp:checks` selon le mode, et la fusion d'intégration
ajoute `mcp:write` et `mcp:integration`. La préparation d'un workflow peut être
prévisualisée sans droit d'écriture ; son application reste protégée côté serveur.
Ces déclarations n'accordent aucun droit et ne remplacent jamais les contrôles.

Le SDK utilisé accepte `_meta`, mais n'expose pas de configuration de propriété
`securitySchemes` au premier niveau : aucune modification de ses champs privés
n'est utilisée. Ce complément améliore le contrat ; il ne prouve pas à lui seul
la résolution de l'erreur réelle de découverte.

Les exemples `type: function`, `parameters`, `strict` et `type: namespace`
configurent le client Responses API. Ils ne doivent pas remplacer `inputSchema`
ni la réponse standard `tools/list` du serveur MCP. Pour suivre l'exemple direct
`type: mcp`, le projet fournit un diagnostic dédié :

```sh
npm run diagnose:openai
npm run diagnose:openai -- --live
```

La première commande est une préparation hors ligne : aucune requête ni dépense.
La seconde appelle réellement l'API et peut être facturée. Elle nécessite deux
variables locales distinctes, jamais à transmettre dans un chat ou un commit :

- `OPENAI_API_KEY` : clé API OpenAI, utilisée seulement pour joindre Responses.
- `MCP_ACCESS_TOKEN` : jeton OAuth d'accès de ce serveur MCP, lié à la ressource
  `/mcp` avec `mcp:read`. Ce n'est ni un jeton GitHub, ni une clé privée de l'App.

`OPENAI_MODEL` peut remplacer le modèle de l'exemple (`gpt-6-astra`) par un modèle
accessible au compte et compatible avec les outils MCP. `MCP_SERVER_URL` permet
de choisir une autre URL HTTPS `/mcp`, sans identifiants ni paramètres.
Le diagnostic ne réalise pas le parcours OAuth initial à votre place.

Un seul outil est autorisé : `github_list_repositories`. Aucun outil d'écriture,
de fusion ou de déploiement n'est accessible dans cet essai. La sortie indique
uniquement les étapes API, découverte et appel et leurs résultats ; elle ne
recopie ni secrets, ni noms de dépôts, ni messages bruts du fournisseur.
Un HTTP 200 sans import d'outil n'est pas un succès ; un résultat MCP en erreur
n'est pas davantage un appel réussi.

Les réponses API sont simulées dans les tests CI. L'essai API réel nécessite les
identifiants du propriétaire ; il n'a pas été réalisé pendant cette adaptation.
Même un succès Responses ne certifierait pas le parcours OAuth du plugin dans
l'interface : ce dernier doit être essayé séparément après publication autorisée.

Références : [authentification des plugins](https://developers.openai.com/plugins/build/auth),
[métadonnées de compatibilité](https://developers.openai.com/plugins/reference),
[MCP avec Responses](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).
