# CC-7 F2 — Promotion de modèle

Décision P3 #1138 §2, rôles #1139 (auteur Grok, relecteur Vibe, testeur GPT-6).

## Règles

1. **Modèle épinglé** — jamais d’alias `latest` fournisseur.
2. **Prix non supérieur** — entrée ≤ et sortie ≤ (et other si présent) par rapport au modèle actuel.
3. **Sonde** — réponse OK, outils/JSON, efforts acceptés.
4. **Canary** — absent ⇒ `propose` seulement ; échec > 5 %, fuite d’identité ou erreur critique ⇒ `reject`.
5. **Gratuit → payant** — `propose` (gel ou repli gratuit même famille), jamais `auto_apply`.
6. **Auto** — uniquement si `AGENT_RUN_PROMOTE_AUTO=true` **et** canary OK ; aucun appel payant sans plafond owner.
7. **Fiche** — la source durable reste `config/agents.fiche.json` (PR F1). Ce lot ne réécrit pas la fiche en silence.

## Module

- `src/collab-store/agentrun/promote/decision.ts` — décision pure.
- Garde G0 : `GEMINI_PROTOCOL.prepare` normalise `thinkingLevel` via `geminiThinkingLevel` (plus de contournement `minimal` sur 3.8).

## Tests

`test/collab-store/agentrun/cc7-f2-promote.spec.ts`.
