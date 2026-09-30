import { validateInputs } from './check-plan.mjs';

try {
  validateInputs(process.env.CHECK_SCOPE, process.env.CHECK_TARGET ?? '', process.env.CHECK_SHA ?? '');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(process.env.CHECK_REQUEST_ID ?? 'manual')) throw new Error('Identifiant de requête invalide.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Entrées invalides.');
  process.exitCode = 1;
}
