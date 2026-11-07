# CC8 S7 — durcissement lot C (#283, issue mère #280)

Auteur : Claude. Branche : `mcp/105856986/cc8-s7-hardening-c`. Base : `bec812321bd647f1309e42cf185a1a0f5d4c5de6`. Aucun pilote réel, aucun budget, aucune configuration modifiée.

## R3 — qualité fonctionnelle par mission

Le mandat du propriétaire (`AGENT_RUN_GITHUB_TASKS`) porte désormais, en option, `mission` et `acceptance`. Le modèle ne les fournit ni ne les modifie.

| Mandat | Effet |
| --- | --- |
| sans `mission`, ou `pilot` | inchangé : un test de démonstration (`expect(true).toBe(true)`) reste accepté ; la preuve serveur garde `scope: 'pilot_e2e_pass'`. `acceptance` est refusé. |
| `functional` | 1 à 5 critères d'acceptation (≤ 300 caractères) obligatoires, rappelés dans la consigne de contenu. |

Pour une mission `functional`, trois contrôles combinés (jamais un filtre unique) :

1. **Prévalidation statique** (`guidedPrecheck`, avant tout effet GitHub, sans exécuter de code) sur les seuls fichiers de test proposés : `test_no_project_import` (aucun import du dépôt), `test_disabled` (`skip`, `todo`, `xit`), `test_tautological` (aucune assertion hors littéraux ou `expect(x).toBe(x)`). Mêmes règles de reprise que le lot A : une reformulation, puis `guided_stop:precheck_failed`. Les commentaires sont ignorés.
2. **Preuve serveur** (`run.proof`) : refus `functional_assertions_missing` si les tests réellement commités n'ont aucune assertion non tautologique. Sinon `scope: 'e2e_pass_review_required'` et un résumé `quality` (`test_files`, `meaningful`, `tautological`).
3. **Revue D12** : le fond reste jugé par le relecteur et le testeur ; ce contrôle ne vaut jamais acceptation.

Limites assumées : signal statique (un test peut être non tautologique et faux) ; les anciens tests et fixtures ne sont pas relus ; les corrections par `github_replace_text` ne portent pas le contenu complet et ne sont pas analysées (le résumé peut être incomplet, jamais gonflé) ; une mission fonctionnelle qui ne commite aucun test est refusée à la preuve.

## R6 — routage : A1 (endpoints) contre agent-runs

| | A1 (`collab_dispatch_task`, endpoints `ep-*`) | agent-runs (exécutions API) |
| --- | --- | --- |
| Source canonique | table D1 des endpoints (un endpoint = un modèle, `attestation_ref` `fournisseur:modèle`), éditée sur `/owner` (`register_endpoint`, sonde, activation) | chaîne ordonnée du participant : `AGENT_RUN_MODELS_<P>` (wrangler versionné, fiche F1) ou, depuis S3, chaîne posée dans le store par `set_agent_models` |
| Sélection | explicite, par le coordinateur (`endpoint_id`) ; aucune chaîne ni repli | automatique à chaque étape : préférence abordable, sinon option suivante de la même famille (S1b), coupe-circuit (S1b-2) |
| Permissions | coordinateur actif, capacités deny-by-default, 50 appels/jour/endpoint, coût 0, aucun outil | participant dans `AGENT_RUN_PARTICIPANTS`, portes d'exécution, budget par agent et par type, outils selon le type |
| Preuve du modèle servi | invocation A1 (empreintes, usage) | `agent_run_model_calls` : maillon choisi, maillon servi, repli, échec |

Constat (issue #283) : pour Gemini, les endpoints directs exposent 3.8 et 3.5-flash-lite, alors que la chaîne des agent-runs est `gemini-3.8-flash → 3.6-flash → 3.5-flash-lite → gemma` ; un run `answer` a donc pu être servi par `gemini-3.6-flash` sans qu'aucun endpoint A1 ne le déclare. Ce n'est pas une incohérence de code mais deux sources, deux sélections et deux journaux. Garantie coût 0 : A1 par réserve 0 € et liste blanche ; agent-runs par `maxCostCents = 0` et refus `MODEL_BUDGET_EXHAUSTED`. À vérifier avant toute proposition de modification : la liste exacte des endpoints actifs en production (lue dans `/owner`, non vérifiée ici).

Convergence proposée, **sans modification implicite de configuration** : (1) un état des lieux en lecture seule qui rapproche, par agent, endpoints A1 et chaîne agent-runs, et signale les modèles présents d'un seul côté ; (2) sur décision du propriétaire seulement, faire résoudre les consultations du coordinateur par la chaîne de l'agent (une seule source), les endpoints devenant des vues. Rien de cela n'est implémenté par ce lot.

## R6 — dossier de tâche autonome (API sans chat)

`task-dossier.ts` (fonctions pures) : `assessDossier` classe une question (`self_contained`, `reference_only`, `insufficient`) et fournit la consigne qui interdit de prétendre avoir lu un lien ; `buildDossier` sépare les références **vérifiées par le serveur** du contenu **non fiable**, borné à 6 000 caractères. Cas de référence : #1739 (URL seul) → `reference_only` ; #1743 (six règles dans le texte) → autonome. Le branchement dans le prompt des exécutions `answer` n'est pas fait ici (il touche `plan.ts`, hors périmètre) : suite proposée.

## R6 — benchmark reproductible

Protocole : tâches appariées (pilote guidé, correction CI, code non trivial, revue/réponse), mêmes entrées pour chaque modèle ; mesures par run : sortie fonctionnelle, premier commit, corrections CI, erreurs d'outil, PR, SHA, jetons, durée, coût, modèle servi, repli. `bench-compare.ts` (`compareModels`) n'autorise aucune conclusion sans au moins **3 runs par modèle sur la même tâche**, ni à taux égaux, et cite les runs fondateurs. Les relevés historiques (`fixtures/cc8-s7-bench/historical-runs.json`) viennent des messages du store (Vibe n° 4 seq 1710, Gemini n° 1 seq 1716) ; les valeurs inconnues restent `null`. Résultat : **aucune conclusion Gemini contre Vibe** (un essai chacun, modèle servi non relevé). Aucun rerun sans GO de Kevin ; plafonds inchangés (48 000 jetons, 12 étapes modèle, 24 étapes serveur, 45 min, 3 corrections).

## Réception

Tests : `test/collab-store/agentrun/cc8-s7-hardening-c.spec.ts` (démonstration refusée en fonctionnel, acceptée en pilote, preuve étiquetée, mandat strict, dossier, comparaison).
