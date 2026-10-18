# CC-5 L1 — Profils modèle × tâche, réflexion, débit

Auteur : Grok (lot L1) · Date : 2026-10-18 · Suite de L0 (X14/X4/W0).

## 1. Bornes avant suppression du 2048

Le plafond global `MAX_OUTPUT_TOKENS = 2048` est remplacé par :

```
effective = min(
  ABSOLUTE_MAX_OUTPUT_TOKENS (8192),
  MODEL_TOKEN_CEILING[model],
  TASK_KIND_BOUNDS[task_kind].max_tokens,
  endpoint.capability_set.token_ceiling,
  requested
)
```

| task_kind | max_tokens | thinking |
| --- | --- | --- |
| probe | 256 | off |
| classify | 512 | off |
| review | 2048 | low |
| design | 4096 | low |
| diagnose | 1024 | low |
| default | 2048 | off |

Source : `src/collab-store/executors/task-profiles.ts`.

## 2. Réflexion / reasoning

| Fournisseur / modèle | Contrôle | Valeur L1 |
| --- | --- | --- |
| Workers AI glm / gemma | `chat_template_kwargs.enable_thinking` | `false` (L0) |
| Z.AI glm-4.7-flash | `thinking.type` | `disabled` |
| Groq openai/gpt-oss-20b | `reasoning_effort` | **`low`** (L1, suite diagnostic X4) |

Aucun changement de forme de requête hors allowlist free. xAI / DeepSeek / OpenRouter paid restent dormants.

## 3. Fenêtres de débit (instantanés 2026-10-18)

Documentées dans `PROVIDER_RATE_WINDOWS` ; le code applique déjà `DEFAULT_DAILY_CAP=50` et `DEFAULT_NEURON_BUDGET=8000`. Les RPM/RPD Groq (30 / ~1000) sont des snapshots à revalider (X12).

## 4. Sortie `output_text` (suivi L0)

`truncateToUtf8Bytes` coupe sur frontière de caractère UTF-8 (64 KiB). Branché dans `InvocationService.succeed` pour remplacer le `.slice` par caractères.

## 5. Hors périmètre

- Activation API payante / enveloppe owner
- Compteurs RPM atomiques (futur, si mesure L0 le justifie)
- Modification des guides `collab-store-guide.md` (suivi)
