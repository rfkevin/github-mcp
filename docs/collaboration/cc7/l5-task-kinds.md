# CC-7 L5 — types de tâche des exécutions API (L5a, S9)

Cycle `cc7-api-auto`, lot **L5** (auteur Vibe, relecteur Claude, testeur Grok ; plan seq 847/854, design seq 943).
L5a couvre S9 (kinds et outils) ; L5b suivra S10 (verdicts serveur vérifiés).

## Décisions → exécutions
Le contrôleur (`nextActors`) décide, il n'exécute rien ; `planAgentRuns` (plan.ts) crée, pour un participant
volontaire (`AGENT_RUN_PARTICIPANTS`, vide par défaut), une exécution par décision :

| décision du contrôleur | type | exécution |
| --- | --- | --- |
| `answer_question` (X13) | `answer` | inchangé (7c-2) : store_delta / store_context, réponse par store_answer |
| `review`, `renew_verdict` du relecteur | `review` | lecture du couple exact, conclusion dans le message final |
| `test`, `renew_verdict` du testeur | `test` | idem, côté test |
| `implement`, `address_feedback`, `address_correction` de l'auteur | `implement` | branche API, commit, PR prête à la revue |

`renew_verdict` suit le rôle réellement tenu sur la tâche (identité logique, famille #126). Les actes du
propriétaire (fusion, déblocage, avancement de phase) ne créent jamais d'exécution API.

## run_id déterministe
`taskRunId(kind, cycle, participant, task, subject)` = `api-<kind>-<sha256 32>` du tuple
(kind, cycle, participant, task, subject) : un passage rejoué retrouve la même exécution et `createRun`
reste idempotent. `answer` garde `answerRunId` (7c-2). L'objet d'un réveil de vérificateur est le couple
`head..base` de la soumission courante ; la consigne (`taskPrompt`) le rend en clair.

## Outils nouveaux
- `github_diff` (lecture, types `review`/`test`) : diff entre une base (SHA ou branche) et un head exact
  (SHA de 40 caractères) via `compareRefs` ; au plus 50 fichiers (`DIFF_MAX_FILES`), patchs coupés à
  2000 caractères (`DIFF_PATCH_CHARS`), drapeaux `files_truncated` / `patch_truncated`. La racine du
  Worker retire le patch des fichiers sensibles (`SENSITIVE_FILE`) avant l'entrée dans le store (C6).
- `github_open_pr` (écriture, type `implement`) : PR PRÊTE à la revue vers la branche de base de l'hôte,
  pied de page « Revue et test D12 par d'autres familles ; fusion par le propriétaire uniquement »,
  trailer d'effet, `draft: false`. Le brouillon (`github_open_draft_pr`) reste. `lookup` distingue
  brouillon et PR prête : chaque outil ne retrouve que son propre effet.

## Hors périmètre L5a (à proposer en L5b)
- Aucun verdict D12 par le canal API : `evidence.add` reste interdit (API_AGENT_FORBIDDEN) ; relecture et
  test concluent dans leur message final. Les écritures serveur de verdict (store_verdict) et la soumission
  (store_submit) sont le sujet de L5b (S10).
- TASK_KIND_BOUNDS (bornes par type de tâche, note N1 de la relecture de #213) n'est pas câblé.
- Bornes inchangées : PLAN_MAX_STEPS 6, PLAN_MAX_TOKENS 24 000, maxCostCents 0 ; aucune variable wrangler
  nouvelle, tout reste éteint par défaut.

## Tests
`test/collab-store/agentrun/cc7-l5a-task-kinds.spec.ts` : planification review/test/implement, renew_verdict
au rôle, run_id déterministe et rejeu, allowlist review/test (lectures seules), github_diff (refus head
non-SHA, bornage), github_open_pr (PR prête, pied de page, CONFLICT, lookup). Les specs l7c1/l7c2/l7c3 sont
étendues : compareRefs du faux GitHub, réveil implement de l'auteur volontaire, github_open_pr dans
l'allowlist implement et le lookup brouillon ≠ prête.
