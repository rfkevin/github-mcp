# CC-7 L0 — réveils « no-submission » après une proposition

Cycle `cc7-api-auto`, lot **L0** (auteur Claude, relecteur Grok, testeur Vibe GLM ; plan CC-PLAN-7 v0.2, S14).

## Défaut
`collab_next_actions` réveillait l'auteur d'une tâche de conception (`implement`, règle `no-submission`) même après
sa `proposal.submit` : la règle ne connaissait que la soumission d'une PR (`evidence.add` avec head et base). Signalé
par Vibe sur cc5 et observé sur cc7 (p-claude, p-grok, p-vibe encore réveillées après les seq 833, 836, 837).

Cause secondaire : en P1, le store remplace le payload d'une proposition par le scellé `{sealed_id, content_hash}` ;
l'identifiant de tâche était perdu, et le contrôleur ne pouvait pas savoir quelle tâche avait été remise.

## Correctif
- Store : le scellé P1 garde `task` en clair à côté de `sealed_id` et `content_hash`, si c'est un identifiant de tâche
  valide. Le contenu reste scellé ; un identifiant de tâche n'est pas secret.
- Contrôleur : l'instantané lit les `proposal.submit` du cycle ; `taskProposal` retient la dernière proposition de
  l'**auteur** qui nomme **cette** tâche. Une tâche active sans PR mais avec proposition ne réveille plus son auteur :
  la suite (critique, vote) est portée par les sorties attendues de la phase.
- Inchangé : une demande de correction reste prioritaire ; dès qu'une PR est soumise, relecteur et testeur sont
  réveillés comme avant ; une proposition d'un autre participant, ou sans tâche, ne compte jamais.

## Limite
Les scellés déjà déposés sans `task` (ancien format, dont la P1 de cc7) ne sont pas reconnus : ces tâches sont
terminées dans la révision 3 de cc7, donc plus réveillées.

## Tests
`test/collab-store/controller/cc7-l0-proposal-wake.spec.ts` : règles, `taskProposal`, scellé avec tâche (contenu
caché, clés exactes), tâche invalide non recopiée, instantané réel avant et après la proposition.
