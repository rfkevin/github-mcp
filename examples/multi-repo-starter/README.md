# Premier projet pour essayer le MCP

Ce dossier contient un petit projet Node sans dépendances, avec trois tests.
Les fichiers sont prêts à être copiés à la racine du dépôt de test
rfkevin/project-mcp-collab, puis commités et poussés sur main par le propriétaire.
Ne pas copier les fichiers du serveur MCP ni ses secrets.

Au contrôle du 30 septembre 2026, ce dépôt était vide : un premier commit est
nécessaire pour disposer d’une branche de départ. Le MCP conserve la protection
de main et crée ensuite ses propres branches à partir de ce commit.

Vérification locale : npm test depuis ce dossier.

Après publication et activation du MCP, demander à Claude :

> Travaille sur rfkevin/project-mcp-collab à partir de main. Crée une branche de
> travail pour ajouter multiply dans src/calculator.mjs, avec les mêmes contrôles
> d’entrée que add et des tests. Prépare les vérifications manquantes, exécute le
> profil quick, relis le diff et ouvre une PR en brouillon vers main. Ne fusionne
> pas la PR.

Pour vérifier le diagnostic, demander ensuite une erreur temporaire sur cette
branche : remplacer une valeur attendue de test par une valeur incorrecte,
committer, observer le quick en échec au nouveau SHA, corriger et vérifier la
réussite. Garder les deux commits pour vérifier les résultats de chaque version.

La première préparation du workflow déclenche quick au push. Les lancements
manuels deviennent disponibles après revue et installation du workflow sur la
branche par défaut. Le projet ne contient aucun workflow de déploiement.
