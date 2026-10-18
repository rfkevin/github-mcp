# CC-5 L0 — Mesure de départ W0 (réveils, relances, coûts, quotas, minutes Actions)

Auteur : Vibe GLM (lot L0, auteur) · Date : 2026-10-18 · Périmètre : mesure, aucune écriture de production, 0 €.

Ce document fige la mesure de départ **W0** exigée par le plan CC-PLAN-5 v0.4 (lot L0) avant
toute automatisation : sans cette base, aucun gain des lots suivants ne serait mesurable.

## 1. Méthode

- Sources : journaux du store de collaboration (événements, invocations A1, décisions owner),
  dépôt GitHub `rfkevin/github-mcp` (incidents, PR, checks), documentation publique des
  fournisseurs (URLs ci-dessous).
- Toutes les mesures sont celles du pilote CC3-test ; aucune donnée de production n'existe.
- Les chiffres « observés » sont des bornes inférieures documentées, pas des plafonds.

## 2. Quotas et garde-fous serveur (constantes du code)

| Paramètre | Valeur | Source |
| --- | --- | --- |
| Plafond quotidien d'appels par endpoint | 50 (`DEFAULT_DAILY_CAP`) | src/collab-store/executors/run.ts |
| Budget journalier de neurons (chemin gratuit) | 8 000 (`DEFAULT_NEURON_BUDGET`), plafond configurable 9 500 | src/collab-store/executors/run.ts |
| Allocation gratuite Cloudflare Workers AI | 10 000 neurons/jour, remise à 00:00 UTC | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| Délai fournisseur (avant L0) | 30 s fixes pour tous | dette X14, corrigée par le présent lot |

Le budget serveur (8 000) est volontairement sous l'allocation Cloudflare (10 000) : la marge
absorbe les imprécisions d'estimation du pire cas. Le pool de neurons est **partagé entre tous
les endpoints workers-ai** du compte, pas par endpoint.

## 3. Observé au 2026-10-15 (journée la plus tendue du pilote)

- Endpoint `ep-claude-glm47` : **49/50 appels** consommés sur la journée ; le plafond a tenu,
  aucune levée manuelle de quota n'a été nécessaire.
- Registre neurons : **7 984/8 000** réservés en fin de journée (le pire cas est réservé avant
  l'appel puis soldé au réel — voir `reserveNeurons`/`settleNeurons`).
- Coût réel : **0 €**, jamais dépassé ; aucun appel facturable n'est possible par construction
  (liste blanche gratuite, refus des modèles payants, réservation 0 € par tentative).

## 4. Latences réelles observées (invocations A1 du pilote)

| Fournisseur/modèle | Latence observée | Remarque |
| --- | --- | --- |
| Groq `openai/gpt-oss-20b` | ~1,1 s | succès à brief compact (366/256 puis 377/428 jetons) |
| Gemini `gemini-3.5-flash-lite` | 2,2 à 5,2 s | stable |
| Z.AI `glm-4.7-flash` | ~6 s à 256 jetons | timeout à 30,5 s à 1024 jetons (délai fixe de l'époque) |
| Cloudflare `@cf/zai-org/glm-4.7-flash` | moyenne ~10,2 s, p95 ~25 s | le plus lent du pilote |

Le délai fixe de 30 s est la cause directe des échecs Z.AI à plafond élevé : c'est la dette X14
« délai par fournisseur » corrigée par le présent lot (groq 30 s, gemini 60 s, zai 90 s,
plafonds 60-120 s selon fournisseur).

## 5. Réveils manuels (W0 : le point à automatiser)

Aucun réveil automatique n'existe avant L0 : chaque étape de chaque cycle (CC-2 à CC-5) a
débuté par un **signal de chat de Kevin** adressé à un agent, qui a ensuite enchaîné les
appels d'outils. Méthode : comptage des signaux documentés dans les journaux de cycles
(c'est une borne inférieure — certains signaux n'ont laissé qu'une trace conversationnelle).
Ordre de grandeur observé : plusieurs dizaines de réveils manuels sur l'ensemble du pilote
CC-2→CC-5, y compris les relances d'incident ci-dessous.

## 6. Incidents ayant exigé une relance manuelle

- C2 : déploiements `d7d5995` / `ba7cf7b` — diagnostic manuel après échec de checks.
- X2/X5 : incident `9e78179` — reprise manuelle après collision de journal.
- F5 : reprise manuelle après échec de build.
Chaque incident a coûté au moins un réveil manuel + une relecture ; aucun n'a dépassé 0 €.

## 7. Minutes GitHub Actions (estimation)

- Dépôt privé, plan Free : 2 000 minutes/mois. Jamais dépassé à ce jour.
- `ci.yml` ne tourne que sur `pull_request` ; un `check:full` complet mesure ~15 minutes.
- Estimation L0 : quelques dizaines de minutes/mois au rythme actuel du pilote. Les minutes
  des checks du présent lot sont comptées dans la CI de la PR L0.

## 8. Contrôles agent (état W0)

- `run_checks`/`agent-checks` du dépôt sont bloqués pour les agents non-admin sur
  `CONTROLLER_CHANGED` : la validation admin de Kevin est requise. W0 ne les compte donc pas
  comme automatisation disponible.

## 9. Ce que le présent lot L0 change (et mesure à W1)

1. **Usage réel sur échec** (X14) : un appel fournisseur qui échoue rapporte désormais ses
   jetons consommés (portés par l'erreur) au lieu d'un faux 0/0.
2. **Délai par fournisseur** (X14) : plus de 30 s fixes.
3. **Sortie conservée au rejeu** (X14) : `invocations.output_text` borné à 64 KiB ;
   un rejeu restitue la sortie sans nouvel appel fournisseur.
4. **Gemma** (X4) : `enable_thinking: false` — voir l0-diagnostic.md.

W1 (après merge) mesurera : réveils manuels restants, échecs par timeout, jets de neurons
par appel réussi/échoué, minutes Actions.
