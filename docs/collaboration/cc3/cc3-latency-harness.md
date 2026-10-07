# CC-3 — Harness de mesure de latence (C2, S5/append)

La mesure S5 (p50/p95 de \`collab_append_event\` et \`collab_get_delta\`) doit être prise sur le déploiement **cc3-test** (https://github-mcp-cc3-test.rfahedkevin.workers.dev), D1 \`COLLAB_DB\` lié, \`COLLAB_STORE_ENABLED=true\`. L'auteur C2 n’a pas d’accès HTTP sortant depuis son environnement : la procédure ci-dessous est livrée pour exécution manuelle (K) ou depuis un poste disposant du réseau. Les résultats sont à ajouter au dossier de la porte C0 (\`c0-gate.md\`) après le merge.

## Préparation

1. Obtenir un jeton avec les scopes \`mcp:read offline_access collab:\` (flux OAuth du Worker, ressource \`https://github-mcp-cc3-test.rfahedkevin.workers.dev/collab/mcp\`).
2. Créer un cycle de test : \`collab_append_event\` avec \`expected_rev=0\`, \`op_id=bench:<cycle>:bench:1\`.

## Échantillonnage (30 appels par outil)

Chaque échantillon = une requête JSON-RPC unique, chronométrée en seconde fractionnaire :

\`\`\`bash
URL=https://github-mcp-cc3-test.rfahedkevin.workers.dev/collab/mcp
TOKEN=... # jeton bearer
CYCLE=bench-$(date +%s)

for i in $(seq 0 29); do
  curl -sS -o /dev/null -w "%{time_total}\n" -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data @- <<EOF | true
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"collab_append_event","arguments":{"cycle":"$CYCLE","expected_rev":$i,"op_id":"bench:$CYCLE:bench:$i","type":"checkpoint","participant_id":"agent:bench","payload_json":"{\"i\":$i}"}}}
EOF
done
\`\`\`

Le même motif s’applique à \`collab_get_delta\` (arguments \`{ "cycle": "$CYCLE", "since_seq": 0, "limit": 200 }\`).

## Calcul

p50 = médiane des 30 échantillons ; p95 = 29e valeur triée (ceil(0.95 × 30) = 29).
Critère du plan (§5) : latence < 1 s attendue sur p50 ; consigner p50 et p95 avec la date, le SHA déployé et le nombre d’échantillons.

## Traçabilité

- Journal : chaque appel d’append crée un événement idempotent ; le cycle \`bench-\` peut être purgé uniquement par opération manuelle owner (C5).
- Quota : 30 appels restent très en dessous de \`DEFAULT_DAILY_WRITE_LIMIT\` (5000).
