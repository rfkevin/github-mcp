# CC8 S7 — agent consultant : préparation et mémoire persistante

## Problème observé
Les pilotes S7 Vibe et Gemini ont pu créer une branche et committer, mais ont écrit des tests qui imaginaient la signature de \`planGuidedS7\`. Le moteur guidé n'offrait que \`github_commit_files\` à l'étape de création : le modèle ne pouvait pas interroger le dépôt, le contexte ou la mémoire à cette étape. La continuité C4 n'était pas activée sur \`cc3-test\`.

## Séquence opt-in, sans remplacer S7
\`AGENT_RUN_PREPARATION=true\` et \`AGENT_RUN_CONTINUITY=true\` sur \`cc3-test\`. Pas de changement pour les autres environnements sans opt-in.

1. Le serveur lit le grant owner et crée la branche via les étapes S7 existantes, sans faire coder le modèle.
2. Avant **le premier commit**, le modèle reçoit une mission de consultant en lecture seule, avec uniquement \`store_context\`, \`store_delta\`, \`store_memory\`, \`store_continuity\`, \`github_read_file\`.
3. Les réponses sont persistées dans \`agent_run_steps\` par le moteur existant. Pour accepter la préparation, il faut prouver les 4 lectures de contexte/mémoire et **au moins un fichier SOURCE existant** lu au SHA immuable de la base. La lecture du futur fichier de sortie ne compte pas. La seule affirmation du modèle « j'ai lu » ne compte pas.
4. Le modèle peut demander plusieurs lectures dans un même tour et disposer de trois tours maximum. Manque d'outils mémoire, base non vérifiée ou lectures insuffisantes : arrêt typé avant tout commit. Une erreur de read ne constitue jamais une preuve.
5. Après ces lectures, le modèle reçoit **le contenu véritable** du code, les événements et les notes via l'historique persistant, **sans compaction destructive** pendant ce run S7 ; il peut alors analyser et écrire via le seul \`github_commit_files\`. Les contrôles existants (scope de branche, HALT, fence, précheck, CI, 3 corrections, D12, no merge) restent actifs.

## Mémoire « comme le chat »
Le serveur n'invente pas une mémoire par run. Il réutilise la mémoire C4 persistante, filtrée par identité/famille/role/tâche/projet (jusqu'à 40 entrées) et \`store_continuity\` : les passations des chats et les précédentes exécutions API du même participant, persistées dans D1. Les mémoires nouvelles suivent le circuit \`store_memory_propose\` et sa validation, jamais une écriture arbitraire du fournisseur dans la mémoire partagée. Une lecture ne modifie pas la mémoire.

## Vérifications
- Opt-in désactivé : les anciens tests et l'ancien chemin guidé restent inchangés.
- Avec opt-in : lecture autorisée seule, pas de \`github_commit_files\` au stade consultant ; une réponse vide, un appel non offert ou une preuve de fichier inexistant ne permet pas de coder.
- Des lectures réussies de contexte, delta, mémoire, continuité et source SHA déclenchent ensuite exactement le chemin S7 existant.
- Un second run du même participant retrouve la mémoire C4 et ses notes de passation, sans mélange avec les mémoires d'autres identités.
- PR et revue D12 avant fusion par Kevin. Aucun reset D1, aucun déploiement automatique, aucun modèle payant.
