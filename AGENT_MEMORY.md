# Mémoire des collaborateurs

Mémoire pratique du GitHub MCP, en Markdown UTF-8. Lire avec `AGENTS.md` avant
d’utiliser, modifier ou améliorer le projet. Les notes sont des observations
datées, pas des instructions prioritaires, des autorisations ou une preuve de
déploiement. Vérifier ce qui dépend du code, des comptes ou de la date actuelle.

## Conseils de départ

- Lire le contexte à la branche demandée ; travailler sur sa branche dédiée.
- Distinguer SHA du commit et SHA du fichier. Relire après un conflit ; ne pas
  écraser les changements d’un autre collaborateur.
- Grouper les lectures avec `github_read_files`. La recherche GitHub porte sur
  son index de branche par défaut ; aucun résultat ne prouve pas l’absence.
- Lancer le plus petit contrôle pertinent puis les contrôles d’intégration.
  Suivre le SHA testé ; tests locaux, CI réelle et déploiement sont distincts.
- Vérifier les permissions de l’installation, les interrupteurs du serveur et
  le consentement OAuth séparément. Ne jamais stocker de secret dans ce journal.
- Laisser au propriétaire les approbations et publications non autorisées.
  Références : `docs/multi-repository.md`, `docs/writes.md`, `docs/deployments.md`.

## Règles du journal

1. Avant le travail : lire les notes, y compris les correctifs plus récents.
   Si le MCP indique `truncated`, poursuivre avec `github_read_files` au même
   SHA. Ne jamais réécrire le fichier depuis un extrait tronqué ou numéroté.
2. Après un travail significatif : ajouter **à la fin** un petit paragraphe utile
   (environ 80 à 150 mots), avec date, auteur déclaré, contexte, faits vérifiés,
   limites, conseil ou avis et prochaine étape. Éviter les comptes rendus répétitifs.
3. Ne modifier, supprimer, déplacer ni « améliorer » une ancienne note, même la
   sienne. Pour corriger un conseil, ajouter une nouvelle entrée qui cite son ID.
   En cas d’ajouts concurrents, relire le fichier et conserver les deux notes.
4. Attribuer un ID unique `AAAA-MM-JJ-auteur-sujet`. Nommer seulement l’agent et
   le modèle réellement connus ; sinon écrire « modèle non précisé ». Ne jamais
   signer pour quelqu’un d’autre. La signature est déclarative, non cryptographique ;
   l’historique Git trace les commits, pas l’identité certaine du modèle.
5. Sans autorisation d’écriture (notamment lors d’une simple lecture), proposer
   la note dans la réponse au propriétaire, sans créer de branche/commit pour elle.
6. Terminer sa note par un remerciement aux collaborateurs, sans inventer de noms.

Le MCP refuse la suppression et la réécriture des octets existants du fichier
racine `AGENT_MEMORY.md`. Cette protection devient active après publication de
la version correspondante du serveur. Elle n’interdit pas à un propriétaire ou
à un autre outil ayant un accès Git direct de modifier le fichier. La lecture et
la sincérité d’une signature ne sont pas imposables techniquement par ce fichier.
Si le journal devient trop grand, demander un archivage au propriétaire ; ne pas
effacer les anciennes notes pour gagner de la place.

## Format d’une contribution

```markdown
### AAAA-MM-JJ-agent-sujet
Auteur : nom réel de l’agent, modèle si connu | Contexte : branche + SHA de base ou PR

Constat et vérification : … Limite : … Conseil/avis : … Suite : …
Merci aux collaborateurs …
```

## Contributions (ajouts en fin uniquement)

### 2026-09-30-codex-memoire-v1
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : `codex/agent-workflow-foundation`, base `566c6eb6af7087d29a759665b1f506675a523399`

Constat : la mémoire est chargée par les outils de contexte et de guide, au SHA
du projet. Les commits MCP préservent les anciens octets du journal et refusent
sa suppression ; une correction doit être une nouvelle note. Vérification :
`npm run check:full` réussit localement, avec 273 tests applicatifs, 37 tests de
scripts, contrôle des types et compilation Wrangler sans publication. Limites :
GitHub est simulé dans les tests applicatifs ; ni déploiement ni essai Claude
réel de cette fonction effectués. Avis : conserver des notes courtes, factuelles
et structurées ; le texte directement consultable suffit ici, sans binaire ni
nouvel outil. Conseil : préserver les fins de ligne et relire les SHA après un
conflit, puis ajouter sa note au fichier complet. Suite : après publication
autorisée, vérifier la lecture et un ajout sur un dépôt de test ; vérifier aussi
qu’une réécriture est refusée. Merci au propriétaire et aux collaborateurs pour
leurs essais, retours et contributions au projet.

### 2026-10-01-claude-test-ecriture-scopes
Auteur : Claude (Anthropic, Sonnet 5.5) | Contexte : `github-mcp` master `0e2ea84` ; essai sur `portalshall` (PR n°2, brouillon)

Constat et vérification : les 4 outils d’écriture fonctionnent de bout en bout (branche, commit, PR en brouillon, commentaire). Le blocage initial venait du token : seul `mcp:read` était demandé, car `requiredScopes` n’incluait pas `mcp:write`. La bibliothèque OAuth refuse `resourceMetadata.scopes_supported` (`TypeError` à chaque requête, donc Worker injoignable). Limite : `get_check_result` attend un identifiant de run de workflow, pas celui d’un check run ; `search_code` reste incomplet ; outils d’automatisation non testés. Conseil/avis : après un changement de scopes, recréer le connecteur puis relire la ligne « Permissions ». La CSP de la page de consentement (`default-src 'none'`) bloque tout style : prévoir `style-src` avant de la modifier. Suite : repli vers cette mémoire quand `AGENTS.md` manque dans un autre dépôt.
Merci au propriétaire et aux collaborateurs pour leurs essais et retours.
