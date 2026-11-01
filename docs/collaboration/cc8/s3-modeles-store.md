# CC-8 S3 — Modèles dans le store (+ vues endpoint, F1 dérivée)

Auteur : Vibe (GLM, Z.ai). Rôles du plan : Vibe / GPT-6 (relecture) / Grok (test).
Base : `CC-PLAN-8 v0.1 §1.6 + v0.2` (seq 1262/1270, validé par Kevin seq 1280), constats S0 (`s0-inventaire.md`).

## Objectif et critères d'acceptation

La chaîne de modèles d'un agent vit dans le store : elle se change par acte owner **sans PR**, le runtime la lit **avant** les listes wrangler (qui restent les **défauts**, jamais réécrites), et la fiche canonique reste la **source des définitions** (F1, fail-on-diff : une chaîne ne crée jamais de définition).

AC du plan, tous couverts par `test/collab-store/agentrun/cc8-s3-model-chain.spec.ts` :

1. **Changement de chaîne sans PR** — `set_agent_models` (acte owner) pose la chaîne dans le store ; la résolution et la capacité suivent immédiatement, aucune variable wrangler ni fiche touchée. Preuve rejouée sur la configuration réelle : `zai:glm-4.7-flash` (absent de `AGENT_RUN_MODELS_VIBE` versionnée) devient routable dès la chaîne posée.
2. **Refus non-owner** — l'acte n'est exécutable que par l'approbation de Kevin sur /owner (demande exécutable `set_agent_models`) ; preuve déléguée refusée (`DELEGATED_FORBIDDEN`), agent jamais exécuteur.
3. **Restauration testée** — `rollback` restaure la version précédente depuis son instantané immuable ; restaurer la version 0 retire la chaîne (retour aux défauts wrangler, routage identique à l'existant).
4. **Routage identique** — sans chaîne dans le store, la résolution rend la politique wrangler **telle quelle** (spéc : égalité profonde par agent + baseline S1a inchangée).

## Statuts des maillons (§1.6)

`inactive / candidate / beta / primary / rollback`. L'**ordre du tableau** de la chaîne porte l'ordre de routage ; le statut décide de l'éligibilité :

- `primary` (courant), `beta` (essai), `rollback` (secours de dernier recours, cible désignée d'un retour arrière) : **routés** ;
- `candidate` (observé, pas encore routé) et `inactive` (jamais routé, ex. payant sans budget) : **visibles dans les vues, jamais routés** ;
- au moins un `primary` exigé (`CHAIN_NO_PRIMARY` sinon).

Première valeur prévue par le plan (chaîne de Vibe, convenue seq 1212) :
`zai:glm-5.3` (payant, inactif) → `zai:glm-4.7-flash` (gratuit, primary) → `workers-ai:@cf/zai-org/glm-4.7-flash` (secours, rollback).
À poser par Kevin via /owner après fusion : la demande exécutable sera déposée au store.

## Livré

- **Tables** (internes au store, portables, jamais dans le schéma canonique gelé) : `agent_model_chains` (chaîne courante par participant, CAS sur `version`) et `agent_model_chain_versions` (historique **append-only** : un instantané immuable par acte `set`/`rollback`, jamais réécrit ni supprimé).
- **Acte owner** `setAgentModels` (`owner/model-chains.ts`, `owner/model-chains.ts` branche `set_agent_models` de `executable.ts`) : CAS `expected_version` (JS + garde SQL dans le lot), validation F1 (`validateModelChain` : chaque maillon existe dans la fiche de l'agent — modèles ou cibles d'alias ep-* — dans SA famille), audit complet (événement `owner.decision` + instantané), jamais déléguable.
- **Résolution store d'abord** `resolveParticipantPolicy` (`model-policy.ts`), branchée aux trois consommateurs de la liste : choix par étape (`createRoutedModel`), capacité du planificateur (`runCapacity`), préférence de modèle (`setModelPreference`). Mêmes règles de choix (`chooseModel`), même enveloppe (wrangler : la chaîne ne finance rien).
- **Vues endpoint / F1 dérivée** : le catalogue (`modelCatalog`, exposé par `collab_model_catalog`) rend la chaîne effective — source `store` (version, maillons avec statut et alias ep-* lié) ou `env` (défauts) — la même source que le routage, divergence historique dashboard/fichier (S0 §1.5, §9.1) close côté lecture.
- **Spec** : `cc8-s3-model-chain.spec.ts` (AC 1 à 4, CAS, F1 fail-on-diff, chemin complet demande → approbation → chaîne, rejeu idempotent, vues).

## Limites et notes

- L'**activation** d'un agent sur le canal API reste versionnée (wrangler/fiche, PR) : la chaîne affine la liste d'un agent déjà aiguillé, elle n'active rien (aiguillage `engineFor` inchangé).
- Les **enveloppes et budgets** restent wrangler (P5 : rien financé). Un maillon payant d'une chaîne sans budget est simplement inabordable, comme avant.
- `candidate` n'est pas encore branché aux paliers S5/S6 (canary, bêta) : le statut est stocké et visible, les paliers viendront avec ces lots.
- Aucune réécriture de la fiche, de wrangler, ni d'un événement du journal ; seules les nouvelles tables internes sont écrites.
