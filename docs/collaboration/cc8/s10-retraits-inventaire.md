# CC8 S10 — inventaire des retraits possibles (préparation, zéro suppression)

**Date :** 2026-11-16 · **référence :** `cc3-integration` @ `b15849eceb8a7d0f0c1df91d3abbe73755583ff7`  
**Plan :** CC-PLAN-8 v0.1 (store seq 1262) + v0.2 (seq 1270), validé par Kevin (seq 1280).  
**Responsabilités du dossier :** GPT-6 auteur, Claude relecteur, Vibe testeur.  
**État : PREPARED_ONLY. Aucun code, permission, variable ni historique D1 n'est retiré par ce dossier.**

## Frontière de sécurité et dépendance S9

S10 vise des **retraits de chemins vraiment redondants, un sujet par PR**, uniquement après preuve du remplaçant. La tâche canonique S9 est encore `in_progress` : harnais `#333` fusionné, échantillon réel `answer` sur trois questions, verdict aveugle Grok seq 2580, mais aucune démonstration globale avec **au moins 3 tâches distinctes pour chacun** des types `answer/review/test/implement`, seuil de réussite ≥80 %, ni clôture `parityLive` attestée. Les tests figés `s9-e2e-worksession.spec.ts` ne remplacent pas cette mesure. **Aucune suppression de runtime avant la clôture documentée S9.**

Les catégories suivantes distinguent des **faits lus dans les fichiers** et des **hypothèses encore à prouver**. L'index GitHub de la branche par défaut n'est pas indexé sur l'intégration ; des recherches vides n'établissent jamais l'absence d'appelants.

| Candidat | Preuves actuelles au SHA ci-dessus | Décision préparatoire |
|---|---|---|
| Pilote ancien `src/collab-store/agents/{pilot,assembler,lease,persona,tools}.ts` | `agents/index.ts` exporte encore `runAgentPilot`; `pilot.ts` possède un chemin historique persona→bail→assemblage et `assembler.ts` une petite liste figée d'outils. Le circuit API actif `agentrun/plan.ts` + `engine.ts` fonctionne par WorkSession, avec catalogue et mandats D1. **La liste exhaustive des appelants du pilote n'est pas encore prouvée.** | **CANDIDAT**, à traiter seulement après recherche complète des imports/usages en intégration, tests d'absence de régression et démonstration que la WorkSession couvre chaque ancien usage. Ne pas supprimer `agents/` en bloc. |
| `preferred_free_model` dans `agents/persona.ts` | La propriété est effectivement recopiée par `agents/assembler.ts` dans un paquet de l'ancien pilote ; elle **n'est pas utilisée comme choix effectif** dans `agentrun/model-policy.ts`. S3 documente la chaîne store prioritaire, wrangler en repli. | **CANDIDAT CONDITIONNEL**, couplé à la migration de l'ancien paquet de pilote. Ne pas retirer isolément une propriété qui a encore un consommateur. |
| Ancien outil `collab_dispatch_task` / lancement manuel parallèle | `docs/collaboration/cc8/one-execution-path.md` indique sa disparition du catalogue MCP. La surface active `mcp/agentrun-tools.ts` expose `collab_assign_worksession` ; `coordinator-launch.ts` attribue le mandat sans créer le run, `plan.ts` crée la WorkSession. | **NE PAS SUPPRIMER davantage sans preuve** : chercher les adaptations/clients historiques et une éventuelle façade résiduelle, mais conserver les journaux append-only et le chemin d'assignation qui reste actif. |
| `src/collab-store/owner/trials.ts` contre `agentrun/canary/` (S5) | `owner/handler.ts` importe `runOwnerTrial` ; le premier exécute un diagnostic ponctuel `/owner` avec consigne contrôlée, tandis que le canary rejoue 20 tâches stratifiées pour F2. S5 documente `auto_apply` interdit en v0 et l'exécution simulée à coût zéro. | **KEEP** : fonctions différentes, aucun remplacement équivalent actuellement prouvé. Le bouton de sonde et son chemin unique S4 restent aussi à conserver. |
| `AGENT_RUN_MODELS_*` et `AGENT_RUN_FAMILY_*` dans wrangler/F1 | `s3-modeles-store.md` affirme une résolution **store d'abord**, et des valeurs wrangler comme **fallback sans chaîne stockée**. La fiche F1 décrit les définitions autorisées et non une seconde liste runtime à supprimer sans migration. | **KEEP** : retirer ces défauts casserait les agents sans chaîne et les tests de compatibilité F1. |
| Mémoire `task:<id>` gelée et données D1 historiques | S0 §6 atteste que les nouvelles propositions de mémoire par tâche sont gelées ; des enregistrements anciens restent lisibles. Les événements D1 et les invocations historiques servent d'audit. | **KEEP DATA** : ne pas supprimer d'historique ni vider D1. Toute évolution de schéma nécessite preuve de migration, rétention et retour arrière. |

## Contrat de chaque futur lot de retrait

1. **Preuve d'appelants** : inventaire des imports/exports et des outils réellement exposés au SHA exact de l'intégration ; distinguer code mort, compatibilité active et données historiques. Ne pas se fonder uniquement sur l'index GitHub de `master`.
2. **Preuve du remplaçant** : mêmes capacités, identité/permissions, contexte, CAS/HALT, réveil, CI, D12 ; référence à une exécution réelle S9 et à un test de non-régression. Une simple similitude de nom n'est pas un doublon.
3. **Lot borné et réversible** : un groupe fonctionnel par PR, diff minimal, aucun effacement des événements et reçus D1, rollback par revert ; pas de modification de `master`.
4. **Validation** : CI GitHub 4/4 au HEAD exact, propriétaire de lot distinct du relecteur et du testeur D12, puis fusion par Kevin. Le déploiement `cc3-test` et l'observation du remplaçant précèdent le lot suivant.
5. **Promotion S11** : seulement après S9 clôturée + retraits S10 prouvés ou explicitement conservés avec raison ; synchronisation `master`→intégration, CI et accords, puis acte humain vers `master` (CC3 v1).

## Ordre proposé et statut

- **S10-0 (ce document)** : cartographie préliminaire, aucune suppression.
- **S10-1** : auditer les usages restants du pilote historique `agents/`; proposer un retrait limité **si** tous les appelants et tests le permettent, sinon décision KEEP documentée.
- **S10-2** : auditer les interfaces désormais masquées ou façades de compatibilité ; préserver les endpoints `/owner`, les traces et `collab_assign_worksession`.
- **S10-3** : vérifier les anciens champs déclaratifs comme `preferred_free_model` avec les consommateurs réels et la politique S3 ; éventuel retrait du champ seulement avec la migration de son paquet.

**Ne pas lancer S10-1 à S10-3 avant la validation live de S9.** La présente PR documentaire peut être revue et fusionnée sans altérer le comportement, et évite d'engager une suppression aveugle.

 
## Addendum S10-1 — dépendances réellement actives (16 novembre 2026)

**Référence vérifiée :** `cc3-integration` @ `8b30f89a1167ba2069249dc0daeb4e40a8652c77`. Cet addendum est **un audit documentaire uniquement**, distinct des retraits S10-1 à S10-3 qui restent conditionnés à la preuve de parité live S9. Il ne modifie ni code runtime, ni CI, ni configuration, ni historique D1.

### Appelants et frontière de sécurité vérifiés

- **Actif, à préserver :** `src/collab-store/agentrun/engine.ts:44` importe précisément `API_AGENT_FORBIDDEN` et `assertNotD12Verdict` depuis `../agents/tools`. Les lignes 1288–1310 utilisent ces symboles pour refuser les actions réservées au propriétaire, les outils hors catalogue et les verdicts D12 libres. Les exceptions `store_verdict` et `store_contribute` ne suppriment pas les contrôles : elles sont revérifiées par des outils dédiés côté serveur.
- **Actif, à préserver :** `src/collab-store/mcp/tools.ts` enregistre les outils de WorkSession ; `src/collab-store/agentrun/plan.ts` planifie les exécutions ; le chemin Worker actif passe par `src/index.ts` / `src/agent-run-object.ts` / `src/collab-store/agentrun/object.ts`. Dans ces points d'entrée lus, aucun appel au pilote historique `runAgentPilot` n'a été observé.
- **Historique, encore exporté :** `src/collab-store/agents/index.ts:1–15` expose `runAgentPilot`, `assembleAgentContext`, les personas, baux et outils. `src/collab-store/agents/assembler.ts` conserve son budget d'assemblage de 3 000 jetons et sa petite liste d'outils ; ce paquet n'est pas la politique des WorkSessions actuelles. `test/collab-store/agents/{pilot,persona,lease,tools}.spec.ts` dépend de ces modules historiques.
- **Fonction distincte :** `src/collab-store/owner/handler.ts:21` importe `runOwnerTrial` pour le parcours `/owner`. Ce diagnostic n'est pas remplacé par le pilote `agents/` ni automatiquement par le canary : **KEEP**.
- **Données :** conserver les événements, effets, historiques et anciennes lignes de baux D1. Aucune migration destructrice ne découle de cet audit.

### Décision préparatoire de retrait

**KEEP pour l'instant :** `agents/tools.ts` car ses deux contrôles sont appelés par `agentrun/engine.ts`. Une suppression globale de `src/collab-store/agents/` casserait le moteur actif. L'ancienne interdiction générale des verdicts D12 via `runAgentPilot` ne décrit pas le chemin WorkSession actuel : `store_verdict` reste une exception étroitement contrôlée et attestée en exécution réelle (S9 PR #347, verdict Gemini seq 2767).

**CANDIDATS CONDITIONNELS :** `agents/{pilot,assembler,lease,persona}.ts`, `preferred_free_model` déclaratif et leurs tests historiques. Leur absence d'appelants runtime **n'est pas prouvée sur l'ensemble de l'intégration** : l'index `github_search_code` porte sur la branche par défaut, et les lectures de points d'entrée ne constituent pas une recherche exhaustive.

**Ordre à respecter, seulement après clôture S9 :** (1) établir la liste complète des imports et usages sur la branche d'intégration ; (2) déplacer si nécessaire les deux gardes encore actifs vers un module du moteur, conserver leur logique et les régressions de refus D12/HALT/identité ; (3) retirer un seul groupe de modules réellement inemployés par PR, avec preuve de remplacement, CI 4/4 au SHA exact, relecteur/testeur indépendants et fusion par Kevin. Si une dépendance demeure, décider **KEEP** plutôt que forcer un retrait.

**État au 16/11 :** S9 `in_progress`, `parityLive=false`, `s9Closed=false` ; aucun retrait S10 autorisé. La responsabilité testeur de la *nouvelle tâche d'audit* est Grok Chat, tandis que la ligne historique « Vibe testeur » en tête du dossier décrit l'ancien lot #346.
