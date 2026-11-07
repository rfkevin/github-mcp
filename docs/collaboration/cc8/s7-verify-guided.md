# CC8 S7 — vérification guidée (review / test)

Décision de Kevin (07/11) : un **système unique** pour tous les runs API — implémentation, relecture,
test — par la compaction et le guidage déjà en place, **en laissant la liberté au modèle**.

## Constat

Les runs API de test de Vibe (`zai:glm-4.7-flash`) sur S7-guided et S7-hardening-B se sont arrêtés en
`token_limit` (18 000 à 30 000 jetons) après 3 étapes, sans verdict : le modèle devait tout orchestrer
(PR, CI, diff jusqu'à 50 fichiers × 2 000 caractères, verdict) et l'historique complet, diff compris,
était renvoyé à chaque étape. Compaction et guidage n'existaient que pour `implement`.

## Ce qui change

| Élément | Avant | Après |
|---|---|---|
| Compaction de l'historique (`buildMessages`) | implement | implement, review, test |
| Contexte préparé par le serveur | implement (S7 guidé) | + review / test (`verify-guided.ts`) |
| Budget gratuit review / test (coût 0) | 16 000 | 48 000 (`FREE_VERIFY_DEFAULT_TOKENS`) — décision de Kevin, 07/11 (« 48k par défaut ») |
| Budget payant review / test | 16 000 | 16 000 (inchangé) |
| Outils offerts au modèle | tous | tous (inchangé : liberté) |

### Contexte de vérification (`src/collab-store/agentrun/verify-guided.ts`)

Au premier appel modèle d'un run `review` ou `test` dont la consigne contient
« Couple exact à vérifier : head X, base Y. » :

1. le serveur lit, **avec les outils du run** (mêmes gardes, même dépôt) :
   - `github_diff` au couple exact — ce qui journalise la preuve de lecture exigée par `store_verdict` ;
   - `github_check_runs` au head ;
   - `github_pull_request` si le numéro de PR est trouvé dans la soumission (`evidence.add` ou `run.proof` au même head) ;
2. il en fait un texte borné (`VERIFY_CONTEXT_MAX` = 14 000 caractères) : état de la PR et concordance du
   head, CI au head seulement, liste des fichiers, extraits de patch (source, puis tests, puis le reste) ;
3. le texte est conservé dans `agent_run_verify_contexts` (append-only, une ligne par run) et réinjecté à
   chaque étape avec une consigne courte : verdict une fois par `store_verdict`, au couple exact.

Une lecture qui échoue est **signalée** dans le contexte (« Lecture serveur impossible : … »), jamais
inventée ; le run continue et le modèle peut refaire la lecture. Le contexte est une donnée, pas une
instruction : il ne change ni le verdict exigé, ni les contrôles de `store_verdict` (D12, couple exact, CI).

### Preuve de lecture (relecture D12 GPT-6 #286, V1)

Le contexte est borné : il peut omettre des fichiers ou des extraits. La prélecture serveur ne doit donc
pas valoir, à elle seule, inspection du diff pour un verdict positif.

- La prélecture serveur passe le drapeau `prefetch` (posé par le serveur seulement, jamais par un appel
  modèle) ; `github_diff` la journalise sous `github_diff_prefetch`, distincte de `github_diff`.
- `agent_run_verify_contexts.complete` = 1 seulement si le texte injecté contient le diff ENTIER : tous les
  fichiers listés, tous les extraits, rien coupé par le budget, et aucune troncature ni absence côté outil
  (`files_truncated`, `patch_truncated`, patch absent ou vide → partiel ; relecture GPT-6, V1a).
- La lecture est journalisée au **couple** lu (`ref_sha` = `head:base`, `diffReadRef`) : un diff lu avec une
  autre base ne prouve rien pour le couple de la PR (relecture GPT-6, V1b). La base doit être le SHA exact.
- Contrôle ⑦ de `store_verdict` (`verifyReadProof`) : une lecture `github_diff` du modèle au couple exact
  suffit toujours ; la prélecture au couple exact suffit pour un verdict négatif (retarder) et, pour
  AGREE/PASS, seulement si le contexte au même couple était complet. Sinon `VERDICT_READ_PROOF_MISSING`.
- La consigne le dit au modèle : « Contexte PARTIEL … lisez vous-même le diff avec github_diff ».

### Hors périmètre (aucun effet)

- runs `implement` (déjà guidés par S7) et autres types ;
- consignes sans couple head/base exact ;
- moteur sans `guidedVerify` (activé dans `object.ts`).

## Tests

`test/collab-store/agentrun/cc8-s7-verify-guided.spec.ts` : couple lu dans la consigne ; contexte borné
au diff maximal ; CI filtrée au head ; ordre source → tests → doc ; lectures serveur une seule fois puis
relecture D1 ; arguments au couple exact ; tous les outils offerts ; panne de lecture signalée ; compaction
à la 3e étape ; aucun effet hors périmètre ; couverture complète ou partielle ; lectures serveur marquées
`prefetch`. `cc7-l5b-store-verdict.spec.ts` : diff complet → AGREE immédiat accepté ; diff tronqué → AGREE
immédiat refusé, CHANGES_REQUESTED accepté, AGREE accepté après `github_diff` du modèle ; un seul patch
tronqué (3 000 → 2 000) → AGREE immédiat refusé ; diff lu avec une autre base → tout verdict refusé.
`cc8-s7-implement-steps.spec.ts` et `cc8-s1b-attempts.spec.ts` : budget gratuit 48 000, payant 16 000.

## Suite

Lot suivant : le coordinateur réveillé et guidé par le même système (décision de Kevin requise : modèle
gratuit autorisé pour gpt6 ou réaffectation du rôle).
