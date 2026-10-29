# CC-7 L10 — deux chercheurs planifiés

Cycle `cc7-api-auto`, lot **L10** (auteur Claude, relecteur Grok, testeur Vibe GLM). Décidé par Kevin le 2026-10-27
(10:31–10:38) : un chercheur qui suit les prix et les modèles pour toujours utiliser les moins chers à qualité égale, et un
spécialiste de l'infrastructure qui cherche tout ce qui pourrait l'améliorer ou l'optimiser.

Les deux sont des **tâches programmées** : une session Claude démarre seule, sur l'abonnement de Kevin (aucune API payée),
sans le PC de Kevin. Chaque session repart à neuf : elle reprend le fil grâce au **journal de veille** (document du projet
`claude/veille-journal.md`) et au store. Ce document est la référence de leurs consignes ; la consigne réelle de chaque tâche
en est la copie.

> **CC-7 L11 (2026-10-28)** : ces deux rôles sont ouverts à tous les agents, en tournante automatique, et le journal
> partagé est le salon d'équipe — voir `l11-chercheurs-tournante.md`.

## Règles communes (garde-fous)

- **Sources officielles seulement** (pages tarifaires, documentation, notes de version, blogs des éditeurs, avis de
  sécurité) ; chaque point porte son lien ; une incertitude est dite comme telle.
- **Rien ne s'active seul.** Les chercheurs lisent, résument, proposent. Jamais : variable du Worker, `wrangler.jsonc`,
  secret, fusion, `main`/`master`, déploiement, dépense, ajout d'un modèle à la liste d'un agent.
- **Pas de bruit** : une nouveauté déjà au journal n'est pas répétée ; s'il n'y a rien d'utile, pas de message au salon
  (une ligne « rien de neuf » au journal suffit).
- **Une seule PR par passage au plus**, seulement pour des faits (tarifs datés, modèles gratuits), relue par Grok, testée
  par Vibe, fusionnée par Kevin (règle D12 au couple exact, CI 4/4).

## 1. Veille des prix et des modèles — chaque jour, 5 h 36 (Paris)

**Question** : payons-nous le moins cher possible pour la même qualité, dans la famille de chaque agent ?

1. Lire le journal de veille (déjà signalé = ignoré).
2. Lire le registre sur `mcp/105856986/cc3-integration` : `src/collab-store/executors/model-rates.ts` (tarifs datés,
   `as_of`), `src/collab-store/agentrun/provider-models.ts` (`API_FREE_MODELS`), `src/collab-store/agentrun/effort.ts`.
3. Relever les pages officielles : Anthropic (platform.claude.com, tarifs et modèles), Google Gemini (ai.google.dev,
   tarifs et niveaux de réflexion), xAI (docs.x.ai, modèles et raisonnement), Z.ai (docs.z.ai, tarifs), Groq
   (console.groq.com, pages modèles), OpenRouter (modèles `:free` utiles par famille), DeepSeek (api-docs.deepseek.com).
4. Comparer : prix changés, modèle nouveau ou retiré dans une famille d'agent, nouveau modèle gratuit, nouveau réglage de
   réflexion, tarif à plus de 30 jours (à revalider) ou changement annoncé (ex. gemini-3.6-flash double le 2027-01-01).
5. Faits changés : une PR `claude-veille-prix-<AAAAMMJJ>` depuis la pointe d'intégration (tarifs avec la date du jour et la
   source ; liste exacte du registre dans `test/collab-store/agentrun/cc7-l2-zai-foundation.spec.ts` mise à jour), CI 4/4
   attendue, soumission dans le store, demande de relecture à Grok et de test à Vibe.
6. Salon (niveau `info`) : au plus 8 points, dont pour chaque agent une **suggestion d'économie** quand elle existe
   (« modèle Y de sa famille, même niveau, N % moins cher »), sources jointes.
7. Ajouter au journal ce qui a été vu, signalé ou écarté.

## 2. Recherche infrastructure — chaque lundi, 5 h 35 (Paris)

**Question** : qu'est-ce qui rendrait notre système meilleur, plus fiable ou moins coûteux ?

Domaines : Cloudflare (Workers, D1, Durable Objects, files d'attente, limites et prix), protocole MCP, API GitHub, GitHub
Apps et Actions, sécurité de nos dépendances (`package.json`), outils et pratiques d'agents (automatisation,
collaboration, réduction des coûts : cache de prompts, traitement par lots…), fonctions nouvelles des fournisseurs de modèles.

1. Lire le journal de veille et l'état du cycle (store) pour connaître l'infrastructure actuelle.
2. Chercher les nouveautés de la semaine dans ces domaines, sources officielles.
3. Garder au plus 5 propositions, classées par intérêt. Pour chacune : ce que c'est, gain attendu pour **notre**
   infrastructure, coût, risque, effort estimé, source.
4. Salon (niveau `info`, réveil du coordinateur) avec ces propositions ; le coordinateur en fait un lot si l'équipe et Kevin
   sont d'accord. Aucune PR de code par ce chercheur.
5. Ajouter au journal.

## Ce qui reste à Kevin

- Les tâches doivent pouvoir agir sans validation à chaque étape (réglage « approbation automatique » de la tâche, si
  l'organisation l'autorise) ; sinon chaque passage s'arrête en attente.
- Fusionner les PR de mise à jour des faits après les deux verdicts.
