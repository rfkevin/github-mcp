# CC-7 L9a — choix libre du modèle, dans la famille de chaque agent, sous son budget

Cycle `cc7-api-auto`, lot **L9a** (auteur Claude, relecteur Grok, testeur Vibe GLM). Plan seq 1000, validé par Kevin le
2026-10-27 : pas de modèle figé ; chaque agent peut tourner en gratuit ou en payant ; le choix se fait par tâche, au mieux
pour un budget variable. L9b ajoutera les niveaux de réflexion par fournisseur et les tarifs des modèles forts.

## Ce que Kevin pose (variables du Worker)

| Variable | Exemple | Effet |
| --- | --- | --- |
| `AGENT_RUN_FAMILY_<P>` | `AGENT_RUN_FAMILY_CLAUDE=anthropic` | Famille de l'agent : anthropic, xai, zai, google, openai, deepseek, qwen, meta, mistral |
| `AGENT_RUN_MODELS_<P>` | `anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5` | Modèles autorisés, **du plus fort au plus léger**, 12 au plus, en direct ou via OpenRouter |
| `AGENT_RUN_PAID_DAY_CENTS_<P>`, `AGENT_RUN_PAID_CYCLE_CENTS_<P>` | `200`, `1000` | Budget payant de CET agent (prioritaire sur `AGENT_RUN_PAID_PARTICIPANT_*`) ; 0 = gratuit seulement |

Sans les deux premières variables, l'agent garde l'aiguillage L8 (`AGENT_RUN_MODEL_<P>` ou réglage global).

**OpenRouter est un canal, pas une famille** : chaque modèle est classé par son fabricant (`openrouter:anthropic/…` est
anthropic, `openrouter:x-ai/…` est xai, `openrouter:z-ai/…` zai, etc.). Un modèle d'une autre famille que celle de l'agent
est écarté à la lecture et signalé dans le catalogue ; il n'est jamais utilisé.

## Qui choisit, à chaque étape

1. **Préférence posée** (`collab_choose_model`) : par l'agent pour lui-même, ou par un coordinateur actif pour n'importe
   quel agent ; pour tout le cycle ou pour une tâche (la préférence de la tâche prime).
2. Si la préférence n'est pas abordable : **l'option suivante de la liste**, journalisée avec la raison (jamais cachée).
3. Sans préférence : **le plus fort abordable** pour review, test et implement ; **le moins cher** pour design et answer.
4. Rien d'abordable : `MODEL_BUDGET_EXHAUSTED`, aucun appel.

**Abordable** : modèle gratuit permis (clé présente, attestation owner si exigée, règle L8), ou coût estimé d'une étape
≤ budget restant du jour ET du cycle. L'estimation est prudente (16 000 jetons d'entrée et le plafond de sortie du type de
tâche, au tarif daté) ; le coût réel est réglé après l'appel par le noyau commun (L2), qui reste la garde définitive.

Chaque choix est écrit dans `agent_model_choices` (exécution, étape, modèle, auteur du choix, raison, coût estimé) ; chaque
appel met à jour `agent_model_calls` (réussis, en échec, dernière erreur, latence).

## Catalogue des modèles (`collab_model_catalog`)

Lisible par tout participant enregistré, et par Kevin à travers son chat. Pour chaque agent API : famille, modèles
(gratuit / payant / indisponible et pourquoi), **clé présente oui / non — jamais la valeur**, tarif daté (périmé au-delà de
30 jours), disponibilité mesurée, budget restant, modèle retenu par défaut pour chaque type de tâche, préférences posées.
Le contexte MCP ne garde des secrets qu'un marqueur de présence.

Les deux outils n'apparaissent que si `AGENT_RUNS_ENABLED="true"`.

## Limites connues

- Les quotas gratuits côté fournisseur (appels par jour) ne sont pas lus chez le fournisseur : le catalogue montre ce que
  nous mesurons (nos appels, les refus récents).
- Les modèles payants via OpenRouter restent indisponibles tant que leur tarif n'est pas relevé et daté (L9b).
