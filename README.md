# GitHub MCP personnel

Serveur MCP sur Cloudflare Workers, accessible depuis un client distant comme Claude sur téléphone. Connexion OAuth, utilisateurs autorisés explicitement et dépôts sélectionnés dans une GitHub App.

## Commencer

- [Réglages GitHub à effectuer, dans l’ordre](docs/github-settings.md)
- [Configuration du Worker et catalogue des outils](docs/setup.md)
- [Vérifications locales et activation optionnelle de run_checks](docs/checks.md)
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

Le code propose douze outils de lecture : dépôts, contexte, fichiers, recherche, différences, état CI et diagnostics. Deux outils supplémentaires permettent de lancer et suivre les vérifications, mais restent cachés sans configuration explicite et nouveau consentement `mcp:checks`.

Aucun outil MCP ne modifie le code, ne fusionne de PR ou ne déploie en production. La bibliothèque contient déjà des opérations d’écriture ; leur exposition sécurisée reste un lot distinct.

Ne jamais committer une clé privée, un jeton, `.env` ou `.dev.vars`. Les préversions doivent conserver leurs propres ressources et identifiants.
