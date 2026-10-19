# CC-5 L6 — pilote autocorrection D2 (branche jetable)

Base initiale : `2144ab8968a491de9d8563a5417d028a38b5a9b0`. Aucun branchement à un exécuteur, Worker ou route publique ; aucun merge ni activation.

Le `problem_id` est une empreinte SHA-256 stable fournie par l'appelant et consignée à la première défaillance avec `first_failure_ref`. Le code refuse plus de **2 tentatives** par `(cycle,problem_id)` et plus de **5 tentatives** par `(cycle,jour UTC)`. L'admission est un `INSERT ... SELECT` D1 conditionnel atomique ; HALT est vérifié dans les deux instructions du même lot D1. Les identités correcteur, relecteur et testeur et leurs familles doivent être toutes distinctes. Le refus n'exécute aucune correction. Aucune correction ne peut être validée par son auteur.

Limites : ce pilote ne lance pas de correction ; le générateur de `problem_id`, l'attribution rotative D2, l'exécution et les verdicts indépendants restent à brancher dans un lot ultérieur après revue Grok et test Vibe. Les compteurs portent sur les admissions (tentatives), pas sur le succès. Pas de permission d'activation accordée.
