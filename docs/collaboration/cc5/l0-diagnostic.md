# CC-5 L0 — Diagnostic des réponses vides Gemma et Groq (X4)

Auteur : Vibe GLM (lot L0, auteur) · Date : 2026-10-18 · Hypothèse « réflexion » : **confirmée**.

## 1. Gemma (`@cf/google/gemma-4-26b-a4b-it`, Workers AI) — CONFIRMÉ, corrigé dans ce lot

### Faits observés (invocations A1 du pilote)

- `inv-774f954a` : réponse vide, 5 428 ms.
- `inv-e15183ba` : réponse vide, 5 449 ms.
- Ledgers A1 correspondants : usage 0/0 (le bug comptable X14 — l'appel a pourtant consommé
  ~28 neurons de raisonnement au registre Cloudflare sans que la réponse ne porte de texte).

### Cause

Gemma 4 26B possède un mode réflexion intégré actif **par défaut** sur Workers AI. Sans
option, le modèle raisonne d'abord ; les jetons de raisonnement consomment le plafond
`max_tokens` et la réponse visible revient vide. Cloudflare documente la coupure explicite :
`chat_template_kwargs: { enable_thinking: false }`
(https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/).
Des intégrateurs mesurent le même comportement : sans l'option, le modèle « raisonne jusqu'au
plafond et rend un corps vide » (https://github.com/yosuke1024/velum/pull/23).

### Correctif livré dans ce lot (commun au glm-4.7-flash existant)

```ts
export const MODEL_CALL_OPTIONS = {
  '@cf/zai-org/glm-4.7-flash': { chat_template_kwargs: { enable_thinking: false } },
  '@cf/google/gemma-4-26b-a4b-it': { chat_template_kwargs: { enable_thinking: false } },
};
```

L'option est spread dans l'entrée `ai.run` par `createWorkersAiAdapter` ; test dédié dans
`test/collab-store/executors/l0-accounting.spec.ts`. La garde « contenu vide » devient par
ailleurs un échec typé `EXECUTOR_BAD_RESPONSE` dans `readWorkersAiOutput` (avec usage attaché),
au lieu d'un `content` vide silencieusement accepté.

## 2. Groq (`openai/gpt-oss-20b`) — CONFIRMÉ, PAS de correctif code dans L0

### Faits observés (invocations A1 du pilote)

- Échec `inv-b5d58029` : contenu vide, 2,4 s, 0 jeton compté, **brief lourd** (~512 jetons
  d'entrée) — réponse perdue en raisonnement.
- Succès à brief compact : `inv-ab8ef880` (1 241 ms, 366/256 jetons), `inv-b53418500`
  (1 099 ms, 377/428 jetons).

### Cause

`openai/gpt-oss-20b` est un **modèle à raisonnement** chez Groq : `reasoning_effort`
(`low`/`medium`/`high`, défaut `medium`), `include_reasoning` ; `reasoning_format` n'est pas
supporté sur gpt-oss (https://console.groq.com/docs/reasoning,
https://console.groq.com/docs/api-reference). Le raisonnement consomme le budget de jetons
avant la réponse ; à effort `medium` (défaut) avec un brief chargé, le contenu peut revenir
vide alors que les jetons de raisonnement sont facturés au quota.

### Recommandation (doc only — décision owner en suivi)

- Ne **pas** changer la forme de requête Groq dans L0 (le pilote reste sur le contrat existant).
- Piste de suivi pour l'owner : `reasoning_effort: 'low'` sur les dispatchs à brief lourd,
  à mesurer en W1 (latence vs qualité). Cela relève d'une modification de contrat fournisseur,
  donc d'une décision owner séparée, pas du lot L0.

## 3. Traçabilité comptable

Avant ce lot, ces échecs étaient comptés 0/0 dans le ledger A1 alors que le fournisseur avait
consommé des jetons. La dette X14 (usage réel sur échec) corrige la mesure : l'usage partiel
est attaché à l'erreur par les adaptateurs et remonté au ledger. Voir l0-w0-baseline.md §9.
