# CC-7 L9b — niveaux de réflexion, Opus 5.5, choix par l'agent lui-même

Cycle `cc7-api-auto`, lot **L9b** (auteur Claude, relecteur Grok, testeur Vibe GLM). Suite de L9a (plan seq 1000).

## Quatre niveaux, traduits par fournisseur

| Niveau | Anthropic (Opus, Sonnet, Haiku 5.5) | xAI grok-4.5 à 4.9 | Groq gpt-oss | OpenRouter | Z.ai glm-4.7-flash | Gemini 3.x |
| --- | --- | --- | --- | --- | --- | --- |
| `low` (faible) | adaptatif, `effort: low` | `reasoning_effort: low` | `low` | `reasoning.effort: low` | réflexion coupée | `minimal` |
| `medium` (moyen) | `effort: medium` | `medium` | `medium` | `medium` | réflexion activée | `low` |
| `high` (élevé) | `effort: high` | `high` | `high` | `high` | réflexion activée | `medium` |
| `xhigh` (très élevé) | `effort: xhigh` | `xhigh` | `high` | `high` | réflexion activée | `high` |

Relevés du 2026-10-27 sur la documentation officielle. Rien n'est envoyé aux modèles sans réglage (grok non-reasoning et
build, glm-5.3 qui pense toujours, Workers AI, DeepSeek) : leurs options historiques restent inchangées.

**La réflexion coûte des jetons de sortie.** Le plafond de sortie de l'étape est multiplié (moyen ×1,5, élevé ×2, très
élevé ×3, borné à 8192) et l'estimation de coût suit ce plafond : le budget de l'agent voit le vrai pire cas.

## Qui choisit le niveau

- La préférence (`collab_choose_model` pour soi ou par le coordinateur, `store_choose_model` pour un agent API) peut
  porter un `effort`.
- Sans niveau choisi : élevé pour review et test, moyen pour implement et design, faible pour answer.
- Budget serré : le serveur essaie les niveaux plus légers **du même modèle** avant de passer au modèle suivant de la
  liste, et l'écrit dans le journal (« réflexion medium au lieu de high (budget) »).
- Une préférence sortie de la liste de l'agent est ignorée **et journalisée** (note de Vibe sur L9a).

## Opus 5.5 et Fable 5.1

Tarifs datés ajoutés, relevés le 2026-10-27 : Opus 5.5 à 4 $ / 20 $ par million de jetons (400 / 2000 cents) ; Fable 5.1
(gamme Mythos, au-dessus d'Opus) à 10 $ / 50 $ (1000 / 5000 cents). Ni l'un ni l'autre ne coûte rien tant qu'il n'est pas
dans la liste d'un agent et que son budget ne le permet pas. Exemple pour Claude :
`AGENT_RUN_MODELS_CLAUDE=anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5`.

## `store_choose_model` (agents API)

Un agent API choisit, pour les étapes suivantes de **sa** tâche, un modèle de **sa** liste et un niveau de réflexion ; le
serveur relit l'exécution (cycle, participant, tâche) et applique les règles de L9a. Proposé seulement quand l'aiguillage
par participant est posé sur le Worker. Refus typés (`MODEL_NOT_ALLOWED`, `MODEL_CHOICE_INVALID`) renvoyés comme refus
d'outil, sans écriture.
