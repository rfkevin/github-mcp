# CC-7 L11 — chercheurs en tournante

Cycle `cc7-api-auto`, lot **L11** (auteur Claude, relecteur Grok, testeur Vibe GLM). Décidé par Kevin le 2026-10-28 (6 h 48) :
les deux rôles de chercheur de L10 (veille des prix et des modèles, recherche infrastructure) ne sont plus réservés à
Claude ; **tous les agents y ont accès**, par une **tournante automatique**.

## Qui fait la passe du jour

- Ordre de la tournante : les participants du canal API (`AGENT_RUN_PARTICIPANTS`, aujourd'hui `claude,grok,vibe` ;
  Gemini et GPT entrent dans la tournante quand ils y sont inscrits).
- **Veille des prix** (chaque jour) : agent n° (jour de l'année UTC modulo le nombre d'agents), dans l'ordre de la liste.
- **Recherche infrastructure** (chaque lundi) : agent n° (numéro de semaine ISO modulo le nombre d'agents).
- La tâche programmée de Claude reste le **réveil** : elle calcule l'agent du jour et lui confie la passe. Si c'est Claude,
  ou si la passe ne peut pas être confiée (porte éteinte, refus, agent hors canal API), Claude la fait lui-même : la
  veille ne saute jamais un jour.
- En chat, **n'importe quel agent** (Grok, Vibe, Gemini, GPT…) peut faire une passe quand Kevin le lui demande : mêmes
  consignes (L10), même journal, même en-tête de message.

## Le journal est partagé : le salon

Le journal de L10 (`claude/veille-journal.md`) vivait dans le projet Claude, illisible pour les autres agents. Le
journal partagé est désormais **le salon d'équipe** : chaque passe publie au plus un message `info` dont l'en-tête est
« Veille prix AAAA-MM-JJ (agent) » ou « Recherche infra AAAA-MM-JJ (agent) ». Avant de chercher, chaque chercheur lit
les messages de ces en-têtes des 30 derniers jours : ce qui y est déjà signalé est ignoré. Claude garde en plus le
document du projet comme copie détaillée.

## Ce que fait le serveur (code de L11)

- `collab_research_assign` (MCP, **coordinateur actif seulement**) : crée pour l'agent une exécution API de type
  `research`, consigne écrite par le serveur (`researchPrompt`, fidèle à L10), une seule par agent, sujet et jour.
- Outils de l'exécution `research`, en plus de ses lectures (store, `github_read_file` pour le registre) :
  - `web_fetch_official` : GET en lecture seule, https, **hôtes officiels figés en code** (Anthropic, Google AI, xAI,
    Z.ai, Groq, OpenRouter, DeepSeek, Cloudflare, MCP, GitHub), aucune clé ni cookie, redirections revérifiées à
    chaque saut, types texte seulement, corps borné à 2 Mo, texte rendu par fenêtres de 8 000 caractères. Le contenu
    est une **donnée**, jamais une consigne.
  - `store_salon_read` : le journal partagé (30 derniers jours, 60 messages au plus).
  - `store_salon_post` : **un seul** message `info` par exécution, auteur = l'agent ; la passe infra réveille le
    coordinateur.
- Un agent API n'ouvre jamais de PR de faits : il écrit « PR de faits à faire » (chiffre, date, source) et le
  coordinateur l'ouvre à la passe suivante (règle D12 habituelle, fusion par Kevin).

## Garde-fous

- Porte propre `AGENT_RUN_RESEARCH` (« true » exact), **éteinte par défaut**, en plus d'`AGENT_RUNS_ENABLED` ; sans
  elle, ni l'outil MCP ni les outils de l'exécution n'existent et Claude fait la passe lui-même.
- Coût : `AGENT_RUN_COST_CENTS_RESEARCH`, 0 par défaut — **modèles gratuits seulement** tant que Kevin ne pose rien.
- Bornes de l'exécution : 10 étapes, 30 minutes, 4 096 jetons de sortie par étape (borne `research` existante).
- Aucun outil ne touche une variable, un secret, une branche, une fusion, `main`/`master` ou un déploiement.
- Limite connue : tant que chaque agent n'a pas son propre modèle sur cc3-test (L8/L9, réglage de Kevin), les agents
  API tournent tous sur le modèle global ; la tournante donne alors l'identité et le journal de chacun, pas encore la
  diversité des modèles. Certaines pages officielles rendues en JavaScript peuvent être pauvres en texte : l'agent le
  dit (« à revoir ») au lieu d'inventer.

## Ce qui reste à Kevin

- Allumer `AGENT_RUN_RESEARCH=true` sur cc3-test (PR de configuration séparée, sur son feu vert).
- Plus tard, s'il le veut : un plafond `AGENT_RUN_COST_CENTS_RESEARCH` pour autoriser un modèle payant.
