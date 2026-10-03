# Connexion : formulaire et redirections du client

Le POST /authorize termine le consentement avec un document HTML 200 indépendant,
puis une navigation automatique vers GitHub (ou vers le callback validé en cas de
refus). Cela empêche la directive form-action de la page de consentement de bloquer
les redirections ultérieures du client. Le callback GitHub reste un 302 ; les URI,
state, PKCE, cookies et transactions à usage unique sont inchangés.

La page intermédiaire n'a ni script ni ressource distante. Elle utilise une
navigation meta refresh, une destination échappée provenant exclusivement du
serveur ou de la requête OAuth validée, no-store et Referrer-Policy: no-referrer.
Un lien permet de poursuivre si le navigateur bloque la navigation automatique.

La page de consentement autorise un seul script fixe avec un nonce neuf par réponse.
Il conserve la décision choisie, désactive les deux boutons et annonce la progression.
Un deuxième submit est annulé. Sans JavaScript, le formulaire continue de fonctionner ;
la transaction serveur reste à usage unique. Le retour par l'historique demande de
recommencer une nouvelle connexion au lieu de réutiliser une demande consommée.

## Vérifications

- Tests Worker : test/oauth/navigation.spec.ts et suites OAuth existantes.
- Régression navigateur locale : node scripts/diagnostics/oauth-navigation-browser.cjs.
  Installer Playwright dans un environnement de test existant ou renseigner
  PLAYWRIGHT_MODULE avec son chemin ; BROWSER_CHANNEL vaut msedge par défaut.
  Le script ne contacte aucun service distant : quatre origines HTTP locales
  reproduisent la chaîne GitHub → serveur → callback client → application.
  L'ancien parcours doit être bloqué par CSP, le nouveau doit atteindre la fin,
  avec une seule soumission et la décision approve/deny conservée.
- Après publication humaine : nouvelle connexion complète depuis chaque client.
  Ne pas réutiliser une ancienne URL contenant un code OAuth.

Les journaux authorize.navigate_to_github indiquent maintenant status=200 et
locationPresent=false. callback.redirect_client_success reste un 302 envoyé,
sans prétendre prouver que l'application a reçu le retour.
