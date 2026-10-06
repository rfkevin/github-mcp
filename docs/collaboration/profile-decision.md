# Décision G4 : profil de catalogue optionnel

**Décision : garder le catalogue existant, avec des consignes compactes et un guide.** Aucun filtrage de catalogue n'est implémenté. La participation (rejoindre, reprendre, publier, s'arrêter) fonctionne sans profil : voir [usage.md](usage.md).

## Mesures (octets sérialisés de `tools/list`, version `015f432`, fixture OAuth du dépôt)

| Mesure | Lecture seule (`mcp:read`) | Toutes capacités (`read`, `write`, `automation`, `integration`) |
| --- | --- | --- |
| Outils exposés | 24 | 40 |
| Réponse `tools/list` complète | 53 029 B | 93 272 B |
| dont descriptions / schémas d'entrée / schémas de sortie | 8 164 / 8 016 / 29 622 B | 14 856 / 21 133 / 44 930 B |
| Consignes d'initialisation (`WORKFLOW_INSTRUCTIONS`) | 6 585 B | 6 585 B |

Plus gros outils : `github_collab_context` 5 674 B (dont 3 562 B de schéma de sortie), `github_get_project_context` 4 361 B, `github_ci_status` 4 317 B.

Parcours de participation (sept outils : `github_collab_context`, `github_get_discussion_delta`, `github_get_issue_comment`, `github_read_files`, `github_plan_project_bootstrap`, `github_ci_status`, `github_apply_changes`) : 24 183 B, soit 25,9 % du catalogue complet. C'est une **borne haute théorique** de ce qu'un profil pourrait retirer de la liste, pas un gain observé.

## Pourquoi on ne l'implémente pas maintenant

- **Gain non démontré.** Aucune mesure de client réel : on ne sait pas si chaque client charge toute la liste dans le contexte du modèle ou la diffère. Les octets ci-dessus sont ceux du serveur, pas une économie de jetons ni de latence (aucune surface de mesure du temps n'existe).
- **Risque de découvrabilité.** Un outil caché est un outil qu'un agent ne sait pas appeler. Un profil devrait garder une route complète découvrable et les mêmes contrôles de capacités ; le catalogue actuel est déjà filtré par capacités accordées.
- **Pas une permission.** Masquer un outil ne retire aucun droit. Aucun texte ne doit présenter un outil masqué comme « révoqué ».
- **Deux clients observés ?** Non : aucune exécution multi-clients n'est disponible dans cette session. Comportement de profil sur client non pris en charge : **not_tested**.

## Ce qui est livré à la place

- Un renvoi court dans les consignes d'initialisation vers `github_collab_context` et ce guide (environ 0,4 Ko).
- [usage.md](usage.md) et [troubleshooting.md](troubleshooting.md) ; une route recommandée unique par rôle.
- Un test qui vérifie que chaque chemin et chaque outil cités existent (`test/collab/guide.spec.ts`).

## Critère pour rouvrir la décision

Implémenter un profil **optionnel et désactivé par défaut** seulement si un essai apparié sur au moins deux clients montre : moins d'appels ou de jetons chargés au démarrage, sans perte de découvrabilité, avec les mêmes portées serveur et le comportement historique inchangé par défaut. Mesure à répéter avec le même script de `tools/list` sur chaque client et à consigner ici (`not_tested` tant qu'elle n'a pas eu lieu).
