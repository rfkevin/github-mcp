import { spawnSync } from 'node:child_process';
import { checkPlan, validateInputs, validateTarget } from './check-plan.mjs';

const scope = process.argv[2] ?? process.env.CHECK_SCOPE ?? 'quick';
const target = process.env.CHECK_TARGET ?? '';
try {
  const plan = validateInputs(scope, target, process.env.CHECK_SHA);
  validateTarget(process.cwd(), target);
  console.log(`Vérifications ${plan.scope} (plan ${plan.version})${plan.sha ? ` — ${plan.sha}` : ''}`);
  for (const args of checkPlan(scope, target)) {
    const started = Date.now();
    const result = spawnSync(process.execPath, args, {
      cwd: process.cwd(), shell: false, stdio: 'inherit', timeout: 8 * 60_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    console.log(`Durée : ${Math.round((Date.now() - started) / 1000)} s`);
    if (result.error || result.status !== 0) process.exit(result.status || 1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Vérification impossible.');
  process.exitCode = 1;
}
