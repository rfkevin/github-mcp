# CC-8 S0 — Inventaire lecture seule (rapport)

Lot S0 du plan CC-PLAN-8 v0.1 (seq 1262) + v0.2 (seq 1270), validé par Kevin.
Auteur : Vibe (owner). Reviewer : GPT-6. Testeur : Claude. Merge : Kevin uniquement.

- Référence lue : `mcp/105856986/cc3-integration` @ `74f6715edfa1502a127c21aa5c8c520712d2559f` (tip au 2026-11-01).
- Zéro diff runtime : lecture seule. Ce document (docs/collaboration/cc8/) est l'unique changement de la PR.
- Méthode : lectures directes des fichiers au tip (github_read_files/list_directory), CI observée au SHA exact. github_search_code (index branche par défaut, en retard sur le staging) n'a rien indexé pour les symboles recherchés — liste vide ≠ absence ; les appelants ci-dessous sont établis par lecture du code au tip.

## 1. Les deux listes de modèles et leurs appelants réels

### 1.1 Liste d'exécution — variables wrangler cc3-test (source du runtime aujourd'hui)

Valeurs posées (wrangler.jsonc, env cc3-test) :
- `AGENT_RUN_PARTICIPANTS=claude,grok,vibe,gemini` (gpt6 absent), `AGENT_RUNS_ENABLED=true`.
- `AGENT_RUN_MODEL=workers-ai:@cf/zai-org/glm-4.7-flash` (repli global).
- `AGENT_RUN_FAMILY_CLAUDE=anthropic` + `AGENT_RUN_MODELS_CLAUDE=anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5`.
- `AGENT_RUN_FAMILY_GROK=xai` + `AGENT_RUN_MODELS_GROK=xai:grok-4.7,xai:grok-4.20-0309-non-reasoning`.
- `AGENT_RUN_FAMILY_VIBE=zai` + `AGENT_RUN_MODELS_VIBE=zai:glm-5.3,workers-ai:@cf/zai-org/glm-4.7-flash`.
- `AGENT_RUN_FAMILY_GPT6=openai` + `AGENT_RUN_MODELS_GPT6=groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b` (posées mais gpt6 hors PARTICIPANTS).
- `AGENT_RUN_FAMILY_GEMINI=google`, `GEMINI_FREE_PROJECT_ATTESTED=true`, `AGENT_RUN_MODELS_GEMINI=gemini:gemini-3.8-flash,gemini:gemini-3.6-flash,gemini:gemini-3.5-flash-lite,workers-ai:@cf/google/gemma-4-26b-a4b-it`.

ABSENTS (donc éteints, fail-closed) : `AGENT_RUN_RESEARCH`, `AGENT_RUN_GITHUB_WRITES`, `AGENT_RUN_GITHUB_REPOSITORY`, `AGENT_RUN_PROMOTE_AUTO`, `AGENT_RUN_PAID_*`, `AGENT_RUN_COST_CENTS_*` (0 par défaut), `AGENT_RUN_CONTINUITY`, `AUTO_MERGE_*`, toute `LLM_KEY_*`.

Appelants réels (lecture au tip) :
- `participantModelRoute` (src/collab-store/agentrun/provider-models.ts) : aiguillage L8 — `AGENT_RUN_MODEL_<P>` > `AGENT_RUN_PAID_MODEL` > `AGENT_RUN_MODEL` > null.
- `participantPolicy` / `chooseModel` / `budgetState` (src/collab-store/agentrun/model-policy.ts, L9a/L9b) : lit `AGENT_RUN_FAMILY_<P>` + `AGENT_RUN_MODELS_<P>` + enveloppes `AGENT_RUN_PAID_*_<P>` ; choix par étape journalisé (`agent_model_choices`, avec tampon fiche v+hash), préférences `agent_model_prefs` (cycle, agent, tâche), disponibilité mesurée `agent_model_calls`.
- `createRoutedModel` → `createProviderModel` (provider-models.ts) : construction fail-closed, refus typé avant tout appel (`MODEL_PROVIDER_UNSUPPORTED`, gratuit non permis, tarifs datés requis), jamais de repli inter-familles.
- `apiParticipants` + `planAgentRuns` (src/collab-store/agentrun/plan.ts) : création des exécutions depuis les décisions du contrôleur ; plafonds de coût par type `AGENT_RUN_COST_CENTS_<KIND>` = 0 par défaut (AUCUN appel payant possible).
- `modelCatalog` / `setModelPreference` : outils MCP `collab_model_catalog` / `collab_choose_model` (src/collab-store/mcp/model-tools.ts, présents si AGENT_RUNS_ENABLED) et outil interne `store_choose_model` (model-choice-tools.ts, L9b).
- `runAgentPilot` (src/collab-store/agents/pilot.ts) : pilote CC-5 L3b (persona → bail → assemblage), consomme `assertApiPersona`.

### 1.2 Liste de définition — fiche canonique config/agents.fiche.json (v2)

- Source unique des DÉFINITIONS (F1, PR #242) : `parseFiche` (fiche.ts, deny-by-default), `deriveAgentRunVars` → les variables wrangler de définition en sont DÉRIVÉES ; artefact `src/collab-store/agentrun/generated/agent-fiche.generated.ts` (FICHE_VERSION/FICHE_HASH) régénéré par `scripts/agent-fiche/generate.mjs`.
- Le runtime lit TOUJOURS les variables d'environnement ; la fiche n'est pas la source d'exécution (migration en lecture parallèle F1). Le tampon version+hash est journalisé à chaque choix serveur.
- Registre ep-* : dans la fiche par agent (ep-claude-glm47 retired, ep-zai-glm47 active, ep-groq-gptoss20b active, ep-gemini-35-flash-lite active, ep-gemini-flash proposed, ep-cf-gemma4 retired, ep-openrouter-gemma retired) + hors agent (ep-openrouter-deepseek-v4, probe_required) — alias immuables, statuts active/probe_required/retired/proposed. Le runtime trials lit le registre D1 via `loadEndpoint` (executors/registry.ts) : la fiche en est le miroir de définition.
- Test qui fige la cohérence : `test/collab-store/agentrun/cc7-f1-fiche-canonical.spec.ts` — fail-on-diff byte-exact fiche ↔ artefact ↔ wrangler cc3-test ; toute variable `AGENT_RUN_(PARTICIPANTS|MODEL|MODELS|FAMILY)*` doit être EXACTEMENT celle dérivée de la fiche (budgets/attestations/secrets exclus du contrôle).

### 1.3 Chaîne dans le store — ABSENTE aujourd'hui (c'est le lot S3)

Aucun état de chaîne (inactive/candidate/beta/primary/rollback), aucun `set_agent_models`, aucune F1 dérivée du store. Aujourd'hui : deux sources tenues synchrones par la CI (wrangler = exécution, fiche = définition). S3 devra faire du store la source et wrangler le défaut au déploiement, en adaptant le fail-on-diff F1.

### 1.4 Constat par agent (état réel au tip)

- Claude/Grok : listes 100 % payantes, AUCUNE clé `LLM_KEY_*`, AUCUN budget → tout modèle = `credential_present: false` → indisponible ; toute exécution créée pour eux échouerait (`MODEL_ROUTE_REFUSED`/`MODEL_BUDGET_EXHAUSTED`). S1a doit les déclarer incapables (refus typé, aucune exécution).
- Vibe : `zai:glm-5.3` payant sans clé → indisponible ; `workers-ai:@cf/zai-org/glm-4.7-flash` gratuit (binding AI) → seul abordable. MAILLON MANQUANT vs chaîne convenue (seq 1212) : `zai:glm-4.7-flash` (gratuit direct, endpoint ep-zai-glm47 actif dans la fiche) est absent de la liste runtime `AGENT_RUN_MODELS_VIBE` — la 1re valeur posée via set_agent_models (S3) devra l'inclure.
- GPT-6 : variables posées mais hors `AGENT_RUN_PARTICIPANTS` (fiche : active=false) → son ajout au canal API = PR de configuration S1a (décision Kevin seq 1280).
- Gemini : 3 modèles directs gratuits permis (3.8/3.6/3.5-flash-lite, attestation posée) + gemma Workers AI ; ep-gemini-35-flash-lite actif (le relais coordinateur du P4 l'a utilisé).

## 2. Trials /owner (src/collab-store/owner/trials.ts)

- `runOwnerTrial` : essai déclenché explicitement sur /owner (CC-4 A4-mini). Cycle `owner-trials`, consignes figées (`summarize`, `review_risks`), données ≤ 4 000 caractères, ≤ 256 jetons, op_id aléatoire (uint32, nouvelle intention par clic).
- Endpoint lu dans le registre D1 (`loadEndpoint`) : actif + `provider_adapter` obligatoires ; prévalidation capacités (plafond de jetons, `assertLlmCapabilities`) AVANT toute écriture ; invocation A1 (empreinte sha256 du paquet, jamais le contenu) puis `dispatchFreeInvocation`.
- Chemin gratuit (executors/run.ts) : `DEFAULT_DAILY_CAP=50` appels/endpoint/jour, `DEFAULT_NEURON_BUDGET=8_000` (plafond 9 500) neurons/jour réservés au PIRE CAS avant tout appel (aucune facturation possible) ; sonde technique `CC4-PROBE-OK + nonce` ≤ 256 jetons (`PROBE_CONTROL`, PROBE_KEY_PREFIX).
- Rôle pour CC-8 : c'est le déclenchement manuel existant ; S4 doit faire que le bouton /owner lance LE MÊME code que la sonde automatique (une implémentation, un chemin).

## 3. Sonde et canary de promotion (F2) — consommateur prêt, producteurs ABSENTS

- `decidePromotion` (src/collab-store/agentrun/promote/decision.ts, PR #244) : décision PURE reject/propose/auto_apply. Consomme `ProbeResult` (ok, tools_ok, efforts_ok, cost_micro_cents) et `CanaryResult` (`CANARY_MIN_CALLS=20`, `CANARY_TASK_KINDS=answer/review/test/implement`, coût ratio, identity_leak, critical_error, taux d'échec ≤ 5 %). Référence épinglée exigée (`isPinnedRef`, latest refusé) ; gratuit devenu payant = propose seulement ; `promoteAutoEnabled` = `AGENT_RUN_PROMOTE_AUTO === 'true'` (ABSENT = éteint, conforme à la décision P5 de Kevin).
- AUCUN producteur de `ProbeResult`/`CanaryResult` dans le runtime : ni sonde automatique, ni canary par rejeu, ni événement typé `model.finding`. Ce sont les lots S4 (veille typée + sonde unique) et S5 (canary + branchement F2).

## 4. Veille L10/L11 (src/collab-store/agentrun/research.ts)

- Porte `AGENT_RUN_RESEARCH` (« true » exact) : ABSENTE de wrangler cc3-test → veille éteinte (Kevin l'allumera au lot S4, décision seq 1280). Coût `AGENT_RUN_COST_CENTS_RESEARCH` = 0 par défaut (fail-closed).
- `assignResearch` (coordinateur actif) crée une exécution `research` par agent/sujet/jour (run_id déterministe) ; outils `web_fetch_official` (hôtes officiels figés en code, lecture seule, corps borné) + salon (`store_salon_read`/`store_salon_post`, UN message info par passe).
- Constat pour S4 : la veille actuelle produit des messages salon `info` SEULEMENT — aucun événement typé ne déclenche quoi que ce soit. S4 doit la brancher sur model.finding → sonde.

## 5. Persona (src/collab-store/agents/persona.ts)

- `AGENT_PERSONAS` figées (CC-5 L3b) : grok, vibe, gpt6, claude — api_enabled, rôles owner/reviewer/tester, `preferred_free_model` (grok : openai/gpt-oss-20b ; vibe : @cf/zai-org/glm-4.7-flash ; gpt6 : openai/gpt-oss-20b ; claude : @cf/google/gemma-4-26b-a4b-it), system_duty. Gemini n'a PAS de persona (elle participe par dispatch coordinateur).
- Appelant réel établi : `assertApiPersona` dans `runAgentPilot` (pilot.ts) — ne vérifie QUE api_enabled/rôles. `preferred_free_model` n'est PAS consommé par le chemin de routage L8/L9 : valeur déclarative aujourd'hui. À trancher en S3/S4 (vue, branchement réel ou retrait) — les persona L3b et le routage L8/L9 sont deux circuits distincts.

## 6. Budgets M2 — portée task GELÉE (PR #245)

- Budgets mémoire (memory-store.ts) : common 1500, project 2000, role 800, participant 1500 (plancher), **task 0**.
- `memory.propose` en `task:<id>` → `MEMORY_SCOPE_FROZEN` (rien n'est écrit ; les entrées existantes restent lisibles). Mémoire role servie au détenteur du rôle + coordinateur (chat) et à l'API par type d'exécution (review→reviewer, test→tester, implement→owner, research→researcher).
- Conséquence pour CC-8 : AUCUNE écriture mémoire de tâche possible ; S8 (coordinateur autonome) et S9 (parité) doivent compter sur role/participant/common.

## 7. Drapeaux et tests qui figent une configuration

Drapeaux cc3-test au tip : AGENT_RUNS_ENABLED, AGENT_RUN_PARTICIPANTS, AGENT_RUN_MODEL, FAMILY_/MODELS_ par agent, GEMINI_FREE_PROJECT_ATTESTED, COLLAB_STORE_ENABLED, CONTROLLER_CRON_ENABLED, CONTROLLER_WEBHOOK_ENABLED, SALON_ENABLED, PRODUCT_CREATE_ENABLED, OWNER_AUTH_MODE=secret, GITHUB_CHECKS_CONFIG (controllerSha master 774a3117), GITHUB_WRITES_ENABLED, GITHUB_AUTOMATION_ENABLED, crons */15.

Tests qui figent (un changement de configuration les casse) :
1. `cc7-f1-fiche-canonical.spec.ts` : fiche ↔ artefact ↔ wrangler (fail-on-diff, voir §1.2).
2. `cc7-l12-cc3-test-families.spec.ts` : lit wrangler.jsonc DIRECTEMENT — familles imposées par agent (claude/grok/vibe/gpt6/gemini), aucun modèle écarté, repli global Workers AI.
3. `cc7-g0-gemini-38.spec.ts` : thinkingLevel « minimal » interdit pour gemini 3.8/4-argon ; attestation gemini déclarée dans wrangler (un déploiement ne l'efface plus).

## 8. Baseline CI au tip 74f6715

- Workers Builds: github-mcp = success (check 124807049886). Workflow `deploy-cc3-test` run 41259348526 = success (cc3-test déployé au tip).
- `ci`, SonarCloud, GitGuardian : AUCUN check au tip (absents, pas en échec) — structurel : contrôles déclenchés par les PR (ci.yml = pull_request), pas par les pushes directs sur le staging. La baseline de qualité reste donc par-PR : chaque lot S* doit montrer ses contrôles au couple exact de sa PR. La CI du tip seul n'est PAS une preuve de suite verte (constat déjà fait en CC-5/CC-7).
- Suite complète la plus récente observée : 213 fichiers / 1975 tests (revendiqués sur la PR S1a #248, pas au tip).

## 9. Écarts à traiter par les lots suivants (constats, non bloquants)

1. **S1a** : Claude/Grok sans modèle abordable (§1.4) → catalogue de capacité + refus typés, aucune exécution vouée ; gpt6 à ajouter à PARTICIPANTS (PR config séparée, fusion Kevin).
2. **S2** : verdicts avant automatisation (PR #249 en revue).
3. **S3** : le store devient la source (set_agent_models, statuts, F1 dérivée) ; wrangler = défaut au déploiement ; 1re valeur = chaîne Vibe convenue seq 1212 (y compris le maillon `zai:glm-4.7-flash` absent de la liste runtime) ; adapter le fail-on-diff F1 ; trancher `preferred_free_model` (persona) et le double registre ep-* (fiche JSON vs D1).
4. **S4** : brancher la veille (salon info → model.finding typé) ; sonde unique (/owner = même code) ; AGENT_RUN_RESEARCH à allumer (act Kevin).
5. **S5** : canary par rejeu de vraies tâches + baseline ; producteurs ProbeResult/CanaryResult absents aujourd'hui.
6. **S6-S9** : budgets 0 partout (AUCUNE dépense possible sans acte Kevin) ; portée task mémoire gelée ; parité à juger en D12.
