# l8 — répétition du canal API sur CC3-test (runbook et mesures)

Cycle `cc5-auto2-infra`, tâche **l8** (auteur Claude, relecteur final Grok, testeur Vibe GLM — réattribution Kevin
seq 749). Plan adopté seq 778 (votes Vibe seq 780, Grok seq 783), décision Kevin R6 option 1 (seq 781). Répétition
du 2026-10-25, environ 08:10–09:30 (heure de Paris). Journal complet : store seq 786 à 816.

## 1. Runbook

### Ouvrir la fenêtre

Les variables de `cc3-test` sont versionnées dans `wrangler.jsonc` : un réglage posé au tableau de bord est effacé au
déploiement suivant (#186). Ouvrir la fenêtre = une PR de configuration seule (modèle : #205), fusionnée par Kevin dans
l'intégration, qui redéploie CC3-test :

| Variable (env `cc3-test`) | Valeur pendant la fenêtre |
| --- | --- |
| `AGENT_RUNS_ENABLED` | `true` |
| `AGENT_RUN_MODEL` | `workers-ai:@cf/zai-org/glm-4.7-flash` (liste gratuite, 0 €) |
| `AGENT_RUN_PARTICIPANTS` | `claude` (seul participant API) |
| `WORKERS_AI_DAILY_NEURONS` | `4000` |
| `AGENT_RUN_DAILY_REQUESTS` / `_ROWS` / `_GB_S` | `500` / `3000` / `1000` |
| `AGENT_RUN_REPOSITORY`, `AGENT_RUN_GITHUB_WRITES`, `AGENT_RUN_PAID_MODEL`, enveloppe, `AGENT_RUN_BASE_BRANCH` | **absents** |
| `CONTROLLER_CRON_ENABLED` | `false` (inchangé) |

Le test `l7b-orchestrator.spec.ts` accepte « éteint » ou **exactement** ce profil pendant la fenêtre. Quotas plus
larges que le plan seq 778 (2000/500/2000/500) : le pire cas d'une exécution `answer` (24 000 jetons, 6 étapes) vaut
environ 874 neurons, soit environ 3 500 pour quatre exécutions (calcul du testeur, seq 785) ; 2000 ne couvrait pas S1-S4.

Avant d'ouvrir : vérifier qu'aucune question ouverte n'est adressée au participant API dans les cycles ouverts
(`collab_get_context`, champ `packet.open_questions`). Pendant la fenêtre, ne lui adresser que des questions marquées
`[l8]` : toute question qui lui est adressée est traitée par le canal API.

### Déclencher un passage

Un passage d'orchestrateur suit chaque livraison webhook **acceptée** (`CONTROLLER_WEBHOOK_ENABLED=true`). Il faut un
**nouvel** événement GitHub (commentaire de PR ou d'issue, push), à **60 s au moins** du précédent :

- un « Redeliver » GitHub réutilise l'identifiant de livraison : le webhook répond `duplicate`, aucun passage (D1) ;
- deux événements à moins de 60 s : le second répond `coalesced`, un seul passage.

Pendant la répétition, les passages ont été déclenchés par des commentaires sur les PR #206 puis sur l'issue #154.

### Observer

- Participant API (chat) : `collab_list_agent_runs` et `collab_agent_run_summary` (ses propres exécutions seulement).
- Kevin : `/owner`, section « Exécutions API » (toutes les exécutions, lecture seule).
- Store : `collab_get_delta` — une `clarify.answer` du participant API porte le rôle `api-agent`.

### Arrêter ou fermer

- Arrêt immédiat : HALT sur `/owner` (section Automatisation), puis PR de fermeture.
- Fermeture : PR inverse exacte (modèle : #206), fusionnée par Kevin ; l'arbre revient à l'état d'avant la fenêtre et
  le test rétablit l'assertion stricte `AGENT_RUNS_ENABLED === 'false'`.
- Critères d'arrêt (R7) : plus d'une réponse pour une même question, une écriture autre que `clarify.answer`, une
  réponse à une question non marquée contenant un verdict ou un acte, toute dépense, une exécution qui ne termine pas en
  6 étapes. Toute réponse à une question non marquée, même sans verdict, est consignée comme écart (amendement R2 de Vibe).

## 2. Scénarios, valeurs d'acceptation et résultats

Valeurs d'acceptation communes (amendement R4 de Vibe) : exactement une exécution `answer` par question traitée,
terminée en 6 étapes au plus, coût 0 ; exactement une `clarify.answer` du participant API, rôle `api-agent` ; aucune
autre écriture, aucun verdict, aucun appel GitHub ni payant.

| Scénario | Déroulé | Attendu | Observé | Store |
| --- | --- | --- | --- | --- |
| S1 réveil | Grok adresse `[l8] q1` ; un passage | 1 exécution, 1 réponse | 1 exécution (3 étapes, 6 090 jetons, 0 €), 1 réponse | 788-790 |
| S2 préemption | préemption chat ; Vibe adresse `[l8] q2` ; passage ; main rendue ; passage | rien pendant la préemption, puis 1 réponse | rien (bail chat, génération 2) ; puis 1 exécution (génération 3, 3 étapes, 6 232 jetons), 1 réponse | 791-796 |
| S3 rejeu | Grok adresse `[l8] q3` ; deux événements à 2 s ; un troisième à plus de 60 s ; renvoi du premier | 1 exécution, 1 réponse | livraison 1 `accepted`, livraison 2 `coalesced`, renvoi `duplicate` ; second passage réel sans nouvelle exécution ; 1 exécution (3 étapes, 6 047 jetons), 1 réponse | 795-800 |
| S4 HALT | HALT posé ; Vibe adresse `[l8] q4` ; passage ; HALT levé ; passage | rien sous HALT, puis 1 réponse | rien sous HALT ; puis 1 exécution (génération 5, 3 étapes, 6 147 jetons), 1 réponse | 801-808 |
| S5 fermeture | #206 fusionnée et déployée ; Grok adresse `[l8] q5` ; passage | aucune exécution | aucune exécution, aucune réponse automatique | 809-816 |

Totaux de la fenêtre : 4 exécutions, 12 étapes, 24 516 jetons, **0 €** ; 4 réponses `api-agent` (seq 789, 794, 798,
807), une par question ; aucun critère d'arrêt atteint.

## 3. Écarts et limites

- **E1-E3 — qualité des réponses (non bloquant).** q1 et q3 : le modèle a répondu ne pas avoir l'information (la
  consigne de `plan.ts` limite la lecture à `store_delta(since_seq ask-1, limit 1)` ; le compte global des tâches n'est
  pas exposé). q4 : le registre des tâches datait de la révision 11 (l7 n'y montre que 7a et 7b). Aucune invention dans
  les quatre cas ; q2 a reçu une réponse exacte. Suites proposées : élargir la consigne de lecture des exécutions
  `answer`, importer la révision 12 avant la clôture.
- **D1 — méthode.** « Redeliver » ne déclenche pas de passage (livraison `duplicate`) ; utiliser un nouvel événement.
- **Non répété en direct.** Les écritures GitHub (décision Kevin R6, seq 781) : l'idempotence reste prouvée par les
  tests 7c-3 (trailer `Agent-Effect`, remontée jusqu'à `expected_head_sha`). Le double réveil concurrent pendant une
  même étape (l'étape dure quelques secondes) : couvert par les tests 7b et 7c-1.
- **Limite d'observation.** Sous préemption ou HALT, l'absence d'exécution ne prouve pas à elle seule qu'un passage a
  tourné (les refus de `createRun` n'écrivent rien) ; le passage suivant, sur le même chemin, crée bien l'exécution.
