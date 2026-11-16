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
