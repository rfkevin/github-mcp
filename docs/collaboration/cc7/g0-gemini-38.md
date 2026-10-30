# CC-7 G0 — Gemini 3.8 Flash et Gemini comme agent API

Décisions de Kevin du 2026-10-31 (synthèse P3 #1138, relais #1139) : lot G0 d'abord ; faire participer
Gemini comme premier vrai agent API, sans chat, en gratuit seulement.

## Constats du 2026-10-30

- L'adaptateur consultatif n'acceptait que `gemini-3.5-flash-lite` (liste gratuite en dur).
- Tous les appels Gemini envoyaient `thinkingLevel: "minimal"` au niveau le plus léger. La documentation
  « What's new in Gemini 3.8 Flash » (lue le 2026-10-31) indique que 3.8 Flash n'accepte que
  `low | medium | high` (défaut `medium`) et que `minimal` **renvoie une erreur**. La veille du
  2026-10-29 relève la même limite pour `gemini-4-argon`. Passer à 3.8 sans correctif aurait cassé
  tous les appels à effort faible et tous les appels consultatifs.
- L'attestation du projet Google gratuit (`GEMINI_FREE_PROJECT_ATTESTED`) n'existait qu'au tableau de
  bord Cloudflare. `wrangler deploy` sans `keep_vars` remplace les variables par celles du fichier
  (vérifié par Vibe, #1127) : elle aurait sauté au prochain déploiement.

## Changements

| Fichier | Changement |
| --- | --- |
| `src/collab-store/executors/gemini.ts` | `gemini-3.8-flash` dans la liste gratuite ; `GEMINI_NO_MINIMAL_MODELS` ; `geminiThinkingLevel(model, effort)` ; l'adaptateur envoie le niveau le plus léger accepté par le modèle |
| `src/collab-store/agentrun/effort.ts` | Gemini passe par `geminiThinkingLevel` : même échelle qu'avant (un cran sous l'effort), plancher `low` pour 3.8 Flash et 4-argon |
| `src/collab-store/agentrun/gemini-model.ts` | défaut sans effort choisi : niveau le plus léger accepté par le modèle |
| `wrangler.jsonc` (cc3-test seulement) | `GEMINI_FREE_PROJECT_ATTESTED: "true"` (attestation de Kevin, non secrète) ; `gemini` ajouté à `AGENT_RUN_PARTICIPANTS` |

Inchangé : la double condition d'attestation (variable **et** origine cc3-test) ; aucune attestation en
production ni dans les autres environnements ; la clé `LLM_KEY_GEMINI` reste un secret posé par Kevin ;
aucune enveloppe payante pour Gemini (gratuit seulement) ; 3.5 Flash-Lite reste accepté.

## Prérequis de Kevin (hors code)

- Enregistrer le participant `gemini` sur `/owner` (`register_participant`). Sans cela, ses écritures au
  store sont refusées (`UNREGISTERED_PARTICIPANT`) ; le planificateur peut créer des exécutions qui
  échoueront à l'écriture.
- Garder la clé `LLM_KEY_GEMINI` sur le Worker cc3-test.

## Ce que Gemini fera sur le canal API

Les mêmes travaux que les autres agents API : répondre aux questions qui lui sont adressées, les réveils
des tâches où il tient un rôle, et son tour dans la tournante des chercheurs (L11). Modèle préféré
`gemini-3.8-flash`, puis 3.6 Flash, 3.5 Flash-Lite et Gemma 4 (Workers AI), tous gratuits.
Sa seule mémoire de continuité est `participant:gemini` (pas de chat).

## Retour arrière

Revert du lot. Effet : Gemini quitte le canal API, l'attestation retourne au tableau de bord (à reposer
à la main) et 3.8 Flash redevient refusé par l'adaptateur consultatif. Aucune donnée migrée.

Tests : `test/collab-store/agentrun/cc7-g0-gemini-38.spec.ts`.
