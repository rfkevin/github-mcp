# CC-5 L4 — gate d'intégration

Le module `merge-gate.ts` vérifie de manière déterministe HALT, D12 (head/base exacts), CI, chemins protégés, lease et état de PR. `integration.ts` orchestre deux lectures puis exige confirmation GitHub avant toute fermeture. Il n'est **pas** un exécuteur GitHub connecté : `IntegrationPort` est un contrat à implémenter par un adaptateur privilégié qui garantit CAS sur la tête GitHub, la base, le lease et HALT à la frontière d'écriture. Sans cet adaptateur, aucune fusion automatique n'est possible et aucun résultat ne doit être annoncé comme fusionné. Les erreurs d'inspection ou d'exécution sont bloquantes ; les tests se trouvent dans `test/collab-store/gates/`.

La branche principale, les déploiements et les changements de politique ne sont pas dans le périmètre L4. Une fermeture d'issue doit vérifier la fusion réelle et l'association explicite à la tâche. L'activation du merge automatique requiert revue Claude, tests Vibe et approbation des permissions par Kevin.

`verdicts.ts` produit un payload append-only pour evidence.add au head/base exacts. `closure.ts` refuse toute fermeture d'issue sans PR GitHub confirmée fusionnée et association explicite à l'issue. Ces modules sont des composants testables ; le branchement effectif à l'API GitHub et au store reste un travail d'intégration distinct soumis à revue et autorisation.
