# Dépannage d'un cycle CC-2

Règle générale : une lecture manquante ou une confirmation perdue n'est jamais une preuve d'absence. Relire avant de réécrire, et signaler l'inconnu (`unknown`, `not_tested`) plutôt que de le déclarer réussi.

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| `404` ou « not found » sur une source | mauvaise `ref`, chemin faux ou dépôt non autorisé | Vérifier `ref` avec `github_get_commit`, le chemin avec `github_list_directory`, puis le dépôt avec `github_list_repositories`. Un dépôt absent de la liste est un droit refusé, pas une erreur de chemin. |
| Outil d'écriture absent ou refusé | capacité non accordée à cette connexion | Le dire ; ne pas contourner. Remettre le contenu prêt au propriétaire. |
| `cycle.stale = true` | une révision plus récente du propriétaire existe | Relire l'état, reprendre `nextAction` ; ne rien publier sur l'ancienne révision. |
| `coverage.partial` non vide | lecture tronquée | Continuer avec `continuation` (offset + révision) ; ne pas annoncer « tout lu » tant que `unread` n'est pas vide. |
| `coverage.toReread` contient d'anciens identifiants | commentaire édité après lecture | Relire ces identifiants ; l'empreinte a changé. |
| `rescanRequired` | une source suivie a disparu (suppression ou accès perdu) | Relire l'index de la discussion ; la suppression n'est pas détectable autrement (`deletionTrackingLimitation`). |
| `checkpoint` refusé ou ignoré | client qui tronque la valeur, ou portée différente (`scopeMatch=false`) | Reprendre sans checkpoint : tout est relu, ce qui est plus lent mais sûr. |
| Réponse d'écriture perdue | coupure après envoi | Ne pas rejouer. Relire la cible (liste des commentaires ou commit attendu), chercher l'identifiant d'opération et l'empreinte (`receipts.ts`, `reconcile.ts`). Introuvable ne veut pas dire non écrit : sortir `unknown` et demander au propriétaire. |
| Écriture en échec partiel | plusieurs étapes, une seule appliquée | Conserver ce qui a réussi, ne pas rejouer l'étape appliquée, marquer les suivantes `pending`. |
| Publication de mémoire en attente | décision prise, écriture Git non faite | La décision reste `accepted` avec `publication: pending` ; rien n'est « effectif » avant la preuve d'écriture ([memory.md](memory.md)). |
| `MEMORY_APPEND_ONLY` ou chemin protégé | journal partagé modifié en parallèle | Se rebaser depuis la branche d'intégration à jour et ne faire que des ajouts ; ne pas réécrire l'historique. |
| Participant absent | indisponibilité | Écrire un point de reprise concret (lot, branche, SHA, prochaine action) ; proposer un remplaçant avec rôles distincts ; ne jamais signer ni approuver à sa place. |

Après tout changement de head ou de base : renouveler les revues et refaire suivre la CI au SHA exact avant de conclure.
