# CC8 — chemin d'exécution unique (retrait A1)
 
Le propriétaire a demandé le retrait direct du deuxième parcours de tâches API,
qui créait un diagnostic séparé sans contexte WorkSession.

## Surface active

- `collab_dispatch_task` (A1 direct) et `collab_list_executors`
  sont **supprimés du catalogue MCP** ; la fabrique A1 des invocations
  de coordinateur est retirée du code accessible.
- Les agents utilisent le seul moteur `agentrun` / WorkSession,
  avec choix de modèle par participant, dossier serveur D1/C4, mémoire,
  outils MCP et preuves spécifiques à la tâche.
- `answer` est déclenché par une question `clarify.ask` adressée au
  participant (ou une question X13). L'historique de la question, les
  informations C4 autorisées et le dossier serveur sont assemblés dans
  `plan.ts` et `unified-run-packet.ts`.
- `review`, `test`, `design` et `implement` passent aussi par le seul
  planificateur WorkSession. Le coordinateur émet `collab_assign_worksession`
  pour autoriser et attribuer le mandat D1 : **aucun autre code ne crée de run**.
- Sans `scheduled_at`, le travail démarre dès qu'il est exécutable ; un timer
  explicite est enregistré dans D1 et déclenche l'outbox à l'échéance.
  HALT, les dépendances, les droits et un bail chat actif restent prioritaires.
- Pour un **diagnostic** d'incident, demander au participant un
  `clarify.ask` ciblé avec les références vérifiables au run et au store.
  Le passage en `answer` automatique utilise WorkSession. Une tâche
  `diagnose` libre sans question doit faire l'objet d'une extension
  de ce même moteur, et non d'un autre dispatcher.

## Invariants et migration

- Les journaux D1 historiques `invocations` et `coordinator-tasks`
  sont **conservés** pour audit ; supprimer l'outil ne les efface pas.
- Les adaptateurs fournisseurs/les APIs utilisés par le moteur commun
  et ses sondes restent disponibles : aucune clé ni configuration n'est
  effacée, et aucun fournisseur n'est privilégié.
- Les contrôles de mandat, d'identité, HALT, CAS, D12, coûts et
  permissions GitHub du WorkSession restent inchangés.
- Les anciens clients utilisant `collab_dispatch_task` migrent vers `clarify.ask`
  pour `answer` ou vers les tâches du contrôleur. Ceux qui utilisaient
  `collab_launch_implement` doivent émettre `collab_assign_worksession` ;
  aucun déclencheur manuel parallèle n'est conservé.
- Cette PR ne modifie pas le code déployé tant qu'elle n'a pas été
  validée, revue et fusionnée dans `cc3-integration`. La PR #317
  de continuité portable reste indépendante.
