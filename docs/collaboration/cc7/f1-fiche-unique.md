# CC-7 F1 — fiche canonique unique par agent

Décision : synthèse P3 #1138 §1 validée par Kevin (#1139) ; lot F1 — auteur Vibe, relecteur GPT-6,
testeur Claude. La fiche unique est un **fichier typé versionné dans le dépôt**, modifié seulement
par PR (D12). Les registres existants deviennent des vues dérivées en lecture ; les anciens `ep-*`
sont des alias immuables ; clés, budgets et VALEURS d'attestation restent hors fiche (env/owner), les lignes du registre /owner (attestation_kind, attestation_ref) étant reprises telles quelles.

## La fiche (config/agents.fiche.json)

- `version` : incrémentée à chaque modification ; journalisée avec l'empreinte du fichier exact.
- `global_fallback_model` : le repli global `AGENT_RUN_MODEL` (épinglé lui aussi).
- `agents` : un agent logique par entrée — `id` (claude, gpt, grok, vibe, gemini), `participant_id`
  (suffixe des variables, ex. gpt → gpt6), `family`, `active` (dérivé dans
  `AGENT_RUN_PARTICIPANTS`), `models` (épinglés, du plus fort au plus léger : fort / rapide /
  léger / gratuit — l'ordre de la fiche EST l'ordre de la politique), `endpoints` (alias ep-*, lignes du registre /owner reprises telles quelles). En tête de fichier, `endpoints_hors_agent` regroupe les endpoints du registre sans agent logique (famille future, ex. deepseek) : l'entrée migrera sous son agent sans changer d'id ni de cible.

| Agent | Participant | Famille | Actif | Modèles (ordre de la politique) |
| --- | --- | --- | --- | --- |
| claude | claude | anthropic | oui | Opus 5.5, Sonnet 5.5, Haiku 5.5 |
| grok | grok | xai | oui | grok-4.7, grok-4.20 non-reasoning |
| vibe | vibe | zai | oui | glm-5.3 (payant), glm-4.7-flash Workers AI (gratuit) |
| gpt | gpt6 | openai | non | gpt-oss-120b, gpt-oss-20b (via Groq) |
| gemini | gemini | google | oui | Gemini 3.8 Flash, 3.6 Flash, 3.5 Flash-Lite, Gemma 4 26B Workers AI |

Aucune valeur `AGENT_RUN_*` n'est modifiée par ce lot : la fiche encode l'EXISTANT (réglé par G0
le 2026-10-31) et en devient la source déclarative. Les secrets (`LLM_KEY_*`), budgets (`AGENT_RUN_PAID_*`) et VALEURS d'attestation (`*_FREE_PROJECT_ATTESTED`) ne figurent JAMAIS dans la fiche ; les lignes du registre (attestation_kind, attestation_ref) y sont reprises telles quelles (cf. Alias ep-*).

## Dérivation et contrôle CI (fail-on-diff)

- `src/collab-store/agentrun/fiche.ts` : module pur sans import — validation `parseFiche`
  (deny-by-default), dérivation `deriveAgentRunVars` (variables de définition de modèles
  uniquement), empreinte `fnv1a64` (FNV-1a 64, UTF-8) du contenu exact, rendu déterministe de
  l'artefact. Sans import pour rester exécutable par le Worker ET par Node (script).
- `src/collab-store/agentrun/generated/agent-fiche.generated.ts` : artefact généré —
  `FICHE_VERSION`, `FICHE_HASH`, `FICHE_RAW`, `AGENT_RUN_VARS`. Ne pas éditer à la main.
- `scripts/agent-fiche/generate.mjs` : `node scripts/agent-fiche/generate.mjs` régénère l'artefact
  (`--check` = contrôle sans écriture, sortie 1 si divergence). Node >= 23.6 (stripping de types).
- `test/collab-store/agentrun/cc7-f1-fiche-canonical.spec.ts` : la CI échoue si
  (1) la fiche et l'artefact divergent (version, hash, rendu byte-exact),
  (2) les variables AGENT_RUN_* de définition de modèles de wrangler.jsonc (env cc3-test) ne sont
  pas EXACTEMENT celles dérivées de la fiche (ni manque, ni ajout, ni valeur différente),
  (3) un alias ep-* change de cible, de statut, de rattachement ou quitte la fiche (liste historique figée en ajout seul),
  (4) un secret / budget / attestation apparaît dans la fiche.
  Rollback = revert du commit ; aucun état mutable, aucune seconde définition.

## Runtime : lecture parallèle, aucun changement de comportement

Le runtime continue de lire les variables d'environnement (`participantPolicy`, L9a) : la fiche
n'est pas encore la source d'exécution. Seul ajout : le tampon « ` ; fiche v2 <hash>` » est
journalisé à la fin du `reason` de chaque choix serveur (`agent_model_choices`,
provider-models.ts) — la version et le hash de la fiche suivent chaque réponse (P3 §1).

## Alias ep-* (immuables, lignes du registre /owner)

Les 7 lignes inscrites au registre (cycle `owner-registry`, dernier acte `register_endpoint` par
endpoint, `attestation_kind` = `provider_adapter`, cible épinglée = `attestation_ref`) sont
reprises TELLES QUELLES ; le statut est celui du registre. Retraits du 2026-10-30 23:25 UTC
(décision Kevin du 2026-10-31 00:20 Paris). La spec fige la liste historique en ajout seul : un
id ne peut ni disparaître, ni changer de cible, de statut ou de rattachement.

| Alias | Agent | Cible (attestation_ref) | Statut (acte registre) |
| --- | --- | --- | --- |
| `ep-claude-glm47` | claude | `workers-ai:@cf/zai-org/glm-4.7-flash` | retired (1148) |
| `ep-cf-gemma4` | gemini | `workers-ai:@cf/google/gemma-4-26b-a4b-it` | retired (1147) |
| `ep-openrouter-gemma` | gemini | `openrouter:google/gemma-4-26b-a4b-it:free` | retired (1146) |
| `ep-gemini-35-flash-lite` | gemini | `gemini:gemini-3.5-flash-lite` | active (205) |
| `ep-zai-glm47` | vibe | `zai:glm-4.7-flash` | active (176) |
| `ep-groq-gptoss20b` | gpt | `groq:openai/gpt-oss-20b` | active (223) |
| `ep-openrouter-deepseek-v4` | — (hors agent, famille deepseek) | `openrouter:deepseek/deepseek-v4-flash:free` | probe_required (208) |

- `ep-gemini-flash` → `gemini:gemini-3.8-flash` : nom STABLE fixé par F1 pour l'endpoint
  consultatif 3.8 évoqué après G0 (#1154) ; statut `proposed`, AUCUNE attestation (pas encore
  inscrit). Son inscription (/owner, sonde, activation) reste un acte de Kevin ; la fiche ne fixe
  que le nom et la cible.
- `ep-openrouter-deepseek-v4` vit dans `endpoints_hors_agent` (famille `deepseek`, sans agent) :
  quand l'agent DeepSeek existera, l'entrée migrera sous lui sans changer d'id ni de cible.
- La cible d'un alias = `attestation_ref` du registre (`provider_adapter`) : un alias actif peut
  viser un modèle hors de la politique courante de son agent (ex. `ep-zai-glm47` →
  `zai:glm-4.7-flash`, le gratuit historique de Vibe) ; l'alias est une identité de registre,
  pas une politique.

## D1 : overrides opérationnels seulement

D1 (et l'environnement) ne portent que des réglages d'exploitation explicitement autorisés
(activation, budgets, références de clés) et l'audit — jamais une seconde définition des modèles.

## Limites

- Pas d'exécution npm locale par l'auteur : conformité attestée par lecture au head et CI au SHA
  exact ; `generate.mjs` n'est pas exécuté par la CI (le contrôle passe par la spec vitest).
- F1 ne couvre ni la promotion de modèle (F2 : sonde, canary, rollback), ni l'inscription owner de
  `ep-gemini-flash`, ni la bascule du runtime vers la fiche comme source (décision ultérieure).
