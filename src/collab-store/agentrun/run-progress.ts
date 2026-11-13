/**
 * Observabilité anti-boucle pour le coordinateur, sans exposer arguments ou résultats.
 * Une répétition est un INDICE pour le recadrage, jamais un plafond ni un arrêt forcé.
 */
import { ensureAgentRunSchema } from './schema';

interface CompletedStep { n: number; model_output: string | null; results: string | null }
interface ToolCall { id: string; name: string; args: unknown }
interface ToolReceipt { id: string; content: string; error?: boolean }

export interface RunProgress {
  run_id: string;
  status: string;
  sampled_steps: number;
  latest_step: number | null;
  last_tool: string | null;
  unique_call_intents: number;
  consecutive_same_call: number;
  consecutive_same_result: number;
  successful_effects_in_window: number;
  candidate_stagnation: boolean;
  note: string;
}

export async function runProgress(db: D1Database, runId: string): Promise<RunProgress | null> {
  await ensureAgentRunSchema(db);
  const run = await db.prepare('SELECT status FROM agent_runs WHERE run_id=?1')
    .bind(runId).first<{ status: string }>();
  if (!run) return null;
  const steps = (await db.prepare(
    "SELECT n,model_output,results FROM agent_run_steps WHERE run_id=?1 AND state='completed' ORDER BY n DESC LIMIT 24",
  ).bind(runId).all<CompletedStep>()).results;
  const intents = new Set<string>();
  let lastTool: string | null = null;
  let sameCall = 0;
  let sameResult = 0;
  let baselineCall: string | null = null;
  let baselineResult: string | null = null;
  let matchingCall = true;
  let matchingResult = true;
  for (const step of steps) {
    let calls: ToolCall[];
    let receipts: ToolReceipt[];
    try {
      calls = (JSON.parse(step.model_output ?? '{}') as { tool_calls?: ToolCall[] }).tool_calls ?? [];
      receipts = JSON.parse(step.results ?? '[]') as ToolReceipt[];
    } catch {
      matchingCall = false; matchingResult = false;
      continue;
    }
    if (!Array.isArray(calls) || !Array.isArray(receipts) || calls.length !== 1) {
      matchingCall = false; matchingResult = false;
      continue;
    }
    const call = calls[0];
    if (!call || typeof call.name !== 'string' || typeof call.id !== 'string') {
      matchingCall = false; matchingResult = false;
      continue;
    }
    const intent = JSON.stringify([call.name,call.args]);
    const receipt = receipts.find(item => item.id === call.id);
    const exact = receipt ? JSON.stringify([intent,receipt.content,receipt.error === true]) : null;
    intents.add(intent);
    if (lastTool === null) lastTool = call.name;
    if (baselineCall === null) baselineCall = intent;
    if (baselineResult === null && exact !== null) baselineResult = exact;
    if (matchingCall && intent === baselineCall) sameCall++;
    else matchingCall = false;
    if (matchingResult && exact !== null && exact === baselineResult) sameResult++;
    else matchingResult = false;
  }
  const oldest = steps.at(-1)?.n ?? 0;
  const effects = await db.prepare(
    "SELECT COUNT(*) AS n FROM agent_run_effects WHERE run_id=?1 AND n>=?2 AND status='completed'",
  ).bind(runId,oldest).first<{ n: number }>();
  const successfulEffects = effects?.n ?? 0;
  // Quatre résultats IDENTIQUES de suite, sans effet métier D1 : motif objectif
  // d'un recadrage ; aucune suppression, suspension ou limite de mission.
  const candidate = run.status === 'running' && sameResult >= 4 && successfulEffects === 0;
  return {
    run_id: runId, status: run.status, sampled_steps: steps.length,
    latest_step: steps[0]?.n ?? null, last_tool: lastTool,
    unique_call_intents: intents.size, consecutive_same_call: sameCall,
    consecutive_same_result: sameResult, successful_effects_in_window: successfulEffects,
    candidate_stagnation: candidate,
    note: candidate
      ? 'Même intention ET même résultat au moins quatre fois sans effet D1 : le coordinateur peut recadrer le run.'
      : 'Pas de stagnation certaine dans cette fenêtre. Une analyse longue ou des résultats changeants sont permis.',
  };
}
