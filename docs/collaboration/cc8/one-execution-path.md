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


## Audit vérifiable des outils API (CC8, 13 novembre 2026)

La vue `collab_agent_run_summary` du propriétaire ou coordinateur autorisé expose désormais,
pour les 64 dernières étapes D1, `step_traces[].tool_attempts` (nom parmi une liste fermée,
nature lecture/écriture, indice, statut de reçu ou d'effet, cause typée connue). Les
arguments, identifiants d'appel, contenus de réponse, prompts et erreurs brutes restent
exclus. Les noms inconnus deviennent `unknown_tool`; les erreurs non reconnues deviennent
`other`. `tool_calls_requested` reste le total réel, avec `tool_attempts_omitted` si plus de
64 appels par étape. `receipt_ok` signifie **reçu enregistré**, pas réussite métier vérifiée.

Ce diagnostic exploite les étapes et effets D1 déjà persistés : aucune table, limite de
modèle, moteur de tâche ou seconde journalisation ajoutés. Les effets externes `failed`
portent un code fermé, notamment `answer_length_invalid` pour `store_answer` trop long ;
une cause non reconnue n'est jamais divulguée en texte libre. Les verdicts des agents
restent à confronter aux traces ; une auto-déclaration ne vaut pas preuve d'outil exécuté.


## Parité chat/API — contexte, lectures GitHub et écritures (13 novembre 2026)

- Le packet de rôle des WorkSessions API se construit désormais avec la même
  référence C0 par défaut que `collab_get_context` chat (12 000 tokens C0, soit
  3 000 tokens de packet estimés). L'injection initiale `answer` autorise jusqu'à
  12 000 octets JSON ; les lectures explicites restent disponibles avec les droits
  serveur, sans changement de visibilité privée C4.
- `github_read_file` côté API renvoie des pages de 12 000 caractères et un
  `next_offset`. Il faut suivre ce curseur pour lire un fichier long au complet,
  plutôt que recevoir une coupe opaque du moteur à 16 384 caractères. Les pages
  sont relues depuis la même référence (de préférence un SHA immuable).
- `github_diff` renvoie 3 fichiers par page (`next_file_offset`) et les patchs
  segmentés (`patch_next_offset`). Une revue doit parcourir les pages pertinentes
  ; le serveur GitHub peut encore omettre les patchs de fichiers sensibles.
- `github_commit_files` API adopte la même enveloppe que le client chat :
  50 fichiers et 1 000 000 de caractères de contenu cumulés. La limitation des
  chemins à la tâche, le SHA attendu, l'idempotence et le contrôle de bail restent.

Cette PR ne modifie pas les plafonds de sortie imposés par les fournisseurs,
les deadlines WorkSession ni les règles owner/D12. Les ajuster nécessite de
vérifier la route et les capacités réelles de chaque modèle, puis une reprise
transactionnelle de run ; les augmenter arbitrairement n'assure pas la parité.
