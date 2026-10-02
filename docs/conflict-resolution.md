# Résoudre les conflits dans une branche de travail

`github_get_merge_context` est disponible avec `mcp:read`. `github_resolve_conflicts`
exige les écritures activées, `mcp:write` et Contents: Write. Le serveur crée un
commit à deux parents dans `mcp/<compte>/<tâche>` ; il ne fusionne pas la PR dans
main/master. Le contexte projet expose `conflictResolutionEnabled` lorsque la
résolution est disponible, sans confirmer les droits GitHub effectifs.

1. Lire la PR et sa discussion, puis appeler `github_get_merge_context` avec
   `repository`, `branch`, éventuellement `baseBranch` (branche par défaut sinon).
   Garder `headSha`, `baseSha`, `ancestorSha`, `conflicts`, `automaticPaths` et
   `blockedPaths`. Aucun contenu sensible n’apparaît dans le diagnostic.
2. Pour chaque conflit, lire le même chemin aux trois SHA avec `github_read_files`.
   `ours` désigne la branche de travail, `theirs` la base entrante. Un blob `null`
   signifie que le fichier n’existait pas dans cette version. Lire la suite des
   extraits tronqués et consulter les interfaces/tests des collaborateurs.
3. Fournir tous les conflits dans `resolutions` à `github_resolve_conflicts` :
   `{path, choice:"ours"}`, `"theirs"`, `"delete"`, ou
   `{path, choice:"content", content:"texte complet corrigé"}`. Aucun choix global
   implicite. Les chemins modifiés uniquement dans la base sont repris, les
   changements propres à la branche sont conservés. Les choix de version réutilisent
   le blob côté serveur sans retransmettre le fichier.
4. Fournir `expectedHeadSha`, `expectedBaseSha`, `message`, `agentLabel` et la même
   branche de base. Si l’une avance, refaire le diagnostic. Suivre `followUp`,
   exécuter tests/build/qualité et renouveler les avis au nouveau SHA avant revue.

Le diagnostic compare les fichiers entiers, avec leurs modes : deux versions
différentes modifiées des deux côtés demandent un choix même si Git pourrait
fusionner automatiquement leurs lignes. Il couvre aussi ajouts/suppressions
divergents. Ce conservatisme évite une décision de contenu implicite. Les renoms
sont vus comme suppression et ajout ; relire leur intention avant de résoudre.

Les arbres tronqués, plus de 20 000 entrées ou 50 chemins concernés sont refusés.
La résolution est limitée à 1 Mo cumulé. Les workflows, scripts CI/publication,
politique d’intégration, fichiers sensibles, liens/sous-modules et changements
fichier/dossier nécessitent une résolution humaine. Aucune exception de sécurité
ne découle de l’existence d’un conflit. Les marqueurs `<<<<<<<`/`>>>>>>>` encore
présents dans un contenu fourni sont refusés.

Les journaux doivent conserver les préfixes exacts des **deux** versions. Si les
ajouts ont divergé et ne permettent pas ce contrôle, le serveur refuse la reprise :
demander l’arbitrage humain pour réconcilier les notes, sans supprimer de mémoire.
Une résolution ne doit jamais servir à contourner la protection d’ajout seul.

Le serveur contrôle head/base avant préparation et avant mise à jour, puis envoie
`force:false`. GitHub ne fournit pas ici de comparaison atomique des deux refs :
un mouvement concurrent reste possible juste après la vérification. Une erreur
peut laisser des objets Git non référencés ; une réponse perdue ne prouve pas un
échec. Relire la branche et ses parents avant tout rejeu, sans forcer la référence.

Code : `src/merges/plan.ts`, `src/merges/coordinator.ts`, `src/github/merges.ts`,
`src/mcp/tools/github/merges.ts`. Tests : `test/merges/` ; transport/droits :
`test/oauth/merges.spec.ts`, `test/oauth/catalogue.spec.ts` et `test/oauth/writes.spec.ts`. Pour le contrôle
complet : `npm run check:full`. Les tests simulent GitHub ; un essai réel du MCP
reste nécessaire après publication humaine. Références API :
[commits à plusieurs parents](https://docs.github.com/en/rest/git/commits#create-a-commit),
[arbres Git](https://docs.github.com/en/rest/git/trees#create-a-tree),
[mise à jour sans force](https://docs.github.com/en/rest/git/refs#update-a-reference).
