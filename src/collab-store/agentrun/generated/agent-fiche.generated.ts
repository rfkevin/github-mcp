/**
 * ARTIFACT GÉNÉRÉ — NE PAS ÉDITER À LA MAIN.
 * Source unique : config/agents.fiche.json (CC-7 F1, fiche canonique des agents).
 * Régénéré par scripts/agent-fiche/generate.mjs ; la CI échoue si cet artefact, la fiche ou
 * les variables AGENT_RUN_* de wrangler.jsonc divergent (cc7-f1-fiche-canonical.spec.ts).
 */

/** Version de la fiche canonique (journalisée avec chaque choix serveur). */
export const FICHE_VERSION = 2;

/** Empreinte FNV-1a 64 du contenu exact de la fiche (identité de version, pas un secret). */
export const FICHE_HASH = "55cc00d2c5f293dc";

/** Contenu exact de la fiche canonique (audit : version et hash se recomptent depuis ici). */
export const FICHE_RAW = `{
  "version": 2,
  "global_fallback_model": "workers-ai:@cf/zai-org/glm-4.7-flash",
  "agents": [
    {
      "id": "claude",
      "participant_id": "claude",
      "family": "anthropic",
      "active": true,
      "models": [
        { "role": "fort", "ref": "anthropic:claude-opus-5-5" },
        { "role": "rapide", "ref": "anthropic:claude-sonnet-5-5" },
        { "role": "leger", "ref": "anthropic:claude-haiku-5-5" }
      ],
      "endpoints": [
        {
          "endpoint_id": "ep-claude-glm47",
          "ref": "workers-ai:@cf/zai-org/glm-4.7-flash",
          "status": "retired",
          "principal_id": "claude",
          "attestation_kind": "provider_adapter",
          "attestation_ref": "workers-ai:@cf/zai-org/glm-4.7-flash",
          "immutable_alias": true
        }
      ]
    },
    {
      "id": "grok",
      "participant_id": "grok",
      "family": "xai",
      "active": true,
      "models": [
        { "role": "fort", "ref": "xai:grok-4.7" },
        { "role": "rapide", "ref": "xai:grok-4.20-0309-non-reasoning" }
      ],
      "endpoints": []
    },
    {
      "id": "vibe",
      "participant_id": "vibe",
      "family": "zai",
      "active": true,
      "models": [
        { "role": "fort", "ref": "zai:glm-5.3" },
        { "role": "gratuit", "ref": "workers-ai:@cf/zai-org/glm-4.7-flash" }
      ],
      "endpoints": [
        {
          "endpoint_id": "ep-zai-glm47",
          "ref": "zai:glm-4.7-flash",
          "status": "active",
          "principal_id": "zai-glm47",
          "attestation_kind": "provider_adapter",
          "attestation_ref": "zai:glm-4.7-flash",
          "immutable_alias": true
        }
      ]
    },
    {
      "id": "gpt",
      "participant_id": "gpt6",
      "family": "openai",
      "active": false,
      "models": [
        { "role": "fort", "ref": "groq:openai/gpt-oss-120b" },
        { "role": "rapide", "ref": "groq:openai/gpt-oss-20b" }
      ],
      "endpoints": [
        {
          "endpoint_id": "ep-groq-gptoss20b",
          "ref": "groq:openai/gpt-oss-20b",
          "status": "active",
          "principal_id": "groq-gptoss20b",
          "attestation_kind": "provider_adapter",
          "attestation_ref": "groq:openai/gpt-oss-20b",
          "immutable_alias": true
        }
      ]
    },
    {
      "id": "gemini",
      "participant_id": "gemini",
      "family": "google",
      "active": true,
      "models": [
        { "role": "fort", "ref": "gemini:gemini-3.8-flash" },
        { "role": "rapide", "ref": "gemini:gemini-3.6-flash" },
        { "role": "leger", "ref": "gemini:gemini-3.5-flash-lite" },
        { "role": "gratuit", "ref": "workers-ai:@cf/google/gemma-4-26b-a4b-it" }
      ],
      "endpoints": [
        {
          "endpoint_id": "ep-gemini-35-flash-lite",
          "ref": "gemini:gemini-3.5-flash-lite",
          "status": "active",
          "principal_id": "gemini-35-flash-lite",
          "attestation_kind": "provider_adapter",
          "attestation_ref": "gemini:gemini-3.5-flash-lite",
          "immutable_alias": true
        },
        {
          "endpoint_id": "ep-gemini-flash",
          "ref": "gemini:gemini-3.8-flash",
          "status": "proposed",
          "immutable_alias": true
        },
        {
          "endpoint_id": "ep-cf-gemma4",
          "ref": "workers-ai:@cf/google/gemma-4-26b-a4b-it",
          "status": "retired",
          "principal_id": "cf-gemma4",
          "attestation_kind": "provider_adapter",
          "attestation_ref": "workers-ai:@cf/google/gemma-4-26b-a4b-it",
          "immutable_alias": true
        },
        {
          "endpoint_id": "ep-openrouter-gemma",
          "ref": "openrouter:google/gemma-4-26b-a4b-it:free",
          "status": "retired",
          "principal_id": "openrouter-gemma",
          "attestation_kind": "provider_adapter",
          "attestation_ref": "openrouter:google/gemma-4-26b-a4b-it:free",
          "immutable_alias": true
        }
      ]
    }
  ],
  "endpoints_hors_agent": [
    {
      "endpoint_id": "ep-openrouter-deepseek-v4",
      "family": "deepseek",
      "ref": "openrouter:deepseek/deepseek-v4-flash:free",
      "status": "probe_required",
      "principal_id": "openrouter-deepseek-v4",
      "attestation_kind": "provider_adapter",
      "attestation_ref": "openrouter:deepseek/deepseek-v4-flash:free",
      "immutable_alias": true
    }
  ]
}
`;

/** Variables wrangler AGENT_RUN_* dérivées de la fiche (définitions de modèles uniquement). */
export const AGENT_RUN_VARS: Readonly<Record<string, string>> = Object.freeze({
	AGENT_RUN_MODEL: "workers-ai:@cf/zai-org/glm-4.7-flash",
	AGENT_RUN_PARTICIPANTS: "claude,grok,vibe,gemini",
	AGENT_RUN_FAMILY_CLAUDE: "anthropic",
	AGENT_RUN_MODELS_CLAUDE: "anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5",
	AGENT_RUN_FAMILY_GROK: "xai",
	AGENT_RUN_MODELS_GROK: "xai:grok-4.7,xai:grok-4.20-0309-non-reasoning",
	AGENT_RUN_FAMILY_VIBE: "zai",
	AGENT_RUN_MODELS_VIBE: "zai:glm-5.3,workers-ai:@cf/zai-org/glm-4.7-flash",
	AGENT_RUN_FAMILY_GPT6: "openai",
	AGENT_RUN_MODELS_GPT6: "groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b",
	AGENT_RUN_FAMILY_GEMINI: "google",
	AGENT_RUN_MODELS_GEMINI: "gemini:gemini-3.8-flash,gemini:gemini-3.6-flash,gemini:gemini-3.5-flash-lite,workers-ai:@cf/google/gemma-4-26b-a4b-it",
});
