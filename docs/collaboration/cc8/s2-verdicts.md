# S2 — Verdicts D12 (ex-L14)

## Règle

Un verdict `evidence.add` du **relecteur** ou du **testeur** de la tâche (rôles
lus dans `tasks`, pas auto-proclamés) est lié uniquement au couple
`head` + `base` de la soumission courante de l’auteur.

- **Valide** tant que head et base sont identiques, **quel que soit l’ordre**
  (verdict avant ou après la soumission).
- **Périmé** seulement si head ou base a changé (nouvelle soumission à un
  autre SHA) → `renew_verdict` / `verdict-stale`.
- **Sans SHA** → `verdict-without-sha` (redépôt avec les SHA).

Implémentation : `bindsTo` dans `src/collab-store/controller/rules.ts`.
Extraction : `taskEvidence` dans `facts.ts` (seul owner = soumission PR ;
seuls reviewer/tester = verdicts).

## Changer un relecteur ou un testeur

Utiliser l’action owner **`reassign_task`** sur `/owner` (déjà exécutable).
Ne pas compter un avis hors rôle (`TASK_NOT_HELD` / participant hors
`roles.reviewer|tester` dans les faits). Après réattribution, le nouvel
titulaire dépose son verdict au couple courant.

## Critère d’acceptation (plan)

Scénario M2-like : AGREE (seq N) puis soumission auteur (seq N+1) au même
couple → `merge_ready` si les deux vérificateurs sont positifs au couple,
sans faux « périmé ».
