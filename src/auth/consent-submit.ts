// Fixed source only; the page authorizes this script with a per-response nonce.
export const CONSENT_SUBMIT_SCRIPT = `(() => {
  const form = document.querySelector('form');
  const status = document.getElementById('connection-status');
  let submitted = false;
  form.addEventListener('submit', event => {
    if (submitted) { event.preventDefault(); return; }
    const decision = event.submitter && event.submitter.value;
    if (decision !== 'approve' && decision !== 'deny') { event.preventDefault(); return; }
    submitted = true;
    const selected = document.createElement('input');
    selected.type = 'hidden'; selected.name = 'decision'; selected.value = decision;
    form.append(selected);
    form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    status.textContent = decision === 'approve' ? 'Connexion en cours… Patientez sans recharger la page.' : 'Refus en cours…';
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    status.textContent = 'Recommencez la connexion depuis votre application : cette demande a déjà été envoyée.';
  });
})();`;
