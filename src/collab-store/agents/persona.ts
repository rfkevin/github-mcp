/**
 * CC-5 L3b — personas des collaborateurs pour le pilote agents API.
 *
 * Cartes serveur uniquement : un agent API ne choisit pas sa persona.
 * Aucun canal API n'émet de verdict D12 (AGREE/PASS/AMEND au head/base).
 */

export type AgentChannel = 'chat' | 'api';

export interface AgentPersona {
  participant_id: string;
  family_id: string;
  display: string;
  /** Rôles autorisés dans le pilote (owner/reviewer/tester côté tâche). */
  roles: ReadonlyArray<'owner' | 'reviewer' | 'tester' | 'coordinator'>;
  /** Canal API autorisé pour ce principal dans le pilote. */
  api_enabled: boolean;
  /** Modèle free préféré (attestation registry) — le moins cher disponible. */
  preferred_free_model: string;
  system_duty: string;
}

/**
 * Personas figées du cycle CC-5. api_enabled=true pour le pilote ;
 * les verdicts D12 restent réservés au canal chat / MCP authentifié humain.
 */
export const AGENT_PERSONAS: Readonly<Record<string, AgentPersona>> = {
  grok: {
    participant_id: 'grok',
    family_id: 'xai',
    display: 'Grok',
    roles: ['owner', 'reviewer', 'tester'],
    api_enabled: true,
    preferred_free_model: 'openai/gpt-oss-20b',
    system_duty: 'Deliver owned paths; independent tests; never self-validate; never emit D12 verdicts on the API channel.',
  },
  vibe: {
    participant_id: 'vibe',
    family_id: 'vibe',
    display: 'Vibe GLM',
    roles: ['owner', 'reviewer', 'tester'],
    api_enabled: true,
    preferred_free_model: '@cf/zai-org/glm-4.7-flash',
    system_duty: 'Independent review and research; never emit D12 verdicts on the API channel.',
  },
  gpt6: {
    participant_id: 'gpt6',
    family_id: 'chatgpt',
    display: 'ChatGPT GPT-6',
    roles: ['owner', 'reviewer', 'tester'],
    api_enabled: true,
    preferred_free_model: 'openai/gpt-oss-20b',
    system_duty: 'Review and design; never emit D12 verdicts on the API channel.',
  },
  claude: {
    participant_id: 'claude',
    family_id: 'anthropic',
    display: 'Claude',
    roles: ['owner', 'reviewer', 'tester'],
    api_enabled: true,
    preferred_free_model: '@cf/google/gemma-4-26b-a4b-it',
    system_duty: 'Controller and infrastructure; never emit D12 verdicts on the API channel.',
  },
};

export function personaOf(participantId: string): AgentPersona | null {
  return AGENT_PERSONAS[participantId] ?? null;
}

export function assertApiPersona(participantId: string): AgentPersona {
  const persona = personaOf(participantId);
  if (!persona || !persona.api_enabled) {
    throw new AgentDenied('persona_not_api_enabled');
  }
  return persona;
}

export class AgentDenied extends Error {
  constructor(public readonly reason: string) {
    super('Agent denied: ' + reason);
  }
}
