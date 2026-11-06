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
| Budget gratuit review / test (coût 0) | 16 000 | 48 000 (`FREE_VERIFY_DEFAULT_TOKENS`) — **à confirmer par Kevin** |
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

### Hors périmètre (aucun effet)

- runs `implement` (déjà guidés par S7) et autres types ;
- consignes sans couple head/base exact ;
- moteur sans `guidedVerify` (activé dans `object.ts`).

## Tests

`test/collab-store/agentrun/cc8-s7-verify-guided.spec.ts` : couple lu dans la consigne ; contexte borné
au diff maximal ; CI filtrée au head ; ordre source → tests → doc ; lectures serveur une seule fois puis
relecture D1 ; arguments au couple exact ; tous les outils offerts ; panne de lecture signalée ; compaction
à la 3e étape ; aucun effet hors périmètre. `cc8-s7-implement-steps.spec.ts` : budget gratuit 48 000,
payant 16 000.

## Suite

Lot suivant : le coordinateur réveillé et guidé par le même système (décision de Kevin requise : modèle
gratuit autorisé pour gpt6 ou réaffectation du rôle).
