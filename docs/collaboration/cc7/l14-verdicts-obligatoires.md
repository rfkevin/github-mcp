# CC-7 L14 — verdicts de PR rattachés obligatoirement (tâche, rôle, couple)

Décision de Kevin du 2026-10-30 : « ça doit être obligatoire pour éviter les confusions dans le futur ».

## Constat du 2026-10-30 (PR #238 et #239)

- Les rôles D12 (relecteur, testeur) n'étaient écrits qu'en prose (description de PR, messages). Aucune
  tâche du store ne les portait, donc `collab_get_context` ne rendait aucune fiche de rôle.
- Des verdicts ont été déposés sous une tâche qui n'existait pas (`L12`), ou sous la tâche de répétition
  (`L7`), parfois sans base exacte, parfois en `clarify.ask`.
- Le contrôleur (`controller/facts.ts`) ne compte un verdict que s'il vise une tâche existante, vient de
  son relecteur ou de son testeur, et porte head et base. Les autres étaient **acceptés puis ignorés en
  silence** : personne ne savait qu'ils ne comptaient pas.

## Règle (store, à l'écriture)

Un `evidence.add` est un **verdict de PR** quand :

1. son état (`verdict`, sinon `state`) commence par AGREE, PASS, APPROVE, OK, AMEND, BLOCK,
   CHANGES_REQUESTED, FAIL ou REJECT (mêmes mots que le contrôleur), ou son rôle est `reviewer` / `tester` ;
2. **et** il cite une PR : champ `pr`, lien `/pull/<n>` dans `evidence_ref` ou le texte, « PR #<n> ».

Un verdict de PR doit alors :

| Exigence | Refus |
| --- | --- |
| `task` = identifiant d'une tâche du store | `VERDICT_TASK_REQUIRED` (absent ou mal formé), `TASK_UNKNOWN` (inconnu) |
| `head` et `base` structurés, SHA de 40 caractères (`head`/`base` ou `pr.head_sha`/`pr.base_sha`) | `VERDICT_PAIR_REQUIRED` |
| déposant = relecteur ou testeur de la tâche (identités équivalentes comprises ; jamais l'auteur), rôle déclaré cohérent | `VERDICT_ROLE_REQUIRED` |

Un refus n'écrit rien : ni événement, ni révision, ni quota.

Non concernés : les preuves d'auteur (`SUBMITTED`, `CI_PASSED`, bilans) et les critiques et votes des
phases de conception (AGREE/AMEND sur une proposition ou la synthèse, sans PR ni SHA, lot L6b).

## Déroulé attendu pour chaque PR

1. L'auteur ouvre la tâche : `task.claim` `{task: {task_id: "pr239", owner_pid, reviewer_pid, tester_pid}}`.
   Le store impose déjà trois participants distincts (D12).
2. L'auteur dépose sa soumission : `evidence.add` `{task, pr, head, base, state: "SUBMITTED…"}`.
3. Le contrôleur réveille le relecteur et le testeur au couple exact (`collab_next_actions`).
4. Chacun dépose son verdict en `evidence.add` `{task, pr, head, base, state: "AGREE…" | "PASS…"}`.
5. Deux verdicts positifs au même couple : `merge_ready` pour Kevin. Head ou base changé : verdicts à renouveler.

Tests : `test/collab-store/store/cc7-l14-verdict-guard.spec.ts`.
