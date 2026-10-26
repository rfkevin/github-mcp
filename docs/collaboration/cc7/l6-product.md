# CC-7 L6a — « Nouveau produit » en un prompt (S8)

Cycle `cc7-api-auto`, lot **L6** (auteur Claude, relecteur Grok, testeur Vibe GLM).
Plan CC-PLAN-7 v0.2, clause S8. **Éteint par défaut** : `PRODUCT_CREATE_ENABLED` absent ou différent de `true`.

## Ce que fait Kevin

Sur `/owner`, section « Nouveau produit » : un identifiant de cycle neuf, les participants (3 à 6, dans l’ordre de rotation),
le dépôt du produit et un SHA de départ (facultatifs), et l’objectif (1 à 4 000 caractères). Un clic.

## Ce que le serveur écrit — un seul lot CAS (`ownerAppend`)

| Écriture | Contenu |
| --- | --- |
| `owner.decision` `create_product` | objectif, participants, coordinateur, gabarit `CC-PRODUCT-1`, définitions de phase ; porte aussi l’état CC-STATE-1 initial (clé `owner-state-import:<cycle>:product:…`), base de `collab_export` et du contrôleur comme un import d’état (K-import) |
| `cycles` | phase P1, dépôt du produit |
| `phase_definitions` | P1 → P2 (`product-p1`) quand chaque participant a scellé sa proposition ; P2 → P3 (`product-p2`) quand chacun a critiqué en relecteur ; P3 → P4 (`product-p3`) quand la synthèse est déposée ; P4 (vote), P5 (validation de Kevin), P6 (lots) manuels |
| `tasks` | `p-<participant>` par participant (auteur i, relecteur i+1, testeur i+2) et `synthesis` (bloquée, au premier participant, qui coordonne) |

Le contrôleur fait le reste avec ses règles existantes : à l’entrée de P1 il réveille chaque auteur (`no-submission`),
puis les relecteurs en P2 et le coordinateur en P3 ; le canal API (L5a) prend ces réveils quand Kevin l’allume.

## Gardes (refus avant toute écriture)

- porte `PRODUCT_CREATE_ENABLED` (`PRODUCT_CREATE_DISABLED`) ; preuve owner directe seulement (`DELEGATED_FORBIDDEN`) ;
- arrêt d’urgence posé : `AUTOMATION_HALTED` (revérifié dans le lot) ;
- cycle neuf seulement : `PRODUCT_CYCLE_EXISTS` (revérifié dans le lot, aucune écriture partielle) ;
- 3 à 6 participants enregistrés et actifs, sans doublon : `PRODUCT_PARTICIPANTS` ;
- identités logiques toutes distinctes (#126), donc trois familles par tâche : `PRODUCT_FAMILIES` ;
- formulaire invalide : `PRODUCT_INVALID` ; l’état produit passe la même validation qu’un import (D12 par tâche, libellés).
- Rejouer le même formulaire renvoie l’acte d’origine (`duplicate`), jamais un second cycle.

L’objectif est cité ligne par ligne (`> `) dans l’état : aucune ligne ne peut devenir section, tableau ou en-tête.

## Hors de cet incrément (L6b)

- vote P4 automatique sans OBJECTION (Q3) : demande une policy qui lit l’état des votes, pas seulement leur nombre ;
- interrupteur de fusion vers l’intégration (S11, Q4), éteint par défaut, par la porte existante (D12 complet, CI 4/4, HALT) ;
- message salon `decision` « prêt à promouvoir » quand le produit est viable.

## Fichiers

- `src/collab-store/owner/product.ts` — gabarit, `planProduct` (pur), `createProduct` (acte owner)
- `src/collab-store/owner/handler.ts`, `page.ts`, `index.ts` — action `create_product`, formulaire, export
- `test/collab-store/owner/cc7-l6a-product.spec.ts` ; `page-inventory.spec.ts` (16 actions, 15 sections)
- `docs/collaboration/cc3/collab-store-guide.md` — K-product et codes `PRODUCT_*`
