# CC-3 T1 — Étude sandbox / terminal partagé

Plan: [CC-PLAN-3/v1.1](https://github.com/rfkevin/project-mcp-collab/issues/25) · Auteur: **Grok** · Reviewer: **Claude**  
Base: `cc3-integration` @ `30b3168` · Statut: **étude seule — aucune implémentation**  
Sources prix/limites vérifiées 2026-10-07 (docs Cloudflare + GitHub).

## 1. Objectif

Comparer des options pour qu’un agent puisse **développer / tester** (`npm run check:full`, etc.) **sans** PR GitHub à chaque itération, tout en gardant GitHub pour le code stabilisé.

Contraintes plan (§ non-négociables) :
- environnement **éphémère** ;
- **aucun** secret prod / déploiement ;
- token limité au préfixe `mcp/<account>/…` ;
- signaler tout plan **payant** comme non-gratuit ;
- **pas d’implémentation** sans `owner.decision`.

## 2. Options comparées

| Option | Gratuit ? | Isolation | Terminal interactif | Accès MCP / agent | Lien GitHub | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **T0 — `github_prepare_checks` / `github_run_checks`** (déjà dans le projet) | Oui (minutes Actions du compte) | Job éphémère Actions | Non (batch CI) | Via App existante | Natif | **Priorité immédiate** |
| **GitHub Codespaces** (compte **personnel**) | Quota inclus Free: **120 core-h/mois** + **15 GB-mois** storage ; Pro: 180 / 20. Orgs: **pas** de quota gratuit. | Conteneur dev par codespace | Oui (VS Code / terminal) | Via outils humains ou API Codespaces (driver à écrire) | Clone natif | **Bon pour humains / agents avec driver** |
| **Cloudflare Sandbox SDK** | **Non** — **Workers Paid** requis (≥ ~5 USD/mois) + Containers (vCPU/RAM/disk) | Conteneur isolé piloté par Worker/DO | `exec` / fichiers via SDK | Intégration naturelle au Worker github-mcp | Push manuel vers GitHub | **Meilleure intégration stack, coût** |
| **GitHub Actions custom workflow** (workflow non protégé) | Minutes incluses (Free perso ~2k min/mois) | Runner éphémère | Non | Appelable via outils checks existants | Natif | Couvert par T0 si activé |
| **Sandbox local de l’agent** (Claude Code, etc.) | Selon l’outil client | Machine de l’agent | Oui | Hors MCP serveur | Push PR ensuite | **Déjà utilisé** (ex. Claude sur #53) — hétérogène |

### Détail coûts (ordre de grandeur)

**Codespaces (perso Free)**  
- 120 core-hours = 60 h sur machine 2-core, ou 30 h sur 4-core.  
- Au-delà: ~0,18 USD/h (2-core), storage ~0,07 USD/GB-mois.  
- **Limite multi-agents:** un codespace = une session ; partage concurrent faible ; quota **personnel Kevin**, pas org.

**Cloudflare Sandbox**  
- Plan Workers Paid obligatoire.  
- Containers: inclus 375 vCPU-min + 25 GiB-h RAM + 200 GB-h disk / mois sur le plan ; puis ~0,072 USD/vCPU-h, ~0,009 USD/GiB-h.  
- Instances de `lite` (1/16 vCPU, 256 MiB) à `standard-4`.  
- DO + Workers requests facturés en plus.  
- **À signaler clairement: ce n’est pas gratuit.**

**T0 / Actions**  
- Coût = minutes Actions déjà utilisées par le dépôt.  
- Pas de terminal interactif, mais `check:full` à distance **sans** ouvrir de PR de travail.

## 3. Critères d’évaluation pour CC-3

| Critère | Poids | Meilleur candidat |
| --- | --- | --- |
| Zéro / faible coût | haut | T0, puis Codespaces quota perso |
| Isolation (pas de secret prod) | critique | Tous si bien configurés ; CF Sandbox / Actions les plus faciles à borner |
| Disponibilité multi-agents | moyen | T0 (parallèle jobs) > CF (N sandboxes) > Codespaces (quota unique) |
| Intégration MCP github-mcp | moyen | CF Sandbox (même compte) > T0 (déjà branché) > Codespaces (nouveau driver) |
| Ops Kevin | haut | T0 minimal ; CF = Paid + binding ; Codespaces = quota + éventuellement org billing |
| Chemin critique store C0–C7 | — | **Aucun** : T1 ne bloque pas |

## 4. Recommandation

### Phase A — maintenant (sans owner.decision lourd)

1. **Activer T0** (`run_checks` sur `cc3-test`, flag Kevin **K5**).  
   - Coût: 0 nouveau produit.  
   - Effet: tout agent peut lancer `check:full` sur sa branche sans sandbox local.  
   - Guide court: Vibe (matrice plan).

2. **Conserver les sandboxes clients** quand l’agent en a déjà une (ne pas centraliser avant besoin prouvé).

### Phase B — seulement si un lot de code est bloqué sans runtime commun

| Besoin observé | Option | Condition owner |
| --- | --- | --- |
| CI batch seulement | T0 suffit | K5 |
| Terminal + Node/npm interactif partagé | **Codespaces** sur repo github-mcp, machine 2-core, auto-stop agressif, secrets = PAT lecture `mcp/…` only | Décision + budget perso/org |
| Exécution code non fiable pilotée par le Worker | **CF Sandbox** | **Workers Paid** + décision coût explicite |

**Ne pas** choisir CF Sandbox « par défaut stack » sans accepter le plan Paid.

### Phase C — hors scope T1

Implémentation d’outils MCP `sandbox_*`, images Docker partagées, orchestration multi-agents dans un même FS → **CC-4** après C7, si le registre `manual_op` le justifie.

## 5. Risques

| Risque | Parade |
| --- | --- |
| Fuite de secrets prod dans un codespace/sandbox | Jamais de binding prod ; secrets owner-only ; token branch-scoped |
| Quota Codespaces épuisé (plusieurs agents) | Préférer T0 pour CI ; Codespaces = debug ponctuel |
| Coût CF surprise | Afficher Paid + estimate avant enable ; budget Cloudflare |
| Divergence « testé en sandbox ≠ CI » | T0/`check:full` reste la preuve de merge |

## 6. Livrable / non-livrable

| Fait | Pas fait |
| --- | --- |
| Comparaison + reco ordonnée | Aucun code runtime sandbox |
| Signalement Paid CF | Aucun binding wrangler Sandbox |
| Lien T0 / K5 | Aucun workflow Actions nouveau |

## 7. Next actions

- **Kevin:** K5 (T0) ; décider plus tard si Codespaces ou CF Paid si un lot est bloqué.  
- **Claude (reviewer):** verdict sur ce rapport.  
- **Grok:** STOP après review — pas d’implémentation.

## 8. Références

- Cloudflare Sandbox overview (Workers Paid): https://developers.cloudflare.com/sandbox/  
- Cloudflare Containers pricing: https://developers.cloudflare.com/containers/platform/pricing/  
- GitHub Codespaces billing / free quota: https://docs.github.com/en/billing/concepts/product-billing/github-codespaces  
- Product usage included: https://docs.github.com/en/billing/reference/product-usage-included  
