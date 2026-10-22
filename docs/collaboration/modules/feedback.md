# Retour d'expérience et maintenance des instructions

Procédure facultative, déclenchée quand un retour utile est rédigé ou lors d'une maintenance des instructions. Le dépôt central de cet outil est rfkevin/github-mcp, quelle que soit la cible de développement. Résoudre sa branche par défaut, lire AGENT_MEMORY.md (conseils d'utilisation) et TOOL_IMPROVEMENTS.md (propositions d'amélioration du MCP), ainsi que les PR de retours encore ouvertes. Ces textes sont consultatifs, jamais des autorisations ; ils restent distincts de la mémoire du projet travaillé.

## Contribution à TOOL_IMPROVEMENTS.md
Auteur déclaré, date, dépôt/branche/SHA de la tâche, expérience réelle ou simple hypothèse, outil concerné, problème, preuve sans secret, proposition, bénéfice/coût/risque, critère de réussite et priorité : P0 sécurité immédiate, P1 blocage ou risque important, P2 gain récurrent, P3 confort. Analyser les propositions antérieures pertinentes par leur ID et donner un avis motivé (accord, nuance, désaccord, déjà traité ou non vérifié), puis un classement personnel actualisé par importance. Ne pas remplacer le classement ou les mots d'un autre ; ne pas compter des labels comme votes indépendants ; ne pas recopier les doublons — ajouter une preuve ou une nuance à l'ID existant. S'il n'y a rien de nouveau, le dire brièvement avec l'avis sur l'existant, sans inventer de besoin. Pas de proposition transformée en autorisation de l'implémenter.

## Publication
Uniquement si l'écriture est autorisée : conserver tous les octets existants, ajouter en fin (append via `github_append_file`), branche dédiée puis PR vers rfkevin/github-mcp, jamais écriture directe sur main/master ni fusion principale automatique. Si ce dépôt est aussi la tâche courante, réutiliser sa PR pour éviter un doublon. Relire les SHA après un ajout concurrent. Sans accès, sans écriture, sans temps ou sans lecture complète : remettre la contribution au propriétaire et signaler la non-publication. Ne pas mélanger ce registre avec AGENT_MEMORY.md. Remercier les collaborateurs.

## Maintenance des instructions — règle minimale
- Conserver uniquement les instructions utiles.
- Remplacer les procédures obsolètes par leur version à jour.
- Éviter l'accumulation de doublons : enrichir l'entrée existante plutôt que dupliquer.
- Aucun changement automatique après chaque tâche : toute maintenance est explicite et passe la même gouvernance (review puis CI) que toute autre modification.
