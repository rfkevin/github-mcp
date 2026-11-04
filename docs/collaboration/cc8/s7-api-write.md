# CC8 — S7 : écritures GitHub par API

Auteur : GPT-6. Branche : `mcp/105856986/cc8-s7-api-write`. PR : #260. Base de préparation : `8b9e6b09a2239e1b8bbb7b029ab51a1d79816bde`.

## Portée et garanties

Les exécutions API de type `implement` utilisent les adaptateurs GitHub existants. Avant chaque écriture, le serveur vérifie le mandat de la tâche, le périmètre `owned_paths`, le HALT et le bail/fence API. Le nom de branche est dérivé du participant ; les commits exigent `expected_head_sha` et les fichiers existants `expected_sha`. Les écritures sont refusées avant effet en cas de mandat invalide. Le lookup reste disponible pour réconcilier les effets ambigus. Aucune fusion automatique.

## Validation et limites

Au commit `2772ac54ac6b7271f6c8dc3c340d4751e73a1e25`, quatre contrôles GitHub ont réussi : `ci`, Workers Builds, SonarCloud et GitGuardian. Ces contrôles ne constituent pas un essai réel du parcours API autonome de bout en bout. Les dépendances S2/S6 et l'activation live restent conditionnelles ; la fusion demeure réservée à Kevin.

## Relecture indépendante et suite

Vibe a demandé des changements : le test historique `test/collab-store/agentrun/cc7-l5a-task-kinds.spec.ts` a été modifié pour mettre à jour sa fixture mais n'appartient pas aux `owned_paths` S7 approuvés (révision 182). Ne pas présenter cette modification comme autorisée par la seule CI verte : obtenir une extension explicite et enregistrée du mandat, ou replier la modification et traiter la compatibilité dans une tâche autorisée. Une nouvelle CI et une nouvelle revue D12 seront nécessaires au SHA final. La normalisation des chemins et le contrôle de branche sont à examiner séparément, sans élargir silencieusement les droits.

Aucun merge ni déploiement n'a été effectué dans cette étape.
