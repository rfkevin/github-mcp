# Canal owner (CC-3 C5) — mise en place par Kevin (K4)

Le canal owner est la seule voie qui écrit une décision `owner.decision` ou modifie le registre des participants (invariant I7). C'est une page web `/owner` sur le Worker, **hors des fournisseurs OAuth** : aucun jeton MCP, scope, outil ou libellé d'agent n'y donne accès.

Sans configuration complète, la route n'est pas montée (réponse 404). Rien ne s'active par défaut, y compris sur `cc3-test`.

## Choisir le mécanisme

| Mode | Quand | Preuve vérifiée par le Worker |
| --- | --- | --- |
| `access` (préféré) | Cloudflare Access disponible sur le nom d'hôte du Worker | JWT `Cf-Access-Jwt-Assertion` : signature (certificats publics de l'équipe Access), émetteur, audience, e-mail du propriétaire |
| `secret` (repli) | Access indisponible (par exemple `workers.dev`) | Secret saisi par Kevin sur `/owner`, comparé à temps constant à `OWNER_SECRET` |

Le rapport C0 recommande Access ; il reste à vérifier qu'Access protège bien un nom `workers.dev` sur ce compte (sinon : domaine personnalisé, ou mode `secret`).

## Mode `secret`

1. Générer un secret d'au moins 32 caractères, **sur votre machine**, et le garder dans votre gestionnaire de mots de passe. Ne jamais le coller dans une conversation avec un agent.
2. Le déposer comme secret du Worker : `npx wrangler secret put OWNER_SECRET --env cc3-test`.
3. Ajouter la variable non secrète `"OWNER_AUTH_MODE": "secret"` dans `env.cc3-test.vars` de `wrangler.jsonc`, puis redéployer.
4. Ouvrir `https://<worker>/owner` : un formulaire demande le secret. Le secret est redemandé à chaque action et n'est ni affiché, ni journalisé, ni stocké, ni inscrit dans les événements (seule la mention `proof_kind: secret` l'est).

**Rotation** : refaire l'étape 2 avec un nouveau secret. L'ancien est refusé dès le déploiement suivant. À faire au moindre doute d'exposition.

Un secret de moins de 32 caractères laisse le canal fermé (404) plutôt que faiblement protégé.

## Mode `access`

1. Dans Cloudflare Zero Trust, créer une application Access de type *self-hosted* sur `https://<worker>/owner`, avec une règle limitée à votre e-mail.
2. Relever le domaine d'équipe (`<équipe>.cloudflareaccess.com`) et l'*Application Audience (AUD) Tag*.
3. Variables non secrètes de `env.cc3-test.vars` :
   `"OWNER_AUTH_MODE": "access"`, `"OWNER_ACCESS_TEAM_DOMAIN": "<équipe>.cloudflareaccess.com"`, `"OWNER_ACCESS_AUD": "<AUD>"`, `"OWNER_ACCESS_EMAIL": "<votre e-mail>"`.
4. Redéployer, puis ouvrir `/owner` : Access vous authentifie, le Worker revérifie le JWT et l'e-mail.

Le Worker vérifie lui-même le JWT : une requête qui contournerait Access (autre route, en-tête forgé) est refusée.

## Ce que fait la page

- **Demandes en attente** : événements `owner.request` et `phase.request` déposés par les agents avec un `request_id` dans `payload_json`, sans décision. *Approuver* ou *Refuser* écrit un événement `owner.decision` dans le cycle de la demande et une ligne `owner_decisions` (décision, preuve, numéro d'événement), dans une seule transaction CAS. Une demande ne se tranche qu'une fois.
- **Demandes exécutables (CC-4 A2)** : quand un agent a préparé l'acte lui-même (installation de phases ou import d'état), la demande affiche :
  - ce qui sera exécuté, avec un aperçu du contenu ;
  - pourquoi, le risque, le retour arrière ;
  - la précondition, le coût maximal et l'expiration ;
  - l'empreinte sha256.

  *Approuver* exécute exactement ce payload. L'acte et la décision forment un seul événement. Au moindre écart (empreinte, précondition, expiration), rien n'est écrit et la page affiche la raison. Il n'y a rien à coller : seul le secret est demandé. Une demande invalide ou expirée ne peut qu'être refusée. Voir le guide, §6.1.
- **Automatisation** : le bouton *Arrêt d'urgence* bloque toute action automatique (avance de phase par policy, réservation budgétaire, invocation) sans rien effacer ; *Reprendre l'automatisation* la relance. Chaque changement est un `owner.decision` du cycle `owner-registry`.
- **Budget** : enveloppe globale (plafond, réservé, dépensé, restant), à 0 € par défaut. Aucune dépense n'est possible sans enveloppe approuvée.
- **Exécuteurs (CC-4 A3)** : la matrice liste chaque endpoint d'exécution (participant, attestation, statut, capacités, dernière sonde). Un endpoint est inscrit puis activé uniquement par des demandes que vous approuvez. Le bouton *Sonder* fait un vrai appel à l'API gratuite (Workers AI, aucune clé à créer) avec un message fixe ; seule une sonde réussie permet d'approuver l'activation. Chaque appel réserve d'abord son pire cas en neurons sous l'allocation gratuite du jour ; s'il n'y a plus de place, il est refusé avant d'être lancé. Voir le guide, §6.3.
- **Participants** : enregistrer un identifiant (`[A-Za-z0-9][A-Za-z0-9:_-]*`, hors `owner`, `system`, `unregistered:*`) et son libellé. Le libellé sert uniquement à l'affichage (I8).
- **Clients OAuth associés** : associer l'identifiant de client OAuth d'un agent à son participant (K6). Le retrait de l'association rend le client « unregistered » dès son appel suivant.

Chaque action du registre est aussi journalisée comme `owner.decision` dans le cycle réservé `owner-registry` : le registre est rejouable et auditable.

## Côté agents

- L'identité d'un agent sur `/collab/mcp` est **dérivée du client OAuth de son jeton**, jamais de ce qu'il déclare. `collab_get_context` renvoie `caller` (son `participant_id` et son statut).
- `collab_append_event` exige `participant_id` = son identité, sinon `PARTICIPANT_MISMATCH`.
- Un client non associé est `unregistered` : lecture, et dépôt de `owner.request` seulement (`UNREGISTERED_CLIENT` sinon). C'est par une demande `owner.request` qu'un nouvel agent demande son association.
- `owner.decision` reste refusé à tous les agents (`OWNER_DECISION_FORBIDDEN`), quel que soit leur statut.

Pour associer un nouvel agent : il dépose une demande `owner.request` sous son pseudonyme `unregistered:…` (dérivé de son client OAuth, non réversible). Sur `/owner`, enregistrez son participant, puis collez ce pseudonyme dans le champ « Client OAuth » : le Worker retrouve le client correspondant parmi les clients déjà authentifiés sur `/collab/mcp` puis parmi les clients OAuth enregistrés. L'identifiant brut fonctionne aussi.

Clients CIMD (identifiant = URL publique de métadonnées, par exemple Claude `https://claude.ai/oauth/mcp-oauth-client-metadata` ou ChatGPT `https://chatgpt.com/oauth/client.json`) : la bibliothèque OAuth ne les enregistre jamais, ils n'apparaissent donc pas dans la liste des clients. Le Worker retient l'identifiant porté par un **jeton validé** lors du premier appel non associé à `/collab/mcp` (table interne `oauth_client_sightings`) ; c'est ce qui permet d'associer leur pseudonyme. Rien de ce que l'agent déclare (champ `participant_id`, contenu d'une demande, libellé) n'y entre, et cette trace n'accorde aucune identité : seule l'association faite ici en donne une. Un pseudonyme qui ne correspond à aucun client authentifié ou enregistré est refusé (`UNKNOWN_CLIENT`) : demandez à l'agent d'appeler d'abord `collab_get_context`. Limite connue : toutes les sessions qui partagent un même identifiant CIMD reçoivent la même identité.

## Limites connues (V1)

- Pas de limitation de débit sur `/owner` en mode `secret` : un secret long est la protection. À ajouter si la page devient exposée.
- Les décisions et le registre n'utilisent pas le quota quotidien des agents : le propriétaire doit toujours pouvoir agir.
- L'isolement de la mémoire personnelle repose sur cette identité ; il est vérifié par le lot C4.
