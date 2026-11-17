# CC8 — S9 : matrice des sorties et reprise WorkSession (préparation)

Propriétaire GPT-6, relecture Claude Chat, tests Grok Chat. Base d'audit intégration `ff6ce4125fbd573f379eb1f1da66a4ff1968e380` (16/11/2026). L'implémentation de cette PR est conditionnelle à la CI/D12 et fusion humaine ; elle **ne prouve pas S9 live parity** et n'autorise aucun retrait S10.

## Chemins étudiés

| Sortie observée | Réaction du circuit actuel | Suite admissible |
| --- | --- | --- |
| Modèle : 429/503/timeout transitoire au milieu d'une étape | `engine.runStep` → `retry` sur **le même run D1**, alarme espacée | Continuer, sans nouveau run ; les anciens `model_transient:` terminaux sont réarmables après 900 s |
| Fournisseur 400/401/403, route invalide, modèle non autorisé | `model_permanent:` → `failed` | Corriger clé/route côté propriétaire ; jamais nouveau run par une simple permission de reprise |
| Budget gratuit historique classé permanent | `failed` | Ancienne voie `WORKSESSION_ASSIGNED` explicitement autorisée pour implement, capacité contrôlée à nouveau |
| Final sans `store_answer`, `store_verdict`, `store_contribute` ou preuves GitHub | `incomplete_final:` → `failed` | Nouveau run seulement avec `WORKSESSION_RETRY_AUTHORIZED` exact, une fois par run échoué |
| Trois refus déterministes, relectures scope en boucle, `guided_stop`, échec de préparation guidée | `blocked:no_progress:`, `guided_*:` → `failed` | Lire diagnostics, réparer cause, puis checkpoint explicite ciblé ; jamais réessai en boucle |
| Etape ancienne épuisée `step_attempts_exhausted` | `failed` | Checkpoint ciblé après analyse, une seule tentative |
| CI pending | Ledger serveur et alarme différée | Ni nouvel appel modèle à chaque poll, ni nouveau run |
| CI rouge après `run.proof` | `controller/ci-transition` produit `correction.request` sur webhook signé + GitHub relu | Réveil auteur; re-soumission D12, pas verdict auto |
| `CHANGES_REQUESTED`, `FAIL` | `controller/rules` → `address_feedback` | Corriger sur la même PR; verdicts au dernier head/base |
| `AMEND` en phase de conception | `store_contribute` et phase-output | Nouveau tour de contribution, pas PR D12 forcée |
| `store_ask` en attente | Durable `waiting_for_reply`, relève à 120 s | Continuer **le même run** à la réponse |
| Quota Durable Object, Worker en panne, alarme perdu | Report 1 h, backoff erreur et scan de secours | Continuer run existant; pas d'effet dupliqué |
| HALT global, arrêt individuel, préemption chat, plafond de coût, effet ambigu `needs_reconcile` | `halted/preempted/cost_limit/needs_reconcile` terminal ou pause contrôlée | Ne jamais auto-relancer avec la permission d'échec ordinaire; décision/diagnostic séparés |
| Terminé `completed` / réponse ou verdict déjà journalisé | Effets idempotents, preuve D1 | Rien à redémarrer, éviter nouveau verdict sur PR fermée |

## Contrat de reprise explicite

Le coordinateur authentifié peut consigner un `checkpoint` D1 de `role=coordinator` et `state=WORKSESSION_RETRY_AUTHORIZED`, avec **task**, **participant**, **kind**, **subject** (couple SHA pour REVIEW/TEST, `ask#seq` pour ANSWER, sujet du contrôleur pour IMPLEMENT/DESIGN) et **failed_run_id**. L'événement doit suivre la terminaison échouée et précéder l'instant du scan. Les identités logiques du coordinateur sont vérifiées sur le store et le mandat actif ; les anciens événements ne peuvent débloquer un deuxième échec. Aucune augmentation de permission GitHub, bypass CI/HALT, fabrication de verdict ni replay d'effets incertains.

Une PR de correctif comme #348 doit être ouverte, au **head/base GitHub réellement courants** ; la preuve de lecture des outils et l'appel `store_verdict` restent obligatoires. Les anciens sorties et les réponses de modèles peuvent citer des SHA périmés : les vérifier via GitHub. Les scénarios QA de la PR démontrent la politique de reprise, pas une parité live des 4 kinds (3 couples/kind, juge indépendant, ≥80%, 0 critique).

## Réveil S8 : contrôlé, pas seulement planifié

**Constat vérifié après le premier commit :** `store/collab-store.ts:durableWakeWorthy` ne reconnaissait les checkpoints que pour `WORKSESSION_ASSIGNED`. Une reprise explicite `WORKSESSION_RETRY_AUTHORIZED` aurait attendu le cron au lieu d'utiliser la voie S8 event-first. Ce lot étend **le même prédicat S8** à une autorisation structurée complète et réutilise l'outbox et l'alarme existantes. Il ne crée aucune deuxième file, aucun runner et aucune autorité nouvelle. Les critères d'autorisation détaillés demeurent dans `agentrun/plan.ts`, à chaque création de run ; le prédicat de réveil seul ne vaut jamais permission. Tests avec `answer` sans tâche, non-réveil pour payload incomplet et conservation du comportement historique `WORKSESSION_ASSIGNED`.
