# CC8 — S8c Cron Monitor, relais CI du lot Gemini

**Auteur d'origine :** Gemini API sur `mcp/105856986/gemini-api-s8c-cron-monitor`, commit final `56e82a7` après 4 tentatives de CI et arrêt `guided_stop / ci_escalate` (0 €). Gemini reste propriétaire de `S8c-cron-monitor` dans le store ; le relais `S8c-ci-rescue` est confié à GPT-6, relecteur Vibe et testeur Grok, sans relance API.

**Source :** code Gemini repris sur branche séparée `mcp/105856986/cc8-s8c-manual-rescue`. La branche et les commits Gemini originaux ne sont jamais écrasés.

## Correctifs
1. La séquence `*/15` placée dans un commentaire bloc dans `scheduled.ts` refermait prématurément ce commentaire (erreur de syntaxe). Remplacement par « quart d'heure ».
2. Le test Gemini référençait `../../src/...` depuis `test/collab-store/agentrun` ; chemin corrigé vers `../../../src/...`.
3. **Contrat architectural S8c** : sur cc3-test, le cron `*/15 * * * *` ne doit ni appeler `scheduleAgentRunPass` ni `integrationPass`. `src/index.ts` déclenchait auparavant directement l'orchestrateur à chaque cron. Ce hook est retiré du seul handler `scheduled`, mais conservé pour le webhook. `runScheduledControllers` ne crée pas de run et ne sollicite pas de modèle : il recalcule les états, historise/rappelle les décisions et signale des erreurs typées via `controller_failures`. Le chercheur quotidien L5 est une passe D1 sans fournisseur.
4. Tests : extraction du véritable handler `scheduled` pour vérifier l'absence d'appel modèle/auto-merge, parsing du cron activé, format du passage quotidien, incidents D1 avec déduplication par heure/portée/code et HALT.

## Dépendance bloquante
**NE PAS FUSIONNER S8c avant le lot B `S8-wake-durable` (PR #291) fusionné et déployé sur cc3-test.** Le cron fournissait un secours pour les réveils perdus ; avant la mise en service de l'outbox CAS D1 et de son alarme Durable Object, retirer le passage agent du cron pourrait faire attendre un run jusqu'au prochain événement. Après B, les nouveaux runs proviennent des événements, jamais du cron.

CI4/4 et D12 Vibe/Grok au couple HEAD/BASE final requis, puis fusion Kevin sur intégration uniquement. Aucune activation master, aucun merge automatique, aucun run Gemini supplémentaire et aucun coût payant.

## Ne pas couper la fusion automatique existante

Contrôle de non-régression sur `cc3-test` : `AUTO_MERGE_INTEGRATION="true"`.
Avant S8c, le passage `integrationPass` (D12 + CI + paths + bail + HEAD/BASE) était appelé **uniquement depuis le cron**. En le supprimant, S8c rendrait la fusion automatique silencieusement inopérante malgré l'indicateur actif.

Le relais déplace donc ce passage sous un déclenchement **événementiel autorisé**, sans élargir ses gardes :
- suite à `evidence.add` APPLIED avec état `SUBMITTED`, `AGREED` ou `PASS`, `task.status` APPLIED (`done`/`verified`), ou `owner.decision` APPLIED, par le canal /collab/mcp ou /owner ;
- suite à un webhook GitHub dont la signature et l'issue `202 accepted` ont déjà été vérifiées ;
- jamais depuis le cron de 15 minutes, ni sur un événement duplicate/STALE/quiet.

Le seul exécuteur reste `runAutoMergePass`, avec la politique existante et le bail de fusion existant. Ce déplacement n'autorise aucune nouvelle fusion, notamment vers `master`. Si aucun événement/webhook n'arrive, un nouveau candidat peut attendre : la robustesse de l'événement/alarme du lot B reste donc prérequise, et l'intégration événementielle doit être revue indépendamment en D12.
