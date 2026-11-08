# CC8 — S7 prévalidation U1/U2/U3

Mandat S7-precheck-repair : GPT-6 owner, Vibe reviewer, Grok tester. Cible cc3-integration. Aucun pilote IA ni master.

## Constat
Vibe pilote #6 : expect utilisé sans import Vitest nommé, uuid non déclaré dans package.json, correction suivante sans diff.
L'ancien précheck imposait seulement un import générique Vitest, pas les fonctions ni les dépendances réellement utilisées.

## Correctif
- U1 : un test Vitest doit importer les fonctions appelées directement (expect, describe, it, test, vi, hooks) ; alias autorisés ; chaînes et commentaires masqués.
- U2 : imports externes des tests comparés aux dependencies, devDependencies, optionalDependencies, peerDependencies du package.json au SHA head. Imports locaux, node:, vitest et cloudflare:test exclus. Manifeste inaccessible = refus typé.
- U3 : après CI rouge, compare les contenus COMPLETS au SHA de tête ; si tous les fichiers proposés sont connus et bit-à-bit identiques, refus correction_no_diff avant effet GitHub. Une lecture inaccessible ne démontre pas de diff nul.

## Invariants
Refus dans guided_precheck (D1, clé déterministe, aucun commit) ; au plus une reformulation, puis guided_stop:precheck_failed.
HALT, fence, mandat, SHA head/blob, plafonds de temps/coût/jetons et garde D12 inchangés.
Tests test/collab-store/agentrun/cc8-s7-precheck-repair.spec.ts. CI 4/4 et revue Vibe / test Grok au couple exact avant fusion Kevin.
Aucun nouveau pilote, coût IA 0, aucune opération master.