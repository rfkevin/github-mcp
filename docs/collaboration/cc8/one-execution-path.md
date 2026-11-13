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


## Recadrage en cours de WorkSession et arrêt individuel (13 novembre 2026)

Le coordinateur, ou le participant propriétaire de la WorkSession, dispose de deux contrôles
distincts du HALT global :

- `collab_steer_agent_run({run_id,op_id,message})` enregistre un nouveau message D1
  immuable et idempotent. Sans créer de deuxième run, le moteur le livre lors
  du prochain **appel fournisseur** autorisé. Le message arrivé pendant un appel
  en vol n'interrompt pas cet appel et sera vu à l'appel suivant. Les messages
  livrés sont reconstruits dans le contexte du même run et conservés lors de
  la compaction de l'historique. Le HALT global peut rester actif pendant l'envoi,
  mais il empêche le moteur de consommer le message avant reprise.
- `collab_stop_agent_run({run_id,reason})` place le run ciblé en état terminal
  `halted` avec `individual_stop:` dans `stop_reason`, invalide la génération
  de son bail et évite de lancer de nouveaux outils. Aucun autre run et aucun
  drapeau `owner_flags.halt` ne sont modifiés. Un appel fournisseur ou un effet
  externe déjà lancé avant l'arrêt ne peut pas être annulé rétroactivement.

Les deux outils vérifient l'identité du participant ou le mandat de coordination
au sein du cycle. Le premier fournit le recadrage conversationnel demandé par
Kevin, y compris lorsqu'un coordinateur détecte une stagnation ; la détection
automatique de non-progression doit distinguer vraies lectures nouvelles et
répétitions, pour ne pas imposer de plafond arbitraire de jetons/étapes.
