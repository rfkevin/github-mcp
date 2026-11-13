# CC8 — parité d'accès chat / agent API (13 novembre 2026)

Le chat utilise `collab_get_context`, `collab_append_event` et les outils GitHub MCP.
L'API passe par des adaptateurs WorkSession mais les événements utilisent déjà
le même `CollabStore.appendEvent`.

## Correctifs
- Référence C0 initiale de 12 000 tokens partagée avec le chat (~3 000 tokens
  estimés de dossier de rôle) ; `answer` sans tâche reçoit un dossier jusqu'à
  12 000 octets de JSON. La mémoire privée conserve les mêmes contrôles de visibilité.
- `github_read_file` : pages de 12 000 caractères, `offset`, `total_chars`,
  `next_offset`. Lire toutes les pages au **même SHA** plutôt que perdre
  silencieusement ce qui dépasse 16 384 caractères de résultat modèle.
- `github_diff` : 3 fichiers/page, `files_available`, `next_file_offset`,
  puis `patch_offset` / `patch_next_offset` pour chaque patch. Une preuve D12
  doit confirmer les pages examinées et ne pas prétendre couvrir les fichiers
  non lus. Les patchs sensibles déjà filtrés chez GitHub restent masqués.
- `github_commit_files` : 50 fichiers et au maximum 1 000 000 d'octets UTF-8
  cumulés, 1 000 000 de caractères maximum par fichier. SHA attendu,
  `owned_paths`, bail et déduplication restent actifs.

## Limites non modifiées
Les profils `TASK_KIND_BOUNDS`, le plafond de tokens `ABSOLUTE_MAX_OUTPUT_TOKENS`
et les délais `TASK_KIND_DEADLINE_S` restent à vérifier par fournisseur et par
reprise d'exécution. Les augmenter sans borne réelle fiable risquerait de provoquer
un refus du modèle ou une expiration de WorkSession.
La réponse `store_answer` à 4 000 caractères est traitée séparément par la
PR #324 ; elle devra être fusionnée par Kevin indépendamment de ce lot.
Pas de promotion production ou de nouveau système d'écriture.

Les prélectures internes `prefetch:true` du contrôleur S7 conservent le contenu de
fichier entier et le diff borné historique de preuve (50 fichiers, 2 000 caractères
par patch avec indicateur), indépendamment des pages fournies au modèle.
