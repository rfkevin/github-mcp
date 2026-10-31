# CC-7 — familles imposées par agent sur cc3-test

Décision de Kevin du 2026-10-30 : chaque agent du canal API reste sur **sa** famille de
modèles (Claude : Anthropic seulement ; Grok : xAI ; Vibe : GLM ; GPT : OpenAI), jamais
sur le modèle gratuit global du Worker.

## Constat

Sur cc3-test, aucune politique par agent n'était posée (`AGENT_RUN_FAMILY_<P>` et
`AGENT_RUN_MODELS_<P>`, lot L9a). Sans ces deux variables, `participantModelRoute`
retombe sur le réglage global `AGENT_RUN_MODEL` (`workers-ai:@cf/zai-org/glm-4.7-flash`).
Les réponses automatiques aux questions adressées (`clarify.ask` avec `to`) de Claude,
Grok et Vibe passaient donc toutes par ce modèle gratuit, quelle que soit leur famille
(constat du 2026-10-30, exécutions `api-answer-*` de Claude à 0 cent).

## Configuration (`wrangler.jsonc`, environnement `cc3-test`)

| Agent | `AGENT_RUN_FAMILY_<P>` | `AGENT_RUN_MODELS_<P>` | Effet aujourd'hui (aucune clé, budget 0) |
| --- | --- | --- | --- |
| `claude` | `anthropic` | Opus 5.5, Sonnet 5.5, Haiku 5.5 | `MODEL_BUDGET_EXHAUSTED`, aucun appel |
| `grok` | `xai` | grok-4.7, grok-4.20 non-reasoning | `MODEL_BUDGET_EXHAUSTED`, aucun appel |
| `vibe` | `zai` | glm-5.3 (payant), puis glm-4.7-flash Workers AI (gratuit) | glm-4.7-flash gratuit, dans sa famille |
| `gpt6` | `openai` | gpt-oss-120b puis gpt-oss-20b (via Groq) | politique prête, **pas** dans `AGENT_RUN_PARTICIPANTS` |
| `gemini` | `google` | Gemini 3.8 Flash, 3.6 Flash, 3.5 Flash-Lite, puis Gemma 4 26B Workers AI (gratuit) | sans attestation : Gemma gratuit ; politique prête, **pas** dans `AGENT_RUN_PARTICIPANTS` |

- Les modèles payants s'allument d'eux-mêmes quand Kevin pose la clé (`LLM_KEY_ANTHROPIC`,
  `LLM_KEY_XAI`, `LLM_KEY_ZAI`, `LLM_KEY_GROQ`) **et** un budget par agent
  (`AGENT_RUN_PAID_DAY_CENTS_<P>`, `AGENT_RUN_PAID_CYCLE_CENTS_<P>`). Sans eux : refus avant tout appel.
- GPT n'existe pas comme fournisseur direct dans le canal API : ses modèles de famille `openai`
  passent par Groq (`gpt-oss`, attestation `GROQ_FREE_PROJECT_ATTESTED` pour le gratuit) ou OpenRouter.
- `gpt6` reste hors de `AGENT_RUN_PARTICIPANTS` : sinon la tournante des chercheurs (L11) lui
  confierait des passes vouées au refus. L'ajouter est une décision de Kevin.
- Le repli global `AGENT_RUN_MODEL` est conservé pour les participants sans politique.

Test : `test/collab-store/agentrun/cc7-l12-cc3-test-families.spec.ts` lit ces valeurs dans
`wrangler.jsonc` même ; retirer une famille fait échouer le test.

## Gemini (ajout du 2026-10-30)

- Registre gratuit (`API_FREE_MODELS`, relevé du 2026-10-30 sur la page tarifaire officielle) :
  `gemini-3.8-flash` et `gemini-3.6-flash` rejoignent `gemini-3.5-flash-lite`. 3.7 Flash est déprécié
  (redirigé vers 3.8 Flash) et n'est jamais listé.
- Tarif payant daté de 3.8 Flash : 0,75 / 3,75 $ par million de jetons jusqu'au 2026-12-31, puis 1,50 / 7,50 $.
  À revalider avant cette date, comme 3.6 Flash.
- Le Gemini gratuit exige la clé `LLM_KEY_GEMINI` **et** `GEMINI_FREE_PROJECT_ATTESTED="true"` (attestation de
  Kevin que le projet Google est sur le palier gratuit) sur l'origine cc3-test. Sans l'attestation, Gemini reste sur
  Gemma 4 (Workers AI, gratuit, famille google) ; sans budget, jamais d'appel payant.
- Pour que Gemini participe au canal API : Kevin enregistre le participant `gemini`, pose l'attestation et
  l'ajoute à `AGENT_RUN_PARTICIPANTS`.

## F1 — source canonique des familles (ajout du 2026-10-31)

Depuis le lot F1, les définitions de ce tableau vivent dans la fiche canonique
`config/agents.fiche.json` (source unique, modifiée par PR) : les variables `AGENT_RUN_*` de
l'environnement `cc3-test` ci-dessus en sont dérivées par un script déterministe
(`node scripts/agent-fiche/generate.mjs`), et la CI échoue si `wrangler.jsonc` diverge de la
fiche (`test/collab-store/agentrun/cc7-f1-fiche-canonical.spec.ts`). Ce document reste la
description lisible ; le runtime lit toujours les variables d'environnement (lecture parallèle,
aucune valeur modifiée). Détails : [f1-fiche-unique.md](f1-fiche-unique.md).
