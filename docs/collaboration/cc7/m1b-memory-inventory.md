# M1b — Inventaire mémoire ré-exécutable et comparaison des seuils de pause (lecture seule)

- **Lot** : CC-7 M1b — GO seq 1057 (feu vert Kevin relayé par GPT-6 ; attribution confirmée en conversation, ce n'est PAS une owner.decision /owner installée).
- **Auteur** : Vibe — relecteur : GPT-6 ; testeur : Claude ; fusion : Kevin seul.
- **Date** : 2026-10-30. Journaux : cc7-api-auto (consultation) + memory-alarms (alarme).
- **Nature** : lecture seule pour toute mémoire, tout seuil et toute baseline — aucune activation, consolidation ou retire, aucune décision owner prise en son nom. Correctif de la revue GPT-6 (CHANGES_REQUESTED, PR #236/6523145152) : le lot livre désormais le composant ré-exécutable demandé (2 outils MCP lecture seule / calcul pur + tests, §9) ; ce document reste le relevé initial et en devient la documentation.

## 1. Ancrage technique (SHA exact)

Code relu à `mcp/105856986/cc3-integration` @ `367203bc81260850abbd48d7c29682b8d3089929` :

| Élément | Emplacement | Valeur |
|---|---|---|
| Métrique canonique des jetons | src/collab-store/contracts/memory.ts l.33-35 (blob 252b356e) | estimateTokens(t) = Math.ceil(t.length / 4) — unités UTF-16 |
| Budgets par famille | src/collab-store/memory/memory-store.ts l.146-152 (blob e0b52f99) | common 1500, project 2000, role 1500, participant 500, task 300 |
| Garde budget | memory-store.ts l.1222-1236 | MEMORY_BUDGET_EXCEEDED si Σ estimateTokens(actives du scope) + estimateTokens(nouveau texte) > budget |
| Règle de croissance (actuelle) | memory-store.ts l.166 (GROWTH_ALARM_PERCENT=25) + l.585 | pause si 100·n > 125·base |
| Plafond d'activations | memory-store.ts l.167 | MAX_ACTIVATIONS_PER_CYCLE = 10 |
| Baseline d'un scope neuf | memory-store.ts l.591 | semée à la 1re activation : MAX(1, actives−1) |
| Reprise (approbation owner) | src/collab-store/memory/pause-resume.ts l.139-146 | base recalée = MAX(1, COUNT(actives)) |
| Plafonds d'entrées (hygiène) | src/collab-store/memory/hygiene.ts l.29 | participant 25, partagés 50 |
| Émetteur de l'alarme | pause-resume.ts l.27, l.83 | participant réservé « system » → owner.request kind memory.pause, cycle memory-alarms |

**Règle candidate** (P3/P4, à implémenter par M1a) : pause si `100·(n−base) > max(25·base, 100·k)`. k=0 équivaut exactement à la règle actuelle.

## 2. Méthode et couverture

Sources (lecture seule) : export memory-md du store (contenu sha256 `1a32f22b6b830934002244f2b3a6973c10ff56b2ff06e49bd584d4e76fec5a87`), journal cc7-api-auto seq 862-1057 (collab_get_delta, seq par seq), journal memory-alarms seq 921-1028, code au SHA ci-dessus.

Scopes couverts : partagés (common, project:*, role:*, task:*) + participant:vibe (mon scope, droit établi). **Exclus** : participant:&lt;autre&gt; — aucun contenu, aucun agrégat (CR-C) ; leur existence même n'est pas dénombrée ici.

Limites consignées :
- Journaux d'autres cycles non balayés intégralement : des candidates/tombstones d'autres cycles peuvent exister et restent invisibles de tout agent (inconnue déjà consignée P1/P2, n'empêche pas ce lot) ;
- Le store D1 n'est pas requêtable en direct depuis l'environnement agent : lecture via les outils collab uniquement ;
- Coûts — CORRECTION (revue GPT-6) : `token_cost` est persisté dès la PROPOSITION (`insertCandidate`, migration 0003), pas seulement à l'activation ; les coûts du §3.2 sont donc les valeurs persistées du D1, recalculées à l'identique par la formule canonique pour vérification. L'absence des coûts dans l'export memory-md reste une limite de l'export, pas du store ; `collab_memory_inventory` (§9) lit les valeurs persistées et les tests e2e vérifient recalculé = persisté.

## 3. Inventaire (au 2026-10-30, avant toute décision mem-pause)

### 3.1 Entrées actives (3)

| id | v | scope | kind | confiance | auteur | reviewer | proposée | activée | coût jetons |
|---|---|---|---|---|---|---|---|---|---|
| cc7-lesson-sealed-payload | 1 | common | lesson | observed | claude | grok | seq 902 (2026-10-26 08:28) | seq 919 (09:18, grok) | 70 |
| cc7-lesson-memory-error-mapping | 1 | common | lesson | observed | claude | grok | seq 903 (08:28) | seq 920 (09:18, grok) | 82 |
| lesson-read-truncation-before-replace | 1 | participant:vibe | lesson | observed | vibe | vibe | hors journal cc7 (cycle antérieur) | — | ≈136 (estimé depuis l'export, préfixe déduit) |

common : 2 actives, **152/1500 jetons** (10,2 % du budget). participant:vibe : 1 active, ≈136/500.

### 3.2 Candidates en attente (7 — toutes scope common, confiance observed, auteur vibe, bloquées par la pause)

| seq (date UTC) | id | kind | coût (recalculé = persisté) | preuves |
|---|---|---|---|---|
| 907 (2026-10-26 08:31) | cc7-fact-xai-adapter-request-body | fact | 117 | github-mcp#214 ; store seq 896 |
| 908 (08:31) | cc7-lesson-second-adapter-shared-socle | lesson | 124 | github-mcp#214 |
| 909 (08:31) | cc7-lesson-adapter-test-contract-by-fixture | lesson | 113 | github-mcp#214 |
| 925 (10:12) | cc7-fact-anthropic-messages-protocol | fact | 127 | github-mcp pull/215 ; store seq 924 |
| 926 (10:12) | cc7-lesson-third-adapter-protocol-core | lesson | 135 | pull/215 ; #214 (7b0d7886) |
| 927 (10:12) | cc7-lesson-elision-scanner-assertion-thresholds | lesson | 128 | pull/215 (0fbd2112/b9022ad2/592406ae) |
| 948 (14:01) | cc7-lesson-lookup-test-one-pr-per-branch | lesson | 128 | github-mcp#219 |

Total des 7 : **872 jetons** (recalculés ; valeurs identiques aux `token_cost` persistés du D1, posés dès la proposition — migration 0003). Après activation des 7 : 152 + 872 = **1024 ≤ 1500 → AUCUN refus budget** (établi par calcul sur les textes exacts avec la formule canonique — conformément à la précision du GO : l'estimation seule ne préjugeait de rien, le calcul l'établit).

### 3.3 Tombstones, consolidations, refus de revue

- memory.retire : **0** ; memory.consolidate : **0** ; memory.review avec refus : **0** (journaux cc7 + memory-alarms).
- Baseline common : semée à la 1re activation (seq 919) = MAX(1, 0−1) = **1**.

### 3.4 Alarme et pause actuelles

- Pause : owner.request `mem-pause-92a5dc04bd6f9fb8f29f-1`, kind memory.pause, scope common, occurrence 1, reason growth — posée par « system » (cycle memory-alarms seq 921, 2026-10-26 09:18, immédiatement après l'activation seq 920 : 100·2 = 200 > 125·1).
- Statut : **OUVERTE** — aucune décision owner. L'approbation recalerait la base à MAX(1, COUNT actives) = 2 aujourd'hui.

## 4. Historique observable (données réelles, aucune simulation)

Le scope common a connu exactement : 9 propositions (seq 902, 903, 907, 908, 909, 925, 926, 927, 948 — correction revue GPT-6 : le « 2 » initial ne comptait que les propositions actives), 2 activations (seq 919, 920, reviewer ≠ auteur), 1 pause (memory-alarms seq 921), 0 reprise, 0 retrait, 0 consolidation, 0 refus de revue.

Sous la règle actuelle (k=0), la pause s'est déclenchée à n=2 sur base 1 — le défaut de baseline de scope neuf déjà établi (P1/P2) : +100 % > +25 % dès la 2e activation. **Sous la formule candidate, aucun k testé (3, 5, 8, 10) n'aurait déclenché de pause à n=2** (100·(2−1) = 100 ≤ 300 = plus petite marge testée).

**Indice d'utilité de la seule pause réelle (921)** : entre la pause (2026-10-26 09:18) et la rédaction de ce rapport, le scope common n'a enregistré AUCUN événement de correction, consolidation, retrait ou refus de revue — uniquement 4 nouvelles propositions (seq 925, 926, 927, 948). La pause reste ouverte : l'absence d'intervention enregistrée entre pause et reprise n'est PAS une preuve d'inutilité (corrélation ≠ causalité ; pause ouverte ≠ absence certaine d'intervention). Coût observable : les 7 candidates attendent depuis le 2026-10-26.

## 5. Comparaison des marges (simulations — hypothèses explicites)

Hypothèses communes : reprise simulée = recalage base ← n (**jamais une décision owner observée**) ; MAX_ACTIVATIONS_PER_CYCLE=10 non modélisé dans S1 (7 < 10) ; supposé s'étaler sur plusieurs cycles dans S2/S3 (hypothèse) ; algorithme : pour chaque activation n→n+1, si 100·(n+1−base) > max(25·base, 100·k) alors pause à n+1 et base ← n+1. L'algorithme est livré ré-exécutable par l'outil `collab_memory_growth_simulate` (§9, calcul pur : mêmes entrées, mêmes positions).

### S1 — Reprise actuelle approuvée (base=2), puis activation des 7 candidates dans l'ordre de proposition (n=2→9)

| k | pauses (n) | rechutes | décisions owner au total (reprise initiale incluse) |
|---|---|---|---|
| 0 (actuelle) | 3, 4, 6, 8 | 4 | 5 |
| 3 | 6 | 1 | 2 |
| 5 | 8 | 1 | 2 |
| 8 | aucune | 0 | 1 |
| 10 | aucune | 0 | 1 |

Budget : aucun refus (1024 ≤ 1500, §3.2).

### S2 — Projection : remplissage de common jusqu'au refus budget (base=2 ; coût moyen 124,6 jetons = HYPOTHÈSE, moyenne des 7 candidates connues ; arrêt à 10 activations → n=12, ≈1398/1500 ; la 13e entrée serait refusée : ≈1523 > 1500 — refus établi PAR CALCUL SOUS CETTE HYPOTHÈSE de coût moyen. Ré-exécution : `collab_memory_growth_simulate` {base:2, activations:10, k_values:[0], budget:{tokens_used:152, avg_cost:124.6, budget:1500}})

| k | pauses (n) | rechutes |
|---|---|---|
| 0 | 3, 4, 6, 8, 11 | 5 |
| 3 | 6, 10 | 2 |
| 5 | 8 | 1 |
| 8 | 11 | 1 |
| 10 | aucune | 0 |

Variante d'ancrage (consignée pour la reproductibilité) : en rejouant depuis l'ORIGINE avec la règle candidate (baseline 1, jamais interrompue — pas de pause à n=2), les positions se décalent (k=3 : [5, 9] ; k=5 : [7] ; k=8 : [10] ; k=10 : [12], cf. réponse Claude P4 seq 1054) : l'ancrage de la baseline change les positions, pas la méthode.

### S3 — Croissance prolongée à 40 entrées (base=2, n=2→40, budget non modélisé — hypothèse d'un scope à budget non limitant, type project/role)

| k | pauses (n) | rechutes |
|---|---|---|
| 0 | 3, 4, 6, 8, 11, 14, 18, 23, 29, 37 | 10 |
| 3 | 6, 10, 14, 18, 23, 29, 37 | 7 |
| 5 | 8, 14, 20, 26, 33 | 5 |
| 8 | 11, 20, 29, 38 | 4 |
| 10 | 13, 24, 35 | 3 |

## 6. Lecture honnête des résultats

- Nuance (revue GPT-6) : la sensibilité de la règle actuelle sur petite base est DÉMONTRÉE (pause réelle dès n=2 sur base 1) ; l'utilité du contrôle humain qu'est une pause reste NON DÉTERMINÉE — sur l'historique accessible, aucune marge candidate n'aurait interrompu le flux et la seule pause réelle est un faux positif du défaut de baseline de scope neuf.
- S1 (le scénario réaliste à court terme) sépare k=0 (4 rechutes) de k=3/k=5 (1 rechute chacun, à des positions différentes : 6 vs 8) et de k=8/k=10 (0 interruption — donc aucune porte humaine tant que le scope ne grossit pas à peu près ×4).
- S2/S3 montrent des positions et fréquences distinctes par marge, mais **aucune donnée n'établit l'UTILITÉ d'une interruption** : pas un seul événement réel de correction/consolidation/retrait lié à une pause n'est observable (§4).
- **Conclusion : NON DÉTERMINÉ.** Aucun classement optimal n'est annoncé ; la donnée manquante (interruptions suivies ou non d'interventions justifiées) ne peut s'accumuler qu'en production.

## 7. Recommandation (décision réservée à Kevin)

- Conserver **k=5 comme valeur initiale provisoire** (plan M1a/M1b) : 1re porte humaine à n=8 dans S1, au plus 2 décisions owner par cycle de remplissage au rythme observé. k=8/k=10 éliminent toute interruption sur l'historique accessible — aucune donnée ne prouve que c'est meilleur ou pire.
- Le réglage définitif devra venir des mesures du suivi M4 (2 cycles) : pauses réelles, refus budget, interventions post-pause, part du contexte servi. Nuance (revue GPT-6) : deux cycles de mesure = un premier bilan, pas la garantie d'un réglage définitif.
- Décisions réservées : valeur de k ; mem-pause-92a5dc04bd6f9fb8f29f-1 (APRÈS M1a+M1b fusionnés et déployés sur cc3-test) ; CR-C sur les agrégats privés ; GO déploiement.

## 8. Reproductibilité

- Métrique : estimateTokens(t) = ceil(len(t)/4) (contrat canonique, blob 252b356e au SHA de référence).
- Entrées : textes exacts des propositions (journal cc7 seq 902, 903, 907-909, 925-927, 948), textes actifs (export memory-md sha 1a32f22b…a87), paramètres du code au SHA 367203bc (§1).
- Algorithme des simulations : §5 (hypothèses communes), ré-exécutable par `collab_memory_growth_simulate` (S1 : base 2, activations 7 ; S2 : budget ci-dessus ; S3 : activations 38 — §9). Inventaire du §3 relisible et re-vérifiable par `collab_memory_inventory` (coûts persistés du D1). Toute divergence entre la règle déployée et ce document devra être relevée par la revue (GPT-6) ou le test (Claude) au couple SHA exact.

---

## 9. Composant livré (correctif de la revue GPT-6, CHANGES_REQUESTED)

La revue (PR #236, commentaire 6523145152) demandait le composant ré-exécutable ; il est livré au head de ce lot, toujours enregistrés (aucune porte) :

- **`collab_memory_inventory`** (lecture seule du D1) : entrées versionnées de tous statuts, multi-scopes, avec leur coût PERSISTÉ `token_cost` (posé dès la proposition, migration 0003 — le rapport initial les disait « estimés » : corrigé §2) ; pagination keyset (`cursor` base64 [scope, id, version] = position dans l'ordre global — les filtres s'appliquent à chaque appel, indépendamment du curseur, le scope du curseur reste soumis à CR-C ; ordre scope/id/version, `limit` 1-200, défaut 50, curseur illisible → `MEMORY_CURSOR_INVALID`) ; rollup par scope (budget `MEMORY_TOKEN_BUDGETS`, comptes par statut, tokens actifs, baseline/occurrences/pause) ; pauses du cycle memory-alarms avec décision owner et **corrective_events** (memory.consolidate/memory.retire de la fenêtre [ouverture, décision ou maintenant], borne d'ouverture par `seq` du journal, résolus id → scope, CR-D). CR-C : scopes partagés + scopes participant de l'appelant (familles logiques) ; `participant:<autre>` → `MEMORY_SCOPE_FORBIDDEN` ; client non enregistré = partagés seulement — ni contenu ni agrégat d'un scope privé tiers (couvert par les tests e2e).
- **`collab_memory_growth_simulate`** (calcul pur, zéro lecture du store) : positions de pause par marge k (règle `100·(n−base) > max(25·base, 100·k)`, reprise simulée immédiate base ← n) et projection de remplissage de budget à coût moyen (`avg_cost` > 0 exigé : un coût moyen nul ne produit jamais de refus — refus typé `MEMORY_SIMULATION_INVALID`, jamais une boucle) — S1/S2/S3 ci-dessus re-exécutables à l'identique (§5, §8).
- **Tests** : `test/collab-store/mcp/memory-inventory-e2e.spec.ts` — 5 parcours HTTP : CR-C (contenu, agrégat, refus nominal, anonyme) ; pagination (6 entrées, limit 2 → 3 pages, égalité recalculé = persisté, `MEMORY_CURSOR_INVALID`) ; statuts et versions (v1 superseded, v2 retirée, filtre status, `supersedes id@1`) ; pause → consolidation corrective → approbation owner (request_seq = opened_seq, cycle_id memory-alarms) → rechute avec fenêtres correctives — adapté à la marge combinée M1a fusionnée (pause à `growthMaxActive(1)+1`, rechute à la `SECOND_PAUSE`-ième activation — la consolidation corrective pendant la pause ne laisse que `FIRST_PAUSE−1` actives à la reprise, le plancher de marge 100·5 maintient la position ; second cycle post-reprise — canon CR-F02) ; simulations S1/S2/S3 + défauts + garde avg_cost = 0 (`MEMORY_SIMULATION_INVALID`, tokens_used <= et > budget). Catalogue renforcé : défaut 15→17, salon 19→21, agentruns 17→19 (`catalog.spec.ts`) ; comptage `tools/list` de L11 mis à jour 18→20 (`cc7-l11-research.spec.ts`).
- **Découpage explicite** : la règle candidate k (valeur, activation) reste M1a ; le suivi M4 (mesures des pauses réelles) n'est pas couvert par ce lot ; M1b n'est PAS terminé tant que la revue et le test au nouveau couple SHA ne passent pas.
- **Retour de CI (2e série)** : le premier run du correctif échouait sur (i) la fenêtre corrective de la rechute — une consolidation posée avant l'ouverture de l'occurrence 2 y tombait par égalité d'horloge à la seconde : borne d'ouverture corrigée par `seq` du journal ; (ii) le comptage `tools/list` du catalogue L11 (18→20, deux outils M1b toujours enregistrés). Aucun seuil, aucune baseline, aucune sémantique d'erreur modifiés.
- **Re-revue GPT-6 (3e série, commentaire 6524079304, CHANGES_REQUESTED)** : (P1) `simulateBudgetFill` bouclait indéfiniment pour `avg_cost = 0` tant que `tokens_used <= budget` — garde fail-closed ajoutée (`avg_cost > 0`, refus typé `MEMORY_SIMULATION_INVALID`), testée pour `tokens_used <= budget` ET `tokens_used > budget` ; (P2) le curseur n'est pas lié aux filtres — comportement INTENTIONNEL, désormais documenté au guide et à la description de l'outil : le curseur est une position dans l'ordre global (scope, id, version), les filtres `scopes`/`status` s'appliquent à chaque appel indépendamment de la position, le scope du curseur reste soumis à CR-C — testé (curseur réutilisé avec un filtre `status` différent : continuation cohérente depuis la position).
- **Fusion M1a et diagnostic CI (correctif final)** : M1a (#237, marge combinée `growthMaxActive`) est fusionnée dans la branche (merge de `eb135a93`) ; l'échec CI du test pause venait de la base de la PR passée à `eb135a93` — la CI `pull_request` teste le merge du head avec la base COURANTE, pas le head seul. Le test est réécrit pour la règle M1a : pause du scope neuf à `growthMaxActive(1)+1` (7e activation), rechute à la 13e — la consolidation corrective pendant la pause ne laisse que `FIRST_PAUSE−1` actives à la reprise, le plancher de marge 100·5 maintient la position ; activations post-reprise en second cycle (canon CR-F02). La réplique de diagnostic (copie byte-for-byte du canon pour bisect) est retirée : elle causait la duplication Sonar 15,1 % > 3 %.
- **Re-revue 2 GPT-6 (commentaire 6530061790, couple bd05b41c/eb135a93)** : (P1) la boucle de remplissage restait non bornée pour un `avg_cost` positif minuscule (ex. 0,000001 avec budget 100 000 000 ≈ 10^14 itérations avant refus, épuisement CPU possible) — `simulateBudgetFill` remplacée par un calcul fermé : accepted = plancher de (budget − tokens_used) / avg_cost (réalignement flottant borné à deux rangs, total plafonné au budget), refus typés `MEMORY_SIMULATION_INVALID` pour valeurs non finies, quotient infini (coût dénormalisé) et progression non mesurable ; test ajouté (coût minuscule + budget maximal : réponse immédiate, accepted = 10^14, refused = 10^14+1, tokens_after = 100 000 000 ; coût dénormalisé refusé). (P2) sémantique du curseur : choix de contrat déjà documenté (3e série), non bloquant — inchangé.

Rapport en lecture seule — aucune mémoire modifiée, aucun seuil/baseline changé, aucune décision owner prise en son nom ; les outils du §9 sont eux-mêmes lecture seule / calcul pur.
