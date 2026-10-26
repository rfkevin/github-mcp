# CC-7 L4 — salon d’équipe (S6 / S7)

Cycle `cc7-api-auto`, lot **L4** (auteur Grok, relecteur Vibe, testeur Claude).
Plan CC-PLAN-7 v0.2. Tout est **éteint par défaut** (`SALON_ENABLED` absent ou ≠ `true`).

## S6 — canal permanent

- Cycle logique `team-salon` (constante `SALON_CYCLE_ID`) : messages dans `salon_messages` (append-only).
- Niveaux : `info` | `decision` | `blocking`.
- `blocking` exige `task_id`.
- Corps ≤ 2 000 caractères.
- Masquage soft (`masked=1`) : n’efface jamais.
- HALT actif → refus `SALON_HALT` (aucune écriture).

## S7 — anti-bruit et exception de sûreté

- ≤ **3** messages `decision` ou `blocking` par participant et par jour UTC (`salon_day_counts`).
- Un seul message par `incident_key` **sans** `new_fact` (`SALON_INCIDENT_DUP`).
- **Exception** : `blocking` + `new_fact=true` n’est **jamais** refusé pour quota ; accepté avec `over_quota=1` (à signaler dans le digest Kevin).
- Les `decision` et les `blocking` sans fait nouveau restent soumis au refus dur `SALON_DAILY_LIMIT`.

## Réveils

- Table `salon_wakes` : au plus une ligne par `(msg_id, participant_id)`.
- L’auteur n’est pas auto-réveillé.
- `ackSalonWake` idempotent (`already: true` au second appel).

## Outils MCP

| Outil | Effet |
| --- | --- |
| `collab_salon_post` | écriture (porte + identité serveur) |
| `collab_salon_list` | lecture bornée |
| `collab_salon_pending_wakes` | réveils non acquittés |
| `collab_salon_ack_wake` | acquittement |

## Hors de cet incrément (L4b / suite)

- Page HTML `/salon` et digest owner.
- Notification GitHub (mention) — câblage worker, secret Kevin.
- Intégration contrôleur (digest over_quota).

## Fichiers

- `src/collab-store/salon/` — schéma 0012, logique, index
- `src/collab-store/mcp/salon-tools.ts` + enregistrement dans `tools.ts`
- `src/collab-store/store/schema.ts` — batch ensureSchema + migration 0012
- `test/collab-store/salon/cc7-l4-salon.spec.ts`
