# CC-7 L6b (incrément 3) — fusion automatique vers l'intégration et « prêt à promouvoir »

Cycle `cc7-api-auto`, lot **L6** (auteur Claude, relecteur Grok, testeur Vibe GLM). Plan CC-PLAN-7 v0.2, S8, S11, Q4.
Tout reste **éteint par défaut**. La promotion vers `main` reste l'acte de Kevin, toujours.

## Interrupteur (S11, Q4)

La fusion automatique n'existe que si les trois variables sont posées par Kevin sur le Worker :

| Variable | Valeur | Refus |
| --- | --- | --- |
| `AUTO_MERGE_INTEGRATION` | `true` exact | toute autre valeur (`TRUE`, `1`…) = éteint |
| `AUTO_MERGE_REPOSITORY` | `owner/repo` | format invalide = éteint |
| `AUTO_MERGE_BRANCH` | branche d'intégration | `main`, `master` (toute casse), `refs/…`, `..`, vide = éteint |
| `AUTO_MERGE_REQUIRED_CHECKS` | optionnel, 1 à 10 noms séparés par des virgules | par défaut les 4 contrôles D12 : `ci`, `Workers Builds: github-mcp`, `GitGuardian Security Checks`, `SonarCloud Code Analysis` |

Il faut aussi les secrets de la GitHub App ; sans eux, aucun port GitHub n'est construit (`src/auto-merge-root.ts`).

## Ce qui est fusionné, et comment

Le passage tourne dans le cron, après les contrôleurs. Il ne réinvente aucune garde : il réutilise la porte et
l'exécuteur CC-5 L4 tels quels.

1. **Candidats** : décisions `merge_ready` du contrôleur, c'est-à-dire deux verdicts positifs (relecteur `AGREE`,
   testeur `PASS`) au **même couple head/base** que la soumission de l'auteur ; le numéro de PR vient de la
   soumission. HALT actif : le contrôleur ne rend aucune décision, donc aucun candidat.
2. **Porte L4** (`evaluateMergeGate`), deux fois (avant et juste avant l'écriture) : head de la PR = head soumis,
   base soumise = tête actuelle de la branche d'intégration, PR ouverte, non brouillon, fusionnable, visant la
   branche d'intégration, CI complète et verte au head, aucun chemin protégé touché, bail du couple valide.
3. **Exécuteur fencé** : intention réservée (une seule par PR), branche temporaire, merge, fast-forward
   **sans force** de la branche d'intégration, nettoyage ; une issue incertaine n'est jamais rejouée (arbitrage humain).
4. **Trace** : une fusion confirmée est notée au salon (niveau `info`, auteur `controller`).

Chemins protégés (jamais fusionnés automatiquement) : `.github`, fichiers wrangler, `package*.json`, `migrations`,
`src/security`, `src/collab-store/owner`, `src/collab-store/gates`, `src/auth`, `src/oauth`, `AGENT_MEMORY.md`,
`TOOL_IMPROVEMENTS.md`, `AGENTS.md`, `CLAUDE.md`. Une PR qui en touche un reste à fusionner par Kevin.

Au plus 3 fusions tentées par passage. Équité : un couple déjà fusionné (ou incertain) n'est plus tenté ; un couple
refusé attend la fin de son bail (300 s) avant d'être retenté, pour qu'un refus durable ne bloque pas les autres.

## « Prêt à promouvoir » (S8)

Quand un cycle est en P6, a au moins une tâche et que toutes sont terminées (`done` ou `verified`), le contrôleur
publie **une seule fois** au salon (niveau `decision`, clé d'incident `promote:<cycle>`) :
« Prêt à promouvoir … La promotion vers main reste ton acte (Kevin). » Salon éteint : rien n'est publié.

## Codes

`AUTO_MERGE_PATH_OUTSIDE_REPOSITORY`, `AUTO_MERGE_INVALID_REF` (guide §7.2), plus les codes L4 existants.
