# CC-7 L1 — parité des canaux et bail chat automatique

Cycle `cc7-api-auto`, lot **L1** (auteur Grok, relecteur Vibe, testeur Claude ; plan CC-PLAN-7 v0.2, S1 et S5).

## S1 — Parité

- Une identité serveur (`participant_id` résolu par le jeton OAuth) porte les droits.
- Chat et API sont des canaux : ils ne modifient pas `authorizeAppend`, les outils MCP ni les baux.
- Module `identity/channel-parity.ts` : `authorizationKey` ignore le canal ; tests de non-régression.
- Un participant API seul (sans session chat) est un participant enregistré à part entière dès qu'un `oauth_client_id` lui est associé par Kevin.

## S5 — Bail chat automatique

Avant L1, `preemptOwnRun` / `releaseOwnRun` exigeaient qu'une exécution `agent_runs` existe déjà pour (cycle, participant, task). Le chat ne pouvait donc pas prendre le bail **avant** la première exécution API.

Correctif :
- la préemption et le relâchement s'appuient sur l'**identité** (lease_key dérivé de cycle + participant + task) ;
- plus d'exigence de run préalable ;
- le fencing `preemptByChat` / `releaseChat` existant reste la source de vérité ;
- TTL défaut inchangé (`CHAT_HOLD_SECONDS_DEFAULT` = 900 s) ; le plan v0.2 mentionne 30 min — ajustable via `hold_seconds`.

Le chat « ouvre » = `collab_preempt_agent_run` ; « ferme » = `collab_release_agent_run`. L'API refuse de créer une exécution tant que `holder=chat` et `held_until` est futur (`chat_holds_lease`).

## Hors périmètre L1

- Mémoire trois cercles et « depuis ta dernière visite » → L3.
- Adaptateurs fournisseurs → L2.
- Types de tâches API / verdicts → L5.
