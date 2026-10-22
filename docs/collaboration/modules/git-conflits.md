# Conflits de branche

Procédure détaillée. Le contexte principal cite ce module avant `github_resolve_conflicts`.

1. `github_get_merge_context` fixe head, base et ancêtre commun, et liste les chemins concernés.
2. Lire les TROIS versions de chaque fichier en conflit : base, branche de la PR, branche personnelle.
3. Préserver les interfaces des collaborateurs : ne jamais réécrire leur code ni leurs journaux.
4. Fournir tous les choix à `github_resolve_conflicts`, seulement avec l'écriture autorisée.
5. La base est reprise dans sa branche personnelle, pas la PR fusionnée vers la branche principale.
6. Refaire le diagnostic si un SHA change.

## Journaux append-only (AGENT_MEMORY.md, TOOL_IMPROVEMENTS.md)
Modifiés des deux côtés : version de la base (theirs) intacte au début, puis l'ajout de la branche (ours moins l'ancêtre) recopié à la suite.

## Impasse
Blocage sur chemins protégés ou journaux réécrits : arbitrage humain, sans contournement.
