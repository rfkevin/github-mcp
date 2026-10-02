# OAuth réussi, découverte des outils en échec dans OpenAI

Transmission de Codex (OpenAI, modèle non précisé), le 2026-10-02, pour une
enquête indépendante avec Claude. Cause non confirmée ; aucun correctif nouveau
ni déploiement effectué au titre de cette transmission.

## Objectif et périmètre

Permettre au même serveur MCP de fonctionner dans les clients compatibles,
sans exception par marque, sans supprimer OAuth et sans casser Claude.
Lire `AGENTS.md`, `AGENT_MEMORY.md`, `TOOL_IMPROVEMENTS.md` et
`docs/team-workflow.md` avant de travailler. Cette enquête n'autorise ni fusion
vers `master`, ni déploiement en production, ni élargissement de permissions.

## Symptômes rapportés

- Plugin personnel OpenAI nommé **aide codage**, endpoint :
  `https://github-mcp.rfahedkevin.workers.dev/mcp`.
- L'interface affiche **Authentication succeeded, action discovery failed**
  après connexion. Plusieurs reconnexions n'ont pas résolu le problème.
- L'utilisateur confirme que Claude continue à utiliser ce serveur.
- Dans une autre conversation OpenAI, un assistant a rapporté :
  `No tool was defined under the given paths. Please try again with the correct paths. Valid namespaces are: 'Plugin_Management', 'aide_codage', 'files'.`

Le dernier message provient du récit de cet assistant, pas d'une réponse HTTP
du Worker que nous aurions capturée. Les « paths » semblent désigner la recherche
d'outils interne au client. Il peut s'agir d'un mauvais nom demandé ou d'outils
non chargés. La présence du namespace ne prouve pas que ses fonctions sont
disponibles. Ne pas ajouter une route `/aide_codage` sur cette seule base.
De même, un `not_installed` obtenu ailleurs avec un identifiant possiblement
incorrect ne prouve pas qu'il faut réinstaller le plugin.

## Référence examinée

- Dépôt : `rfkevin/github-mcp`, branche par défaut `master`.
- HEAD local et master distant vérifiés :
  `6a9df4cbf4ed8ce5eddfee731322b2e1a819aade` (`openai`).
- Serveur annoncé : `github-mcp`, version `0.7.0`.
- Dépendances du projet examinées : `agents` 0.24.0,
  `@modelcontextprotocol/server` 2.0.0,
  `@cloudflare/workers-oauth-provider` 1.2.1, `zod` 4.6.5.
- `/ready` répondait `{"status":"ready","sha":null}` : cela ne permet pas
  de certifier le SHA effectivement servi. Ne pas confondre code examiné et
  preuve de version en production.

## Faits vérifiés et limites

| Vérification | Résultat | Limite |
| --- | --- | --- |
| Contrôle local complet précédent | 357 tests applicatifs, 37 tests de scripts, types et compilation Wrangler sans publication réussis | GitHub et clients OAuth simulés |
| Client indépendant `Client` + `StreamableHTTPClientTransport` du SDK MCP installé | `connect()` et `listTools()` réussissent ; 24 outils, 24 outputSchema, inputSchema object, descriptions présentes | Appels en mémoire vers le vrai `createMcpHandler`/`createServer`, contexte simulé ; pas d'OAuth ni de réseau dans cet essai |
| Matrice JSON-RPC locale | initialize et tools/list réussissent pour 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25 | Ne certifie pas les clients réels |
| Métadonnées OAuth publiques | Serveur d'autorisation et ressource protégée répondent 200 ; DCR/CIMD et PKCE S256 annoncés | Pas de preuve de la transaction OpenAI concernée |
| GET /mcp sans authentification | 401 avec challenge de ressource protégée | Comportement attendu, pas la preuve d'un échec de découverte authentifiée |
| Observation ponctuelle des requêtes déployées | POST /mcp à 200 identifiés par User-Agent Anthropic | Pas une preuve de succès OpenAI ; un statut 200 ne suffit pas non plus à exclure une erreur JSON-RPC |
| Parcours OpenAI réel | Échec persistant selon l'utilisateur | Il manque une trace corrélée de cette tentative précise |

La fenêtre d'observation limitée n'a pas identifié avec certitude une requête
OpenAI correspondant à l'échec. Cela ne prouve pas que ses requêtes n'arrivent
jamais au Worker. Aucun jeton réel, cookie ou en-tête Authorization n'est inclus.

## Changements déjà essayés, insuffisants pour résoudre le symptôme réel

Le code actuel vérifie une origine externe exacte à partir du client associé
au jeton validé (métadonnées DCR/CIMD). Un refus d'origine avait été reproduit
localement avant cette correction. Les 24 outils disposent maintenant d'un
outputSchema, avec texte JSON conservé en plus de structuredContent.

Ces corrections ont passé les tests locaux, mais l'utilisateur signale encore
l'erreur OpenAI. Ne pas les présenter comme un diagnostic confirmé du problème
en production. Voir `docs/mcp-compatibility.md`.

## Investigation proposée à Claude

1. Relire les faits et confirmer le SHA examiné. Ne pas reprendre les conclusions
   d'un autre agent sans contrôler leurs preuves.
2. Obtenir, avec le propriétaire, une seule tentative OpenAI datée et corréler
   les requêtes : méthode HTTP, chemin sans query string, statut, phase JSON-RPC
   (`initialize`, notification, `tools/list`), code d'erreur nettoyé. Ne jamais
   publier tokens, codes OAuth, cookies, identifiants de session ou réponses privées.
3. Si aucune requête ne peut être corrélée, distinguer un problème de chargement
   du plugin dans l'interface d'un rejet du serveur. Ne pas inventer les chemins
   internes des outils et ne pas conclure à partir du seul namespace.
4. Comparer les échanges réels aux contrats MCP et aux exigences documentées
   OpenAI : version négociée, Accept/Content-Type, notifications, identifiant de
   session éventuel, forme JSON-RPC, schémas JSON et portée des jetons.
5. Examiner ces pistes **non confirmées**, une à la fois dans un environnement
   de test :
   - Métadonnées d'authentification par outil : le catalogue testé n'a pas de
     `securitySchemes` ni de miroir `_meta.securitySchemes`. OpenAI recommande
     une déclaration explicite, mais documente aussi l'héritage de la politique
     serveur en leur absence. Ce n'est donc pas une cause démontrée.
   - Origine du client : le rapprochement avec l'origine des redirectUris est
     une politique applicative, pas une garantie universelle OAuth. Un client
     valide pourrait avoir une origine différente. Chercher un rejet réel avant
     de proposer une évolution ; ne pas remplacer le contrôle par `*`.
   - Contrat des schémas et catalogue selon les droits : 15 outils en lecture
     seule contre 24 dans le contexte complet ; vérifier la réponse réellement
     reçue, pas seulement les enregistrements TypeScript.
   - Cache/métadonnées du plugin, transport réseau ou compatibilité des SDK :
     comparer avant de changer de version ou de transport.
6. Si une cause est reproductible : proposer une correction minimale dans une
   branche dédiée et une PR, ajouter un test de non-régression, puis suivre la
   CI au SHA exact. Sinon, laisser un résultat négatif précis et la donnée
   manquante plutôt que modifier au hasard.
7. Répondre dans l'issue si l'interface le permet ; sinon transmettre le rapport
   au propriétaire ou discuter dans la PR. Signer avec son identité déclarée,
   sans prétendre qu'elle est authentifiée. Compléter séparément mémoire et
   propositions d'amélioration selon les consignes du dépôt.

## Fichiers et vérifications utiles

- Transport et origine : `src/mcp/handler.ts`, `src/mcp/origin.ts`.
- Catalogue : `src/mcp/tools.ts`, `src/mcp/tools/github/`,
  `src/mcp/tools/github/output-schemas.ts`.
- Authentification et droits : `src/index.ts`, `src/auth/handler.ts`,
  `src/auth/consent.ts`, `src/mcp/context.ts`.
- Tests ciblés : `npx vitest run test/oauth.spec.ts test/mcp-origin.spec.ts`.
- Contrôle complet : `npm run check:full` (pas de déploiement).

## Critères de résolution

- [ ] La cause est étayée par un échange ou un cas reproductible, pas supposée.
- [ ] OpenAI découvre les outils et réussit une lecture autorisée sur la version testée.
- [ ] Claude conserve son fonctionnement ; les autres clients essayés sont nommés,
  sans promettre une compatibilité universelle non testée.
- [ ] OAuth, validation d'origine et séparation lecture/écriture sont conservés.
- [ ] Aucun outil en lecture seule ne gagne des droits supplémentaires.
- [ ] Tests/CI réussis au SHA exact ; validation humaine avant production.

## Sources officielles à vérifier lors de la reprise

- [OpenAI : dépannage des plugins](https://developers.openai.com/plugins/deploy/troubleshooting)
- [OpenAI : authentification et securitySchemes](https://developers.openai.com/plugins/build/auth)
- [MCP : découverte et contrat des outils](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP : transport Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Cloudflare : transport MCP](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/)

Merci à Claude et au propriétaire pour la vérification indépendante et les
prochaines preuves, y compris si elles contredisent les hypothèses de Codex.
