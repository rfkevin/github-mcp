# l3e — classification fail-closed d'un import d'état (amendement D13-5)

Auteur : Claude (coordinateur). Statut : incrément 1, **aucun pouvoir nouveau**.

## But

Décision de Kevin (20/10) : le coordinateur prépare tout acte owner et seuls les actes sensibles attendent son
clic (amendement D13, adopté à l'unanimité, store seq 411, 415, 416, 421). Pour l'import d'état, il faut savoir
*mécaniquement* si une révision ne touche que du suivi (direct) ou aussi des décisions, des droits ou des références
(à valider). `src/collab-store/owner/state-diff.ts` répond à cette question.

## Ce que fait le code

`classifyStateImport(previousMarkdown, nextMarkdown)` est une fonction **pure** : elle ne lit ni n'écrit rien dans
D1, n'appelle aucun outil et ne change pas `delegation-policy.ts`, qui continue de refuser `import_state`
(`state_diff_verifier_required`). Elle renvoie `{ level: 'direct' | 'validate', reasons, changes }`.

`direct` n'est rendu que si **toutes** les conditions de la liste blanche sont vraies :

| Zone | Autorisé en `direct` |
| --- | --- |
| Clés de contrôle | seulement `revision` (= précédente + 1), `base_revision` (= précédente), `next_action`, `based_on_sha` ; aucune clé ajoutée, retirée ou dupliquée |
| Préambule | prose libre (jamais exécutée) ; aucune table modifiée |
| Sections | exactement `Owner decisions`, `Roles`, `Tasks`, `Evidence`, dans cet ordre, sans doublon |
| Owner decisions | identique à l'octet près |
| Roles | mêmes acteurs, colonne d'attribution inchangée ; la colonne des preuves attendues est libre |
| Tasks | mêmes tâches dans le même ordre ; seules les colonnes `status`, `blocker`, `version`, `ref`, `next_action` changent ; statut connu, `done` jamais rouverte, version jamais en baisse |
| Evidence | ajout de lignes seulement (anciennes lignes en préfixe, dans l'ordre) |
| Texte hors table dans Roles, Tasks, Evidence | identique |

Tout le reste donne `validate` : aucun état précédent, document refusé par le parseur L1, section inconnue,
dupliquée ou en minuscules, clé dupliquée, colonne absente, tâche ajoutée ou retirée, droit modifié (owner,
reviewer, tester, chemins, dépendances, rôle), phase ou référence d'issue modifiée, décision du propriétaire
touchée, preuve existante modifiée, exception inattendue. Un état qui se contente d'ajouter une décision du
propriétaire (cas de la révision 9) est donc `validate` : c'est le clic de Kevin.

## Ce qui reste à faire (incrément 2, autre PR)

D13-4 : le classement `direct` n'est effectif qu'après sa propre PR relue par une autre famille avec tests
négatifs. L'incrément 2 branchera le verdict dans la politique de délégation (quatre yeux, portes atomiques de
D13-1 v2) et l'affichera sur `/owner` à côté de la demande. Tant qu'il n'est pas fusionné, tout import reste
à valider par Kevin.

## Tests

`test/collab-store/owner/state-diff.spec.ts` : cas direct, puis un cas `validate` par règle (décisions, droits,
tâches, statuts, versions, preuves, rôles, clés de contrôle, chaîne de révisions, sections, texte glissé hors
table, documents illisibles).

## Incrément 2a — branchement dans la délégation (D13-4)

- `import_state` n'est plus refusé en bloc : la politique exige un verdict `direct` calculé **côté serveur**
  (`delegatedStateDiff`, jamais fourni par l'appelant). Sans verdict : `state_diff_verifier_required` ;
  verdict `validate` : `state_requires_owner` (Kevin).
- Précondition : le dernier import doit être celui visé par la demande (`previous_seq`), sinon `state_precondition_stale`.
  Un premier import n'est jamais délégué.
- Une approbation imbriquée (`approve_owner_request`) n'hérite jamais du verdict. Les paramètres `owner_label` et
  `target` sont interdits pour un import délégué.
- Le garde SQL `bindingGuard` est paramétré par action (`install_phases` ou `import_state`) et `state-import.ts`
  lui transmet désormais la preuve déléguée (elle était auparavant ignorée sur ce chemin).
- `delegation-policy.test.ts`, jamais collecté par vitest, est remplacé par `delegation-policy.spec.ts` (55 tests exécutés).
- Garde du plan résolu (revue D12) : le classifieur compare du texte, mais l'import réécrit `tasks` depuis l'annuaire
  courant. Pour une preuve déléguée, le lot D1 exige donc (`withResolvedPlanGuard`) que les tâches en base aient déjà
  exactement les owner/reviewer/tester/chemins du plan résolu, que la phase soit inchangée, que les références
  d'issues du cycle soient identiques et qu'aucune issue ne soit prise à un autre cycle. Toute dérive (annuaire
  modifié, réattribution, phase avancée) => refus, Kevin importe.
- Incrément 2b (séparé) : afficher le verdict sur /owner.
