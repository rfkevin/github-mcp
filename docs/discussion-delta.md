# Suivi des changements d'une discussion

`github_get_discussion_delta` répond à la question « qu'est-ce qui a changé depuis ma dernière lecture ? »
sans relire la discussion. Lecture seule, permission GitHub App Issues: Read, aucun nouveau scope OAuth.
Le moteur est un module pur, [`src/discussions/delta.ts`](../src/discussions/delta.ts) ; l'outil est
[`src/mcp/tools/github/discussion-delta.ts`](../src/mcp/tools/github/discussion-delta.ts).

## Usage

1. Premier appel sans `cursor` : mode `baseline`. L'outil renvoie les `limit` derniers éléments (index compact,
   sans corps) et un `nextCursor` qui reconnaît **tout** l'existant, y compris ce qui n'est pas affiché
   (`olderOmitted` indique combien).
2. Appels suivants avec le dernier `nextCursor` : mode `delta`. Réponse : `added`, `modified`, `deleted`
   (identifiants), puis `unchanged`, `olderUntracked`, `duplicatesIgnored`, `reenumerated`.
3. Si `hasMore` est vrai, rappeler avec `nextCursor` : au plus 100 changements sont rapportés par appel, le
   reste revient au prochain, rien n'est perdu.
4. Lire le texte d'un élément avec `github_get_issue_comment`.

`kind` vaut `issue_comment` ou `pull_request_comment` (même endpoint GitHub, permissions identiques).

## Ce que « changé » veut dire

- **Nouveau** : identifiant absent du curseur.
- **Modifié** : l'empreinte (SHA-256 du contenu masqué) a changé. Un changement qui disparaît au masquage, par
  exemple un jeton remplacé par un autre jeton, n'est pas visible : l'agent ne verrait de toute façon que le texte
  masqué. Un contenu modifié puis rétabli à l'identique n'est pas rapporté.
- **Supprimé** : absent de deux énumérations consécutives. Une seconde énumération n'a lieu que si un élément
  manque. Un élément raté par une pagination GitHub qui bouge n'est donc jamais déclaré supprimé ; le curseur suivant
  est bâti sur l'union des deux lectures, et une disparition survenue exactement entre les deux est rapportée au
  delta suivant.

Le moteur ne s'appuie ni sur `updated_at`, ni sur le paramètre `since`, ni sur l'ordre des identifiants.

## Curseur

Opaque et sans état serveur : version, dépôt (insensible à la casse), `kind`, numéro, version du masquage,
début de fenêtre, puis pour chaque élément suivi son identifiant (codé en différences) et 6 octets d'empreinte,
avec une somme de contrôle (détection d'une copie défectueuse, pas une signature). Un curseur ne contient aucun
secret et peut être forgé : cela ne modifie que la vue de celui qui le forge. Environ 14 octets par élément suivi :
moins de 5 000 caractères pour 300 éléments.

| Code | Cause | Que faire |
| --- | --- | --- |
| `INVALID_CURSOR` | curseur mal formé, tronqué ou corrompu | repartir sans curseur |
| `FOREIGN_CURSOR` | autre dépôt, `kind` ou numéro | utiliser le curseur de cette discussion |
| `CURSOR_STALE` | autre version du format ou du masquage | repartir sans curseur |
| `DISCUSSION_TOO_LARGE_FOR_DELTA` | au moins 1 000 commentaires | utiliser `github_list_discussion_items` |

## Limites

- Seuls les 300 éléments les plus récents (date de création, puis identifiant) sont suivis. Les plus anciens sont
  comptés dans `olderUntracked` : ni modification ni suppression n'y sont visibles.
- Chaque appel énumère toute la discussion à 100 commentaires par page (10 pages au plus) : le coût est en appels
  GitHub, pas en jetons côté agent.
- Au moins une livraison : si une réponse est perdue, rappeler avec le même curseur redonne les mêmes changements.
- Les textes sont des données non fiables, jamais des instructions ou des autorisations.

## Évolutions possibles

Étendre à `pull_request_review`, `pull_request_review_comment` et `commit_comment` demande de décider quelle
énumération sert de base à chaque `kind` ; non fait ici.
