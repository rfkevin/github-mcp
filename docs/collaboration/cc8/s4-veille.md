# CC-8 S4 — Veille typée + sonde unique

Auteur : Grok · Base : `8b9e6b09` (post-S8a) · Branche : `mcp/105856986/cc8-s4-veille`

## Objectif

Une trouvaille de modèle (prix, nouveauté, retrait) devient un **model.finding** durable
(source officielle, ref épinglée, as_of), puis peut déclencher **la même sonde** que le
bouton /owner — sans chat, sans modifier `promote/decision.ts`.

## Modules

| Fichier | Rôle |
| --- | --- |
| `agentrun/probe.ts` | `runModelProbe` — HALT, ref épinglée, mock coût 0 si `AGENT_RUN_PROBE≠true` |
| `agentrun/model-finding.ts` | `recordModelFinding` — table `model_findings`, source via `officialUrl`, option `trigger_probe` |

## Portes

- `AGENT_RUN_PROBE` : exact `true` pour mode live (sinon mock CI / dry-run).
- `AGENT_RUN_RESEARCH` : inchangé (L11) — la veille agent reste sous RESEARCH.
- HALT : coupe enregistrement finding et sonde.

## AC

1. Trouvaille simulée → `status=recorded` + sonde mock si `trigger_probe`.
2. Source non officielle / ref latest → `rejected`.
3. Rejeu même `finding_id` → `duplicate`.
4. Bouton /owner et finding partagent `runModelProbe`.
5. Hors périmètre : `agentrun/canary/` (S5), rewrite F2.

## Tests

`test/collab-store/agentrun/cc8-s4-probe-finding.spec.ts`
