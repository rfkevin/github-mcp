# CC8 U2a-1 — gardes au point de commit (seq2189, T1 seq2185)

Auteur : Claude (tâche `S7-U2a-effect-guards`, relecteur GPT-6, testeur Vibe). Base : intégration `5d1803b9`. Aucun changement de `engine.ts`, `object.ts`, `plan.ts`, `chat-continuity.ts` ni de schéma (U1 de GPT-6, PR #311). Aucun run, aucune configuration, aucun budget.

Objectif : retirer la couche guidée ne doit rien faire perdre. Ces gardes sont désormais appliquées par `createS7Tools` au moment du commit, que le modèle soit guidé ou libre.

| Point T1 | Changement | Preuve |
| --- | --- | --- |
| B1 | `functionalTestCause` (lot C de #283) est appelée au commit pour une mission `functional` : tests désactivés, sans import du dépôt ou tautologiques refusés, avec l'indice de `PRECHECK_HINTS`. Aucune réservation consommée. | `cc8-u2a-effect-guards.spec.ts` |
| B2 | Un commit dont tous les fichiers sont identiques à la tête est refusé (`api_write_no_change`) avant `reserveCommit` : il brûlerait une des 3 corrections. Un fichier neuf (lecture 404) compte comme un changement. | idem |
| B3 | Aucun changement de code : le doublon est déjà refusé par GitHub (422 « already exists », `pull-requests.ts` l.52), mappé en `GitHubWriteRefused('CONFLICT')` (`agent-run-object.ts` l.53), donc refus certain, et `lookup` retrouve la PR existante. Test négatif ajouté. | idem |
| C1 | `github_replace_text` accepte `edits[]` (5 au plus, fichiers distincts, un blob attendu par fichier) appliqué en UN commit. La forme historique reste valide. Les deux formes mélangées, un doublon de chemin ou plus de 5 éditions sont refusés. | idem |

Contrainte conservée : `reserveCommit` n'autorise un 2e commit qu'après une CI rouge au head suivi (`api_write_wait_for_failed_ci`) et plafonne à 3 corrections. Les éditions avant la première CI doivent donc être groupées en un commit ; le test le vérifie.

Gardes non modifiées : `authorize`, `assertPaths` (mandat ET `owned_paths`), tête attendue, blob attendu, branche dérivée du participant, base jamais main ou master, HALT, pause, fence, idempotence par `effect_key`.

Hors périmètre, pour U2a-2 : `scope` et `target` de `github_run_checks`. La clé d'un check doit contenir le scope, et seul `full` doit compter pour `request_D12`, `run.proof` et les sondes de preuve de fin (`allCiPolls`) : un `typecheck` vert ne doit jamais valoir CI complète.

Limites : le mode libre n'est pas activé par ce lot. Le message de refus de `commitGuards` est une chaîne typée suivie d'un indice ; la forme structurée (tête actuelle, exemple valide) reste à faire côté moteur, hors de ce périmètre.
