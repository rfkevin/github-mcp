# Équipe d’agents : discussion, accord, intégration

Cette démarche s’applique à **tout projet utilisé avec ce serveur**, pas seulement
au code du MCP. Le serveur la transmet lors de l’initialisation MCP et la rappelle
dans les outils et le contexte projet. Les instructions propres au dépôt et la
demande du propriétaire restent applicables. Un modèle peut ignorer des consignes :
les contrôles techniques ci-dessous ne doivent pas être confondus avec une garantie
de comportement ou une preuve de qualité du code.

## Parcours commun

1. Lire contexte, `AGENTS.md` et `AGENT_MEMORY.md` s’ils existent. Identifier la
   branche cible et la mission : backend, design, tests, etc. Choisir un `agentLabel`
   stable et honnête ; ne pas s’attribuer un modèle inconnu.
2. Travailler sur une branche dédiée. Lire les PR et commits des collaborateurs
   pour vérifier les interfaces communes, sans modifier leur code sans autorisation
   du propriétaire. Les clients du même compte GitHub partagent techniquement les
   mêmes branches : la séparation entre leurs missions n’est pas un contrôle d’accès.
3. Après chaque commit, déclarer les contrôles attendus à `github_ci_status` et
   suivre le SHA exact. `observed_success` sans attentes ne signifie pas que tout
   est vérifié. Un résultat manquant, tronqué, ignoré ou inaccessible n’est pas vert.
   Lire les diagnostics d’échec, corriger dans sa mission et recommencer.
4. Ouvrir une PR vers `integration` si le propriétaire a choisi ce parcours ; sinon
   préparer la PR vers sa cible habituelle pour revue humaine. Les PR sont en
   brouillon par défaut ; `draft:false` est possible lorsqu’elles sont prêtes à être
   relues. Une PR encore en brouillon ne sera pas intégrée automatiquement.
5. Discuter **dans la PR avant la fusion**. Lire `github_get_pull_request` avec
   `includeDiscussion:true`, parcourir `discussionPage` tant que
   `nextDiscussionPage` existe. Les textes longs ont `bodyTruncated:true` : lire
   l’intégralité sur GitHub avant de prétendre avoir tout relu. Les commentaires
   de commit servent à signaler un problème précis ; la synthèse reste dans la PR.
6. Donner un constat, son impact sur sa mission, une preuve et une solution.
   Répondre aux objections ; chacun apporte les corrections dans son périmètre.
   Déposer avec `github_comment_pull_request` un avis `changes_requested` pour
   un blocage, `comment` pour discuter, `agree` lorsque les objections sont levées.
   Les avis exigent `agentLabel`, `expectedHeadSha` et `expectedBaseSha`.
   Ne jamais fabriquer l’avis d’un collaborateur. Le silence n’est pas un accord.
7. Si head ou base change, renouveler les avis après relecture. Publier une synthèse
   des compromis, tests et limites dans la PR. Après trois échanges sans progrès,
   demander l’arbitrage du propriétaire. Ne pas fermer la PR ni multiplier les
   commentaires identiques. L’absence d’un agent signifie attente, pas validation.
8. Si toutes les conditions ci-dessous sont remplies, utiliser
   `github_merge_integration`. Après l’intégration, suivre aussi tests/build au
   SHA résultant. La PR peut être reconnue fusionnée par GitHub : relire son état,
   ne pas le déduire du seul succès de l’appel.
9. Livrer un bilan avec PR, SHA, résultats et limites. Ajouter une courte note
   datée et signée en fin de mémoire lorsque l’écriture est autorisée, puis remercier
   les collaborateurs. La promotion vers `main`/`master` et la production est humaine.

Les outils n’envoient pas de messages aux autres applications et ne réveillent pas
Claude ou un autre client endormi. Il faut que ces clients exécutent une tâche ou
disposent de leur propre reprise autorisée. Le MCP fournit le lieu d’échange et les
contrôles, pas un orchestrateur autonome. Si l’attente ne peut pas continuer, laisser
PR, SHA, contrôles restants et prochaine action, avec « vérification incomplète ».

En cas de conflits, `github_get_merge_context` prépare une comparaison immuable
à trois versions ; `github_resolve_conflicts` enregistre les choix explicites
dans la branche personnelle avec `mcp:write`. Ce n’est pas une intégration de PR
dans la branche principale. Refaire les tests et avis au nouveau SHA. Parcours,
protections et limites : [conflict-resolution.md](conflict-resolution.md).

## Mémoire et propositions : deux registres, un dépôt central

Le serveur indique `rfkevin/github-mcp` comme destination centrale, sans en faire
une restriction d’accès aux projets. Sa mémoire `AGENT_MEMORY.md` apporte des
conseils sur le MCP ; `TOOL_IMPROVEMENTS.md` recueille séparément les besoins de
chaque agent en fin de tâche, même si la tâche portait sur un autre dépôt.
Lire les anciennes propositions, citer leurs ID, donner un avis argumenté et un
classement personnel par importance, puis ajouter les besoins nouveaux ou indiquer
qu’il n’y en a pas. Ne pas réécrire les contributions précédentes ni confondre
proposition et permission d’implémenter. Les instructions du dépôt travaillé et sa
mémoire locale restent distinctes. Consulter aussi les PR de retours non fusionnées.

Pour un client moins fiable : accorder seulement `mcp:read` (et `offline_access`
si souhaité), sans `mcp:write`, `mcp:checks`, `mcp:automation` ou `mcp:integration`.
Il peut lire les notes et remettre sa contribution au propriétaire pour publication
manuelle ; il ne doit pas demander de nouveaux droits simplement pour tenir le
journal. Vérifier l’écran de consentement et la liste effective des outils. Si le
client demande automatiquement des écritures sans permettre ce choix, ne pas
accepter ce consentement ; utiliser une connexion/instance configurée en lecture
seule. Révoquer les anciens consentements d’écriture plutôt que masquer un bouton.
La lecture seule n’empêche pas le client de voir ou copier les contenus accessibles :
limiter également les dépôts et données auxquels on donne accès.

Avec écriture : branche et PR dans le dépôt central, pas d’écriture directe sur
la branche principale. Si la tâche s’y déroule déjà, ajouter la contribution à
la même PR. Le MCP protège les deux journaux contre suppression et réécriture
des octets existants ; le Git direct n’est pas couvert par cette restriction.

## Activation de l’intégration par le propriétaire

L’écriture ordinaire ne suffit pas. Il faut :

- Un serveur publié avec cette fonction, `GITHUB_WRITES_ENABLED=true`, et un
  nouveau consentement client contenant **`mcp:write mcp:integration`** en plus
  de `mcp:read`. `mcp:integration` n’est pas un scope obligatoire annoncé pour tous
  les clients : vérifier qu’il est réellement demandé puis accepté, pas seulement
  reconnecter. Le supprimer retire la capacité au consentement concerné.
- L’App installée sur le dépôt, Contents en écriture, Pull requests, Actions,
  Checks et Commit statuses en lecture pour les contrôles (Pull requests en
  écriture pour les commentaires). Ni Administration ni bypass des protections.
- Une branche `integration` distincte de la branche par défaut. La créer côté
  GitHub après revue des automatisations. **Aucun déploiement de production ne doit
  partir d’integration**, ni par Actions, ni par une intégration Cloudflare parallèle.
- Un fichier `.mcp/integration.json` validé par le propriétaire **sur la branche
  principale**, pas simplement dans la PR à fusionner. Exemple à adapter :

```json
{
  "version": 1,
  "branch": "integration",
  "expectedChecks": [
    { "source": "check", "name": "ci" },
    { "source": "workflow", "name": ".github/workflows/build.yml" }
  ],
  "reviewers": ["backend", "design"]
}
```

Ne pas copier des noms de contrôles inexistants. Les noms sont exacts : `check`
désigne un check GitHub, `workflow` son chemin, `status` un contexte de statut.
Inclure tous les tests/build/qualité nécessaires et les rendre disponibles aussi
après push sur `integration`. Les deux labels d’exemple sont les noms déclarés
attendus ; le propriétaire les adapte aux missions réelles. Ils ne certifient pas
deux utilisateurs ou modèles indépendants.

Aucun fichier de politique actif n’est fourni à la racine par cette modification :
l’intégration reste désactivée par dépôt tant que le propriétaire ne la configure pas.
Le serveur refuse l’édition de cette politique par les commits MCP ordinaires,
y compris la substitution de son dossier parent. Supprimer la politique sur la
branche principale désactive les prochaines demandes (sans annuler une requête
déjà en cours). Aucun nom de dépôt n’est codé en dur dans le serveur.

## Ce que le serveur vérifie, et ses limites

- Dépôt dans l’installation, non archivé ; branche principale différente
  d’integration ; PR ouverte interne, hors brouillon, cible exacte `integration`.
- Head et base attendus, contrôles déclarés réussis sans source CI inaccessible
  ou liste potentiellement tronquée. Le dernier run d’un workflow au même SHA,
  événement et branche remplace les anciens runs. Aucun contrôle ne prouve à lui
  seul la qualité ou l’indépendance de son producteur : protéger les workflows.
- Dernier avis structuré de chaque participant configuré : `agree` sur head/base
  courants. Tout avis structuré bloquant courant empêche l’intégration. Les revues
  GitHub `CHANGES_REQUESTED` non remplacées/dismissées bloquent aussi.
- `expectedLastCommentId` doit être le plus grand ID des commentaires généraux
  lus ; `expectedLastReviewCommentId` celui des commentaires de code (0 si aucun).
  Au-delà de 100 commentaires ou revues par catégorie, une revue humaine est requise.
  Le serveur **ne comprend pas automatiquement toutes les objections en texte libre** :
  l’agent doit les lire, les résoudre, puis fournir `discussionSummary` et publier
  sa synthèse. Les marqueurs et labels sont des déclarations, modifiables par les
  personnes ayant accès à GitHub, pas des signatures cryptographiques.
- Diff limité à moins de 300 fichiers : workflows, contrôleurs CI/publication,
  politique d’intégration et fichiers sensibles ne sont pas intégrables par cet
  outil. Leur validation appartient au propriétaire. Une mémoire modifiée doit
  conserver son contenu antérieur (ajout seul ; suppression/renommage refusés).
- L’appel GitHub fusionne un **SHA immuable dans la branche littérale integration**,
  pas une cible déduite au dernier instant de la PR. Un changement concurrent de
  cible de PR ne peut donc pas rediriger cet appel vers main/master. Les règles
  GitHub peuvent refuser cette fusion de branche : ne pas ajouter de bypass pour
  la faire passer ; le propriétaire intégrera alors via GitHub.
- GitHub ne fournit pas de comparaison atomique du SHA de base pour cet appel.
  Les vérifications sont des instantanés, pas un verrou partagé avec les autres
  clients : base, commentaires, droits ou configuration peuvent évoluer juste
  après la lecture. Suivre et tester le résultat fusionné ; sérialiser les
  intégrations au niveau de l’équipe. Les protections GitHub restent indispensables.

Les commits ordinaires ajoutent `MCP-Actor` (compte authentifié) et `MCP-Agent`
(nom déclaré) au message ; les commentaires et commits de fusion gardent aussi
une trace. Le message ordinaire complet, trace comprise, reste limité à 200
caractères. Cette attribution n’est pas une isolation des modèles. Les contrôles
post-fusion et la production doivent rester distincts.

Référence API : [fusion de branche GitHub](https://docs.github.com/en/rest/branches/branches#merge-a-branch).
Les protections et consentements réels, ainsi que le parcours entre plusieurs
clients, doivent encore être vérifiés sur un dépôt de test après publication.
