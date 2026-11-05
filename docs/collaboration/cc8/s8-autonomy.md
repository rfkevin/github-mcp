# CC8 S8b — supervision du contrôleur

Auteur GPT-6, reprise demandée par Kevin le 2026-11-04 (Vibe indisponible).
S8a est déjà intégré. Ce lot étend le passage du contrôleur, sans orchestrateur,
sans changement de modèle, de budget ou de configuration déployée.

## Comportement

- Le cron existant et le webhook appellent `superviseCycle` après un passage actif
  du contrôleur. `SALON_ENABLED` doit valoir exactement `true`, en plus des portes
  existantes de ces deux chemins. Aucun nouveau cron, appel fournisseur ou réveil
  de chat n'est créé.
- Une tâche explicitement `blocked` depuis 24 h produit une alerte dans le salon
  et un checkpoint `S8_BLOCKED_ESCALATION`. Le checkpoint contient le brouillon de
  `reassign_task` avec la révision et les trois anciens titulaires. Le coordinateur
  doit choisir les nouveaux titulaires capables, préserver D12 puis soumettre la
  demande exécutable ; le serveur ne devine pas les compétences d'un remplaçant.
- L'âge provient de l'événement qui a établi la révision de la tâche. Sans cette
  preuve historique, la première observation est persistée et une fenêtre entière
  de 24 h est attendue. Une nouvelle révision ouvre un nouvel épisode.
- Avec des tâches ouvertes, un coordinateur sans événement depuis 24 h déclenche
  la préparation d'une demande `appoint_cycle_coordinator`. Ce délai de surveillance
  est le choix provisoire de ce lot ; le plan imposait un délai sans le chiffrer.
  Le mandat initial et l'activité de tous ses alias de famille repoussent le délai.
- Le successeur proposé est un autre participant actif déjà habilité coordinateur
  par le propriétaire, de famille distincte, choisi de façon déterministe. Cette
  habilitation ne prouve pas sa disponibilité : le propriétaire doit la vérifier.
  Sans successeur admissible, un checkpoint et le salon signalent le besoin de
  choix ; aucune révocation n'est proposée implicitement.
- Une nomination proposée porte l'empreinte canonique, l'époque attendue et la
  dernière décision owner. Elle expire au bout de 24 h. Seul le clic owner peut
  l'appliquer. Une reprise d'activité ultérieure doit être prise en compte par
  l'owner avant approbation : elle ne révoque pas automatiquement la proposition.

## Concurrence, répétition et bornes

Le checkpoint/demande, le message salon, le réveil du coordinateur et l'avancement
de révision sont dans un seul lot D1. HALT et le CAS du cycle y sont revérifiés ;
le candidat est encore actif, habilité et de même famille au moment de l'écriture.
Une course annule le lot. La primitive transactionnelle est celle de D1 `batch`
(documentation officielle consultée le 2026-11-04 :
https://developers.cloudflare.com/d1/worker-api/d1-database/).

Une clé serveur par tâche/révision ou par époque du mandat empêche les doublons,
y compris après perte de réponse. Une demande refusée ou expirée n'est pas
renvoyée toutes les 15 minutes : sa reprise est une décision de coordination.
Les messages système ne consomment pas le quota des agents ; ils sont bornés par
ces épisodes et le maximum de 50 tâches escaladées par cycle et par passage.
Les tâches déjà escaladées sont exclues de cette fenêtre pour éviter la famine.
La limite existante de 20 cycles du passage programmé reste inchangée.

## Validation et limites d'acceptation

Tests D1 avec horloge contrôlée : frontière 24 h, historique absent, rejeu et
concurrence, résolution/nouvel épisode, HALT pendant la préparation, CAS cycle,
proposition owner analysable sans application, alias du coordinateur, absence de
successeur, cycle fermé/terminé et raccordement au passage programmé.

Ces tests ne constituent pas une observation réelle de 48 h. Pour clôturer S8 :

1. Après intégration, relever les portes effectivement actives et l'heure de début.
2. Pendant 48 h, vérifier les passages, échecs, alertes et propositions du contrôleur.
3. Vérifier qu'aucune tâche `blocked` ne dépasse le seuil sans alerte (tolérance :
   délai d'un passage du cron), et qu'aucune intervention Kevin n'a été nécessaire
   hors clés et validations owner prévues au plan.
4. Conserver les preuves du cycle, les demandes préparées et les verdicts D12 au
   couple SHA exact. Le temps simulé des tests ne remplace pas cette durée réelle.

Le lot ne détecte pas encore une tâche laissée `in_progress` malgré un blocage
non déclaré. Une activité du coordinateur est un événement, pas une preuve de
qualité de son action. Les déclarations de disponibilité d'un modèle ne sont pas
acceptées comme validation indépendante.

Relecture Vibe, désigné par Kevin le 2026-11-04 en remplacement de Gemini
(carte de tâche S8b, store seq 1513). Grok est testeur ; GPT-6 reste auteur.
Tout changement de head ou de base exige le renouvellement des deux verdicts
indépendants au même couple SHA exact. L'auteur ne s'auto-valide pas ; aucune
fusion ni activation live par ce lot.
