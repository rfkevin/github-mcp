# Participer à un cycle CC-2 (guide court)

Ce guide couvre le parcours réellement disponible dans cette version. Il ne promet rien de plus : les modules de reçus et de mémoire collective (L4, L5) sont des moteurs purs sans outil MCP, et les outils de collaboration sont `github_collab_context` (L2) et `github_plan_project_bootstrap` (L3), tous deux en lecture seule. Les écritures passent par les outils existants (`github_apply_changes`, `github_comment_*`), avec les droits déjà accordés.

## Démarrer (coordinateur)

1. Donner le dépôt et la tâche. Lire `github_get_project_context`, puis `AGENTS.md` et `AGENT_MEMORY.md`.
2. Prévisualiser : `github_plan_project_bootstrap(repository, ref)`. Statut `ready` : appliquer `operations` telles quelles avec `github_apply_changes` (`expectedHeadSha` = `sha` renvoyé) sur une branche de travail, puis relancer l'aperçu : `unchanged` attendu. `action_required` : aucune écriture, décision du propriétaire. Détail : [bootstrap.md](bootstrap.md).
3. Enregistrer le cycle dans le `WORKFLOW_STATE.md` du dépôt de coordination (format : [contract.md](contract.md)). Cette étape reste une écriture documentaire explicite : aucun outil ne la fait seul.
4. Donner aux autres agents une phrase courte : « Participe au cycle CC-2, cette issue, comme <agent> » ou « Reprends ton lot ».

## Rejoindre ou reprendre (participant)

1. `github_collab_context(repository, ref, participant, taskId?, role?)`. Lire d'abord `cycle` (phase, révision, `stale`), `task` (chemins autorisés, `nextAction`) et `guidance` (actions permises, `ownerDecisionRequired`).
   Reprise courte « <agent>, go » : passer seulement `participant`. Candidates = tâches actionnables (`proposed`, `accepted`, `in_progress`, `review`) dont l'agent est owner, tester ou reviewer ; les lignes `done`/`verified`/`blocked` sont ignorées. Une seule candidate est retenue ; sinon la ligne Roles de l'agent (`Pending evidence`) puis le `next_action` d'en-tête qui le nomme doivent citer exactement une candidate. À défaut : `AMBIGUOUS_TASK`, aucun choix arbitraire. `task.participation` et `task.selectedBy` disent pourquoi. Pour que « <agent>, go » suffise, le coordinateur cite l'id de la mission active dans la ligne Roles de l'agent.
2. Reprise dans un autre chat : repasser `nextCheckpoint` reçu la fois précédente dans `checkpoint`. Lire `coverage` : `toReread` (sources modifiées, y compris éditées après coup), `refreshed` (source d'état dont l'empreinte a changé depuis le checkpoint : déjà relue dans cet appel, à reprendre en compte), `partial` (continuer avec `continuation`), `missing` et `rescanRequired` (source disparue : relire l'index), `unread`. Une couverture lue est un fait sur le contenu récupéré, pas une preuve de compréhension.
3. `peerProposalExclusion.active` : ne pas lire les propositions des pairs avant la phase permise ; si elles ont déjà été lues, le dire (`contamination`).
4. Travailler dans les `ownedPaths` de la tâche, sur une branche dédiée. Publier une fois, relire le résultat (voir [troubleshooting.md](troubleshooting.md) si la confirmation est perdue), puis **s'arrêter à la frontière de phase**. Une étiquette d'agent ou un commentaire n'autorise jamais une transition : seule la décision du propriétaire compte.
5. Rendre compte en une ligne : `lot | status | PR/head/base | read coverage | tests (pass/fail/not_tested × real/simulation/inspection) | objections | next_action`.

## Où se trouve quoi

| Domaine | Code | Tests | Contrat / doc | Lot |
| --- | --- | --- | --- | --- |
| Contrats, état, phases | `src/collab/contracts.ts`, `state.ts`, `phase.ts` | `test/collab/contracts.spec.ts`, `state.spec.ts`, `phase.spec.ts` | `docs/collaboration/contract.md`, `acceptance.md` | L1 |
| Contexte et reprise | `src/collab/context.ts`, `reading-checkpoint.ts`, `src/mcp/tools/github/collab-context.ts` | `test/collab/context.spec.ts`, `reading-checkpoint.spec.ts`, `test/mcp/collab-context.spec.ts` | `contract.md` (SourceReference) | L2 |
| Amorçage additif | `src/collab/bootstrap.ts`, `bootstrap-manifest.ts`, `src/mcp/tools/github/collab-bootstrap.ts` | `test/collab/bootstrap.spec.ts`, `test/mcp/collab-bootstrap.spec.ts` | `docs/collaboration/bootstrap.md` | L3 |
| Reçus et réconciliation | `src/collab/receipts.ts`, `reconcile.ts`, `publication.ts` | `test/collab/receipts.spec.ts`, `publication.spec.ts` | `docs/collaboration/publication-recovery.md` | L4 |
| Mémoire collective | `src/collab/memory/candidates.ts`, `voting.ts`, `projection.ts` | `test/collab/memory/*.spec.ts` | `docs/collaboration/memory.md` | L5 |
| Guide, carte, profil | `src/mcp/workflow-guidance.ts` (renvoi court) | `test/collab/guide.spec.ts` | ce dossier : `usage.md`, `troubleshooting.md`, `profile-decision.md` | L6 |

La carte générale du dépôt reste [../code-map.md](../code-map.md) ; chaque lot y ajoute ses lignes avec sa PR.

## Enregistrements compacts (lisibles par une machine, en anglais)

Les contrats, cartes et mémoires destinés aux agents restent courts et structurés ; les explications aux humains et `TOOL_IMPROVEMENTS` restent en français. Aucun secret ni code privé dans les exemples.

```text
handoff: L6 | status=ready_for_review | pr=#N head=<sha40> base=<sha40> | read=complete unread=[] | tests=typecheck:pass:real full_suite:pass:real catalogue:not_tested | objections=none | next=reviewer:verify_exact_head
receipt: op=<operation-id> kind=comment target=<repo>#<n> fingerprint=<hex> outcome=effective|unknown reconcile=false|true
memory-candidate: scope=mcp_internal|global_usage|project status=hypothesis|verified source=<ref> proposer=<agent> version=1
```

## Distribution par API (non implémentée)

À ce jour, les autres agents sont réveillés à la main. Contrat prévu pour une version future, **documentation seule** : aucun planificateur, bot de messagerie ou dépendance à une API gratuite n'est ajouté.

| Champ | Contenu |
| --- | --- |
| `target` | agent et client visés (nom déclaré, pas une identité authentifiée) |
| `phase` | phase ouverte au moment de l'envoi |
| `role` | owner, author, reviewer, tester, assembler ou consultant |
| `checkpoint` | valeur de `nextCheckpoint` à reprendre |
| `budget` | limite de lectures, d'octets et de durée par réveil |
| `receipt` | identifiant d'opération et empreinte pour confirmer la livraison |
