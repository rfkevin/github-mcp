# CC-8 S6 — Bêta, principal, retour arrière (bilan de lot)

Lot S6 du plan CC-PLAN-8 (§5 paliers de bêta, v0.2 seq 1270, plan voté seq 1262/1270, GO Kevin seq 1280). Rôles D12 : auteur Vibe (GLM, servi par Mistral AI), relecteur GPT-6, testeur Grok.

## Parties et état

| Partie | Contenu | PR |
| --- | --- | --- |
| 1/2 | src/collab-store/agentrun/beta/ : store.ts (tables internes, suivi, exécutions comptées, métriques), advance.ts (avance, retour arrière automatique, fermeture) + spec cc8-s6-beta.spec.ts | cette PR |
| 2/2 | Ce bilan + complément au guide du store (codes S6 en section 7, exigé par le test docs-coverage du dépôt — convention des lots S3/S5) | cette PR |

## Choix

- **Paliers votés** : la candidate entre dans la chaîne comme SECOURS (statut rollback, dernier recours routé, posé par l'owner via set_agent_models) ; passage secours → bêta à >= 20 exécutions réelles ET >= 48 h, à des seuils PRÉENREGISTRÉS à l'ouverture du suivi (recalibrables par lot ultérieur, jamais par ce chemin) ; promotion bêta → principal = ACTE OWNER (set_agent_models sur /owner) : aucun chemin automatique vers primary n'existe dans ce module, et l'acte owner DOIT appeler assertBetaPrimaryWindow avant de promouvoir — fenêtre bêta >= 20 exécutions réelles ET >= 48 h DEPUIS l'exposition, aux mêmes seuils préenregistrés, garde lecture seule (BETA_PRIMARY_WINDOW_NOT_MET ; relecture GPT-6 : le caractère manuel de l'acte ne prouve pas le seuil) ; retour arrière AUTOMATIQUE pour une bêta qui casse ses seuils (>= 5 exécutions ET taux d'échec > 5 %).
- **Entrée par preuve** : l'ouverture vient seulement d'une PromotionTaskProposal du lot S5 (verdict propose — auto_apply est dégradé en propose par S5 — next beta, >= 20 appels, empreinte canonique du rapport, cycle). La candidate doit déjà être un maillon secours de la chaîne posée par l'owner (F1 : la chaîne référence les définitions de la fiche, elle n'en crée jamais).
- **Exposition automatique limitée** : l'avance secours → bêta est la seule écriture automatique de chaîne (audit append-only S3 : set_by system:beta-track, action set, event_seq NULL). Garde transactionnelle C2 : CAS sur track_version + version de chaîne + HALT en tête de lot (revue #115 R1) ; une course ou un halt annule TOUT le lot, jamais last-write-wins ; re-diagnostic typé (BETA_TRACK_STALE, BETA_CHAIN_STALE, AUTOMATION_HALTED, BETA_TRACK_OPEN).
- **Retour arrière** : restaure la chaîne d'AVANT l'exposition (instantané pre_beta_version de l'audit, y compris une version retirée via la sentinelle), nouvelle version action rollback, suivi rolled_back avec motif, journal du suivi. Une bêta saine ne produit RIEN (BETA_CRITERIA_INTACT). Contre-exemple relecture GPT-6 : chaîne modifiée par l'owner depuis l'exposition (autre maillon, candidate gardée en bêta) → le retour automatique REFUSE (BETA_CHAIN_DIVERGED) sans écraser son acte — arbitrage owner via set_agent_models, rien n'est écrit.
- **HALT coupe tout** : l'arrêt d'urgence bloque l'ouverture, l'avance ET le retour arrière automatique (fail-safe : l'owner garde set_agent_models manuel sur /owner — divulgation assumée).
- **Comptage** : agent_model_beta_executions append-only (triggers no-delete), idempotent par run_id ; distinct du cumul agent_model_calls et du coupe-circuit S1b-2, inchangés. Fermeture = bookkeeping seul (pas de garde HALT) ; réouverture avec nouvelle preuve, compteur de suivi monotone.

## AC vérifiés (tests D1 réels, horloge figée)

- **ouverture** : preuve conforme → suivi secours + événement ; rejeu même empreinte = duplicate ; autre preuve → BETA_TRACK_OPEN ; < 20 appels → BETA_CANARY_INSUFFISANT ; verdict reject ou next hors bêta → BETA_PROPOSAL_INVALID ; alias latest → BETA_REF_INVALID ; maillon absent → BETA_CANDIDATE_ABSENT, statut primary → BETA_ENTRY_NOT_SECOURS ; version CAS expirée → CHAIN_VERSION_STALE ; chaîne retirée (sentinelle) → BETA_CHAIN_ABSENT ;
- **exécutions** : idempotentes par run, ignorées hors suivi ouvert (avant ouverture, après fermeture) ;
- **avance** : 19 exécutions puis durée insuffisante → BETA_THRESHOLDS_NOT_MET sans écriture ; paliers atteints → chaîne v2 maillon beta, audit versions (system:beta-track, set), suivi bêta (pre_beta_version, advanced_at) + événement ; rejeu = duplicate sans v3 ; course CAS → BETA_TRACK_STALE sans écriture, le gagnant applique ensuite ; chaîne modifiée par l'owner depuis l'ouverture → BETA_CHAIN_STALE ; halt → AUTOMATION_HALTED ;
- **retour arrière** : 1/6 échecs → chaîne d'avant exposition restaurée en v3 (action rollback), suivi rolled_back avec motif, événement ; rejeu = duplicate ; 0 échec → BETA_CRITERIA_INTACT sans écriture ; 4 exécutions → BETA_THRESHOLDS_NOT_MET ; halt → AUTOMATION_HALTED ; maillon rétracté par l'owner → BETA_CHAIN_STALE ;
- **fenêtre principal** : garde lecture seule assertBetaPrimaryWindow — 0 exécution en bêta ou < 48 h depuis l'exposition → BETA_PRIMARY_WINDOW_NOT_MET sans écriture ; paliers atteints → métriques de fenêtre rendues (exécutions, échecs, heures), aucun événement ni version créés ; hors bêta exposée → BETA_NOT_IN_BETA ;
- **contre-exemple owner** : chaîne modifiée pendant la bêta (autre maillon, candidate gardée, v3) puis bêta cassée → BETA_CHAIN_DIVERGED sans écriture : la version owner survit, le suivi reste bêta, aucune version rollback ni événement ;
- **fermeture** : suivi stale avec motif, rejeu duplicate, réouverture avec nouvelle preuve (compteur monotone : fermeture → 2, réouverture → 3) ;
- **métriques** : fenêtres secours/bêta séparées, advance_blockers visibles avant paliers, rollback_broken après casse, seuils préenregistrés lisibles.

## Raccordements v0 (aucun dans ce lot — module autonome)

- moteur (engine.ts) → recordBetaExecution après chaque appel du maillon suivi ;
- contrôleur (orchestrator.ts) → advanceSecoursToBeta / autoRollbackBeta sur les métriques ;
- /owner (owner/handler.ts, owner/page.ts) → betaMetrics (vue paliers et santé) ; l'acte set_agent_models appelle assertBetaPrimaryWindow avant toute promotion bêta → principal (refus sur erreur) ;
- extensions d'owned_paths hors périmètre S6 : à poser sur approbation de Kevin, avec le recalibrage des seuils après les mesures du lot S1.

## Divulgations

Aucune variable wrangler, aucun appel réseau, aucune écriture du schéma canonique ni des tables S3 hors paliers (lecture des chaînes ; écriture des versions uniquement par l'avance et le retour arrière). Le halt bloque aussi le retour arrière automatique : l'owner reste seul à pouvoir rouler manuellement via /owner. Tant que le moteur n'est pas raccordé, le comptage ne peut venir que d'appels directs (tests/mock) : l'avance ne peut pas être déclenchée par des exécutions réelles. code-map.md et AGENT_MEMORY.md non touchés (hors périmètre). Seuils PROVISOIRES (recalibrage S1) ; montée progressive 5 → 20 → toutes les tailles : réserve future. Base : mcp/105856986/cc3-integration @ 41e9d79a. Fusion par Kevin uniquement.
