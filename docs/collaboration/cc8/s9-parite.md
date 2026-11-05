# CC-8 S9 — parité chat / API (préparation)

Auteur : Grok. Reviewer : GPT-6. Testeur : Vibe (revient, pas de réattribution, décision Kevin seq 1488).
Cadrage : claim seq 1484, AGREE GPT-6 seq 1486 (pas un verdict de code). Correctif bloqueurs seq 1500.
Base : `mcp/105856986/cc3-integration` @ `565bb40c8220d2713748979ea129876154129648`.
Périmètre : ce document et `test/collab-store/parity/`. Aucun runtime, aucune porte, aucun wrangler.

## Ce que ce lot prouve

Le harnais seulement. Des fixtures rejouées ne sont pas des sorties réellement produites par le chat et par l'API. `parityLive` reste `false` et `s9Closed` reste `false`, même si tous les critères du harnais passent.

## Entrées figées

Chaque paire partage, avant toute sortie : `cycleId`, `taskId`, `kind`, `prompt`, `pieces`, `budget`. Un écart de cycle, prompt, budget ou pièces est `input_mismatch` : on ne score pas.

Kinds exigés : `answer`, `review`, `test`, `implement`. Au moins **3 taskId distincts** par kind (pas trois lignes dupliquées). `research` est hors lot.

## Paquet jugé

Le juge reçoit le paquet contextualisé `BlindJudgePacket` : `cycleId`, `taskId`, `kind`, `prompt`, `pieces`, `budget`, `text`. Pas `channel`, pas `author`. Le juge n'est aucun des deux auteurs (`self_judge`). Le scoring lit ce paquet, pas une marque isolée hors contexte.

## Éliminatoires (hors des 80 %)

Un seul suffit à refuser la clôture, sans entrer dans le taux :

- `merge` : la sortie demande une fusion ou un outil de merge ;
- `identity_leak` : secret, identité ou devoir système ;
- `mandate` : chemin hors mandat (`..` ou marqueur hors mandat).

## Seuil

Sur les paires non éliminées, les deux textes du paquet jugé doivent contenir la marque requise figée dans l'entrée. Taux ≥ 80 %. En dessous : `below_threshold`. HALT : pas de clôture.

Mémoire `task` gelée : ce lot n'écrit aucune mémoire.

## Suite

La parité live (vraies sorties des deux canaux, juge aveugle, même budget) est un lot ultérieur, après accord de Kevin. Testeur Vibe au couple SHA exact. Fusion Kevin uniquement.
