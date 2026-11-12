# CC8 — Continuité universelle des fournisseurs (fondation)

L'utilisateur peut ajouter de nouveaux fournisseurs sans modifier la logique de mémoire et
de mission. Le fournisseur peut changer pendant un travail ; la reprise sûre utilise
toujours le journal D1 (objectif, actions, résultats, mandats et preuves).

## Contrat

- \`provider-continuity.ts\` définit une interface ouverte (\`provider: string\`) ; elle n'est
  pas limitée aux huit fournisseurs actuels. Ce module n'effectue aucun appel réseau.
- Le mode **portable** est obligatoire. Les identifiants de session native, signatures de
  pensée et caches opaques restent propres au couple fournisseur/modèle.
- Le mode **native** est optionnel et utilisable seulement si un adaptateur l'a réellement
  implémenté et explicitement déclaré ; une référence native d'un autre modèle/fournisseur
  n'est jamais transférée.
- Les mandats GitHub, la validation des outils, HALT, CAS, D12, le coût et les
  règles de fusion restent uniquement côté serveur.
- Les résultats réussis de GitHub sont résumés depuis des reçus D1 sous forme de
  jalons portables, même lorsque les vieux tours sont compactés.
- Une répétition constatée de lectures du même mandat après création de branche,
  sans nouvelle opération productive, devient un blocage expliqué. Ce n'est pas une
  limite générale d'étapes, de jetons, de temps de mission ou de recherches.

## Limitations explicites

Cette fondation **n'active pas** l'API native Interactions de Gemini, l'API Responses
d'OpenAI ni les signatures de réflexion d'Anthropic ; chaque intégration native fera
l'objet d'un adaptateur vérifié, de tests de reprise après coupure et de validation de
l'identité du modèle. Le transfert portable ne copie aucun raisonnement interne caché.

## Validation attendue

CI au SHA exact ; tests compaction, reprise, répétition sans progression et
répétition légitime avec commit intermédiaire ; revue Vibe, test Claude et fusion
uniquement par le propriétaire sur \`cc3-integration\`.
