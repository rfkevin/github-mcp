# CC8 — WorkSession unique, mémoire étendue et parité chat/API

**Décision owner : 11 novembre 2026** — store seq2243, 2246 et 2248, audit PR #301–315 seq2245.
**Branche de réalisation unique :** `mcp/105856986/cc8-worksession-parity` → `mcp/105856986/cc3-integration`.
**Owner/coordination :** GPT-6 ; relecture indépendante : Vibe ; test indépendant : Grok. **Fusion et tag de retour arrière : Kevin.**

## Résultat recherché

Un appel à un modèle API ne doit pas être traité comme un automate de six étapes, mais comme une nouvelle interface vers **la même identité d'agent et le même espace de travail qu'un chat**.

**Cible = agent IA piloté via API fournisseur**, non le produit Cloudflare Workers AI ni un Worker hébergeur. L'exécuteur actuel peut être remplacé : la session logique et ses mémoires doivent rester indépendantes du transport et de l'hébergement.

- Le chat et l'API ayant **la même identité logique, le même rôle et le même mandat** peuvent consulter les mêmes mémoires, lire les mêmes dossiers et disposer des mêmes outils MCP.
- L'API sans chat (Gemini, notamment) reçoit sa continuité depuis notre store, pas depuis le fournisseur.
- Le fournisseur peut interrompre un appel (quota gratuit, délai, fenêtre de contexte, Worker). La mission logique ne se réinitialise pas : reprise au checkpoint, avec les mêmes preuves, le même projet, la même branche et la même PR.
- Pas de plafond cumulé de jetons, de compteur maximal d'étapes métier, de passage guidé obligatoire ni de refus « cet outil n'est pas permis sur le canal API » lorsqu'un chat doté du même rôle peut l'utiliser.
- Une API peut consulter l'historique intégral **par pages** ; elle ne doit pas injecter cet historique intégral dans chaque requête. Les limites par requête du modèle restent physiques, pas des limites de mission.

## Architecture minimale — réutiliser l'existant

```text
Chat ─┐
      ├── WorkSession(cycle + participant logique + tâche/question)
API ──┘             │
                    ├── résolveur commun de capacités C0 (identité, rôle, mandat)
                    ├── C4 : mémoire personnelle, commune, projet, rôle
                    ├── active_work : objectifs / acquis / action suivante
                    ├── D1 : historique complet des tours, outils et effets
                    ├── journal : décisions, salon, questions, avis, séquences
                    └── GitHub : ref/branche/HEAD/base/CI/PR vérifiables
                           ↓
                modèle + tous les outils permis pour CET agent
                           ↓
                  persistance D1 → suite ou reprise
```

Le transport `chat|api` n'a pas à décider des outils ou de la profondeur de raisonnement. Le type de tâche peut décrire le but (coder, répondre, relire) mais ne doit pas être une liste secrète de privilèges. Aucune nouvelle base ni second salon n'est nécessaire.

### Mémoire utile, pas gigantesque prompt

1. **Stockage durable :** les faits et méthodes condensés restent dans C4 (scope personnel et partagé). Le détail exhaustif des étapes reste dans le journal et les checkpoints D1. La mémoire C4 n'est pas un substitut aux traces de travail.
2. **Lecture à la demande :** mémoire visible, historique, événements et sources GitHub paginables. L'agent peut relire des éléments anciens sans qu'un défaut de 5/40 éléments les cache définitivement.
3. **Dossier d'entrée :** rôle et permissions réels, objectif, état de tâche, dernière position `seq`, décisions et alertes en vigueur, état GitHub/CI, résumé des faits acquis. Le dossier indique explicitement ce qu'il a omis et où le relire.
4. **Résumé progressif :** résumer pour le modèle les anciens tours, conserver leurs preuves originales en D1. Injecter un delta récent plutôt que recopier chaque fois tout le contexte.
5. **Passation bilatérale :** même objet WorkSession partagé par les deux canaux ; une interruption ou le passage chat → API → chat n'entraîne ni nouvelle tâche ni relecture complète depuis zéro.

Premier changement effectif sur cette branche : **aucune limite applicative de tokens stockés par scope C4** pour `common`, `project`, `role`, `participant` (sentinelle `Infinity` côté TypeScript, convertie en `NULL` dans la vérification transactionnelle D1). La mémoire et la continuité sont récupérables par pages via `store_memory` et `store_continuity`; les résumés de runs restitués peuvent atteindre 4000 caractères. Les fenêtres de chaque appel fournisseur ne limitent pas le stockage total. Les checkpoints existants ne sont pas effacés. Les anciens plafonds d'activation/pauses C4 restent à traiter séparément.

### Reprise des missions

L'état doit distinguer :
- **`running`** : le moteur peut avancer à nouveau ;
- **`waiting`** : question humaine, API gratuite indisponible, CI en cours, outil momentanément hors service ;
- **`needs_reconcile`** : effet externe ambigu à vérifier par lecture, jamais à réémettre sans contrôle ;
- **`done`** : résultat prouvé par effet/checkpoint, et non juste texte « j'ai terminé ».

Le réveil ou la transition de fournisseur reprend la mission logique, pas un « attempt 1/2/3 » qui perd son passé. Le compteur de tokens peut rester dans les métriques, jamais comme condition d'arrêt. Une exécution technique finit naturellement et laisse place à la suivante ; l'utilisateur ne doit pas avoir à relancer toute la mission.

### Parité des outils et des droits

Le runtime des **agents IA par API fournisseur** consomme maintenant `agent-capabilities.ts` (C0) et expose un catalogue basé sur les ressources réellement connectées plutôt que sur `READ_TOOLS_BY_KIND` / `WRITE_TOOLS_BY_KIND`. Le serveur re-vérifie les capacités à chaque effet. Les refus `task_kind === implement` ont été retirés des points d'accès GitHub et des appels de contribution/verdict au profit des mandats réels. **Ce raccordement n'est pas encore validé E2E pour les écritures GitHub, et les hôtes chat existants doivent être comparés de bout en bout** : l'égalité du catalogue ne suffit pas.

Les limites qui ne proviennent que du canal sont à retirer. Les droits réels sont égaux sur les deux canaux : pas d'accès aux mémoires privées de tiers, aux dépôts non accordés ou aux actions propriétaire réservées. **Une décision d'autonomie ne constitue pas l'autorisation de facturer des modèles payants.** Ces frontières s'appliquent aussi au chat ; elles ne sont pas des « garde-fous API » supplémentaires.

## Travail restant — une seule PR de livraison

- **Raccordement effectif des outils :** catalogue C0 déjà branché sur l'exécuteur d'agent API; finir la parité sur l'hôte chat, et prouver l'effet GitHub réel `github_write_scope` avec un rôle auteur autorisé depuis `answer` (l'attestation C0 passe, l'effet complet reste un blocage de test).
- **WorkSession durable :** un 429/503/timeout fournisseur conserve désormais le même `run_id`/l'étape D1 et réessaie avec délai progressif (test 503→succès). Restent : autres erreurs, états `waiting`, continuité indépendante de l'exécuteur et bascule chat→API→chat.
- **Contexte commun :** finir de relier `unified-context`, `task-dossier`, C4, `active_work` et l'historique complet consultable ; même format dans chat et API.
- **Mémoire et historique :** confirmer par CI les pages anciennes, ajouter des curseurs/snapshots si les pages peuvent changer pendant une lecture concurrente, traiter la croissance C4 par observation plutôt que blocage artificiel d'une session.
- **Validation :** test d'identité/rôle égal chat/API, 100+ étapes et >48k tokens cumulés sans arrêt, interruptions avant/après effet GitHub et sans commit doublé, même PR, attente CI + reprise, questions et mémoire visibles, confidentialité d'un autre participant.
- **E2E gratuit réel :** laisser Gemini API travailler sur une mission de code avec lecture, commit, correction CI et passation, puis autre fournisseur gratuit. Pas de modèle payant sans autorisation de dépense. Les 12 entrées gelées de #315 sont un harnais, pas une preuve d'autonomie réelle.

## Critère de fin

**Réussite =** un agent API accomplit une vraie mission de bout en bout, dispose des mêmes capacités que l'agent chat doté du même mandat, et reprend seul après interruption sans perdre sa mémoire ni répéter ses effets.

Une PR verte de tests statiques, une fonction de dossier non utilisée ou une hausse numérique de plafond n'est pas la fin du chantier.
