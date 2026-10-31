# CC-7 L15 — bail du chat automatique

Décision de Kevin du 2026-10-31 (option 2) : le chat et l'API d'un même agent ne doivent jamais
travailler en même temps sur la même tâche, sans dépendre de la discipline de chaque agent.

## Constats du 2026-10-31 (cycle cc7-api-auto)

- Le bail du chat existait depuis L1 (`collab_preempt_agent_run`, fencing 7a), mais aucun chat ne le
  prenait.
- seq 1157 : le chat de Vibe a codé plus de 15 minutes sans rien écrire au store ; le planificateur a
  lancé son API sur la même tâche (réveil « rien soumis ») ; l'API a écrit 12 s après la soumission
  du chat.
- seq 1160 : un verdict négatif a réveillé l'API de Vibe pour « corriger » ; sans outils d'écriture
  GitHub (`AGENT_RUN_GITHUB_WRITES` absent sur cc3-test), elle a annoncé « commencé l'implémentation »
  sans pouvoir le faire.

## Règles

1. **Bail automatique.** Toute écriture appliquée par le canal chat (`collab_append_event`) qui porte
   une tâche et dont le type est `task.claim`, `task.status`, `task.handoff`, `checkpoint` ou
   `evidence.add` prend ou renouvelle le bail du chat sur cette tâche pendant
   `CHAT_AUTO_HOLD_SECONDS` (1 h), pour chaque identité équivalente de l'agent. Effets, déjà portés par
   le moteur :
   - aucune nouvelle exécution API sur la tâche (`createRun` → `chat_holds_lease`) ;
   - une exécution API en vol sur la tâche perd la main (nouvelle génération ; ses écritures
     suivantes sont refusées, statut `preempted`).
2. **Libération.** `task.status` `done` ou `verified` écrit par le chat rend le bail. Sinon il expire
   seul après 1 h sans écriture : un chat planté ne bloque jamais l'API plus longtemps.
3. **Le canal API ne prend jamais le bail du chat** : ses écritures passent directement par le store,
   pas par `collab_append_event`.
4. **Réveil « implémenter » seulement si l'API peut coder.** Le planificateur ne crée une exécution
   `implement` (implémenter, corriger, correction demandée) que si `AGENT_RUN_GITHUB_WRITES` vaut
   `true`. Sinon le réveil est compté `unequipped` et reste pour le chat.
5. La réponse de `collab_append_event` indique l'effet : `chat_lease: {task, action: held|released,
   held_until}`.

`collab_preempt_agent_run` reste disponible pour prendre le bail plus longtemps (jusqu'à 24 h) avant un
long travail sans écriture ; `collab_release_agent_run` le rend en fin de session.

## Consigne pour les chats

Avant de coder sur une tâche, écrire au store (prise de tâche, `task.status in_progress` ou
point d'étape) : le bail est pris. Poser un point d'étape au moins toutes les heures pendant un long
travail, et à chaque commit.

## Limites

- Les questions adressées sans tâche ne sont pas concernées : la fenêtre glissante de L12 s'applique.
- Une écriture du chat sur une tâche où il n'a pas de rôle prend aussi le bail pour son propre agent
  sur cette tâche (sans effet sur les autres agents).

## Retour arrière

Revert du lot : retour au bail explicite seul et aux exécutions `implement` sans condition. Aucune
donnée migrée (les lignes `agent_fences` existantes restent valides).

Tests : `test/collab-store/agentrun/cc7-l15-chat-auto-lease.spec.ts`.
