# CC8 — Attribution WorkSession (migration S7 / issue #320)

> **Ancien parcours historique.** Le lancement manuel `collab_launch_implement` et sa création directe de run ont été remplacés. Ce document ne doit plus servir d'instruction de lancement. Voir [le chemin d'exécution unique](one-execution-path.md).

## Nouveau comportement

Le coordinateur **attribue** la mission, il ne crée ni ne réveille de modèle. L'outil MCP `collab_assign_worksession` vérifie les autorisations GitHub owner-approved, les chemins de la tâche, le réviseur et le testeur D12 distincts, puis écrit les événements `task.claim`, `task.handoff` et `checkpoint` en D1. Un seul circuit exécute la mission : `planAgentRuns` → `createRun` idempotent → outbox durable → Durable Object, cron en secours.

Sans `scheduled_at`, les tâches disponibles démarrent au premier passage du planificateur. Le champ `scheduled_at` accepte uniquement une échéance UTC explicite ; elle est conservée sans mutation dans `agent_task_schedule`, et aucun run n'est créé avant l'échéance. Un rejeu identique ne fabrique pas de second run. Un bail de chat actif, HALT, l'absence de capacité modèle ou une dépendance non satisfaite peut différer le départ : le coordinateur consulte alors `collab_agent_runs_overview` et le contexte D1.

## Invariants conservés

- Aucun agent ne contourne le bail chat par `takeover_chat` : cette ancienne option du lancement manuel est supprimée.
- Le mandat GitHub (statique ou dynamique) est validé séparément du déclenchement WorkSession ; il ne provient jamais d'une simple instruction textuelle.
- Le coût modèle payant, les chemins autorisés et les protections D12 restent vérifiés côté serveur. Aucune fusion automatique, aucun effet sur `master`.
- Le statut `queued` signifie « attribution enregistrée », pas « run terminé » ; contrôler l'identifiant de run, les effets D1, les commits, la CI au SHA exact et les validations indépendantes.

**Migration des clients :** ne plus appeler `collab_launch_implement` ; appeler `collab_assign_worksession` pour une tâche nécessitant un mandat GitHub, ou utiliser les événements du contrôleur/une question `clarify.ask` pour un `answer` automatique. Ne créer ni `collab_launch_answer` ni autre deuxième moteur.
