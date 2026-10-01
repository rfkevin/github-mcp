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
