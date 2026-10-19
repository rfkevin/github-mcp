# CC-5 L2 — Clarification ouverte et sélection de tâche explicite

Lot L2 du cycle `cc5-auto2-infra` (auteur Vibe GLM ; reviewer Claude ; tester GPT-6 ; fusion Kevin). Suite de L0 (comptabilité X14 / rejeu, PR #161). Branche `mcp/105856986/vibe-cc5-l2` depuis `mcp/105856986/cc3-integration` @ `b9a797a`.

## 1. clarify.ask / clarify.answer et questions ouvertes

- `clarify.ask` : payload `{ "question", "subject"?, "task"? }` — ouvre une question ouverte sur le cycle.
- `clarify.answer` : payload `{ "ask_seq", "answer" }` — lie la réponse à l’événement `clarify.ask` de seq `ask_seq`.
- Les questions sans réponse liée alimentent `packet.open_questions` de `collab_get_context` : format `#<seq> (<participant>) <question>`, question tronquée à 400 caractères, payload illisible → entrée vide, 50 entrées au plus par seq croissant, budget 300 tokens (§9 du guide). Le journal du cycle prime sur toute liste fournie par l’appelant.
- Réponse orpheline (`ask_seq` inconnu) : acceptée, ne ferme rien. Pas de garde serveur sur `ask_seq` — choix assumé, le demandeur relit le delta. Les questions ouvertes ne sont pas masquées : ne jamais poser de question confidentielle (§10).

## 2. Sélection de tâche explicite

Un `task` fourni à la résolution de contexte ne produit jamais un packet sans tâche :

- tâche absente du cycle → `TASK_UNKNOWN` (code C2 réutilisé, étendu à la résolution de contexte) ;
- tâche présente mais l’appelant ne tient aucun rôle (ou pas le rôle demandé) → `TASK_NOT_HELT` (nouveau code), le message dit le rôle réellement tenu ;
- plusieurs candidates → `AMBIGUOUS_TASK`, message listant `task_id (participation)` et suggérant `Fournissez task: « <id> »`.

## 3. Mode d’emploi (descriptions d’outils)

Les instructions du serveur et les descriptions de `collab_get_context` / `collab_append_event` documentent : les contrats clarify.ask/answer et `open_questions` ; `TASK_UNKNOWN` / `TASK_NOT_HELT` ; les propositions scellées (une seule par participant et par ronde, seuls `sealed_id` et `content_hash` visibles avant révélation) ; le bilan `evidence.add` au couple SHA exact (payload `{ "task", "source", "state", "review" }`).

## 4. Guide collab-store (suite de L0)

15 éditions dans `docs/collaboration/cc3/collab-store-guide.md` : section 3 (questions ouvertes, sélection explicite, clarification, mode d’emploi), types acceptés, tableaux d’erreurs (`TASK_UNKNOWN` étendu C2/L2, `TASK_NOT_HELT` nouveau, `AMBIGUOUS_TASK` et `NO_ACTIVE_CYCLE` précisés), budgets §9, limites §10, et reprise des lignes L0 : sortie conservée au rejeu (65 536 caractères), délais d’attente par fournisseur, `enable_thinking: false` pour gemma-4-26b (diagnostic `l0-diagnostic.md`).

## Divulgations hors owned_paths

owned_paths : `src/collab-store/context`, `src/collab-store/mcp`, `docs/collaboration/cc5`.

- `src/collab-store/contracts/events.ts` — `clarify.ask` / `clarify.answer` ajoutés à `EVENT_TYPES` (+ tableau dans events.spec.ts).
- Tests hors owned_paths : `test/collab-store/context/open-questions.spec.ts` (nouveau), `resolution.spec.ts`, `events.spec.ts`, `test/collab-store/mcp/collab-tools.spec.ts`.
- `docs/collaboration/cc3/collab-store-guide.md` — 15 éditions (dont reprise L0).
- `AGENT_MEMORY.md` — append-only.
- `src/collab-store/mcp/tools.ts` — dans le périmètre (mcp), descriptions uniquement, aucune logique.

0 €, pas de main, pas de production, pas de migration.
