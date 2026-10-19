# CC-5 L3b — Pilote agents API + assembleur de contexte D3

Auteur : Grok · Reviewer : Vibe GLM · Testeur : ChatGPT GPT-6  
Base : `mcp/105856986/cc3-integration` @ vague 2.

## Principe

Pilote **serveur** pour faire tourner les collaborateurs (Grok, Vibe, GPT-6, Claude)
sur le **canal API** avec les modèles **free les moins chers**, sans jamais émettre
de **verdict D12** (AGREE/PASS/AMEND au couple head/base) depuis ce canal.

| Module | Rôle |
|---|---|
| `agents/persona.ts` | Personas figées, `api_enabled`, modèle free préféré |
| `agents/tools.ts` | Allowlist outils API + interdiction explicite D12 |
| `agents/lease.ts` | Bail fencing append-only par (cycle, participant, task) |
| `agents/assembler.ts` | Paquet D3 borné (réutilise `buildRolePacket`) |
| `agents/pilot.ts` | Orchestration fail-closed : HALT, persona, outil, bail, assemble |

## Invariants

1. **0 €** — `max_cost_cents: 0`, `free_models_only: true`.
2. **Pas de D12 sur API** — `assertNotD12Verdict` refuse state/verdict AGREE|PASS|AMEND…
   et kinds `*verdict*` ; `evidence.add` / `collab_append_event` hors allowlist.
3. **Deny-by-default** — outil inconnu ou forbidden → `AgentDenied`.
4. **Fencing** — un seul bail **actif** par clé (`UNIQUE INDEX … WHERE status = 'active'`).
   Release = transition terminale `active → released` (seule UPDATE autorisée).
   DELETE refusé. Ré-acquisition possible après release ou expiration (acquire
   expire d'abord les actifs dont `expires_at <= now`). Preview non déployée :
   pas de migration d'ancienne colonne UNIQUE.
5. **Budget paquet** — défaut 3000 tokens, plancher effectif 500 si l'appelant
   demande moins (trim L2 inchangé).
6. **assertNotD12Verdict** — refuse aussi un champ `review`/`state` libre qui
   commence par OK/AGREE/… (fail-closed ; pas de verdict D12 déguisé).

## Hors incrément 1

- Branchement Cron / wake A1 réel vers `dispatchFreeInvocation` (le bail
  incrément 1 ne couvre que l'assemblage, pas l'appel LLM).
- Mémoire persona persistée et consolidation (L5).
- Outils d'écriture non-D12 au-delà de `memory.propose` / `clarify.ask`.
- Gemma : conserver `enable_thinking: false` (L0) si dispatch sur le modèle
  persona Claude.
- Activation production : Kevin GO.

## Tests

`test/collab-store/agents/{persona,tools,lease,pilot}.spec.ts`.
