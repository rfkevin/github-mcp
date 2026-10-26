# CC-7 L6b (incrément 1) — un produit avance seul de P1 à P5

Cycle `cc7-api-auto`, lot **L6** (auteur Claude, relecteur Grok, testeur Vibe GLM).
Plan CC-PLAN-7 v0.2 : S8 (un prompt), Q3 (P5 sans objection), suivis de la relecture de #222 (S10 « CI 4/4 », N2).
Tout reste **éteint par défaut** ; rien ne change pour un cycle sans policy de phase.

## 1. Réveils des sorties attendues (contrôleur)

Avant L6b, le contrôleur ne réveillait que par tâche (implémenter, relire, tester une PR). Les phases de conception
(critique en P2, synthèse en P3, vote en P4) n’avaient aucun réveil : il fallait un message du coordinateur.

Désormais, quand la phase courante a une policy (`auto_advance` ≠ `none`) et qu’une sortie attendue n’est pas satisfaite,
chaque titulaire du rôle qui ne l’a pas encore produite reçoit un réveil `contribute` (règle `phase-output-missing`) :

| Phase (gabarit CC-PRODUCT-1) | Réveillés |
| --- | --- |
| P1 | déjà couverts par la règle de tâche `no-submission` (aucun doublon) |
| P2 | chaque relecteur, sur la proposition qu’il critique |
| P3 | le coordinateur, sur `synthesis` |
| P4 | le relecteur et le testeur de `synthesis` (vote) |

- Un participant déjà réveillé sur la même tâche par une règle de tâche n’est pas réveillé deux fois.
- Épisode = phase + seq d’entrée dans la phase : une nouvelle visite de la phase réarme les réveils.
- `inspectPhase` rend maintenant le détail par sortie (`phaseOutputStatus` : producteurs, titulaires, satisfaite).
- Le canal API ne prend pas encore ces réveils (types de tâche de conception) : incrément suivant.

## 2. Vote P4 sans OBJECTION (contrat `states`)

`expected_outputs[].states` (facultatif, 1 à 8 jetons en majuscules) : seule compte une identité dont la **dernière**
contribution de la visite a un état de la liste. Gabarit : P4 → P5 quand le relecteur ET le testeur de la synthèse ont
voté `AGREE` ou `AMEND`. Une `OBJECTION` bloque ; un nouveau vote `AGREE`/`AMEND` la remplace. Code d’erreur :
`INVALID_PHASE_OUTPUT_STATES`.

## 3. P5 au choix de Kevin (Q3)

Case « P5 sans ma validation » du formulaire « Nouveau produit » (`auto_p5`, décochée par défaut). Cochée : policy
`product-p5` sans sortie attendue, P5 → P6 dès l’entrée en P5. Décochée : P5 sans policy, la validation reste à Kevin.
Le choix est un acte owner, journalisé dans l’événement `create_product`.

## 4. Plafonds de coût par variable owner (suivi N2 de #222)

`AGENT_RUN_COST_CENTS_ANSWER`, `_REVIEW`, `_TEST`, `_IMPLEMENT` : entier de 0 à 1 000 cents par exécution, posé par
Kevin seul sur le Worker. Absent ou invalide = 0 (fail-closed, inchangé). Financer un type ne demande plus de PR ;
l’enveloppe par participant (L2) borne toujours en plus.

## 5. `store_verdict` exige les 4 contrôles nommés (suivi S10 de #222)

`AGENT_RUN_REQUIRED_CHECKS` (noms séparés par des virgules) ; absent = `ci`, `Workers Builds: github-mcp`,
`GitGuardian Security Checks`, `SonarCloud Code Analysis`. Chaque contrôle nommé doit avoir réussi au head et aucun ne
doit être en cours ; un contrôle non exigé (ex. `deploy`) n’empêche rien.

## Hors de cet incrément (L6b-2)

- Interrupteur de fusion vers l’intégration (S11, Q4) par la porte existante, éteint par défaut.
- Message salon `decision` « prêt à promouvoir ».
- Exécutions API pour les réveils `contribute` (proposer, critiquer, synthétiser, voter).

## Fichiers

- `src/collab-store/phases/engine.ts` — `phaseOutputStatus`, `states`, `inspectPhase().outputs`
- `src/collab-store/contracts/phases.ts`, `owner/phase-install.ts` — contrat et installation de `states`
- `src/collab-store/controller/rules.ts`, `snapshot.ts`, `run.ts`, `next-actions.ts`, `relay.ts` — réveils `contribute`
- `src/collab-store/owner/product.ts`, `handler.ts`, `page.ts` — gabarit P4/P5, case `auto_p5`
- `src/collab-store/agentrun/plan.ts`, `verdict-tools.ts`, `read-tools.ts`, `object.ts`, `index.ts` — plafonds owner, CI nommée
- `test/collab-store/controller/cc7-l6b-phase-wakes.spec.ts` ; `cc7-l6a-product.spec.ts` (gabarit P4)
