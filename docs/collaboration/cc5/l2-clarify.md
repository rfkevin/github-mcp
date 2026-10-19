# CC-5 L2 — Clarification ouverte et sélection de tâche explicite

Lot L2 du cycle `cc5-auto2-infra` (auteur Vibe GLM ; reviewer Claude ; tester GPT-6 ; fusion Kevin). Suite de L0 (comptabilité X14 / rejeu, PR #161). Branche `mcp/105856986/vibe-cc5-l2` depuis `mcp/105856986/cc3-integration` @ `b9a797a`.

## 1. clarify.ask / clarify.answer et questions ouvertes

- `clarify.ask` : payload `{ "question", "subject"?, "task"?, "to"? }` — ouvre une question ouverte sur le cycle. `to` optionnel (X13) adresse la question : à un participant (`"to": "claude"`) ou à un rôle (`"to": "owner" | "reviewer" | "tester"`, qui exige `task` — le destinataire est le titulaire du rôle sur cette tâche). Sans `to` : question publique. Garde serveur à l’append : `CLARIFY_TO_INVALID` (`to` mal formé), `CLARIFY_TO_REQUIRES_TASK` (rôle sans `task`), `TASK_UNKNOWN` (tâche inconnue).
- `clarify.answer` : payload `{ "ask_seq", "answer" }` — lie la réponse à l’événement `clarify.ask` de seq `ask_seq`. Une question adressée ne se ferme que par son auteur ou son destinataire (identité logique comprise) : un tiers reçoit `CLARIFY_ANSWER_FORBIDDEN`, rien n’est écrit.
- Les questions sans réponse liée alimentent `packet.open_questions` de `collab_get_context` : format `#<seq> (<participant>) <question>`, question tronquée à 400 caractères, payload illisible → entrée vide, 50 questions visibles au plus par seq croissant (filtrage d’adressage avant limite, correction test GPT-6), budget 300 tokens (§9 du guide). Le journal du cycle prime sur toute liste fournie par l’appelant, et une question du journal retenue n’est jamais écartée par le trim du paquet (test GPT-6) : refs, puis questions de l’appelant, puis mémoire cèdent, sinon `PACKET_BUDGET_TOO_SMALL`.
- Réponse orpheline (`ask_seq` inconnu ou illisible) : acceptée, ne ferme rien. Pas de garde serveur sur `ask_seq` pour une question publique — choix assumé, le demandeur relit le delta. Une question adressée (`to`) n’apparaît dans `packet.open_questions` qu’à son auteur et à son destinataire (le rôle se résout sur la tâche citée) ; l’événement reste lisible dans le journal (`collab_get_delta`) — le filtrage vise le paquet (bruit, coût), pas la confidentialité : ne jamais poser de question confidentielle (§10).

## 2. Sélection de tâche explicite

Un `task` fourni à la résolution de contexte ne produit jamais un packet sans tâche :

- tâche absente du cycle → `TASK_UNKNOWN` (code C2 réutilisé, étendu à la résolution de contexte) ;
- tâche présente mais l’appelant ne tient aucun rôle (ou pas le rôle demandé) → `TASK_NOT_HELD` (nouveau code), le message dit le rôle réellement tenu ;
- plusieurs candidates → `AMBIGUOUS_TASK`, message listant `task_id (participation)` et suggérant `Fournissez task: « <id> »`.

## 3. Mode d’emploi (descriptions d’outils)

Les instructions du serveur et les descriptions de `collab_get_context` / `collab_append_event` documentent : les contrats clarify.ask/answer et `open_questions` ; `TASK_UNKNOWN` / `TASK_NOT_HELD` ; les propositions scellées (une seule par participant et par ronde, seuls `sealed_id` et `content_hash` visibles avant révélation) ; le bilan `evidence.add` au couple SHA exact (payload `{ "task", "source", "state", "review" }`).

## 4. Guide collab-store (suite de L0)

15 éditions dans `docs/collaboration/cc3/collab-store-guide.md` : section 3 (questions ouvertes, sélection explicite, clarification, mode d’emploi), types acceptés, tableaux d’erreurs (`TASK_UNKNOWN` étendu C2/L2, `TASK_NOT_HELT` nouveau, `AMBIGUOUS_TASK` et `NO_ACTIVE_CYCLE` précisés), budgets §9, limites §10, et reprise des lignes L0 : sortie conservée au rejeu (65 536 caractères), délais d’attente par fournisseur, `enable_thinking: false` pour gemma-4-26b (diagnostic `l0-diagnostic.md`).

## 5. Corrections de la review Claude (seq 295, AMEND)

Au head `50b04b6` (base `b9a797a`), la review Claude valide le lot (1120/1120 tests verts) et demande deux corrections courtes :

- **R1** : `TASK_NOT_HELT` était une faute de frappe — renommé `TASK_NOT_HELD` partout (code, guide §7, docs-coverage, tests). Un code d’erreur est une API citée par les agents et les tests.
- **R2 (X13)** : adressage optionnel des questions ouvertes — `to` (participant ou rôle, le rôle exige `task`) dans `clarify.ask` ; `packet.open_questions` ne montre une question adressée qu’à son auteur et à son destinataire (rôle résolu sur la tâche citée, identité logique comprise) ; la clôture `clarify.answer` est réservée à l’auteur et au destinataire (`CLARIFY_ANSWER_FORBIDDEN`, rien n’est écrit sinon) ; gardes serveur `CLARIFY_TO_INVALID` / `CLARIFY_TO_REQUIRES_TASK` / `TASK_UNKNOWN` à l’append de `clarify.ask`. L’expiration par révision prévue par X13 reste en L3 (contrôleur), volontairement hors L2.
- Tests pour chaque cas : `test/collab-store/store/clarify.spec.ts` (nouveau, pré-checks serveur), `open-questions.spec.ts` (visibilité), `collab-tools.spec.ts` (outil réel `CLARIFY_TO_REQUIRES_TASK`).

## 6. Corrections du test GPT-6 (PARTIAL / AMEND au head `b6119ab`)

Au head `b6119ab`, le test indépendant GPT-6 (commentaire 6257857046) constate CI 4/4, valide `TASK_NOT_HELD`, `TASK_UNKNOWN`/`AMBIGUOUS_TASK`, l’adressage et la clôture réservée, et demande deux corrections :

- **F1 — perte silencieuse de questions du journal** : le trim global du paquet pouvait écarter une question du journal retenue dans la limite dédiée, contre le contrat « journal en tête, survit au trim ». Corrigé : l’ordre de sacrifice est refs, puis questions fournies par l’appelant, puis mémoire ; une question du journal retenue (`priorityQuestionCount`) n’est jamais écartée — au pire `PACKET_BUDGET_TOO_SMALL` (refus explicite). Test de stress : budget faible, nombreuses questions, refs et mémoire — aucune question retenue perdue silencieusement ; test discriminant : budget trop petit → `PACKET_BUDGET_TOO_SMALL` (l’ancien code perdait les questions en silence et réussissait).
- **F2 — fenêtre de 50 lignes brutes** : `loadOpenQuestions` appliquait `ORDER BY a.seq LIMIT 50` AVANT le filtrage de visibilité — 50 adressages aux tiers pouvaient masquer une question visible plus récente. Corrigé : le filtrage précède la limite (pagination par curseur `a.seq > ?`), la fenêtre rend 50 questions visibles. Test : 50 adressages aux tiers + 1 question visible au-delà de la fenêtre — elle est rendue (chargement direct et `buildRolePacket`).
- Verdicts : Claude (reviewer) AGREE au head `b6119ab` (store seq 299) ; GPT-6 AMEND — renouvellement attendu au nouveau couple SHA après ces corrections.

## Divulgations hors owned_paths

owned_paths : `src/collab-store/context`, `src/collab-store/mcp`, `docs/collaboration/cc5`.

- `src/collab-store/contracts/events.ts` — `clarify.ask` / `clarify.answer` ajoutés à `EVENT_TYPES` (+ tableau dans events.spec.ts).
- `src/collab-store/store/collab-store.ts` — pré-checks serveur clarify (R2 : `validateClarifyAsk` / `validateClarifyAnswer`, lecture seule, fail-closed, aucun refus n’écrit) : hors owned_paths, divulgé.
- Tests hors owned_paths : `test/collab-store/context/open-questions.spec.ts`, `resolution.spec.ts`, `events.spec.ts`, `test/collab-store/mcp/collab-tools.spec.ts`, `test/collab-store/store/clarify.spec.ts` (nouveau).
- `docs/collaboration/cc3/collab-store-guide.md` — 15 éditions (dont reprise L0).
- `AGENT_MEMORY.md` — append-only.
- `src/collab-store/mcp/tools.ts` — dans le périmètre (mcp), descriptions uniquement, aucune logique.

0 €, pas de main, pas de production, pas de migration.
