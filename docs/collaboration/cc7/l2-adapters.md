# CC-7 L2 — fondation des adaptateurs payants (PR 2.1)

Plan CC-PLAN-7 v0.2, S2/S3. Cette fondation reste TOUTE éteinte par défaut : sans
`AGENT_RUN_PAID_MODEL` le câblage ne change pas, et même posé, aucun appel n'a lieu
tant que l'enveloppe par participant n'est pas financée et que le secret du
fournisseur n'est pas posé par Kevin seul sur le Worker. Aucune migration de
schéma : la comptabilité passe par `quota_counters` et `agent_paid_steps` existants.

## Registre des tarifs (daté, deny-by-default)

`src/collab-store/executors/model-rates.ts` — relevé du 2026-10-25
(`API_RATE_SNAPSHOT_DATE`), cents US par million de jetons, `source_url` par
entrée. Une référence absente est refusée avant tout appel (`apiModelRate` →
null). `centsOfApiTokens` arrondit au cent supérieur, jamais sous-évalué.

| Référence | Entrée | Sortie | Source |
| --- | --- | --- | --- |
| `zai:glm-5.3` | 140 | 440 | docs.z.ai/guides/overview/pricing |
| `zai:glm-5.3-flash` | 15 | 50 | docs.z.ai/guides/overview/pricing |
| `zai:glm-5.3-flashx` | 37 | 125 | docs.z.ai/guides/overview/pricing |
| `xai:grok-4.7` | 200 | 600 | docs.x.ai/docs/models |
| `xai:grok-4.20-0309-non-reasoning` | 125 | 250 | docs.x.ai/docs/models |
| `xai:grok-build-0.1` | 100 | 200 | docs.x.ai/docs/models |
| `anthropic:claude-sonnet-5-5` | 200 | 1000 | anthropic.com/pricing |
| `anthropic:claude-haiku-5-5` | 10 | 50 | anthropic.com/pricing |

`grok-4.1-fast` est absent de la page xAI au moment du relevé : il n'est PAS
listé (aucune exécution possible). `anthropic:claude-haiku-5-5` couvre les
prompts ≤ 100k jetons (palier long-contexte non relevé). À revalider avant tout
financement réel.

## Enveloppe payante PAR PARTICIPANT

`src/collab-store/agentrun/paid-model.ts` — l'enveloppe 7d devient par
participant. Variables posées par Kevin seul, TOUT à 0 par défaut = refus
`PAID_ENVELOPE_NOT_FUNDED` avant tout appel, aucun quota touché :

- `AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS` — cents US par participant et par jour (P5 Q1 : 200)
- `AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS` — cents US par participant et par cycle (P5 Q1 : 1000)
- `AGENT_RUN_PAID_PARTICIPANT_DAY_TOKENS` — plafond optionnel de jetons/jour (0 = aucun)
- `AGENT_RUN_PAID_PARTICIPANT_DAY_REQUESTS` — plafond optionnel d'appels/jour (0 = aucun)

L'enveloppe n'est financée que si les deux bornes en cents sont posées
(`envelopeFunded`). Registres par participant dans `quota_counters` :
`paid:participant:<pid>:day:<date>` (cents), `…:tokens`, `…:requests` et
`paid:participant:<pid>:cycle:<cycleId>`. Réservation au pire cas dans le même
lot D1 que la ligne `agent_paid_steps` et la garde `collab_store_guard` : un
refus (`PAID_DAILY/CYCLE/TOKEN/REQUEST_BUDGET_EXCEEDED`) ne laisse RIEN écrire ;
règlement au réel avec remboursement, jamais de découvert (coût plafonné à la
réservation), rejeu idempotent (une étape déjà réservée ne réserve jamais deux
fois, une étape réglée rejouée est refusée `PAID_STEP_ALREADY_SETTLED`), erreur
fournisseur = règlement au pire cas. Les registres globaux `paid:day` /
`paid:cycle` de 7d sont remplacés (rien d'actif).

Limites déclarées : les bornes par participant en lignes écrites et en Go-s ne
sont pas câblées dans ce lot — elles se comptent déjà au niveau du compte
(`metered-db`, `do_gb_s`) ; une borne par participant se câblera côté
orchestrateur (suivi L2/L5).

## Plafonds de jetons par type de tâche

`src/collab-store/executors/task-profiles.ts` — `TaskKind` et
`TASK_KIND_BOUNDS` étendus aux kinds du canal API : `answer` 2048/off,
`planification` 4096/low, `code` 4096/low, `revue` 2048/low, `test` 2048/low.
Le plafond effectif reste `min(absolu, modèle, task_kind, endpoint, demandé)`
(`resolveEffectiveMaxTokens`) — inchangé.

## Adaptateur Z.ai

`src/collab-store/agentrun/zai-model.ts` — `createZaiModel` : même contrat
`ModelClient` que les chemins Workers AI, tool_calls au format OpenAI. Secret
`LLM_KEY_ZAI` (posé par Kevin seul) : absent = `EXECUTOR_UNAVAILABLE` avant
toute réservation, aucun quota touché. Endpoint constant
`ZAI_CHAT_COMPLETIONS_URL`, timeout 90 s (`providerTimeoutMs('zai')`), aucun
retry. `parseZaiRef` : deny-by-default, aucun repli inter-familles
(`zai:` seulement, hors registre = `ZAI_MODEL_UNSUPPORTED` à la construction).
`thinking` désactivé pour la famille glm-5.3 (précédent glm-4.7-flash : le
raisononnement consomme max_tokens avant la réponse ; à revalider à
l'activation). L'enveloppe et les gardes de `paid-model.ts` s'appliquent telles
quelles (réservation/règlement par participant, participant relu depuis
`agent_runs`, jamais des arguments).

## Câblage engineFor

`src/collab-store/agentrun/object.ts` — `AGENT_RUN_PAID_MODEL` (prioritaire sur
`AGENT_RUN_MODEL`) dispatche par préfixe : `zai:<modèle>` part sur l'adaptateur
Z.ai SANS binding AI ; `workers-ai:@cf/vendor/model` exige le binding AI (sans
lui : modèle simulé, comportement inchangé) ; hors registre : refus à la
construction. L'enveloppe vient de `parseParticipantEnvelope(env)`.

## Hors périmètre de ce lot

- PR 2.2 : adaptateur xAI (`LLM_KEY_XAI`, refs `xai:`, même contrat ModelClient).
- PR 2.3 : adaptateur Anthropic (protocole Messages distinct avec tool_use,
  `LLM_KEY_ANTHROPIC` à ajouter au catalogue des secrets).
- Bornes lignes/Go-s par participant (comptage côté orchestrateur, suivi L2/L5).
- Aucune variable ajoutée à `wrangler.jsonc` : Kevin pose les vars à l'activation.
