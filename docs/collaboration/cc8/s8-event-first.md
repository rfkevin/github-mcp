# CC8 S8 — exécution événementielle unique (8 novembre 2026)

Mandat Kevin : issue #247, rectificatif #6714594255. Cible : `mcp/105856986/cc3-integration` (jamais master).

## Incident live
`clarify.ask #1812` a créé `api-answer-d6ebfec0...` après 678 secondes. Le run a fini `completed/final` en 2 étapes, 4161 jetons, 0 payé, mais aucune `clarify.answer` correspondante n'était constatée. Cause du retard non prouvée.

## Sous-lot A : preuve métier avant completed
Les runs `answer/review/test/design` requièrent un effet D1 `completed` (`store_answer/store_verdict/store_contribute`) et l'événement réel au même `cycle_id`, auteur et `seq`. Vérifier `ask_seq` pour answer, `task` pour les autres, et le couple `head/base` du prompt serveur pour review/test. Un final textuel sans preuve se clôt `failed/incomplete_final:store_effect_missing`. Implement sous mandat GitHub S7 reste protégé par sa chaîne CI/PR ; implement hors mandat reste inchangé.

## Lots suivants : non inclus dans le sous-lot A
B — émission durable des réveils, bail 60 secondes et erreurs waitUntil tracés ; C — cron de 15 minutes MONITEUR UNIQUEMENT (jamais planification/exécution/modèle), incidents typés dédoublonnés ; D — validation live par type, coût payé zéro et D12. Les alarmes internes d'un run existant demeurent autorisées. Aucun essai Vibe #7, permission, modèle, budget, fusion ou master implicite.

Relecture Vibe et test Grok indépendants au même HEAD/BASE, CI4/4 avant décision Kevin.
