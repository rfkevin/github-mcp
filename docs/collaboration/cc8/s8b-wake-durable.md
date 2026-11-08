# CC8 S8 — lot B, réveil durable D1

Propriétaire : GPT-6 ; relecture Vibe ; tests indépendants Grok. Branche `mcp/105856986/cc8-s8-wake-durable`, depuis l'intégration après PR #289/#290. Aucun changement `src/index.ts` ni au cron du lot C de Gemini.

## Problème vérifié
S8a déclenchait `agentRunPass` dans `waitUntil` après APPLIED. Si le bail singleton 60 s était occupé, le hook quittait silencieusement et seul le cron de 15 minutes rattrapait. Un crash de `waitUntil` ne laissait aucune intention D1. Le run S8c Gemini après correction #1846 a illustré un délai de plusieurs minutes ; cette corrélation ne prouve pas à elle seule la cause exacte.

## Nouveau circuit
- **Dans la transaction CAS du store :** pour `clarify.ask` adressée, `evidence.add`, `task.claim/status/handoff`, `owner.decision` et `round.add`, ajouter une ligne unique `agent_event_wake_intents` (clé = idempotency_key de l'événement) et un audit `wake_queued`. Duplicate/STALE/refus : zéro ligne. Aucun appel modèle à ce stade.
- **Exécution immédiate :** le hook `eventWake` garde `waitUntil`, arme une alarme dans un DO singleton et tente de drainer les intentions sous le bail D1 60 secondes. Le passage demeure `agentRunPass` existant (policy, HALT, pause, quotas, chat fence, capacité, D1 `createRun`), aucune seconde implémentation de planificateur.
- **Bail occupé / HALT :** ne pas perdre l'événement : état `deferred`, `next_at` calculé à partir du bail ou à 60 s. L'alarme du DO reprend à l'échéance. Les dates sont injectables par le drain pour des tests déterministes.
- **Erreur :** `wake_error` avec `PASS_FAILED`, reprise exponentielle 5–60 s après libération du bail, au plus 6 échecs d'intention (statut terminal `error` conservé pour diagnostic). Journal `wake_deferred/delivered/error` sans suppression ; cardinalité bornée par intention.
- **Livraison :** `wake_delivered` signifie « le passage a été déclenché », et **pas** « le modèle a fini, CI verte ou PR fusionnée ». D12 inchangé.

## Limites
Aucune atomicité D1–alarme DO : une panne avant l'armement laisse l'intention conservée mais sans garantie d'une alarme immédiate ; un passage ou nouvel événement ultérieur doit la récupérer. La révision de l'état, le bail et les actions du contrôleur restent l'autorité. Le cron existant reste le filet de sécurité. Le nouveau singleton partage la classe DO des runs, mais possède une clé `cc8-agent-event-pass-v1` dédiée : aucun bail modèle ni action GitHub directe.

Tests : création transactionnelle sous CAS, duplicate/STALE/non pertinent, lease busy et expiration, HALT, statut livré idempotent, audit. CI et revue/test indépendants sont requis avant intégration. Aucun master, aucune relance payante, aucun merge automatique.
