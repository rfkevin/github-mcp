# CC8 — S8c-api-grant : autorisation GitHub ciblée Gemini

## Incident démontré
Le transfert de tâche `task.handoff` #1826 a déclenché le run API `api-implement-e9adb4d41ca2ef569d036b06a905b12c` pour `S8c-cron-monitor`, terminé `step_limit` (12 étapes, 33 487 jetons, 0 centime). Le résumé serveur expurgé donne six effets `github_write_scope` **failed** et deux `store_task_status` **failed**, sans branche/commit/CI/PR attestés. Le code `createS7Tools` refuse `github_write_scope` si l'entrée exacte manque dans `AGENT_RUN_GITHUB_TASKS` (`api_task_not_enabled`). Le code exact des erreurs du run n'est pas lisible dans les reçus expurgés : cela reste un diagnostic causal à confirmer lors du prochain essai autorisé.

## Changement limité à cc3-test
Dans `wrangler.jsonc`, ajout d'une entrée **unique** et explicite à `env.cc3-test.vars.AGENT_RUN_GITHUB_TASKS` (deux mandats S7 préservés). `AGENT_RUN_GITHUB_WRITERS=gemini,vibe` est déjà correct, inchangé. Aucune autorisation sur `master`, aucune clé, aucun appel payant, aucun changement au namespace racine ni aux autres environnements.

| Élément | Mandat |
|---|---|
| Cycle | `cc8-systeme-unique` |
| Tâche | `S8c-cron-monitor` |
| Participant | `gemini` |
| Branche API | `mcp/105856986/gemini-api-s8c-cron-monitor` |
| Mission | `functional`, avec 3 critères d'acceptation |
| Chemins | Uniquement l'intersection de la liste ci-dessous avec les `owned_paths` courants |

Chemins du grant : `src/index.ts`, `src/collab-store/controller/scheduled.ts`, `src/collab-store/controller/monitor/`, `src/collab-store/agentrun/event-monitor.ts`, `test/collab-store/controller/cc8-monitor/`, `test/collab-store/agentrun/cc8-cron-monitor.spec.ts`, `docs/collaboration/cc8/s8c-monitor.md`.

Le mandat n'autorise pas `engine.ts` (lot A), `wake-trigger.ts`, `schema.ts` et le store (lot B), ni `wrangler.jsonc` lui-même. `authorize` revérifie le rôle owner, statut, cycle ouvert, HALT, pause et fence API. Le modèle n'élargit jamais ses permissions. La CI/D12 restent des exigences indépendantes.

## Processus d'acceptation
1. Examiner le diff et la nouvelle suite `cc8-s8c-api-grant.spec.ts` (mandats figés, paths, refus sans grant/branche et tâche bloquée). Une CI de PR n'est **pas** une preuve de déploiement.
2. Faire relire par Vibe et tester par Grok sur le couple HEAD/BASE exacts ; aucune fusion sans protocole.
3. Intégrer uniquement sur `mcp/105856986/cc3-integration` par voie approuvée, puis vérifier le déploiement réel `cc3-test` et le mandat rendu par `github_write_scope`.
4. Décider séparément si un **nouveau** run API `implement` Gemini est autorisé. Ancien run terminal : pas de réexécution automatique.
5. Vérifier la suite GitHub branche → commit → CI vérifiée → PR, les effets D1 et les critères fonctionnels avant toute validation S8c.

Les deux refus `store_task_status` restent inexpliqués par les reçus expurgés ; les traiter comme diagnostic distinct, pas comme preuve d'un défaut des permissions GitHub. Pas d'activation `master`/production.
