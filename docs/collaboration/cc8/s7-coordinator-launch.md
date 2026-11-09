# CC8: lancement S7 depuis le coordinateur

Le planificateur S7 et ses Durable Objects restent inchangés. Le nouvel outil collab_launch_implement cree un run via createRun puis appelle directement le meme wake RPC. Il retourne un vrai run_id et un statut de prise en charge, PAS une preuve de succes fonctionnel.

Les grants owner de cc3-test restreignent cycle, tache, agent, branche et fichiers. Toute depense de modele payant est refusee. Le coordinateur peut enchaîner autant de demandes indépendantes que l'autorisent les grants owner et les quotas : il déclenche A, puis B, puis C **sans attendre le résultat du modèle pour A ou B**. Les Durable Objects sont indexés par clé de bail (cycle, participant, tâche) : plusieurs runs distincts peuvent être `running` simultanément, chacun avec son propre run_id, son scope et son arrêt. Les demandes sont enregistrées l'une après l'autre afin de préserver le CAS D1, mais leur **exécution est concurrente**. Seules les tâches réellement dépendantes attendent un verdict préalable. En cas d'échec d'une tâche, les autres ne sont pas annulées. Le coordinateur vérifie ensuite les preuves GitHub et CI de chacune.

Gemini sans chat : le coordinateur fait un task.claim TEMPORAIRE sous sa propre identite, puis task.handoff a Gemini en respectant D12. Aucun evenement ne se fait passer pour Gemini. Vibe : son ancien task.claim a pris un bail chat d'une heure. Le parametre takeover_chat=true, seulement sous ordre explicite de Kevin, libere le bail sur cette tache apres journal checkpoint. Sans takeover, createRun refuse le lancement.

Les run IDs sont deterministes, et un rejeu n'effectue pas de seconde tentative. Les protections HALT, fence, scope GitHub, correction D1 et CI au SHA restent celles du moteur existant. Aucune fusion automatique et aucun effet sur master.

Apres CI4/4, double avis D12 et fusion owner, verifier le deploy cc3-test avant l'utilisation. Appeler collab_launch_implement sur S7-compare-vibe-1 (takeover_chat=true), puis sur S7-compare-gemini-1 (reviewer=vibe, tester=grok). Lire les deux run_ids puis les etapes GitHub, commits, CI et PR. Ne pas relancer sans nouveau GO.
