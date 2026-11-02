# CC-8 S1a — Capacité et équité (bilan de lot)

Lot S1a du plan CC-PLAN-8 (seq 1262 + v0.2 seq 1270, validé par Kevin seq 1280).
Rôles D12 : auteur Claude, relecteur GPT-6, testeur Vibe.

## Parties et état

| Partie | Contenu | PR |
| --- | --- | --- |
| 1/3 | `runCapacity` : capacité réelle avant toute création (même résolution que le routage : politique, chaîne du store S3, `resolveProviderRoute` pour le chemin sans politique) ; aucune exécution vouée à l'échec ; service par ancienneté des réveils (`controller_decisions.created_at`), à tour de rôle sous `PLAN_LIMIT` | #248 (fusionnée) |
| 3/3 | Configuration : gpt6 dans `AGENT_RUN_PARTICIPANTS`, fusion auto vers l'intégration (`AUTO_MERGE_*`), `AGENT_RUN_REPOSITORY` versionnée (pas de `keep_vars`) | #251 (fusionnée) |
| 2/3 | Refus anticipé sur coupe-circuit S1b-2, capacité journalisée, vue du coordinateur | cette PR |

## Partie 2/3

- **Refus anticipé (coupe-circuit)** : `runCapacity` applique le même filtre que le routage réel (`breakerOpenUntil` + `breakerSkipping`, option B participant × modèle). Si tous les maillons d'un agent sont en pause, le verdict est `CIRCUIT_OPEN` et aucune exécution n'est créée. Si un seul maillon est en pause, le suivant est retenu, dans l'ordre du routage. Les sondes (`probe`) restent exemptées.
- **Capacité journalisée** : à chaque passage, le planificateur consigne le verdict de chaque (agent, cycle, type) évalué dans `agent_run_capacity` (upsert : une ligne par clé). Le verdict est soit le modèle retenu, soit un refus typé (`MODEL_BUDGET_EXHAUSTED`, `MODEL_ROUTE_REFUSED`, `NO_MODEL`, `MODEL_POLICY_INVALID`, `CIRCUIT_OPEN`), borné à 300 caractères. L'écriture est best-effort : elle ne conditionne jamais la décision du passage.
- **Vue du coordinateur** : outil MCP `collab_agent_runs_overview`, en lecture seule, réservé au détenteur du mandat du cycle ou à un coordinateur owner-approved (`COORDINATOR_REQUIRED` sinon). Il rend :
  - les comptes par agent et statut ;
  - les exécutions récentes, avec la raison d'arrêt réduite à son code typé (`stopReasonCode`) ;
  - les verdicts de capacité ;
  - les maillons en pause coupe-circuit.

  Il ne rend jamais de consigne, de résumé ni de sortie de modèle.

## Hors S1a (S8)

Réveil immédiat sur événement du store (cron de 15 min en secours) et coordinateur autonome : décision de Kevin du 2026-11-01 à 22:07.
