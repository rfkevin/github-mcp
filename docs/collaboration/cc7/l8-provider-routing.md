# CC-7 L8 — chaque agent sur sa propre API

Cycle `cc7-api-auto`, lot **L8** (auteur Claude, relecteur Grok, testeur Vibe GLM). Plan CC-PLAN-7 v0.2, S2.
Constat de Kevin (2026-10-27) : sur cc3-test, claude, grok et vibe tournaient tous sur le même modèle (GLM-4.7-flash),
car le canal API n'avait qu'un réglage global. Objectif : continuité et diversité, chaque chat a sa propre API.

## Un modèle par participant

| Variable (Worker, posée par Kevin) | Effet |
| --- | --- |
| `AGENT_RUN_MODEL_<PARTICIPANT>` | Modèle de ce participant (identifiant en majuscules, tout caractère hors `A-Z0-9` devient `_`) : `AGENT_RUN_MODEL_CLAUDE`, `AGENT_RUN_MODEL_GROK`, `AGENT_RUN_MODEL_VIBE`, `AGENT_RUN_MODEL_GEMINI`… |
| `AGENT_RUN_PAID_MODEL`, `AGENT_RUN_MODEL` | Inchangés : réglage commun des participants sans variable propre |

Le participant est relu dans `agent_runs` depuis l'exécution, jamais depuis le modèle. Sans aucune variable
`AGENT_RUN_MODEL_*`, le câblage historique est strictement inchangé. Un participant sans modèle : `MODEL_ROUTE_NONE`,
l'étape échoue sans appel (jamais de repli vers le modèle d'un autre).

## Fournisseurs du canal API

| Fournisseur | Secret | Gratuit (aucune enveloppe, coût 0) | Payant (enveloppe par participant) |
| --- | --- | --- | --- |
| Cloudflare Workers AI (`workers-ai:`) | binding `AI` | `@cf/zai-org/glm-4.7-flash`, `@cf/google/gemma-4-26b-a4b-it` | liste payante vérifiée L2 |
| Z.ai (`zai:`) | `LLM_KEY_ZAI` | `glm-4.7-flash` | `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx` |
| xAI (`xai:`) | `LLM_KEY_XAI` | — | `grok-4.7`, `grok-4.20-0309-non-reasoning`, `grok-build-0.1` |
| Anthropic (`anthropic:`) | `LLM_KEY_ANTHROPIC` | — | `claude-sonnet-5-5`, `claude-haiku-5-5` |
| Google Gemini (`gemini:`) | `LLM_KEY_GEMINI` | `gemini-3.5-flash-lite` si `GEMINI_FREE_PROJECT_ATTESTED="true"` et origine cc3-test | `gemini-3.5-flash-lite`, `gemini-3.6-flash` |
| Groq (`groq:`) | `LLM_KEY_GROQ` | `openai/gpt-oss-20b` si `GROQ_FREE_PROJECT_ATTESTED="true"` et origine cc3-test | `openai/gpt-oss-120b` |
| OpenRouter (`openrouter:`) | `LLM_KEY_OPENROUTER` | tout modèle `…:free` (données jamais conservées : `data_collection: deny`) | — |
| DeepSeek (`deepseek:`) | `LLM_KEY_DEEPSEEK` | — | aucun : tarif officiel non relevable le 2026-10-27, refus deny-by-default |

Tarifs relevés le 2026-10-27 sur les pages officielles (Gemini : `gemini-3.6-flash` passe de 75/375 à 150/750 cents
par million de jetons le 2027-01-01, à revalider avant). Les attestations Gemini et Groq reprennent la règle CC-4 : un
compte gratuit facturable par erreur coûterait, donc Kevin l'atteste et l'origine doit être cc3-test.

**Gratuit ou payant, le serveur décide** : un modèle gratuit permis part sur le chemin gratuit ; sinon, s'il a un tarif
daté, il part sur le chemin payant (enveloppe `AGENT_RUN_PAID_PARTICIPANT_*` à 0 par défaut = refus avant tout appel) ;
sinon refus à la construction. `AGENT_RUN_MODEL` (réglage historique « gratuit ») n'accepte qu'un modèle gratuit permis.

## Protocole Gemini

`generateContent` avec appel de fonctions : consigne en `systemInstruction`, tours `user` / `model`, outils en
`functionDeclarations` (`parametersJsonSchema`), résultats d'outils regroupés en `functionResponse` nommés, en-tête
`x-goog-api-key`, raisonnement `minimal`. Le moteur ne conserve pas les signatures de pensée ; la valeur documentée par
Google pour un historique sans signature accompagne le premier appel de chaque tour rejoué.

## Exemple de configuration cc3-test (à poser par Kevin, clés comprises)

```
AGENT_RUN_PARTICIPANTS=claude,grok,vibe,gemini
AGENT_RUN_MODEL_CLAUDE=anthropic:claude-haiku-5-5
AGENT_RUN_MODEL_GROK=xai:grok-4.20-0309-non-reasoning
AGENT_RUN_MODEL_VIBE=zai:glm-4.7-flash
AGENT_RUN_MODEL_GEMINI=gemini:gemini-3.5-flash-lite
GEMINI_FREE_PROJECT_ATTESTED=true
```

Claude et Grok exigent en plus leurs clés et l'enveloppe par participant (payants) ; Vibe et Gemini sont gratuits.
