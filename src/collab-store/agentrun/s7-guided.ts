/**
 * CC8 S7 — mode guidé : le serveur fait les étapes mécaniques, le modèle écrit seulement le contenu.
 *
 * Constat (pilotes Vibe n° 4 seq 1710, Gemini n° 1 seq 1716) : les modèles gratuits n'enchaînent pas
 * seuls les six appels dépendants (mandat → branche → commit → CI → résultat → PR). Vibe s'est arrêté
 * après la lecture du mandat ; Gemini a épuisé ses 12 étapes sans créer la branche. Décision de Kevin
 * (2026-11-06, 16:25) : réparer le circuit pour les modèles gratuits, ce qui allège aussi le travail
 * d'un modèle payant plus tard.
 *
 * Principe : pour une exécution implement couverte par un mandat S7, la prochaine action est déduite
 * des seuls effets D1 (et des relevés de CI serveur). Si elle est mécanique, le serveur l'émet lui-même
 * comme sortie d'étape (aucun appel modèle, aucun jeton) ; elle passe ensuite par le MÊME chemin que
 * les appels du modèle : allow-list, gardes S7 (HALT, pause, fence, mandat, head), effets idempotents,
 * réconciliation, garde de complétude #271. Si l'action demande du contenu (premier commit, correction
 * après CI rouge), le modèle est appelé avec une consigne précise et un seul outil, github_commit_files.
 * Dans tout autre état (refus, ambiguïté, escalade), ARRÊT TYPÉ `guided_stop:<cause>` : un run guidé ne
 * revient jamais à l'orchestration libre par le modèle (relecture D12 GPT-6, 2e passe).
 *
 * Relecture D12 (GPT-6, PR #278) et avis Vibe / Grok (salon) :
 * - le serveur remplit lui-même name, expected_head_sha et le expected_sha du fichier (lu au head) :
 *   le modèle ne fournit que chemin et contenu (applyGuidedFill) ;
 * - les étapes serveur ne comptent pas dans max_steps (table agent_run_server_steps, plafond propre) ;
 * - branche préexistante : reprise depuis la tête lue par le mandat (branch_head) ;
 * - correction : diagnostics de CI bornés et contenu actuel du fichier injectés dans la consigne.
 */
import type { ModelOutput, ToolCall } from './engine';

export interface GuidedEntry { tool: string; value: Record<string, unknown> | null; failed: boolean }

export type GuidedStep =
  | { kind: 'server'; call: ToolCall }
  | { kind: 'model'; tools: string[]; instruction: string; fill: GuidedFill }
  | { kind: 'stop'; reason: string };

/**
 * Sortie d'une étape de contenu guidée : exactement UN appel github_commit_files, rien d'autre.
 * null = conforme ; sinon cause typée (aucun appel, appel non offert, plusieurs appels). Vérifié par
 * le moteur AVANT tout effet ; en cas de violation l'exécution s'arrête (aucun repli libre).
 */
export function guidedViolation(output: ModelOutput): string | null {
  if (output.tool_calls.length === 0) return 'no_tool_call';
  const names = output.tool_calls.map(call => call.name);
  if (names.some(name => name !== 'github_commit_files')) return 'tool_not_offered:' + [...new Set(names)].join(',').slice(0, 120);
  if (names.length !== 1) return 'multiple_tool_calls:' + names.length;
  return null;
}

/** Valeurs autoritaires du serveur, appliquées à l'appel github_commit_files du modèle. */
export interface GuidedFill { name: string; head: string; paths: string[]; blobs?: Record<string, string | null> }

/** Plafond propre des étapes serveur d'une exécution guidée (au-delà : flux historique). */
export const GUIDED_SERVER_MAX = 24;
const DIAGNOSTICS_MAX = 1_500;

const SHA = /^[a-f0-9]{40}$/;
const COMMIT_TOOLS = ['github_commit_files', 'github_replace_text'];

function sha(value: unknown): string | null {
  return typeof value === 'string' && SHA.test(value) ? value : null;
}

function lastIndex(entries: readonly GuidedEntry[], from: number, test: (e: GuidedEntry) => boolean): number {
  for (let i = entries.length - 1; i >= from; i--) if (test(entries[i])) return i;
  return -1;
}

/**
 * Prochaine étape guidée : serveur, contenu (modèle) ou arrêt typé.
 * `entries` : effets D1 dans l'ordre (n, idx), relevés de CI serveur insérés après leur effet d'origine.
 */
export function planGuidedS7(entries: readonly GuidedEntry[], branch: string, taskId: string, step: number): GuidedStep {
  const stop = (reason: string): GuidedStep => ({ kind: 'stop', reason });
  const name = branch.split('-api-')[1];
  if (!name) return stop('branch_name');
  const server = (tool: string, args: Record<string, unknown>): GuidedStep =>
    ({ kind: 'server', call: { id: 'srv-' + step + '-' + tool, name: tool, args } });

  // 1. Mandat.
  const scopeAt = lastIndex(entries, 0, e => e.tool === 'github_write_scope' && e.value?.branch === branch);
  if (scopeAt < 0) {
    return entries.some(e => e.tool === 'github_write_scope' && e.failed) ? stop('scope_refused') : server('github_write_scope', {});
  }
  const scope = entries[scopeAt].value!;
  const baseSha = sha(scope.base_sha);
  const paths = Array.isArray(scope.granted_paths) ? scope.granted_paths.filter((p): p is string => typeof p === 'string') : [];
  if (!baseSha || paths.length === 0) return stop('scope_invalid');

  // 2. Branche : créée dans cette exécution, ou préexistante (tête lue par le serveur dans le mandat).
  let createdAt = lastIndex(entries, 0, e => e.tool === 'github_create_branch' && e.value?.branch === branch && !!sha(e.value?.sha));
  let branchHead = createdAt < 0 ? null : sha(entries[createdAt].value!.sha);
  if (createdAt < 0 && sha(scope.branch_head)) {
    createdAt = scopeAt;
    branchHead = sha(scope.branch_head);
  }
  if (createdAt < 0 || !branchHead) {
    return entries.some(e => e.tool === 'github_create_branch' && e.failed) ? stop('branch_refused')
      : server('github_create_branch', { name, base_sha: baseSha });
  }

  // 3. Dernier commit de la branche après sa création.
  const commitAt = lastIndex(entries, createdAt + 1, e => COMMIT_TOOLS.includes(e.tool) && e.value?.branch === branch && !!sha(e.value?.commit_sha));
  const pathList = paths.map(p => '« ' + p + ' »').join(', ');
  if (commitAt < 0) {
    return { kind: 'model', tools: ['github_commit_files'], fill: { name, head: branchHead, paths }, instruction: [
      'ÉTAPE GUIDÉE PAR LE SERVEUR (S7). Le serveur a déjà lu ton mandat et préparé la branche ' + branch + ' (tête ' + branchHead + ').',
      'Ta seule action maintenant : appeler UNE FOIS l’outil github_commit_files avec :',
      '- message : un résumé d’une ligne (120 caractères au plus)',
      '- files : [{ "path": <un chemin autorisé>, "content": <le contenu COMPLET du fichier> }]',
      'Le serveur complète lui-même name, expected_head_sha et expected_sha. Chemins autorisés : ' + pathList + '. N’appelle aucun autre outil.',
      'Ensuite, le serveur lancera la CI, attendra son résultat et ouvrira la PR lui-même.',
    ].join('\n') };
  }
  const commitSha = sha(entries[commitAt].value!.commit_sha)!;

  // 4. CI lancée au SHA du dernier commit.
  const startedAt = lastIndex(entries, commitAt + 1, e => e.tool === 'github_run_checks' && e.value?.targetSha === commitSha
    && Number.isSafeInteger(e.value?.runId) && Number(e.value?.runId) > 0);
  if (startedAt < 0) {
    return entries.slice(commitAt + 1).some(e => e.tool === 'github_run_checks' && e.failed) ? stop('checks_refused')
      : server('github_run_checks', { name, sha: commitSha });
  }
  const runId = Number(entries[startedAt].value!.runId);

  // 5. Résultat de CI (dernier relevé connu, modèle ou serveur).
  const checkedAt = lastIndex(entries, startedAt + 1, e => e.tool === 'github_check_result');
  const checked = checkedAt < 0 ? null : entries[checkedAt];
  if (!checked || (checked.value?.targetSha === commitSha && checked.value?.next_action === 'wait')) {
    return server('github_check_result', { name, sha: commitSha, run_id: runId });
  }
  if (checked.failed || checked.value?.targetSha !== commitSha) return stop('check_unexpected');
  const verdict = checked.value.next_action;

  // 6. CI verte : PR prête, une seule fois.
  if (checked.value.verifiedSuccess === true && checked.value.status === 'completed') {
    if (lastIndex(entries, checkedAt + 1, e => e.tool === 'github_open_pr') >= 0) return stop('pr_already_open');
    return server('github_open_pr', { name, title: ('CC8 ' + taskId + ' — ' + paths.join(', ')).slice(0, 200),
      body: 'PR ouverte en mode guidé S7 : branche, commit, CI et PR exécutés par le serveur ; contenu écrit par le modèle de l’agent. CI vérifiée au SHA ' + commitSha + '.' });
  }

  // 7. CI rouge, corrections restantes : le modèle corrige le contenu.
  if (verdict === 'correct') {
    const diagnostics = checked.value.diagnostics ?? checked.value.failures ?? checked.value.summary;
    const shown = diagnostics === undefined ? '(aucun diagnostic fourni)' : JSON.stringify(diagnostics).slice(0, DIAGNOSTICS_MAX);
    return { kind: 'model', tools: ['github_commit_files'], fill: { name, head: commitSha, paths }, instruction: [
      'ÉTAPE GUIDÉE PAR LE SERVEUR (S7). La CI a ÉCHOUÉ au SHA ' + commitSha + '.',
      'Diagnostics (bornés) : ' + shown,
      'Ta seule action maintenant : corriger le fichier en appelant UNE FOIS github_commit_files avec :',
      '- message : un résumé d’une ligne de la correction',
      '- files : [{ "path": <le chemin concerné>, "content": <le contenu COMPLET corrigé> }]',
      'Le serveur complète lui-même name, expected_head_sha et expected_sha. Chemins autorisés : ' + pathList + '. N’appelle aucun autre outil.',
    ].join('\n') };
  }
  // Escalade, refus, état inattendu : arrêt typé, jamais de repli libre.
  return stop('ci_' + String(verdict ?? 'unknown').replace(/[^a-z0-9_]/gi, '').slice(0, 40));
}

/**
 * Applique les valeurs autoritaires du serveur à la sortie du modèle (étape de contenu guidée) :
 * name et expected_head_sha imposés, expected_sha du fichier imposé quand le serveur l'a lu (fichier
 * existant au head) et retiré sinon. Les chemins restent ceux du modèle : la garde S7 les vérifie.
 */
export function applyGuidedFill(output: ModelOutput, fill: GuidedFill): ModelOutput {
  return {
    text: output.text,
    tool_calls: output.tool_calls.map(call => {
      if (call.name !== 'github_commit_files') return call;
      const raw = Array.isArray(call.args?.files) ? call.args.files as unknown[] : [];
      const files = raw.map(entry => {
        const file = { ...((entry ?? {}) as Record<string, unknown>) };
        const path = typeof file.path === 'string' ? file.path : '';
        delete file.expected_sha;
        const blob = fill.blobs?.[path];
        if (blob) file.expected_sha = blob;
        return file;
      });
      return { ...call, args: { ...(call.args ?? {}), name: fill.name, expected_head_sha: fill.head, files } };
    }),
  };
}
