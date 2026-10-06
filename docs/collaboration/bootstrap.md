# Amorçage additif d'un projet (lot L3)

Objectif : donner à un dépôt les fichiers minimaux de collaboration (`AGENTS.md` pointeur, `AGENT_MEMORY.md`, registre d'installation) **sans jamais écraser** ce qui existe. Le moteur est un planificateur pur ([`src/collab/bootstrap.ts`](../../src/collab/bootstrap.ts)) ; l'écriture reste faite par `github_apply_changes` (aucun second moteur de commit, aucun nouveau scope OAuth, lecture Contents: Read seulement pour la prévisualisation).

## Procédure

1. **Prévisualiser** : `github_plan_project_bootstrap(repository, ref)` (lecture seule). La réponse donne `sha` (commit résolu), `status`, une entrée par fichier et, si `ready`, la liste `operations`.
2. **Appliquer** (si `ready` et écriture autorisée) : créer une branche de travail à partir de `sha`, puis `github_apply_changes` avec `expectedHeadSha = sha` et les `operations` telles quelles. Un fichier apparu entre-temps ou une branche déplacée fait échouer l'application : relancer la prévisualisation.
3. **Relancer** la prévisualisation sur la branche : le résultat attendu est `unchanged`.

## Règles

| Situation | Action | Effet |
|---|---|---|
| Fichier absent | `create` | créé depuis le modèle épinglé |
| Identique au modèle | `unchanged` | rien |
| Existant, compatible (`requiredPatterns` satisfaits) | `kept` | conservé, jamais écrasé |
| Existant, incompatible | `action_required` | **aucune** opération planifiée (tout ou rien) ; décision explicite du propriétaire |
| Registre absent (même si les modèles existent déjà) | `create` | `docs/collaboration/bootstrap-manifest.json`, sauf si un `action_required` bloque le plan |
| Registre différent | `action_required` | pas de mise à jour automatique |

Garde-fous : modèles épinglés par SHA-256 (`TEMPLATE_SHA_MISMATCH` si altéré) ; sources de dépôt épinglées sur un commit de 40 hex ; chemins cibles validés (`assertWritablePath`, fichiers sensibles refusés, chemin du registre réservé, doublons insensibles à la casse refusés) ; registre déterministe dérivé du seul manifeste.

## Exemples mesurés (planificateur, tests `test/collab/bootstrap.spec.ts`)

- Dépôt déjà équipé sans registre (github-mcp, project-mcp-collab) : modèles `kept` / `unchanged`, une seule création (le registre) ; une fois le registre en place, `unchanged` et zéro opération.
- Dépôt vide : `ready`, 3 créations (`AGENTS.md`, `AGENT_MEMORY.md`, registre).
- `AGENT_MEMORY.md` sans titre : `action_required`, zéro opération.

## Limites

- Le cycle réel prévisualisation → `github_apply_changes` → nouvelle prévisualisation n'a pas été éprouvé de bout en bout sur un dépôt réel ; seuls le planificateur et l'outil (avec lectures simulées) sont testés.
- La compatibilité d'un fichier existant est textuelle (`requiredPatterns`), pas sémantique.
- Les noms de contrat (`templateVersion`, schéma du registre) sont provisoires tant que le propriétaire ne les a pas figés.
