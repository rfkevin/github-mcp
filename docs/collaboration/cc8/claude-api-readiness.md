# CC8 — Activation du canal API Claude sur le parcours unique (préparation)

Statut : **préparé, non financé, non testé en direct**. Branche d'intégration : `mcp/105856986/cc3-integration`. Environnement cible : **`cc3-test` uniquement**. Aucun secret, recharge, fusion ou déploiement n'est effectué par ce document.

## Réutilisation, sans nouveau moteur

Le participant logique `claude` existe dans `config/agents.fiche.json`, `AGENT_RUN_PARTICIPANTS` et le store CC8. Les chats Claude et les runs API partagent l'identité logique, le store, la continuité C4, les WorkSessions et le contrôle D12. L'adaptateur Anthropic Messages (`src/collab-store/agentrun/anthropic-model.ts`) et les quatre niveaux de réflexion `low/medium/high/xhigh` sont déjà présents. L'ancien alias `ep-claude-glm47` est **retired** et ne doit pas être réactivé.

Ce changement prépare seulement la même porte GitHub déjà utilisée par Vibe et Gemini : autoriser `claude` dans `AGENT_RUN_GITHUB_WRITERS` et `AGENT_RUN_DYNAMIC_SCOPE.participants`. **Portée inchangée** : cycle `cc8-systeme-unique`, un fichier par grant, préfixe `test/collab-store/agentrun/`, maximum 30 grants dans le cycle, expiration par grant 48 heures, contrôle de la tâche D12 et de l'identité au point d'effet. Aucun droit sur `src/`, `wrangler.jsonc`, `master` ou la fusion n'est donné aux agents API. `collab_assign_worksession` reste l'unique entrée pour les travaux attribués.

## Actions propriétaire avant le premier essai payant

1. Fusionner la PR préparatoire **seulement après** CI et revue, puis déployer sur `cc3-test`. Vérifier que le catalogue montre toujours le participant `claude` mais `capable=false` tant que la clé/budgets manquent.
2. Depuis un environnement sécurisé, créer une clé API dans la console Anthropic ; la stocker comme secret Cloudflare `LLM_KEY_ANTHROPIC` de l'environnement `cc3-test`. **Jamais dans GitHub, le store, les messages ou le chat.** Confirmer sa présence via `collab_model_catalog` (présence uniquement, pas la valeur).
3. Configurer côté Worker, pour Claude uniquement : `AGENT_RUN_PAID_DAY_CENTS_CLAUDE=200` et `AGENT_RUN_PAID_CYCLE_CENTS_CLAUDE=200` (centimes **USD** ; maximum 2 USD par jour et pour ce cycle). Les deux plafonds sont obligatoires et peuvent rester à zéro jusqu'au premier test.
4. Autoriser le coût **par type de run** en ajustant `AGENT_RUN_COST_CENTS_ANSWER`, puis `AGENT_RUN_COST_CENTS_REVIEW`, `AGENT_RUN_COST_CENTS_TEST`, `AGENT_RUN_COST_CENTS_IMPLEMENT` selon le test choisi. Ces variables sont **globales**, non réservées à Claude ; vérifier les budgets des autres participants avant d'en activer une. Le plafond par run ne remplace pas l'enveloppe de Claude. Aucun montant n'est activé dans cette PR.
5. Dans CC8, choisir `anthropic:claude-haiku-5-5` pour le participant `claude` via `collab_choose_model`, avec `effort=medium` pour démarrer (ou `high` sur `review/test` avec son coût propre). Sans préférence, `chooseModel` privilégie Opus sur `implement/review/test` si celui-ci est abordable : ne pas comparer les coûts sans modèle fixé. Ne pas modifier la fiche canonique juste pour une préférence de test.

## Protocole de comparaison

- Confirmer d'abord `collab_model_catalog` et `collab_agent_runs_overview` : clé présente, modèle Claude abordable, absence de runs en cours, budget restant et circuit sain ; vérifier la version déployée de `cc3-test`.
- `ANSWER` en lecture seule : question CC8 à `claude`, consultation du store + preuve de `store_answer` et exactitude des références. Consigner réponse, étapes, coûts et erreurs D1.
- `REVIEW` et `TEST` sur preuves GitHub immuables déjà existantes, sans faux verdict AGREE. Comparer avec Vibe/Gemini au même SHA, même question, mêmes documents et budget connu.
- `IMPLEMENT` seulement après correction du défaut commun de transmission de mission (`acceptance_json` n'est pas exposé dans le packet de tâche ni `github_write_scope`). Mission déléguée uniquement à un nouveau fichier `test/collab-store/agentrun/<nom>.spec.ts`; branch/commit/CI/PR relus par le coordinateur. Aucun merge automatique.
- Compter séparément : (a) erreur de fournisseur, (b) refus politique/outils, (c) incompréhension de la mission, (d) erreur de code, (e) perte de continuité. Ne jamais attribuer un échec commun à la performance du modèle sans preuve.

**Limites connues** : Claude API n'a actuellement ni clé ni budget. Les modes de raisonnement sont ceux du Worker, pas les réglages du chat Claude. Un appel est borné à 8 192 tokens de sortie ; l'échéance initiale des runs payants est 900 secondes par type (voir `effort.ts`, `run-policy.ts`). Les tests unitaires Anthropic valident l'adaptateur simulé, **pas** un appel live au fournisseur. Ne pas créer un second participant Claude ni redonner vie à l'ancien endpoint de repli.
