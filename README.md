# GitHub MCP personnel (branche de test batch)

Serveur MCP sur Cloudflare Workers, accessible depuis un client distant comme Claude sur téléphone. Connexion OAuth, utilisateurs autorisés explicitement et dépôts sélectionnés dans une GitHub App.

## Commencer

- [Carte du code et des tests : chemins par domaine et points d’entrée](docs/code-map.md)
- [Mémoire des collaborateurs : conseils et journal signé à lire avant le travail](AGENT_MEMORY.md)
- [Retours centralisés : besoins du MCP, avis et propositions classées](TOOL_IMPROVEMENTS.md)
- [Démarche commune : discussion entre agents et intégration contrôlée](docs/team-workflow.md)
- [Réglages GitHub à effectuer, dans l’ordre](docs/github-settings.md)
- [Configuration du Worker et catalogue des outils](docs/setup.md)
- [Compatibilité MCP/OAuth, clients et diagnostic de découverte](docs/mcp-compatibility.md)
- [Vérifications locales et activation optionnelle de run_checks](docs/checks.md)
- [Écritures optionnelles : branches, commits et PR](docs/writes.md)
- [Travailler sur tous les dépôts avec le même MCP](docs/multi-repository.md)
- [Staging, approbation et publication en production](docs/deployments.md)
- [Bilan de l’audit et validations restantes](docs/audit-2026-09-30.md)
- [Architecture retenue et prochaines étapes](docs/agent-roadmap.md)
- [Bilan du lot et validations effectuées](docs/overnight-handoff.md)
- [Bibliothèque GitHub interne](docs/github-client.md)

## Vérifier sans déployer

Depuis la racine du dépôt, avec Node 24.19.0 :

```sh
npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
npm run check:quick
npm run check:full
```

`quick` contrôle les types et les tests. `full` ajoute une compilation Wrangler avec `--dry-run` : aucun déploiement.

## Capacités et limites

Le code propose dix-huit outils de lecture : dépôts, contexte, fichiers, recherche, différences, commits et leurs commentaires, état CI, diagnostics, suivi des PR et lecture des issues. `github_list_issues` et `github_get_issue` utilisent une permission GitHub App Issues: Read distincte ; son absence ne bloque pas les fichiers ou les PR. Le mode multi-dépôts ajoute trois outils : `github_prepare_checks`, `github_run_checks` et `github_get_agent_check_result`, avec activation globale et nouveau consentement `mcp:automation`. Le mode historique `mcp:checks` conserve ses deux outils de lancement et suivi.

Douze outils d’écriture sont disponibles dans le code mais cachés par défaut : `github_create_branch`, `github_commit_changes`, `github_apply_changes`, `github_replace_text`, `github_restore_file`, `github_append_file`, `github_create_issue`, `github_comment_issue`, `github_resolve_conflicts`, `github_open_pull_request`, `github_comment_pull_request` et `github_comment_commit`. Ils nécessitent `GITHUB_WRITES_ENABLED=true`, le consentement `mcp:write` et les permissions GitHub appropriées. Le remplacement, la restauration et l’ajout évitent de retransmettre un gros fichier. La création et le commentaire d’issue utilisent séparément Issues: Write ; la lecture conserve Issues: Read. Les dépôts accessibles restent ceux de l’installation GitHub, sans seconde liste locale.

L’utilisateur choisit le dépôt et la branche de départ ; l’agent crée une branche de travail liée à son identité et prépare une PR en brouillon vers la branche choisie. Il peut préparer un workflow de vérification encadré et un plan `.mcp/checks.json` adapté au projet, sans modifier le MCP pour chaque dépôt. L’activation initiale et l’essai distant restent à effectuer ; voir [le guide multi-dépôts](docs/multi-repository.md).

Une option distincte ajoute `github_merge_integration` : consentement `mcp:integration`, politique validée par le propriétaire dans le dépôt, CI réussie et accords déclarés des participants. Maximum : 33 outils avec toutes ces capacités. La fusion cible uniquement `integration`, jamais la branche principale ; aucun outil d’approbation GitHub, fermeture de PR ou publication directe n’est exposé. Voir [le protocole d’équipe et ses limites](docs/team-workflow.md). Un commit, une PR ou une intégration peut déclencher les automatisations existantes du dépôt. Le workflow de tests généré ne reçoit pas de secret de déploiement.

Ne jamais committer une clé privée, un jeton, `.env` ou `.dev.vars`. Les préversions doivent conserver leurs propres ressources et identifiants.

La chaîne de publication est prête dans le code : CI → paquet compilé → staging → approbation humaine → même paquet en production. Elle reste désactivée jusqu’à la configuration des environnements et de `RELEASE_PIPELINE_ENABLED`. L’autodéploiement Cloudflare existant doit être désactivé pour que l’approbation GitHub devienne le passage obligatoire.

Le diagnostic `github_get_merge_context` et l’écriture `github_resolve_conflicts` permettent de reprendre une base dans sa branche de travail, avec choix explicites des conflits et sans fusion de PR. Voir [le parcours de résolution](docs/conflict-resolution.md).
