# CC-3 — Harness de mesure de latence (C2, S5/append)

La mesure S5 (p50/p95 de `collab_append_event` et `collab_get_delta`) doit être prise sur le déploiement **cc3-test** (https://github-mcp-cc3-test.rfahedkevin.workers.dev), D1 `COLLAB_DB` lié, `COLLAB_STORE_ENABLED=true`. L'auteur C2 n'a pas d'accès HTTP sortant depuis son environnement : la procédure ci-dessous s'exécute via un client MCP branché sur la ressource `/collab/mcp` (connecteur), ou manuellement (K) depuis un poste disposant du réseau. Les résultats sont à ajouter au dossier de la porte C0 (`c0-gate.md`) après le merge.

## Principe : mesurer `db_ms`, pas le réseau du poste

Une exécution locale (`curl -w %{time_total}`) chronomètre le trajet poste → Worker → D1 → poste : elle porte le même biais que le rejeu cloud C0 (voir `c0-cloud-run.md`) et ne mesure pas la latence Worker ↔ D1. La métrique à consigner est donc **`db_ms`** : la durée D1 mesurée côté serveur, renvoyée dans le résultat des outils `collab_*` (et journalisée) — ajout après le merge de C5. Le chronométrage client ne sert que d'ordre de grandeur pessimiste, à ne pas consigner comme valeur S5.

## Préparation

1. Obtenir un jeton avec les scopes `mcp:read offline_access collab:` (flux OAuth du Worker, ressource `https://github-mcp-cc3-test.rfahedkevin.workers.dev/collab/mcp`).
2. Créer un cycle de test : `collab_append_event` avec `expected_rev=0`, `op_id=bench:<cycle>:bench:1`.
3. **Ne pas passer `participant_id`** : depuis C5, l'identité du participant est **dérivée du jeton côté serveur** (invariant I8) ; le paramètre, s'il existe encore dans le contrat d'entrée, est ignoré ou refusé. Le cycle `bench-` est attribué à l'identité du jeton utilisé pour la mesure.

## Échantillonnage (30 appels par outil)

Chaque échantillon = un appel de l'outil ; relever la valeur `db_ms` du résultat (version réseau à titre indicatif uniquement) :

```bash
URL=https://github-mcp-cc3-test.rfahedkevin.workers.dev/collab/mcp
TOKEN=... # jeton bearer
CYCLE=bench-$(date +%s)

for i in $(seq 0 29); do
  curl -sS -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data @- <<EOF | true
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"collab_append_event","arguments":{"cycle":"$CYCLE","expected_rev":$i,"op_id":"bench:$CYCLE:bench:$i","type":"checkpoint","payload_json":"{\"i\":$i}"}}}
EOF
done
```

Le même motif s'applique à `collab_get_delta` (arguments `{ "cycle": "$CYCLE", "since_seq": 0, "limit": 200 }`).

Depuis un client MCP branché en connecteur sur `/collab/mcp`, les mêmes 30 appels par outil se font via les outils `collab_*` ; relever `db_ms` dans chaque résultat.

## Calcul

p50 = médiane des 30 échantillons de **`db_ms`** par outil ; p95 = 29e valeur triée (ceil(0.95 × 30) = 29).
Critère du plan (§5) : latence < 1 s attendue sur p50 ; consigner p50 et p95 avec la date, le SHA déployé et le nombre d'échantillons.

**Portée de l'indicateur** : p50/p95 de `collab_append_event` et `collab_get_delta` est un **indicateur** de la latence du store, pas la mesure de la requête mémoire : celle-ci (assemblage du contexte, lecture mémoire, budget) viendra avec le lot C4.

## Traçabilité

- Journal : chaque appel d'append crée un événement idempotent ; le cycle `bench-` peut être purgé uniquement par opération manuelle owner (C5).
- Quota : 30 appels restent très en dessous de `DEFAULT_DAILY_WRITE_LIMIT` (5000).

## Historique

- v1 (C2) : chronométrage client `time_total`, `participant_id` en argument.
- v2 (cette révision, post-C5) : métrique `db_ms` côté serveur, `participant_id` retiré (identité dérivée du jeton), portée limitée à append/delta explicitée.
