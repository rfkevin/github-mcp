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
 * Dans tout autre état (refus, ambiguïté, branche préexistante, escalade), aucun guidage : flux historique.
 */
import type { ToolCall } from './engine';

export interface GuidedEntry { tool: string; value: Record<string, unknown> | null; failed: boolean }

export type GuidedStep =
  | { kind: 'server'; call: ToolCall }
  | { kind: 'model'; tools: string[]; instruction: string };

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
 * Prochaine étape guidée, ou null (aucun guidage : le modèle garde la main avec tous ses outils).
 * `entries` : effets D1 dans l'ordre (n, idx), relevés de CI serveur insérés après leur effet d'origine.
 */
export function planGuidedS7(entries: readonly GuidedEntry[], branch: string, taskId: string, step: number): GuidedStep | null {
  const name = branch.split('-api-')[1];
  if (!name) return null;
  const server = (tool: string, args: Record<string, unknown>): GuidedStep =>
    ({ kind: 'server', call: { id: 'srv-' + step + '-' + tool, name: tool, args } });

  // 1. Mandat.
  const scopeAt = lastIndex(entries, 0, e => e.tool === 'github_write_scope' && e.value?.branch === branch);
  if (scopeAt < 0) {
    return entries.some(e => e.tool === 'github_write_scope' && e.failed) ? null : server('github_write_scope', {});
  }
  const scope = entries[scopeAt].value!;
  const baseSha = sha(scope.base_sha);
  const paths = Array.isArray(scope.granted_paths) ? scope.granted_paths.filter((p): p is string => typeof p === 'string') : [];
  if (!baseSha || paths.length === 0) return null;

  // 2. Branche (créée dans cette exécution ; une branche préexistante n'est pas guidée).
  const createdAt = lastIndex(entries, 0, e => e.tool === 'github_create_branch' && e.value?.branch === branch && !!sha(e.value?.sha));
  if (createdAt < 0) {
    return entries.some(e => e.tool === 'github_create_branch' && e.failed) ? null
      : server('github_create_branch', { name, base_sha: baseSha });
  }
  const branchHead = sha(entries[createdAt].value!.sha)!;

  // 3. Dernier commit de la branche après sa création.
  const commitAt = lastIndex(entries, createdAt + 1, e => COMMIT_TOOLS.includes(e.tool) && e.value?.branch === branch && !!sha(e.value?.commit_sha));
  const pathList = paths.map(p => '« ' + p + ' »').join(', ');
  if (commitAt < 0) {
    return { kind: 'model', tools: ['github_commit_files'], instruction: [
      'ÉTAPE GUIDÉE PAR LE SERVEUR (S7). Le serveur a déjà lu ton mandat et créé la branche ' + branch + ' (tête ' + branchHead + ').',
      'Ta seule action maintenant : appeler UNE FOIS l’outil github_commit_files avec exactement :',
      '- name : "' + name + '"',
      '- expected_head_sha : "' + branchHead + '"',
      '- message : un résumé d’une ligne (120 caractères au plus)',
      '- files : [{ "path": <un chemin autorisé>, "content": <le contenu COMPLET du fichier> }]',
      'Chemins autorisés : ' + pathList + '. N’appelle aucun autre outil.',
      'Ensuite, le serveur lancera la CI, attendra son résultat et ouvrira la PR lui-même.',
    ].join('\n') };
  }
  const commitSha = sha(entries[commitAt].value!.commit_sha)!;

  // 4. CI lancée au SHA du dernier commit.
  const startedAt = lastIndex(entries, commitAt + 1, e => e.tool === 'github_run_checks' && e.value?.targetSha === commitSha
    && Number.isSafeInteger(e.value?.runId) && Number(e.value?.runId) > 0);
  if (startedAt < 0) {
    return entries.slice(commitAt + 1).some(e => e.tool === 'github_run_checks' && e.failed) ? null
      : server('github_run_checks', { name, sha: commitSha });
  }
  const runId = Number(entries[startedAt].value!.runId);

  // 5. Résultat de CI (dernier relevé connu, modèle ou serveur).
  const checkedAt = lastIndex(entries, startedAt + 1, e => e.tool === 'github_check_result');
  const checked = checkedAt < 0 ? null : entries[checkedAt];
  if (!checked || (checked.value?.targetSha === commitSha && checked.value?.next_action === 'wait')) {
    return server('github_check_result', { name, sha: commitSha, run_id: runId });
  }
  if (checked.failed || checked.value?.targetSha !== commitSha) return null;
  const verdict = checked.value.next_action;

  // 6. CI verte : PR prête, une seule fois.
  if (checked.value.verifiedSuccess === true && checked.value.status === 'completed') {
    if (lastIndex(entries, checkedAt + 1, e => e.tool === 'github_open_pr') >= 0) return null;
    return server('github_open_pr', { name, title: ('CC8 ' + taskId + ' — ' + paths.join(', ')).slice(0, 200),
      body: 'PR ouverte en mode guidé S7 : branche, commit, CI et PR exécutés par le serveur ; contenu écrit par le modèle de l’agent. CI vérifiée au SHA ' + commitSha + '.' });
  }

  // 7. CI rouge, corrections restantes : le modèle corrige le contenu.
  if (verdict === 'correct') {
    return { kind: 'model', tools: ['github_commit_files'], instruction: [
      'ÉTAPE GUIDÉE PAR LE SERVEUR (S7). La CI a ÉCHOUÉ au SHA ' + commitSha + ' (diagnostics dans le dernier résultat github_check_result).',
      'Ta seule action maintenant : corriger le fichier en appelant UNE FOIS github_commit_files avec exactement :',
      '- name : "' + name + '"',
      '- expected_head_sha : "' + commitSha + '"',
      '- message : un résumé d’une ligne de la correction',
      '- files : [{ "path": <le chemin concerné>, "content": <le contenu COMPLET corrigé> }]',
      'Chemins autorisés : ' + pathList + '. N’appelle aucun autre outil.',
    ].join('\n') };
  }
  return null; // escalade, refus, état inattendu : flux historique
}
