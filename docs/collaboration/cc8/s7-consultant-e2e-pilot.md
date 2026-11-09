# CC8 — pilotes E2E de préparation consultant et de continuité chat/API

## Pourquoi un nouveau grant est nécessaire
Les missions S7 antérieures sont déjà exécutées ou en échec. Réutiliser leurs mêmes branches et compteurs de commits créerait une preuve ambiguë. Les deux mandats ci-dessous ouvrent deux tâches et deux branches isolées, jamais `main` ni `master`.

## Mandats owner à valider
**Gemini** — `S7-consultant-e2e-gemini-1` ; branche `mcp/105856986/gemini-api-s7-consultant-e2e-1` ; seul fichier autorisé : `test/collab-store/agentrun/s7-consultant-e2e-gemini-1.spec.ts`. Vérifier par un test fonctionnel le refus des appels d'écriture au stade consultation.

**Vibe** — `S7-consultant-e2e-vibe-1` ; branche `mcp/105856986/vibe-api-s7-consultant-e2e-1` ; seul fichier autorisé : `test/collab-store/agentrun/s7-consultant-e2e-vibe-1.spec.ts`. Vérifier par un test fonctionnel la validation d'une passation `store_handover`.

## Recette après fusion et déploiement
1. Confirmer que le SHA de la PR est déployé en `cc3-test` (pas dans `master`) et que les grants sont actifs.
2. Par coordinateur GPT-6, créer sous sa propre identité une tâche temporaire par grant (reviewers/testers D12 différents) puis `task.handoff` aux modèles. Variante : `collab_launch_implement` avec le mandat owner, si visible dans la connexion MCP actualisée.
3. Déclencher Vibe et Gemini en deux requêtes sans attendre la fin d'aucun, constater les deux `run_id` réels.
4. Vérifier dans `agent_run_steps` que `store_context`, `store_delta`, `store_memory`, `store_continuity` et `github_read_file` au SHA base ont réussi avant `github_commit_files`. Les seuls messages textuels ne sont pas une preuve.
5. Vérifier un commit par branche autorisée, CI au SHA, PR par serveur, puis `store_handover` du même participant. Vérifier une reprise chat/API de la note; une proposition de mémoire C4 reste candidate jusqu'à revue.
6. Un arrêt (`preparation_incomplete`, `model_*`, CI rouge ou `guided_handover_violation`) est rapporté comme échec, jamais maquillé en succès. Pas de relance automatique, de reset D1, de merge sans Kevin ni de coût IA payant.

**Conditions** : planificateur S7 existant, budgets/quotas/fencing/HALT/D12 inchangés. Les deux pilotes sont indépendants et peuvent fonctionner simultanément après l'unique fusion de cette PR.
