# CC8 S7 — comparaison contrôlée Vibe / Gemini, première paire

## But
Deux pilotes S7 `implement` font le **même parcours de bout en bout** (scope GitHub → branche vierge → commit → CI au SHA → PR prête) sur des branches et tests isolés. Une seule tentative par participant ; aucune fusion automatique. La comparaison porte sur le même scénario fonctionnel du planificateur `planGuidedS7` et non sur deux issues différentes. Un essai par modèle est descriptif, insuffisant pour établir un classement fiable (bench-compare.ts exige au moins trois essais par modèle).

## Scénario commun à l'identique
1. Créer UN test Vitest fonctionnel qui importe planGuidedS7 depuis src/collab-store/agentrun/s7-guided.ts et couvre un comportement réel ; pas de expect(true) ou test tautologique.
2. Avec un scope valide et corrections_remaining=0, planGuidedS7 doit retourner {kind:'stop',reason:'commit_budget_exhausted'} sans appeler un modèle.
3. Avec un scope valide et corrections_remaining=3 et branch_head absent, planGuidedS7 doit émettre l'appel serveur github_create_branch ; ne pas employer de module npm non déclaré.

## Deux mandats et branches NEUVES

| Paramètre | Vibe | Gemini |
|---|---|---|
| Tâche | `S7-compare-vibe-1` | `S7-compare-gemini-1` |
| Participant | `vibe` | `gemini` |
| Branche à créer par le moteur | `mcp/105856986/vibe-api-s7-compare-1` | `mcp/105856986/gemini-api-s7-compare-1` |
| Seul fichier autorisé | `test/collab-store/agentrun/s7-compare-vibe-1.spec.ts` | `test/collab-store/agentrun/s7-compare-gemini-1.spec.ts` |
| Mission | `functional` | `functional` |
| Budget LLM payant | 0 centime | 0 centime |
| Modèle | routage gratuit autorisé de son fournisseur | routage gratuit autorisé de son fournisseur |
| Limites de run | 48 000 tokens, 12 étapes modèle, 24 serveur, 45 min | mêmes plafonds |
| Écriture | 1 commit initial + 3 corrections CI max | mêmes plafonds |

Les branches ci-dessus ne sont PAS précréées : l'outil `github_create_branch` du pilote doit en fournir la preuve GitHub. Le SHA de base est lu à l'instant du scope, les règles CAS/fence/HALT et la validation de CI épinglée restent obligatoires. Pas de modification de `master`, pas de secret nouveau ni de changement de prix d'API.

## Séquence de mise en service après PR de configuration

1. Fusionner cette PR de configuration seulement après CI 4/4, D12 Vibe AGREE et Grok PASS, puis confirmer `deploy-cc3-test` SUCCESS au SHA intégration. Aucun pilote n'est déclenché par la PR.
2. `vibe` et `gemini` revendiquent chacun LEUR tâche nouvelle via `task.claim` en `in_progress` dans le store, avec `owned_paths` exact et rôles croisés ; GPT-6 ne revendique pas les tâches au nom des autres.
3. Pour éviter qu'un vieux automate lance une tâche inattendue, vérifier aucun run déjà actif avant tout GO. Le propriétaire autorise **une** invocation API chacun, en série pour isoler les effets et mesurer équitablement.
4. Consigner pour chaque essai `run_id`, SHA source, modèle effectivement servi (fallback distingué), jetons, durée, coûts, effet `github_create_branch`, compteurs D1, commit, CI complète et PR, tests fonctionnels, puis D12 au head/base.
5. Si échec ou garde refusée, aucun run supplémentaire sans nouveau GO. Les anciens compteurs de `S7-live-vibe` et `S7-live-gemini` restent intacts.

## Périmètre de cette PR
`wrangler.jsonc` — ajout de deux entrées dans la variable `AGENT_RUN_GITHUB_TASKS` de l'environnement `cc3-test` uniquement ; aucune entrée préexistante modifiée, aucune clé, aucune activation de run ni de budget payant. Ce document de procédure. Le test de comparaison lui-même sera écrit exclusivement par chaque agent sur sa branche lors du vrai pilote.