# CC-7 L12 — un seul travailleur actif par agent (chat ou API)

Demande de Kevin du 2026-10-30 : « que le système regarde si le chat ou l'API a déjà une tâche en
cours pour éviter de faire des simultanés qui pourront créer une confusion ».

## Constats du jour

1. Le planificateur créait une exécution API `answer` pour une question adressée même quand le chat du
   même agent traitait déjà cette question. Le bail chat (L7-4) est **par tâche** ; une réponse n'a pas de
   tâche (`task_id = ''`), donc le bail ne la couvrait pas.
2. Une session chat interrompue a laissé des commits sans trace dans le store ; la session suivante du
   même agent ne savait pas qu'un travail était en cours et a failli le refaire.

## Ce qui change

| Où | Règle | Effet |
| --- | --- | --- |
| Planificateur (`planAgentRuns`) | Le chat de l'agent (identités équivalentes comprises, rôle ≠ `api-agent`, hors `owner.decision` / `phase.advance`) a écrit depuis moins de `CHAT_ACTIVE_SECONDS` = 900 s | **Question adressée** : chat actif sur le cycle → pas d'exécution `answer`. **Réveil de tâche** : chat actif sur cette tâche → pas d'exécution `review` / `test` / `implement`. Compteur `deferred` (présent seulement s'il est non nul). |
| `collab_get_context` | Nouveau champ `active_work` (participant enregistré seulement) | Dernière écriture du chat, exécutions API ouvertes (`running`, `needs_reconcile`, 5 au plus), dernier checkpoint par tâche (5 au plus), troncature signalée. |
| `collab_append_event` | Une **autre** session nommée du même agent a écrit sur la **même** tâche depuis moins de `CONCURRENT_SESSION_SECONDS` = 1800 s | Champ `concurrent_session` dans la réponse. Avertissement seulement : l'événement est appliqué. |

## Garde-fous

- **Fenêtre glissante** : un chat planté ne bloque jamais l'API au-delà de 15 min. La décision n'est pas
  consommée, seulement différée ; le passage suivant la reprend.
- **Limité à l'agent** : jamais les écritures, exécutions ou checkpoints d'un autre participant (CR-C).
- **Aucun faux positif** sans `session_id` ou sans tâche dans le payload (`task` texte ou `task.task_id`).
- **Lecture seule** : rien n'est écrit par ces contrôles ; une erreur de lecture ne fait jamais échouer un
  append déjà appliqué.
- Le chat qui revient pendant une exécution API la voit dans `active_work.open_api_runs` et peut la
  préempter (`collab_preempt_agent_run`, L7-4), comme avant.

## Bonne pratique pour les sessions chat

Déposer un `checkpoint` `{task, state}` en début et en fin de travail, avec un `session_id` stable par
session : c'est ce qui rend le travail en cours visible aux autres sessions et au planificateur.

Tests : `test/collab-store/agentrun/cc7-l12-active-work.spec.ts` (11 tests).
