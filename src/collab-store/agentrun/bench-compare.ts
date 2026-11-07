/**
 * CC8 S7 durcissement — lot C, R6 (#283) : comparaison équitable de runs, sans donnée inventée.
 *
 * Fonction pure sur des relevés déjà établis (runs historiques, fixtures, mocks). Règles :
 * - une mesure par run : sortie fonctionnelle, premier commit, corrections CI, erreurs d'outil, PR, jetons,
 *   durée, modèle servi, repli ; une valeur inconnue reste `null` (jamais estimée) ;
 * - aucune conclusion tant qu'un modèle n'a pas au moins MIN_RUNS_PER_MODEL runs sur la MÊME tâche :
 *   un essai chacun ne départage rien (issue #283, réception 2) ;
 * - toute conclusion cite les identifiants de runs qui la fondent.
 */
export const MIN_RUNS_PER_MODEL = 3;

export interface BenchRun {
  run_id: string; task: string; model_served: string | null; fallback_used: boolean | null;
  /** Empreinte du même protocole, entrée, outils et budgets, vérifiée avant de comparer. */
  scenario_sha?: string | null;
  /** Résultat produit observé, distinct du simple statut completed. */
  functional_pass?: boolean | null;
  outcome: 'completed' | 'failed' | 'step_limit' | 'token_limit' | 'deadline';
  first_commit: boolean | null; ci_corrections: number | null; tool_errors: number | null; pr_opened: boolean | null;
  tokens: number | null; duration_s: number | null; cost_cents: number | null; sha: string | null;
}

export interface ModelStats { model: string; runs: number; completed: number; tokens_known: number; tokens_total: number; run_ids: string[] }
export type Verdict = { conclusive: false; reason: string; stats: ModelStats[] } | { conclusive: true; best: string; stats: ModelStats[]; basis: string[] };

export function compareModels(runs: readonly BenchRun[], task: string): Verdict {
  const same = runs.filter(r => r.task === task && r.model_served !== null);
  const byModel = new Map<string, BenchRun[]>();
  for (const run of same) byModel.set(run.model_served!, [...(byModel.get(run.model_served!) ?? []), run]);
  const stats: ModelStats[] = [...byModel.entries()].map(([model, list]) => ({
    model, runs: list.length, completed: list.filter(r => r.outcome === 'completed').length,
    tokens_known: list.filter(r => r.tokens !== null).length, tokens_total: list.reduce((n, r) => n + (r.tokens ?? 0), 0),
    run_ids: list.map(r => r.run_id) })).sort((a, b) => a.model.localeCompare(b.model));
  if (stats.length < 2) return { conclusive: false, reason: 'un seul modèle (ou aucun) sur cette tâche', stats };
  if (new Set(same.map(r => r.run_id)).size !== same.length) {
    return { conclusive: false, reason: 'run_id dupliqué : essais non indépendants', stats };
  }
  const scenarios = new Set(same.map(r => r.scenario_sha ?? ''));
  if (scenarios.size !== 1 || !/^[a-f0-9]{64}$/.test([...scenarios][0])) {
    return { conclusive: false, reason: 'entrées, outils et budgets appariés non prouvés', stats };
  }
  if (same.some(r => typeof r.functional_pass !== 'boolean')) {
    return { conclusive: false, reason: 'résultat fonctionnel inconnu sur au moins un essai', stats };
  }
  const thin = stats.filter(s => s.runs < MIN_RUNS_PER_MODEL);
  if (thin.length > 0) return { conclusive: false, reason: 'moins de ' + MIN_RUNS_PER_MODEL + ' runs pour : ' + thin.map(s => s.model).join(', '), stats };
  const rate = (s: ModelStats) => same.filter(r => r.model_served === s.model && r.functional_pass === true).length / s.runs;
  const ranked = [...stats].sort((a, b) => rate(b) - rate(a) || a.model.localeCompare(b.model));
  if (rate(ranked[0]) === rate(ranked[1])) return { conclusive: false, reason: 'taux de réussite égaux', stats };
  return { conclusive: true, best: ranked[0].model, stats, basis: stats.flatMap(s => s.run_ids) };
}