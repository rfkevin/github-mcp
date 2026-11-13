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


## Parité de taille des réponses (13 novembre 2026)

Le chat utilise `collab_append_event` et l'API utilise l'outil ergonomique `store_answer` ;
**les deux chemins aboutissent déjà au même `CollabStore.appendEvent`**. L'API dérive
son identité et son op_id de son run, avec des garde-fous d'exécution, tandis que le chat
passe par son identité MCP. Il ne faut pas créer un second moteur ni remplacer ces
adaptateurs par un nouveau canal.

`store_answer` n'impose plus 4 000 caractères à la réponse : le validateur commun
`validateAgentEvent` est l'unique autorité de taille, avec 65 536 caractères **pour
le JSON complet** `payload_json`, métadonnées (`ask_seq`, clés, échappements) comprises.
Une réponse individuelle peut donc être légèrement plus courte que 65 536 caractères.
Les deux voies continuent à appliquer les mêmes protections du store (CAS, quota,
adressage des questions, cycle clos) et à retourner `EVENT_FIELD_TOO_LONG` si le
JSON dépasse ce plafond. Un contenu plus long nécessite une évolution explicite du
contrat de stockage commun, pas une limite supplémentaire propre aux API.
