# l7 — exécution autonome des agents dans le cloud (canal API)

Auteur : Claude (coordinateur). Relecteur : Grok. Testeur : Vibe GLM. ChatGPT GPT-6 consulté (exécution durable, préemption).

## Décision

Kevin, 21/10 : l7 ne passe plus par son PC (« runners locaux » abandonnés). Les agents travaillent seuls dans le cloud par
le canal API, en continuité avec le chat : même participant, même store, même mémoire ; Kevin peut les réveiller et leur
parler en chat en même temps. Plan adopté par les trois familles : l7 v2.1 (store seq 453-457). Choix de l'exécution
durable : Durable Objects SQLite, pas Workflows ni Queues sur un compte Workers Free (note L7-1 v1.1, seq 458-462).

Découpage, une PR et un D12 par incrément : **7a** moteur et sécurité (ce document) ; 7b orchestrateur Durable Object et
réveil depuis le contrôleur (outbox) ; 7c fournisseurs réels gratuits ; 7d modèles payants derrière l'enveloppe owner ;
7e intégration chat et vue `/owner`. l8 : répétition générale, audit par un relecteur final désigné par Kevin, GO de Kevin.

## Incrément 7a — moteur pas à pas (`src/collab-store/agentrun/`)

Aucun pouvoir activé : rien n'appelle ce moteur hors des tests ; modèle et outils sont injectés (modèle simulé, 0 €).

- `runStep(db, runId, deps)` fait **une** étape : appel modèle → outils → checkpoint, puis rend la main. Aucun état en
  mémoire : tout est relu dans D1, source de vérité. L'orchestrateur (alarme d'un Durable Object en 7b, ou une étape
  Workflows si Kevin passe en Workers Paid) l'appelle en boucle.
- **Double réveil** : l'étape est réclamée par CAS (`PRIMARY KEY (run_id, n)`) ; le second appel reçoit `busy`.
- **Coupure** : une étape réclamée depuis plus de `STEP_TIMEOUT_S` (600 s, sous les 15 min d'une alarme) est reprise par
  un autre worker, au plus `MAX_STEP_ATTEMPTS` (2) fois, puis l'exécution passe `failed`. La sortie du modèle est
  enregistrée avant tout effet : une reprise rejoue la même décision sans rappeler le modèle.
- **Fencing chat > API (L7-4)** : table `agent_fences`, une génération par clé de bail (cycle, participant, tâche).
  `preemptByChat` incrémente la génération ; chaque écriture de l'exécution revalide dans le même lot D1 sa génération,
  le titulaire `api` et l'absence de HALT (garde `LIVE`). Le Durable Object ne sera pas un verrou sur D1 ou GitHub.
- **Effets externes (R2)** : `intent → pending → completed | failed | ambiguous`, clé d'effet = SHA-256 canonique de
  (exécution, étape, rang, outil, arguments). Un effet resté `pending` après une coupure n'est **jamais réémis à
  l'aveugle** : `lookup` cherche s'il a eu lieu ; « trouvé » = résultat repris, « certainement pas » = tenté une fois,
  « impossible de savoir » = `needs_reconcile`. Une erreur d'exécution non certaine (délai) donne `ambiguous` ;
  `ToolRefused` (refus certain) donne `failed` et l'agent continue. Le résultat d'un effet réellement envoyé est
  enregistré même si le bail a changé : c'est la trace de ce qui a eu lieu.
- **HALT (L7-7)** : aucune nouvelle étape, aucun nouvel effet, aucune écriture ; une décision du modèle reçue après HALT
  n'est pas enregistrée ; un effet déjà envoyé reste visible (pas de promesse d'annulation).
- **Plafonds (R5)**, vérifiés à chaque étape dans la garde de réclamation puis par `settle` : étapes, jetons, coût
  (`cost_cents <= max_cost_cents`, 0 € par défaut ; la réservation au pire cas arrive en 7d), échéance. L'usage d'un
  appel modèle est compté même si l'appel échoue ou si l'étape est refusée ensuite.
- **Outils (L7-2, L7-6)** : allowlist deny-by-default fournie par l'hôte par type de tâche ; les outils de
  `API_AGENT_FORBIDDEN` (verdicts, owner, fusion…) sont refusés en code même si l'hôte les déclare ; toute écriture passe
  par `assertNotD12Verdict`. Résultats d'outils tronqués à 16 Ko et rendus au modèle comme données.
- `createRun` prend le bail côté API et crée l'exécution dans un seul lot : refusée si HALT, si le chat tient le bail,
  ou si une exécution est déjà active pour la clé ; un `run_id` rejoué ne crée rien.
- Tables append-only (DELETE refusé) : `agent_fences`, `agent_runs`, `agent_run_steps`, `agent_run_effects`.

### Protocole de récupération DO/D1 (pour 7b)

Pas de transaction distribuée. L'objet ne garde qu'une copie de travail ; s'il est perdu ou évincé, l'alarme suivante
(ou le scan de secours du contrôleur) rappelle `runStep`, qui reprend depuis D1 et les clés d'effet. 7b réutilisera
l'outbox et les baux d'invocation existants (`src/collab-store/invocations/`, A1) pour le réveil.

### Tests

`test/collab-store/agentrun/l7a-engine.spec.ts` (16) : parcours complet ; double réveil ; coupure après le modèle ;
coupure après l'effet et avant son enregistrement (lookup, aucun second commit) ; effet incertain sans lookup ;
délai contre refus certain ; effet pending certainement non appliqué ; réessai modèle borné et usage compté ;
préemption pendant et avant l'effet ; bail tenu par le chat puis libéré ; une exécution active par clé ; HALT entre
deux étapes et pendant l'appel modèle ; plafonds d'étapes, jetons, coût et échéance ; outils refusés et verdict D12 ;
DELETE refusé. Contre-épreuves locales : retirer la garde du checkpoint, la vérification d'effet incertain, le délai de
reprise, HALT de la garde, la borne de réessai ou le contrôle D12 fait échouer au moins un test.
