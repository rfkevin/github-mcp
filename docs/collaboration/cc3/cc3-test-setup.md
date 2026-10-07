# CC-3 — environnement `cc3-test` (opération K3)

Plan : [CC-PLAN-3/v1.1](https://github.com/rfkevin/project-mcp-collab/issues/25) · Préparé par Claude · Exécution : Kevin (propriétaire)
Base : `cc3-integration` @ `30b3168`.

Ce document décrit comment créer le Worker de test `github-mcp-cc3-test`, avec son KV OAuth et sa base D1 `COLLAB_DB`. Il sert à rejouer C0 sur une vraie D1 puis à tester C2. Rien ici ne touche `master`, la production ou le Worker `github-mcp`.

## Ce que cette préparation contient

| Fichier | Rôle |
| --- | --- |
| `wrangler.jsonc`, bloc `env.cc3-test` | Nom du Worker, KV OAuth séparé, base D1 `COLLAB_DB`, mêmes variables que `cc2-test`. Les deux identifiants sont des **marqueurs à remplacer** (`REPLACE_WITH_CC3_TEST_KV_ID`, `REPLACE_WITH_CC3_TEST_D1_ID`). |
| `deploy-cc3-test.yml` (**fourni à part, étape 8**) | Même principe que `deploy-cc2-test` : sur un push de `mcp/105856986/cc3-integration` (ou lancement manuel), `check:full`, puis `wrangler deploy --env cc3-test`, puis sondes `/ready` et découverte OAuth. Aucune exécution depuis une autre branche. Les fichiers GitHub Actions sont protégés pour le MCP : je ne peux pas le publier moi-même. |

Le bloc D1 n'est lu par aucun code avant C2 : la liaison existe, mais personne ne s'en sert encore. `GITHUB_AUTOMATION_ENABLED` reste à `false`.

## Étapes pour Kevin

1. **Créer le KV OAuth** de test (nom conseillé : `github-mcp-cc3-test-oauth`), par le tableau de bord Cloudflare ou `npx wrangler kv namespace create`. Ne jamais réutiliser le KV de production ni celui de `cc2-test`. Noter son identifiant.
2. **Créer la base D1** `github-mcp-cc3-test`, par le tableau de bord ou `npx wrangler d1 create github-mcp-cc3-test`. Noter son `database_id`.
3. **Me transmettre les deux identifiants** dans la conversation (ce ne sont pas des secrets). Je remplace les marqueurs dans `wrangler.jsonc`, je pousse, puis je suis la CI au SHA exact.
4. **Créer l'environnement GitHub `cc3-test`** (dépôt `github-mcp`, Settings → Environments) avec :
   - le secret `CLOUDFLARE_API_TOKEN` : un jeton distinct de celui de production, limité au compte, avec le droit de publier des Workers. Le droit sur D1 ne sert que plus tard, pour appliquer des migrations : à confirmer au moment de C2 ;
   - la variable `CF_ACCOUNT_ID` : l'identifiant de compte déjà présent dans `wrangler.jsonc`.
5. **Ajouter le callback OAuth de test** dans la GitHub App : `https://github-mcp-cc3-test.rfahedkevin.workers.dev/callback` (origine publique suivie de `/callback`). Garder les callbacks existants.
6. **Installer les deux secrets d'exécution** sur le Worker de test, directement chez Cloudflare, sans les écrire dans un chat, un fichier ou Git : `GITHUB_PRIVATE_KEY` (format PKCS#8) et `GITHUB_OAUTH_CLIENT_SECRET`, avec `npx wrangler secret put <NOM> --env cc3-test`. Ils doivent exister avant la première sonde `/ready`. Si la commande propose de créer le Worker, accepte.
7. **Fusionner la PR de préparation** vers `cc3-integration`, seulement **après** l'étape 3 : tant que les marqueurs sont en place, le déploiement échoue.
8. **Ajouter le workflow de déploiement.** Ajoute toi-même le fichier `deploy-cc3-test.yml` que je te remets dans `.github/workflows/` de la branche `mcp/105856986/cc3-integration` (interface GitHub : Add file → Create new file, commit direct sur cette branche). Ce commit déclenche le premier déploiement.
9. **Vérifier** que `https://github-mcp-cc3-test.rfahedkevin.workers.dev/ready` répond, et que la CI du résultat est verte.

## Ensuite : K5 (`run_checks`)

Une fois le Worker en ligne, suivre « Activer le lancement MCP » dans [`docs/checks.md`](../checks.md) : variable non secrète `GITHUB_CHECKS_CONFIG` (dépôt, branche et SHA du contrôleur), redéploiement, nouveau consentement avec `mcp:read mcp:checks offline_access`. Le choix de la branche et du SHA du contrôleur se fixe avec Vibe GLM (guide T0). Cette variable n'est volontairement pas ajoutée ici.

## Ce que cette préparation ne fait pas

- Elle n'applique aucune migration et ne crée aucune table : le schéma final vient de C1, son application de C2.
- Elle ne déploie rien par elle-même et ne modifie pas le Worker de production.
- La rejouée cloud de C0 (S1 à S6 sur la vraie D1) demande un harnais de test, à décider avec le relecteur Grok ; elle n'est pas dans cette PR.
