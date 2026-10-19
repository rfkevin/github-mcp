# CC-5 L5 — chercheur planifié et hygiène mémoire (D3), incrément 1

Lot L5 (révision 5, vague 2) — auteur : Vibe GLM ; relecteur : Grok (l3b) ;
testeur : Claude. Base : `mcp/105856986/cc3-integration`. Chemins possédés :
`src/collab-store/research`, `src/collab-store/memory`, `docs/collaboration/cc5`.

## Périmètre de l'incrément 1

- **Passes du chercheur en lecture seule** (`src/collab-store/research`) :
  `runResearchPass(db, { passId, cycleId, caps, now })` calcule des findings
  d'hygiène et les écrit dans UN lot D1 vers les tables internes
  `research_passes` / `research_findings` (pattern des migrations internes du
  store 0005/0007/0008/0009, jamais dans le schéma canonique gelé). Le
  registre canonique (`events`, `memory_entries`, `cycles`) n'est jamais
  modifié — prouvé par test (comparaison intégrale avant/après).
- **Politique d'hygiène pure** (`src/collab-store/memory/hygiene.ts`, sans
  D1) : plafonds par famille, kinds critiques, ordre archive-first, liaison
  de consolidation.
- **Résumé d'archivage par cycle** (`cycleArchiveSummary`) : plage seq du
  journal, empreinte sha256, stats mémoire ; fail-closed sur cycle inconnu ;
  le résumé n'est JAMAIS une source d'autorité (notice explicite, D3-b).

## Invariants

- **HALT** (owner_flags, canal owner) : un passage retourne `halted` et
  n'écrit RIEN (test).
- **Idempotence** : même `passId` rejoué → passage original renvoyé
  (`duplicate`), aucune seconde écriture (test). Le contrôleur L3d peut donc
  rejouer un déclencheur identique sans doublon.
- **Confidentialité** (X2/CRB-R1) : aucun finding ne transporte le texte
  d'une entrée mémoire — scopes `participant:` privés compris (test).
- **Kinds critiques** : `invariant`/`decision` ne comptent jamais dans un
  plafond et ne sont jamais candidates à l'archivage (D3-c, exception
  contrôlée). La liste SQL est dérivée de `PROTECTED_KINDS` (source unique).
- **Autorité** : consolidation et archivage réels passent par le lifecycle
  C4 (`memory.consolidate`, `memory.retire`), jamais par réécriture directe.

## Matrice de traçabilité D3

| Point D3 | État incrément 1 | Où |
| --- | --- | --- |
| a) consolidation périodique par le chercheur | PRÉPARÉ : findings `consolidation_candidate` avec liaison source ; exécution via C4 = différée (lifecycle existant) | `run.ts` |
| b) archivage par cycle, résumé ≠ autorité | LIVRÉ | `archive.ts` |
| c) plafond participant + scopes partagés, exception contrôlée | LIVRÉ (défauts 25/50, surcharge) | `hygiene.ts` |
| d) budgets par task_kind | DIFFÉRÉ (revient à L3b, paquet API borné) | — |
| e) utilité mesurée, archive-first | LIVRÉ (policy + finding `archive_first`) | `hygiene.ts`, `snapshot.ts` |
| f) paquet API borné | DIFFÉRÉ (L3b) | — |
| TTL expires_at/review_at (Grok/GPT-6) | DIFFÉRÉ : colonnes = migration du schéma canonical (C1), hors chemins possédés ; liaison `review_at` encodable dès maintenant | `hygiene.ts` |

## Interfaces pour les autres lots

- **L3d (contrôleur, cron)** : appeler `runResearchPass(db, { passId: <idempotent par déclencheur>, cycleId })` ; traiter `halted` sans écriture ; consommer `listFindings(db, { cycleId, sinceSeq })` pour le backlog.
- **L3b (assembleur de contexte)** : consommer `archiveCandidates(db)` et `archiveFirstCompare` ; câbler l'incrément du compteur `uses` à la construction du paquet (aujourd'hui `uses` n'est incrémenté que par `recordRefute`) ; injecter les findings `archive_first` comme liste d'archivage prioritaire.
- **Digest /owner** : `listFindings(db, { kind })` borné (≤500), résumés internes non autoritaires.

## Suivis (hors incrément 1)

1. Colonnes TTL (`expires_at`/`review_at`) : migration du schéma canonical → décision C1/Kevin (divulgation hors chemins possédés).
2. Exécution de la consolidation via `memory.consolidate` (C4) pilotée par les findings.
3. Câblage du compteur d'utilité `uses` à la construction du paquet (L3b).
4. Injection de la liste archive-first dans le pipeline d'archivage (L3b).
5. `docs/code-map.md` : chemin partagé — mise à jour laissée à Kevin pour éviter les conflits entre lots parallèles.
