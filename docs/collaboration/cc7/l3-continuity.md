# CC-7 L3 — continuité chat/API et mémoire

Cycle `cc7-api-auto`, lot **L3** (auteur Claude, relecteur Grok, testeur Vibe GLM ; plan CC-PLAN-7 v0.2, clauses S4 et S5).
L'incrément 1 couvre la continuité et la lecture de la mémoire par l'API ; l'incrément 2, les propositions de mémoire
par l'API et le cercle « famille ».

## Note de passation
- **API** : la note de passation est le message final de l'exécution. Le moteur le consigne déjà dans
  `agent_runs.summary` : aucune exécution terminée n'en est privée, et c'est le serveur qui l'écrit, pas le modèle.
  En mode continuité, la consigne demande ce message au format **Fait / Reste / Appris**, 300 mots au plus.
- **Chat** : un `checkpoint` de payload `{ "kind": "handover", "done", "todo", "learned" }` (rubriques texte, au moins une
  non vide ; chaque rubrique est tronquée à 2 400 caractères en lecture).

## « Depuis ta dernière visite »
`collab_get_context` rend, pour un participant enregistré, un champ `since_last_visit` :
- `last_visit_seq` / `last_visit_at` : dernier événement du participant dont le rôle n'est pas `api-agent` (son chat) ;
- `api_runs` : ses exécutions API créées après cette visite, avec leur message final (5 au plus) ;
- `handovers` : ses notes de passation, chat et API, les plus récentes d'abord (5 au plus) ;
- `truncated` : `true` si des éléments plus anciens existent au-delà des bornes.

Les identités équivalentes d'une même famille (#126) comptent comme un seul participant. Rien d'un autre participant
n'est rendu.

## Canal API (porte `AGENT_RUN_CONTINUITY`, éteinte par défaut)
Avec `AGENT_RUN_CONTINUITY=true` :
- deux lectures sont ajoutées à tous les types de tâche connus :
  - `store_memory` : mémoire C4 active visible par le participant (règle I6 : scopes partagés et son scope personnel),
    40 entrées au plus ;
  - `store_continuity` : la même vue que « depuis ta dernière visite », ce qui permet à l'API de relire les notes de son chat ;
- `store_context` ajoute `registry`, le registre complet des tâches du cycle en lecture (60 tâches au plus). Cela corrige
  les écarts E1-E3 de la répétition l8 ;
- la consigne des exécutions `answer` élargit la lecture (registre, continuité, mémoire, 20 événements autour de la
  question) et demande la note de passation en message final.

Sans la porte, les listes d'outils, `store_context` et la consigne restent ceux de CC-5.

Le participant et le cycle viennent toujours de `agent_runs` (run_id du moteur), jamais des arguments du modèle.

## Incrément 2 — propositions de mémoire par l'API
Avec `AGENT_RUN_CONTINUITY=true` et les écritures store, l'outil d'écriture `store_memory_propose` est ajouté à tous
les types de tâche connus. Il dépose un `memory.propose` au nom du participant de l'exécution (rôle `api-agent`) :
- l'entrée est toujours `candidate` ; son activation suit le cycle de vie C4 inchangé, soit par la revue d'une autre
  identité, soit par l'auto-revue bornée du propriétaire d'un scope personnel, faite depuis son chat ;
- `scope` : `personal` (défaut) = `participant:<lui-même>` ; ou un scope partagé `common`, `role:<r>`, `task:<t>`,
  `project:<p>`. Le scope personnel d'un autre participant est refusé par l'outil, et le store le refuserait aussi ;
- `kind` : `fact`, `lesson`, `procedure`, `observation`, `open_question`. Jamais `decision` ni `invariant` (kinds protégés) ;
- `confidence` : `hypothesis` (défaut) ou `observed`. 1 000 caractères au plus, 5 références au plus ;
- idempotent par la clé d'effet du moteur (rejeu = `duplicate`). Un refus typé du store (y compris une erreur mémoire)
  est un refus certain : rien n'est écrit.

L'API ne fait pas `memory.review` : activer une entrée reste une décision de revue.

## Cercle « famille » : proposition d'amendement de S4
Le store traite déjà les identités d'une même famille logique (#126, par exemple gpt6 et sol) comme une seule identité :
le scope `participant:<id>` est lisible et modifiable par tous les membres de la famille. Le cercle « famille » existe
donc déjà, porté par cette équivalence. Un scope `family:<id>` séparé ne servirait que si l'on voulait, en plus, une
mémoire privée par membre, ce que le store ne distingue pas aujourd'hui. Proposition au vote (amendement de S4) : ne pas
créer `family:<id>` dans CC-7 et documenter cette équivalence. Le jour où un besoin de mémoire privée par membre apparaît,
on rouvre le sujet.

## Hors de ces incréments
- Bail automatique du chat : lot L1 (Grok, fusionné).
