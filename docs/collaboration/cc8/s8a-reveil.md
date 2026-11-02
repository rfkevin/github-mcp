# CC-8 S8a — Réveil événementiel et pause serveur (bilan de lot)

Lot S8a du plan CC-PLAN-8 (consultation S8a — AGREE seq 1402/1403, AMEND seq 1404, GO de Kevin).
Rôles D12 : auteur Vibe (GLM, servi par Mistral AI), relecteur GPT-6, testeur Grok.

## Parties et état

| Partie | Contenu | PR |
| --- | --- | --- |
| 1/3 | Acte owner `set_agent_run_status` (`owner/agent-run-status.ts`) : pause serveur réversible — jamais déléguable, CAS `expected_version` revérifié dans le lot d'écriture, précondition = dernier acte de statut du participant, fail-closed sans ligne (participant actif) ; garde `AGENT_PAUSED` en tête de `runCapacity`, AVANT toute politique, route ou sonde (sondes comprises) : aucune exécution n'est créée pour un participant en pause, le verdict est journalisé puis rendu au coordinateur | cette PR |
| 2/3 | Réveil événementiel (`agentrun/wake-trigger.ts`) : après une écriture APPLIQUÉE (jamais duplicate/STALE/refusée) d'un type réveil — `clarify.ask` adressée (`to` non vide), `evidence.add`, `task.claim`, `task.status`, `task.handoff`, `owner.decision` (canal /owner), `round.add` (via `collab_phase_adjust`) — le canal programme le MÊME passage que le webhook via `ctx.waitUntil` ; bail anti-rafale D1 `agent_run_pass_lease` (CAS atomique, TTL 60 s) : au plus un passage événementiel par minute ; webhook et passage programmé inchangés | cette PR |
| 3/3 | Guide (§3 `AGENT_PAUSED` dans `collab_agent_runs_overview`, §6.1 action et params, codes au §7), ce bilan, code-map, mémoire | cette PR |

## AC vérifiés (tests D1 réels, `ctx.waitUntil` factice, horloge simulée)

- question adressée (`clarify.ask` `to` non vide) → exécution `answer` créée sans aucun passage programmé ;
- dix écritures appliquées en rafale → UN seul passage (bail), livreur `event-pass:` ;
- duplicate (même `op_id`), STALE (révision périmée), type hors liste, `clarify.ask` sans `to`, bail tenu, AGENT_RUNS_ENABLED éteint ou binding absent → aucun passage ;
- pause → `AGENT_PAUSED` refusé (même pour une sonde), consigné dans `agent_run_capacity`, visible du coordinateur ; `resumed` → resservi au passage suivant ;
- approbation `/owner` d'une demande exécutable → passage déclenché par la décision appliquée ; rejeu du même formulaire → duplicate, rien de plus.

## Budget waitUntil

Le hook ne fait RIEN en inline : il programme le passage par `ctx.waitUntil`, jamais dans la réponse du canal. La documentation officielle Cloudflare (Runtime APIs, `ExecutionContext.waitUntil`) garantit que les promesses ainsi enregistrées continuent de s'exécuter après l'envoi de la réponse, dans la limite de la fenêtre du runtime (jusqu'à 30 secondes après le retour de la réponse). Le passage complet mesuré en test (`planAgentRuns` + livraison de l'outbox + scan de secours, base D1 réelle) reste de l'ordre de la seconde, très en deçà de cette fenêtre ; le passage programmé quart d'heure reste le filet si une promesse était perdue. Aucune étape n'est inline : les étapes restent des alarmes du Durable Object.

## Hors S8a

S8b/S8c, réveil du salon, fusion, appels payants, tests live répétitifs. `collab_delegate_owner` (owner.decision par délégation) ne passe pas par le hook : hors liste de la mission, le passage programmé le reprend. Aucun changement wrangler (cc3-test a déjà `AGENT_RUNS_ENABLED="true"`, les participants, le cron et le binding `AGENT_RUN`).
