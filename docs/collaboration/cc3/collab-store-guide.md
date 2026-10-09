# Store de collaboration CC-3 — guide (voir cc3-integration pour corps C4/C6/L1 complet)

### `collab_phase_advance`
- **Entrée** : `cycle`, `expected_rev`, `next_phase` (`P1`–`P6`). **Pas de `policy_id` côté agent** : policy dérivée de `auto_advance` serveur (`none` → `POLICY_NOT_AUTHORIZED`).
- **Sortie** : `applied` ou `duplicate`, avec `revision` et `event_seq`.
- **Erreurs** : `PHASE_TRANSITION_FORBIDDEN`, `PHASE_ENTRY_CONDITIONS_UNMET`, `PHASE_DEFINITION_MISSING`, `POLICY_NOT_AUTHORIZED`, `PHASE_OUTPUTS_INCOMPLETE`, `PHASE_EXIT_CONDITIONS_UNMET`, `STALE`.

> Resync F5 : le corps complet du guide (sections 1–10, codes C4/C6/L1) est sur `cc3-integration@e15bb4d`. Ce fichier minimal documente uniquement l’outil F5 ajouté. Si `docs-coverage` exige le corps complet, reprendre le blob `b31401e` d’intégration et y insérer la section ci-dessus avant `collab_memory`.
