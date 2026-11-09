# CC8 — Mandats GitHub dynamiques sans PR pour chaque tâche (S7)

## Pourquoi
La PR #298 a mis en évidence une limite de la configuration actuelle : chaque nouveau grant exact dans `AGENT_RUN_GITHUB_TASKS` exigeait une PR et un déploiement. Désormais le coordinateur habilité peut émettre un grant **dans D1**, sous une politique owner approuvée une seule fois. Les grants historiques restent compatibles.

## Politique owner de périmètre
`AGENT_RUN_DYNAMIC_SCOPE` (absent = refus) définit un cycle, les participants autorisés, les préfixes de chemins, `max_paths` et `max_grants`. Pour `cc3-test` : uniquement Gemini et Vibe, fichiers sous `test/collab-store/agentrun/`, un fichier par tâche, 30 tâches au total. Les préfixes dangereux et fichiers protégés sont refusés. Les barrières HALT, D12, coût payé 0, modèle/agent, GitHub App et fencing demeurent. Une modification des limites reste un acte owner explicite, non délégué.

## Lancement automatique
Le coordinateur appelle `collab_launch_implement` avec `cycle`, `task`, `participant`, `reviewer`, `tester`, `paths`, éventuellement `acceptance`, `op_id`, et `takeover_chat`. Le serveur exige le coordinateur owner-approved, un agent autorisé et gratuit, et des personnes D12 distinctes. Il crée un grant D1 immuable `{cycle,task,participant,branch,paths,acceptance,created_by,expires_at}`, avec une branche déterministe basée sur SHA-256 du cycle et de la tâche. Il crée ou réutilise la tâche puis lance le Durable Object ; plusieurs appels sont possibles sans attendre la fin du premier run.

À chaque écriture GitHub, le moteur relit le grant D1, sa durée de validité (48 h), les chemins, la politique owner actuelle et `tasks.owned_paths`. Un rejeu strictement identique retrouve la même autorisation ; tenter d'élargir les chemins ou de modifier l'acceptation est un conflit. Retirer la politique désactive les grants D1 précédemment émis sans effacer leur audit.

Le nouveau modèle de tâche conserve la phase consultant obligatoire : lectures prouvées de `store_context`, `store_delta`, `store_memory`, `store_continuity` et du code source avant le premier commit ; ensuite CI, PR **de code** et passation `store_handover` chat/API. La PR de code n'est pas supprimée : elle garde sa relecture D12 et sa fusion owner.

## Sécurité et vérifications
Le grant est issu du seul outil MCP authentifié du coordinateur, non d'une sortie libre du modèle. Table D1 append-only, branche sous `mcp/105856986/<participant>-api-`, pas de main/master, aucun merge, aucun nouveau modèle payant. Statuts S7 et gardes owner inchangés. Les tests couvrent politique invalide/absente, TTL, immuabilité D1, chemins hors périmètre, coordinateur révoqué, scopes exacts et deux runs parallèles.

## Déploiement
CI4/4, revue Vibe + tests Grok D12, fusion par Kevin seulement vers `cc3-integration`, puis déploiement `cc3-test`. La connexion MCP doit être rafraîchie pour exposer les nouveaux paramètres de `collab_launch_implement`. Après cette fusion, la PR #298 (grants exacts supplémentaires) est redondante ; ne pas la fusionner. Aucun reset D1 ni déploiement master.


## Diagnostic des refus et identité du coordinateur

Le contrôle de lancement, l'INSERT atomique du grant et chaque relecture utilisent désormais la même famille d'identité approuvée par le propriétaire. `created_by` conserve l'identité authentifiée, sans réécriture des historiques. Révoquer le mandat actif de la famille retire aussi les grants issus de ses alias.

Un refus déterministe remonte par MCP avec `GITHUB_GRANT_REFUSED`, `retryable=false` et une raison bornée : `dynamic_grant_cap_exhausted` (plafond cumulatif, inchangé), `dynamic_grant_conflict` (intention immuable incompatible), `dynamic_grant_expired` (pas de renouvellement implicite), `dynamic_cycle_not_open`, `dynamic_coordinator_not_active`, `dynamic_branch_conflict` ou `dynamic_grant_insert_refused` (aucune insertion confirmée). Les autres refus de politique restent explicites. Une vraie exception de stockage reste `STORE_UNAVAILABLE` ; aucun message SQL arbitraire n'est publié.

Régression du 9 novembre : le log live `dynamic_grant_conflict_or_cap` prouve le refus, mais ne permet pas seul de choisir sa cause. La suite D1 reproduit l'incohérence d'alias et couvre révocation, quota concurrent, rejeu au plafond, conflit, expiration, cycle fermé et réponse MCP sans réveil. Le déploiement puis les deux vrais essais restent nécessaires pour confirmer la résolution live.
