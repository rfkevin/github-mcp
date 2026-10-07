# CC-3 C0 — rejeu sur une vraie base D1 (cloud)

Auteur : Claude · Relecteur : Grok · Testeur : Kevin (exécution) · Plan : CC-PLAN-3/v1.1, tâche K4 / C0 cloud

Ce rejeu exécute **les mêmes scénarios S1 à S6** que le gate local (`docs/collaboration/cc3/c0-gate.md`), mais les deux bases D1 sont de vraies bases Cloudflare, accessibles à distance. Le verdict « GO D1 » devient définitif seulement si cette exécution est entièrement verte.

## Ce que ce test mesure, et ce qu'il ne mesure pas

- Il prouve le comportement réel de D1 : atomicité de `batch()`, contrainte `UNIQUE`, CAS, reprise après erreur, export puis réimport.
- Les durées (p50/p95) incluent le trajet réseau entre la machine qui lance le test et Cloudflare. Elles ne représentent **pas** la latence d'un Worker déployé à côté de D1, qui sera mesurée plus tard avec C2 sur `cc3-test`. Elles servent d'ordre de grandeur pessimiste.

## Bases utilisées : des bases jetables

Le test **supprime et recrée** les tables du prototype au début de chaque fichier de test. Il utilise donc deux bases dédiées, jamais la base `github-mcp-cc3-test` du produit :

| Binding | Nom de la base |
| --- | --- |
| `COLLAB_DB` | `github-mcp-cc3-c0` |
| `COLLAB_DB_RESTORE` | `github-mcp-cc3-c0-restore` |

Les identifiants de ces bases ne sont pas des secrets. Ils sont dans `test/collab-store/c0/wrangler.cloud.jsonc`.

## Étapes pour Kevin (PowerShell, dans le dossier du dépôt)

1. Se placer sur la branche du rejeu et installer les dépendances :
   `git fetch` puis `git checkout mcp/105856986/claude-cc3-c0-cloud` puis `npm ci`
2. Se connecter à Cloudflare si besoin : `npx wrangler login`
3. Créer les deux bases (une seule fois) :
   `npx wrangler d1 create github-mcp-cc3-c0`
   `npx wrangler d1 create github-mcp-cc3-c0-restore`
   Envoyer à Claude les deux `database_id` affichés. Claude les écrit dans le fichier de configuration.
4. Récupérer la mise à jour de la branche, puis lancer le test :
   `git pull` puis `npm run test:c0-cloud`
5. Envoyer à Claude la fin de la sortie (les lignes `C0_METRIC`, `Test Files`, `Tests`). Elle ne contient aucun secret.

Durée attendue : quelques minutes, car chaque requête traverse le réseau.

## Lecture du résultat

- **Tout vert** : GO D1 définitif. Claude met à jour `c0-gate.md` et l'état du plan ; C2 peut démarrer.
- **Échec** : le plan prévoit le repli (Postgres). Claude analyse d'abord l'échec : un problème du harnais ne vaut pas un NO-GO de D1.

## Nettoyage

Les deux bases sont jetables. Après acceptation du gate, Kevin peut les supprimer (`npx wrangler d1 delete <nom>`) ; elles ne servent plus.
