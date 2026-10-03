# Changements de fichiers en lot

`github_apply_changes` regroupe des transformations déjà connues et les publie par au plus un appel à `WriteCoordinator.commitChanges`. Il complète les outils unitaires ; il ne remplace pas `github_commit_changes` pour l’écriture complète d’un fichier existant.

## Contrat V1

Un lot partage `repository`, `branch`, `expectedHeadSha`, `message` et `agentLabel`. Il contient 1 à 50 opérations : `replace`, `append`, `restore` ou `create`. Tous les `expectedSha` d’un même chemin désignent le blob **initial** lu au commit attendu. Plusieurs `replace`/`append` sur un même chemin sont appliqués dans l’ordre en mémoire. `restore` et `create` restent seuls sur leur chemin.

Le serveur vérifie branche, propriétaire et chemins avant les lectures, vérifie le head, lit chaque cible une fois, résout chaque `sourceRef` une fois et cache les restaurations par `(repository, commitSha, path)`. Seul un 404 est interprété comme une absence ; un refus, rate-limit ou échec serveur reste une erreur globale.

Les préconditions de chemins indépendants sont collectées. Après l’échec d’un chemin, ses opérations suivantes sont `not_evaluated`. Si une précondition échoue, `status=rejected`, `applied=false` et aucun appel au moteur d’écriture n’est effectué. Si l’état final est identique à l’état initial, `status=unchanged` et aucun commit n’est créé. Sinon les fichiers finaux sont transmis ensemble au coordinateur historique, qui répète les protections de taille, concurrence, chemins et journaux append-only.

## Budgets V1

- 50 opérations maximum ;
- JSON des opérations : 1 000 000 octets UTF-8 ;
- contenus distincts chargés : 2 000 000 octets ;
- contenu final de travail : 2 000 000 octets ;
- le coordinateur final conserve sa limite plus stricte de 1 000 000 octets cumulés publiés ;
- concurrence des lectures : 3.

Les erreurs globales (autorisation, réseau, budget, head périmé) utilisent l’enveloppe d’erreur MCP existante. Une réponse perdue après mutation conserve les garanties du coordinateur : ne jamais rejouer automatiquement ; relire la branche.

## Parcours agent recommandé

Quand plusieurs lectures et changements indépendants sont prévisibles : plan court → `github_read_files` → analyse → `github_apply_changes` → suivi CI au SHA produit. Ne pas forcer un lot lorsque les prochaines lectures dépendent réellement du résultat des précédentes.
