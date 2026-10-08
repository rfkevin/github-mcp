/**
 * CC-3 C6 — explicit fallback when the store is down (R4).
 *
 * The store never falls back silently: a failing call answers
 * STORE_UNAVAILABLE with this object. The only sanctioned fallback is a
 * READ of the last merged CC-STATE-1 file through github_collab_context on the
 * GitHub endpoint (/mcp). Writes are suspended: an agent must not record the
 * state in GitHub instead of the store (no state PR, no file edit) while the
 * store is unavailable. No code in src/collab-store/ calls GitHub.
 */
export interface FallbackState {
  repository: string;
  path: string;
  ref: string;
}

export interface StoreFallback {
  tool: 'github_collab_context';
  endpoint: '/mcp';
  mode: 'read_only';
  state: FallbackState | null;
  writes: 'suspended';
  instruction: string;
}

const FALLBACK_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):([^@\s]+)@(\S+)$/;

/** COLLAB_FALLBACK_STATE = "owner/repo:path/to/state.md@ref" (optional, non-secret). */
export function parseFallbackState(value: string | undefined): FallbackState | null {
  const match = typeof value === 'string' ? value.trim().match(FALLBACK_RE) : null;
  if (!match || match[2].includes('..')) return null;
  return { repository: match[1], path: match[2].replace(/^\/+/, ''), ref: match[3] };
}

export function storeFallback(state: FallbackState | null): StoreFallback {
  const where = state
    ? 'github_collab_context { repository: "' + state.repository + '", ref: "' + state.ref + '", workflowStatePath: "' + state.path + '" }'
    : 'github_collab_context sur le dernier état CC-STATE-1 fusionné (dépôt et chemin indiqués par le propriétaire ou par le dernier collab_export)';
  return {
    tool: 'github_collab_context',
    endpoint: '/mcp',
    mode: 'read_only',
    state,
    writes: 'suspended',
    instruction: 'Store indisponible : lisez le contexte via ' + where
      + '. Aucune écriture de substitution dans GitHub (ni PR d’état, ni fichier) : réessayez l’écriture dans le store quand il répond.',
  };
}
