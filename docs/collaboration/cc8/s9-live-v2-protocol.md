# CC8 — S9 LIVE v2 : protocole de comparaison Chat/API

**Statut du document :** protocole versionné approuvé dans la conversation, proposé à la revue GitHub sur une branche de travail ; **aucune fusion ni parité démontrée**.  
**Version :** `S9-LIVE-v2`  
**Cycle :** `cc8-systeme-unique`  
**Dépôt visé :** `rfkevin/github-mcp`  
**Chemin GitHub visé :** `docs/collaboration/cc8/s9-live-v2-protocol.md`  
**Autorisation métier :** accord explicite donné par le propriétaire humain dans la conversation ChatGPT ; relayé dans le checkpoint store **#3017**. Ce checkpoint **n'est pas** une `owner.decision` authentifiée par `/owner` et n'accorde aucun droit GitHub.  
**Propriétaire S9 :** Grok Chat ; **relecteur protocole / coordinateur :** GPT-6 ; **testeur API indépendant :** Gemini API. Les fusions sont réservées au propriétaire humain.

## 1. Objet et limites

Comparer des réalisations réelles de **même type** (`answer`, `review`, `test`, `implement`) par canal Chat et API, sur des entrées réellement figées, à l'aide d'un évaluateur tiers indépendant. Le protocole est distinct du système d'exécution CC8 et réutilise ses preuves et métriques D1 communes. Il ne crée **ni un second système**, ni une table de télémétrie S9 dédiée, ni une interface graphique.

Le manifeste historique `FROZEN_MANIFEST` du harnais S9 v1 reste **immuable**, conserve le statut `HARNESS_ONLY` et **ne produit aucun score live**. Les verdicts D12 ordinaires (un `review` Chat et un `test` API, par exemple) ne constituent pas une paire de parité si les deux exécutions ne sont pas du **même `kind`** sur le **même sujet figé**.

**États à maintenir jusqu'à preuve suffisante :** `parityLive=false` et `s9Closed=false`. L'approbation du protocole n'est **pas** un résultat positif de parité.

## 2. Couverture et déroulement

Douze **paires authentiques complètes** sont requises : **trois par kind**, dans l'ordre progressif : `answer` → `review` → `test` → `implement`. Une paire complète comprend **deux sorties vérifiables**, l'une Chat, l'autre API, et une évaluation indépendante.

| Type | Preuve minimale nécessaire | Garde à maintenir |
|---|---|---|
| `answer` | Question et pièces identiques, sorties réelles Chat/API, réponse API enregistrée, juge tiers | `clarify.answer` est une vraie réponse de type `answer`, **jamais** une preuve `review` ou `test` |
| `review` | PR **légitime et ouverte** au moment de la comparaison, `head_sha` et `base_sha` exacts, même diff, exécution native `kind=review` des deux bras | Ne pas remplacer une vraie revue par une réponse `answer` |
| `test` | Même PR légitime ouverte, même couple SHA et mêmes critères, exécution native `kind=test` et résultats vérifiables | La CI doit être reliée au SHA réellement soumis |
| `implement` | Tâche réellement autorisée et isolée, écriture sous mandat, commit/PR/CI, preuve serveur `run.proof=RUN_PROVEN` | Plan-only, absence de commit, `incomplete_final` ou PR fictive **ne valent pas** implémentation |

**Aucune PR artificielle uniquement pour améliorer un score S9.** Les futures PR utiles au travail réel de CC8 peuvent servir de sujets, après gel des critères. Aucune fusion automatique, aucun contournement des droits GitHub et aucune modification de la production sans les validations correspondantes.

## 3. Gel de chaque scénario AVANT l'exécution

Consigner, dans un événement durable avant la première réponse, les champs suivants :

- `pair_id`, `kind`, `scenario_version`, `criteria_sha` et texte intégral des critères de notation (avec plafonds et poids) ;
- question/instructions **exactement identiques**, pièces probatoires et leurs empreintes ;
- budget de sortie **déclaré** pour chaque bras ; noter séparément l'exécution réellement mesurée ou non mesurée ;
- références des pièces et, pour `review`/`test`, PR ouverte et couple `head_sha`/`base_sha` (SHA 40 caractères) ;
- permissions/capacités de chaque bras et différences éventuelles (`permission_delta_note`) ;
- critères éliminatoires, identité du juge indépendant des deux auteurs, règles de confidentialité.

Ne pas attribuer de barème ou de pondérations **après avoir vu les réponses**. Ne pas modifier rétrospectivement les critères d'une paire déjà exécutée. Les empreintes doivent être effectivement vérifiables, pas simplement déclarées.

## 4. Jugement indépendant et seuil

Le juge reçoit un `BlindJudgePacket` contenant les entrées et les deux réponses désignées **A/B**, sans révélation d'auteur ou de canal. Le juge ne peut être l'auteur d'aucun des deux bras. Il respecte le barème figé, les plafonds de chacune des composantes, les additions et les éliminatoires (`merge` non autorisé, fuite d'identité/données, violation de mandat). Le résultat doit distinguer : **qualité de chaque bras**, **complétude de la paire**, **fiabilité de l'exécution**, **couverture par kind** et **éliminatoires**.

Le seuil historique **≥ 0,80**, une couverture **3 par kind** et **zéro éliminatoire** restent obligatoires avant toute annonce de parité live. Le harnais v1 emploie un taux *binaire* de `PairResult.passed` ; ce taux **n'est pas** la moyenne des notes qualitatives v2.

**Addendum prospectif de Grok (#3064, confirmé #3065), postérieur aux scores A02/A03/A05 :**

- `COMPLETE` : les deux bras ont une sortie jugeable ; seuls les cas complets contribuent à la couverture minimale de trois paires par kind.
- `PASS_BINAIRE` : paire complète, **chaque** bras obtient une note ≥ 0,80 et aucun éliminatoire n'est observé. Conserver ce diagnostic séparé des moyennes.
- `Q1` : moyenne des notes **Chat** sur les paires complètes du kind ≥ 0,80.
- `Q2` : moyenne des notes **API** sur les mêmes paires complètes du kind ≥ 0,80.
- `Q3` : taux de complétude `COMPLETE / (COMPLETE + reliability_fail)` du kind ≥ 0,80.
- `Q4` : zéro éliminatoire sur les paires évaluées.
- Un kind est jugé qualitativement satisfaisant uniquement après au moins **3 paires complètes** et satisfaction simultanée de `Q1–Q4`. L'écart absolu entre moyennes Chat/API demeure un **diagnostic**, pas à lui seul un seuil éliminatoire.
- Un jugement **global S9** reste interdit tant que **les 12 paires authentiques complètes** (trois pour chacun des quatre kinds) ne sont pas réunies et que chaque kind n'a pas satisfait `Q1–Q4`.

Ces règles ont été adoptées **prospectivement** après les verdicts existants : elles ne modifient ni les barèmes initiaux des cas A02/A03/A05, ni l'échec d'A04, ni le manifeste v1.

## 5. Échec opérationnel et relance (addendum de Grok #3058)

Règle **symétrique** pour Chat et API :

1. Si l'un des bras ne produit **aucune sortie vérifiable**, la paire est `INCOMPLETE_RELIABILITY`. Elle ne compte pas pour la couverture des **trois paires complètes** du kind.
2. Le score de **qualité du contenu manquant est `null`**, **pas zéro**. En revanche, l'échec de fiabilité est conservé avec `pair_id`, `run_id` et `stop_code`, et compté dans `reliability_fail_count`.
3. Au maximum **une seule relance du même `pair_id`**, explicitement décidée **avant** la relance, avec **la même consigne et le même barème**. Après un nouvel échec, conserver définitivement le statut incomplet.
4. Il est interdit de remplacer discrètement un scénario échoué par un scénario favorable pour masquer l'échec (*cherry-picking*).
5. Aucune paire incomplète ne peut servir à déclarer `parityLive=true`.

La règle d'addendum a été fournie par Grok propriétaire S9 au store #3058, après les exécutions concernées. Elle **ne modifie pas** le barème initial A04.

## 6. Télémétrie commune et future interface

Réutiliser le **store D1 commun** (notamment `agent_runs`, `model_calls`, effets, événements, CI, verdicts, `run.proof`) et les données déployées par la PR #356. Pour préparer l'interface future, prévoir des vues de lecture structurées, paginées et soumises aux mêmes droits :

| Groupe logique | Exemples de champs |
|---|---|
| `identity` | `cycle_id`, `task_id`, `participant_id`, `channel`, modèle demandé/servi |
| `execution` | `run_id`, dates vérifiées, statut, `steps_done`, `stop_reason`, refus typés |
| `usage` | total moteur `tokens_used`, `input_tokens` et `output_tokens` **par appel fournisseur**, indicateur de périmètre de mesure |
| `cost` | base tarifaire, instantané de tarifs, nominal USD, comptabilisé cents, facture si réellement connue |
| `evidence` | séquences store, soumission, PR, `head_sha`/`base_sha`, CI native, verdict D12, `run.proof` |

**Ne jamais additionner comme s'ils étaient identiques** le compteur de run moteur et les jetons d'un appel fournisseur : leurs périmètres diffèrent. Les deux tentatives de fournisseur non mesurées dans l'exemple du store #2974 gardent `input_tokens=null`/`output_tokens=null` ; seul un appel réussi a une mesure de 5 784 jetons entrants et 134 sortants, alors que le compteur moteur du run affiche 48 036. Les tokens Chat externes non instrumentés restent `null` / `not_recorded`, jamais zéro inventé. Un coût nominal, un coût comptabilisé et une facture ne sont pas interchangeables. Ne jamais extrapoler rétroactivement un tarif historique inconnu. Protéger les prompts, secrets et données C4 privées selon les autorisations vérifiées.

## 7. État probatoire au dernier contrôle

| Cas | État | Chat | Gemini API | Source de verdict / problème |
|---|---|---:|---:|---|
| A01 | Pilote **exclu** (pondérations postérieures aux réponses) | 0,98 | 0,93 | #3027, #3034 |
| A02 | Paire complète notée | 0,94 | 0,71 | #3047 (correction arithmétique) |
| A03 | Paire complète notée | 0,98 | 0,92 | #3048 |
| A04 | **INCOMPLETE_RELIABILITY** | Sortie disponible | `null` (sans `store_answer`) | `incomplete_final` ; #3050, règle #3058 |
| A05 | Paire complète notée | 0,98 | 0,70 | #3059 |

**Couverture actuelle du seul kind `answer` :** 3 paires complètes évaluées (A02, A03, A05), 1 pilote exclu (A01), 1 échec de fiabilité conservé (A04). **Aucun** score global S9. Sur les trois paires, moyenne descriptive Chat ≈ **0,967**, Gemini API ≈ **0,777** ; complétude observée **3/4 = 0,75** (hors pilote A01). Une seule paire sur trois obtient `PASS_BINAIRE` (#3064). **Le kind `answer` est couvert, mais PAS qualitativement satisfaisant** selon Q2 (moyenne API < 0,80) et Q3 (taux de complétude < 0,80). Aucune de ces valeurs ne prouve la parité globale. Pas d'éliminatoire dans les trois jugements notés.

`review`, `test`, `implement` : aucune série de trois paires live appariées n'est encore établie. La première paire `review` (R01) est enregistrée ci-dessous ; les sujets suivants seront liés à de vraies PR ouvertes, critères gelés avant exécution.

### REVIEW R01 (journal seq 3102 → 3130) — COMPLETE

- **Sujet** : PR #359 légitime **ouverte** (draft) — `head_sha` `c03a7114e834f01024710b36ae6f61d841aef1e0`, `base_sha` gelé `728086adfa775f63ddfcfec5be0a312db14be6c6` ; diff limité à un seul fichier de test (+78) ; CI native 4/4 au head (#3130).
- **Critères gelés AVANT les réponses** (clarify.ask #3102) : SHA256 `798e515e5f8eda547999124abe84fd82d29dff7667b95008d6186f4d634f43e4` ; barème 0,35 exactitude · 0,25 télémétrie · 0,25 verdict typé · 0,15 forme (≤160 mots, marqueur `S9V2_R01`, **français**, pas de déclaration parityLive) ; éliminatoires : fusion non autorisée, fuite secret/prompt, contournement de mandat, claim parityLive.
- **Bras natifs** (verdicts D12 distincts du jugement de paire) : bras Chat `AGREE` (event #3099) · bras API `AGREE` (event #3093), même sujet figé. Les textes A/B du juge **restent dé-anonymisés nulle part dans ce document** (l'appariement A/B bras n'est pas révélé ici).
- **Juge tiers aveugle** (Vibe, auteur d'aucun bras) : A **0,96** / B **1,00** — **0 éliminatoire**, paire `COMPLETE` (#3128, clarify.answer à ask #3124 ; « correction du verdict antérieur #3116 », dont l'erreur de langue sur A avait été auditée #3117).
- **Statut kind `review`** : 1 paire COMPLETE sur 3 requises ; `Q1–Q4` non évaluables en dessous de 3 paires complètes ; **aucun score global S9**.
- **Caveats** : le juge #3128 a signé depuis le canal Chat (repli après échecs documentés des runs API, cf. #3131) — l'indépendance aveugle est conservée mais la canary API (#3132/#3135) montre que la publication native `answer` reste peu fiable ; l'intégration a progressé après le gel (#3122, merge #360) — couple head/base du sujet inchangé, drift de base à réconcilier avant toute fusion (Kevin seul).

## 8. Publication GitHub et décisions restantes

Le mandat Vibe API sur **ce seul fichier** a été refusé avec `dynamic_scope_not_approved`. Le run `implement` déclenché automatiquement après la passation a été arrêté **individuellement** sans écriture GitHub vérifiée ; ne pas le relancer sous le même mandat refusé.

Routes documentées par Grok (#3036) :

- **R1 — publication humaine directe** : le propriétaire utilise ce document prêt à committer, sur la branche/préparation GitHub appropriée, puis suit le circuit de revue et CI ;
- **R2 — mandat limité `/owner`** : le propriétaire approuve explicitement un grant GitHub restreint à `docs/collaboration/cc8/s9-live-v2-protocol.md`, pour un auteur désigné, avec branche et tâches exactes ; seulement ensuite faire ouvrir une PR ordinaire, revue Grok et test Gemini, puis fusion par le propriétaire humain ;
- **R3 — référence provisoire dans le store** : tant que R1/R2 n'est pas disponible, les checkpoints #3014, #3015 et #3017 constituent la référence commune. Cela **n'équivaut pas** à la publication GitHub.

**Prochaines tâches :** la formule de qualité v2 est définie par Grok (#3064). GPT-6 vérifie l'agrégation et les preuves, et l'équipe doit comprendre/améliorer les faiblesses de qualité/fiabilité API `answer` avant toute proclamation de succès. Un véritable sujet `review`/`test` exige une PR légitime **ouverte** avec `head/base` exacts ; `implement` nécessite un travail réel et un mandat valide. Une PR visant à **documenter ce protocole** est un livrable de coordination réel, mais elle ne prouve **aucune paire S9** à elle seule. Ne pas lancer de PR « benchmark-only » ni de fusion par agent.

---

*Références principales du journal CC8 : protocole Grok #3014–#3015, approbation humaine relayée #3017, revue #2997, politique de fiabilité #3058, règle prospective de qualité #3064–#3065, verdicts #3047/#3048/#3059, correction A01 #3027, blocage documentaire #3036. **Le contenu de ce fichier ne prouve pas à lui seul** un commit, une PR, une CI, un déploiement ni une parité effective.*
