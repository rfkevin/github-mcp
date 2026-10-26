# CC-7 L6b (incrément 2) — les agents API proposent, critiquent, synthétisent et votent

Cycle `cc7-api-auto`, lot **L6** (auteur Claude, relecteur Grok, testeur Vibe GLM). Plan CC-PLAN-7 v0.2, S9.
Tout reste **éteint par défaut** : aucune exécution API sans `AGENT_RUNS_ENABLED`, `AGENT_RUN_PARTICIPANTS` et un modèle.

## Ce qui change

| Avant | Après |
| --- | --- |
| En P1 d’un produit, l’auteur recevait « implémenter » (`no-submission`) | Il reçoit `contribute` : la phase attend une proposition, pas du code (le réveil de tâche est remplacé, jamais doublé) |
| Les réveils `contribute` ne lançaient aucune exécution API | Chaque réveil `contribute` crée une exécution de type `design` (run_id déterministe par phase et tâche) |
| Le canal API ne pouvait déposer ni proposition, ni critique, ni vote | Outil `store_contribute`, contrôlé serveur |

## `store_contribute` (type `design` seulement)

Arguments : `task`, puis `content` (proposition, synthèse) ou `state` + `review` (critique, vote).

Le serveur décide de ce qui compte, jamais le modèle :

1. l’exécution doit être de type `design` (`CONTRIBUTION_KIND_FORBIDDEN`) ;
2. la sortie est relue dans la phase courante (`inspectPhase`) : elle doit être non satisfaite et le participant
   (identité logique, #126) doit en être un titulaire manquant sur la tâche nommée (`CONTRIBUTION_NOT_EXPECTED`) ;
3. le type d’événement et le rôle viennent de la définition de phase installée par Kevin :
   `proposal.submit` (rôle author, scellé en P1 par le store) ou `evidence.add` (rôle reviewer ou tester) ;
4. une critique ou un vote porte `AGREE`, `AMEND` ou `OBJECTION` (`CONTRIBUTION_STATE_INVALID`) et un texte ; il ne cite
   jamais de PR, de head ni de base — ce n’est pas un verdict D12 (ceux-là passent par `store_verdict`, L5b) ;
5. écriture par le serveur (`appendEvent`), op_id dérivé de la clé d’effet du moteur : un rejeu rend l’événement
   d’origine (`duplicate`) ; mêmes gardes du store (rôles, scellé, cycle clos, quota, CAS).

Le moteur exempte `store_contribute`, comme `store_verdict`, de la garde `assertNotD12Verdict` (son état est un vote
de conception re-vérifié serveur) ; toute autre écriture du canal API reste soumise à cette garde.

## Plafonds

Type `design` : 4 096 jetons de sortie (`TASK_KIND_BOUNDS.design`), coût `AGENT_RUN_COST_CENTS_DESIGN` (0 par défaut).

## Hors de cet incrément (L6b-3)

- Interrupteur de fusion vers l’intégration (S11, Q4), éteint par défaut.
- Message salon `decision` « prêt à promouvoir ».

## Fichiers

- `src/collab-store/agentrun/contribution-tools.ts` — `store_contribute`
- `src/collab-store/agentrun/read-tools.ts`, `plan.ts`, `engine.ts`, `object.ts`, `index.ts` — kind `design`, planification, garde D12
- `src/collab-store/controller/rules.ts` — `contribute` remplace `no-submission` sur la même tâche
- `test/collab-store/agentrun/cc7-l6b2-api-contribute.spec.ts` ; mises à jour : `cc7-l6b-phase-wakes.spec.ts` (P1), `cc7-l5b-store-verdict.spec.ts` (registre de coût)
