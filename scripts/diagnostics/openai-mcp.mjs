import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_SERVER = 'https://github-mcp.rfahedkevin.workers.dev/mcp';
const TOOL = 'github_list_repositories';

export function buildRequest({ token, serverUrl = DEFAULT_SERVER, model = 'gpt-6-astra' }) {
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('MCP_SERVER_URL doit être une URL HTTPS sans identifiants ni paramètres.');
  }
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('MCP_ACCESS_TOKEN est requis : jeton OAuth du MCP, pas une clé GitHub.');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('OPENAI_MODEL invalide.');
  return {
    model, store: false, max_output_tokens: 600,
    tools: [{ type: 'mcp', server_label: 'aide_codage',
      server_description: 'Outils GitHub de lecture et de collaboration de développement.',
      server_url: url.href, authorization: token,
      allowed_tools: [TOOL], require_approval: 'never' }],
    input: 'Utilise github_list_repositories une seule fois pour lister les dépôts accessibles.',
  };
}

async function boundedJson(response) {
  if (!response.body) throw new Error('Réponse OpenAI vide.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2_000_000) {
        await reader.cancel();
        throw new Error('Réponse OpenAI trop volumineuse.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(data));
}

/** Return only diagnostic counts/states; never echo tokens, arguments, repository data or provider errors. */
function repositoryResult(output) {
  try {
    const result = typeof output === 'string' ? JSON.parse(output) : output;
    if (!result || result.isError || result.error || result.structuredContent?.error) return false;
    if (Array.isArray(result.repositories) || Array.isArray(result.structuredContent?.repositories)) return true;
    return Array.isArray(result.content) && result.content.some(item =>
      item?.type === 'text' && repositoryResult(item.text));
  } catch { return false; }
}

export async function diagnose({ apiKey, token, serverUrl, model, fetcher = globalThis.fetch }) {
  const body = buildRequest({ token, serverUrl, model });
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new Error('OPENAI_API_KEY est requis pour le test réel.');
  }
  let response;
  try {
    response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  } catch {
    return { ok: false, stage: 'api', reason: 'network_or_timeout' };
  }
  if (!response.ok) return { ok: false, stage: 'api', status: response.status };
  let payload;
  try { payload = await boundedJson(response); } catch {
    return { ok: false, stage: 'api', status: response.status, reason: 'invalid_or_oversized_response' };
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const listing = output.find(item => item?.type === 'mcp_list_tools' && item.server_label === 'aide_codage');
  const tools = Array.isArray(listing?.tools) ? listing.tools : [];
  const discovered = !listing?.error && tools.some(tool => tool?.name === TOOL);
  const calls = output.filter(item => item?.type === 'mcp_call' && item.server_label === 'aide_codage' && item.name === TOOL);
  // API responses may contain an incomplete call. Only an actual non-null output confirms completion.
  const callSucceeded = calls.length === 1 && !calls[0].error &&
    repositoryResult(calls[0].output);
  return { ok: discovered && callSucceeded, status: response.status,
    stage: !discovered ? 'discovery' : 'call', importedTools: tools.length,
    expectedToolImported: discovered, calls: calls.length, callSucceeded };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some(flag => !['--dry-run', '--live'].includes(flag)) ||
        (flags.includes('--dry-run') && flags.includes('--live'))) throw new Error('Choisir --dry-run ou --live.');
    const settings = { token: process.env.MCP_ACCESS_TOKEN,
      model: process.env.OPENAI_MODEL, serverUrl: process.env.MCP_SERVER_URL };
    if (!flags.includes('--live')) {
      const body = buildRequest({ ...settings, token: '<MCP_ACCESS_TOKEN>' });
      console.log(JSON.stringify({ dryRun: true, endpoint: ENDPOINT, request: body }, null, 2));
    } else {
      const result = await diagnose({ ...settings, apiKey: process.env.OPENAI_API_KEY });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch {
    console.error('Diagnostic impossible. Vérifier les options et les variables décrites dans docs/mcp-compatibility.md.');
    process.exitCode = 1;
  }
}
