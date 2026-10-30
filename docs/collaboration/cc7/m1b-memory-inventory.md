# M1b — Rapport d'inventaire mémoire et comparaison des seuils de pause (lecture seule)

- **Lot** : CC-7 M1b — GO seq 1057 (feu vert Kevin relayé par GPT-6 ; attribution confirmée en conversation, ce n'est PAS une owner.decision /owner installée).
- **Auteur** : Vibe — relecteur : GPT-6 ; testeur : Claude ; fusion : Kevin seul.
- **Date** : 2026-10-30. Journaux : cc7-api-auto (consultation) + memory-alarms (alarme).
- **Nature** : STRICTEMENT LECTURE SEULE — aucune activation, consolidation, retire ; aucun changement de seuil/baseline ; aucun code modifié (ce rapport est le seul fichier du lot).

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
- Coûts des candidates = ESTIMÉS (formule canonique sur le texte de proposition) ; jamais persistés avant activation. Les coûts des actives sont ceux des textes proposés (= persistés à l'activation, la métrique ne dépend pas de l'état).

## 3. Inventaire (au 2026-10-30, avant toute décision mem-pause)

### 3.1 Entrées actives (3)

| id | v | scope | kind | confiance | auteur | reviewer | proposée | activée | coût jetons |
|---|---|---|---|---|---|---|---|---|---|
| cc7-lesson-sealed-payload | 1 | common | lesson | observed | claude | grok | seq 902 (2026-10-26 08:28) | seq 919 (09:18, grok) | 70 |
| cc7-lesson-memory-error-mapping | 1 | common | lesson | observed | claude | grok | seq 903 (08:28) | seq 920 (09:18, grok) | 82 |
| lesson-read-truncation-before-replace | 1 | participant:vibe | lesson | observed | vibe | vibe | hors journal cc7 (cycle antérieur) | — | ≈136 (estimé depuis l'export, préfixe déduit) |

common : 2 actives, **152/1500 jetons** (10,2 % du budget). participant:vibe : 1 active, ≈136/500.

### 3.2 Candidates en attente (7 — toutes scope common, confiance observed, auteur vibe, bloquées par la pause)

| seq (date UTC) | id | kind | coût estimé | preuves |
|---|---|---|---|---|
| 907 (2026-10-26 08:31) | cc7-fact-xai-adapter-request-body | fact | 117 | github-mcp#214 ; store seq 896 |
| 908 (08:31) | cc7-lesson-second-adapter-shared-socle | lesson | 124 | github-mcp#214 |
| 909 (08:31) | cc7-lesson-adapter-test-contract-by-fixture | lesson | 113 | github-mcp#214 |
| 925 (10:12) | cc7-fact-anthropic-messages-protocol | fact | 127 | github-mcp pull/215 ; store seq 924 |
| 926 (10:12) | cc7-lesson-third-adapter-protocol-core | lesson | 135 | pull/215 ; #214 (7b0d7886) |
| 927 (10:12) | cc7-lesson-elision-scanner-assertion-thresholds | lesson | 128 | pull/215 (0fbd2112/b9022ad2/592406ae) |
| 948 (14:01) | cc7-lesson-lookup-test-one-pr-per-branch | lesson | 128 | github-mcp#219 |

Total estimé des 7 : **872 jetons**. Après activation des 7 : 152 + 872 = **1024 ≤ 1500 → AUCUN refus budget** (établi par calcul sur les textes exacts avec la formule canonique — conformément à la précision du GO : l'estimation seule ne préjugeait de rien, le calcul l'établit).

### 3.3 Tombstones, consolidations, refus de revue

- memory.retire : **0** ; memory.consolidate : **0** ; memory.review avec refus : **0** (journaux cc7 + memory-alarms).
- Baseline common : semée à la 1re activation (seq 919) = MAX(1, 0−1) = **1**.

### 3.4 Alarme et pause actuelles

- Pause : owner.request `mem-pause-92a5dc04bd6f9fb8f29f-1`, kind memory.pause, scope common, occurrence 1, reason growth — posée par « system » (cycle memory-alarms seq 921, 2026-10-26 09:18, immédiatement après l'activation seq 920 : 100·2 = 200 > 125·1).
- Statut : **OUVERTE** — aucune décision owner. L'approbation recalerait la base à MAX(1, COUNT actives) = 2 aujourd'hui.

## 4. Historique observable (données réelles, aucune simulation)

Le scope common a connu exactement : 2 propositions (seq 902, 903), 2 activations (seq 919, 920, reviewer ≠ auteur), 1 pause (memory-alarms seq 921), 0 reprise, 0 retrait, 0 consolidation, 0 refus de revue.

Sous la règle actuelle (k=0), la pause s'est déclenchée à n=2 sur base 1 — le défaut de baseline de scope neuf déjà établi (P1/P2) : +100 % > +25 % dès la 2e activation. **Sous la formule candidate, aucun k testé (3, 5, 8, 10) n'aurait déclenché de pause à n=2** (100·(2−1) = 100 ≤ 300 = plus petite marge testée).

**Indice d'utilité de la seule pause réelle (921)** : entre la pause (2026-10-26 09:18) et la rédaction de ce rapport, le scope common n'a enregistré AUCUN événement de correction, consolidation, retrait ou refus de revue — uniquement 4 nouvelles propositions (seq 925, 926, 927, 948). La pause reste ouverte : l'absence d'intervention enregistrée entre pause et reprise n'est PAS une preuve d'inutilité (corrélation ≠ causalité ; pause ouverte ≠ absence certaine d'intervention). Coût observable : les 7 candidates attendent depuis le 2026-10-26.

## 5. Comparaison des marges (simulations — hypothèses explicites)

Hypothèses communes : reprise simulée = recalage base ← n (**jamais une décision owner observée**) ; MAX_ACTIVATIONS_PER_CYCLE=10 non modélisé dans S1 (7 < 10) ; supposé s'étaler sur plusieurs cycles dans S2/S3 (hypothèse) ; algorithme : pour chaque activation n→n+1, si 100·(n+1−base) > max(25·base, 100·k) alors pause à n+1 et base ← n+1.

### S1 — Reprise actuelle approuvée (base=2), puis activation des 7 candidates dans l'ordre de proposition (n=2→9)

| k | pauses (n) | rechutes | décisions owner au total (reprise initiale incluse) |
|---|---|---|---|
| 0 (actuelle) | 3, 4, 6, 8 | 4 | 5 |
| 3 | 6 | 1 | 2 |
| 5 | 8 | 1 | 2 |
| 8 | aucune | 0 | 1 |
| 10 | aucune | 0 | 1 |

Budget : aucun refus (1024 ≤ 1500, §3.2).

### S2 — Après reprise, remplissage de common jusqu'au refus budget (base=2 ; coût moyen 124,6 jetons = moyenne des 7 candidates ; arrêt à 10 activations → n=12, ≈1398/1500 ; la 13e entrée serait refusée : ≈1523 > 1500 — refus ÉTABLI par calcul)

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

- Sur l'historique réel accessible, AUCUNE marge candidate n'aurait interrompu le flux : la seule pause réelle est un faux positif du défaut de baseline de scope neuf.
- S1 (le scénario réaliste à court terme) sépare k=0 (4 rechutes) de k=3/k=5 (1 rechute chacun, à des positions différentes : 6 vs 8) et de k=8/k=10 (0 interruption — donc aucune porte humaine tant que le scope ne grossit pas à peu près ×4).
- S2/S3 montrent des positions et fréquences distinctes par marge, mais **aucune donnée n'établit l'UTILITÉ d'une interruption** : pas un seul événement réel de correction/consolidation/retrait lié à une pause n'est observable (§4).
- **Conclusion : NON DÉTERMINÉ.** Aucun classement optimal n'est annoncé ; la donnée manquante (interruptions suivies ou non d'interventions justifiées) ne peut s'accumuler qu'en production.

## 7. Recommandation (décision réservée à Kevin)

- Conserver **k=5 comme valeur initiale provisoire** (plan M1a/M1b) : 1re porte humaine à n=8 dans S1, au plus 2 décisions owner par cycle de remplissage au rythme observé. k=8/k=10 éliminent toute interruption sur l'historique accessible — aucune donnée ne prouve que c'est meilleur ou pire.
- Le réglage définitif devra venir des mesures du suivi M4 (2 cycles) : pauses réelles, refus budget, interventions post-pause, part du contexte servi.
- Décisions réservées : valeur de k ; mem-pause-92a5dc04bd6f9fb8f29f-1 (APRÈS M1a+M1b fusionnés et déployés sur cc3-test) ; CR-C sur les agrégats privés ; GO déploiement.

## 8. Reproductibilité

- Métrique : estimateTokens(t) = ceil(len(t)/4) (contrat canonique, blob 252b356e au SHA de référence).
- Entrées : textes exacts des propositions (journal cc7 seq 902, 903, 907-909, 925-927, 948), textes actifs (export memory-md sha 1a32f22b…a87), paramètres du code au SHA 367203bc (§1).
- Algorithme des simulations : §5 (hypothèses communes). Toute divergence entre la règle déployée et ce document devra être relevée par la revue (GPT-6) ou le test (Claude) au couple SHA exact.

---

Rapport en lecture seule — aucune mémoire modifiée, aucun seuil/baseline changé, aucune décision owner prise en son nom.
