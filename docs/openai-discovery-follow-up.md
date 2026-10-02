Complément de Codex (OpenAI, GPT-6), 2026-10-02 : examen des documents fournis par le propriétaire.

Les trois pièces jointes ont le même SHA-256 : il s'agit d'un même guide, envoyé trois fois.
Il précise que `search` et `fetch` servent aux parcours deep research et company knowledge.
Leur absence ne démontre pas une incompatibilité d'un plugin destiné aux outils de code.

Un écart concret a été trouvé dans le catalogue examiné au commit
`6a9df4cbf4ed8ce5eddfee731322b2e1a819aade` : aucun outil n'avait de `title`.
Le guide OpenAI demande un nom d'action et un titre lisible par outil :
https://developers.openai.com/plugins/build/mcp-server

Correction **locale, non publiée** : ajout de titres français aux 24 outils,
sans changement de nom d'outil, paramètre, résultat, transport ou autorisation.
Les enregistrements sont dans `src/mcp/tools/github/*.ts`.

Vérifications effectuées :
- types TypeScript réussis ;
- 75 tests dans `test/oauth.spec.ts` et `test/mcp-origin.spec.ts` réussis ;
- un client MCP SDK indépendant a connecté le serveur en mémoire et lu le catalogue :
  24 outils, 24 titres non vides, 24 outputSchema.

Limites : cet essai n'utilise ni OAuth réel ni réseau. Le propriétaire rapporte
toujours l'échec OpenAI sur la version actuellement publiée. Aucun test réel
OpenAI/Claude après publication de ces titres n'a encore été effectué.
Les titres sont une amélioration documentée de conformité et de présentation ;
leur absence n'est **pas une cause démontrée** de l'échec de découverte.

Pour Claude : poursuivre le diagnostic du parcours authentifié et des échanges
réels. Tenir compte de ce changement local pour éviter un travail concurrent
redondant. Ne pas conclure que le problème est résolu avant validation réelle.
Merci pour la relecture indépendante et les prochaines preuves.

## 2 octobre : nouvel essai réel et schémas Unicode

Les PR #12 et #13 ont été fusionnées par le propriétaire. Il signale encore
l'erreur de découverte et une liste d'outils vide. Pendant son nouvel essai,
une trace filtrée montre le 2026-10-02 à 07:35:21–23 UTC :

- POST `/oauth/token` provenant d'OpenAI : 200 ;
- première sonde POST `/mcp` sans autorisation : 401, puis découverte OAuth ;
- deux POST `/mcp` authentifiés provenant d'OpenAI : 200, sans exception Worker.

Les journaux ne donnent pas les méthodes JSON-RPC ni leurs réponses : ces 200
ne prouvent donc pas encore que `tools/list` a réussi. Aucun jeton n'a été conservé.
Le dernier déploiement observé est `912672cc-54bd-4e8d-ab32-28e06f9f3bbe` ; `/ready`
renvoie toujours `sha: null`, donc la correspondance au commit n'est pas prouvée
par cette sonde seule. Le build GitHub du commit master `c13b6f9` est réussi.

Un rejet du catalogue est reproduit indépendamment avec Python `jsonschema 4.26.0`
et `Draft202012Validator.check_schema` : 4 des 48 schémas du catalogue MCP échouent
sur `properties.agentLabel.pattern`, à cause de `\\p{L}` / `\\p{N}`. Outils concernés :
`github_comment_commit`, `github_comment_pull_request`, `github_commit_changes`,
`github_merge_integration`. Le catalogue a été lu par un vrai client SDK MCP en
mémoire, avec les 24 outils activés et des identifiants fictifs, sans appel GitHub.

Correction 0.7.2 : publier longueur et description portables du nom d'agent,
conserver la règle Unicode exacte en validation serveur. Les 48 schémas passent
ensuite le même validateur. Des tests protègent les quatre définitions réellement
transmises ainsi que les accents, alphabets non latins, 80 caractères Unicode,
81 caractères et caractères interdits.

La [documentation JSON Schema](https://json-schema.org/understanding-json-schema/reference/regular_expressions)
recommande un sous-ensemble portable des expressions régulières. Le rejet Python
est établi ; l'utilisation de ce validateur par OpenAI et la causalité de l'erreur
du plugin ne le sont pas. Après publication autorisée, retester la découverte et
une lecture avec OpenAI, puis un client déjà fonctionnel. Si l'erreur persiste,
il faut obtenir le code JSON-RPC ou le diagnostic d'import de la plateforme avant
une nouvelle hypothèse de correction.
