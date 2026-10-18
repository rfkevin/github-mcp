# CC-5 L3c — contrat d'exécution de la délégation (travail en cours)

Auteur : ChatGPT GPT-6. Base immuable : `b9a797aeb42ed7f2410931dba98dc7066f690e77` sur `mcp/105856986/cc3-integration`.

## Autorité et frontière de confiance

La délégation appartient au **coordinateur actif d'un cycle**, jamais au nom « Claude » ni aux grants globaux CC-4. Un acte owner authentifié de Kevin nomme ou révoque ce coordinateur ; le changement incrémente un numéro de mandat (`epoch`). Un poste vacant désactive toute délégation. Aucun intérim automatique.

La permission déléguée doit être vérifiée **au moment de l'exécution**, dans le **même lot transactionnel** que l'acte et la réservation du budget. Un jeton borné à `participant_id + logical_family + cycle_id + epoch + scope + expiry` est inutilisable après changement d'époque, expiration, révocation ou HALT. Les demandes déjà en file ne sont pas rejouées automatiquement : elles exigent une nouvelle validation sous le mandat courant.

## Allowlist exhaustive (refus par défaut)

- `import_state` si l'état ne modifie **aucun** grant, règle protégée ou paramètre de délégation ;
- `install_phases` ;
- réattribution des tâches, ouverture de tours et changements de phase ;
- fermeture d'issues et de PR ;
- dispatch de tâches **dans** une enveloppe préalablement financée par Kevin ;
- approbation d'une autre demande owner **uniquement** si son action effective satisfait cette allowlist.

Une action nominalement autorisée ne suffit pas : les **paramètres**, le diff d'état, la portée, la dépense maximale et les préconditions doivent être validés avant et dans le lot d'exécution.

## Denylist inconditionnelle

Refuser même avec un jeton délégué : fusion `main`/`master`, déploiement hors CC3-test, déploiement discrétionnaire vers CC3-test, création/extension/modification/révocation de délégation, nomination/prolongation/révocation du coordinateur, grants et droits, secrets et credentials, waivers, HALT, D12, canaux API votants, règles de sécurité, chemins protégés, financement et augmentation d'enveloppes ou de plafonds globaux. Les actions inconnues sont refusées.

## Quatre yeux, atomicité et journal

Pour une demande du coordinateur, un principal **authentifié côté serveur** et d'une famille logique distincte de celle du coordinateur **actuel** doit approuver `request_id + action + exact_params_hash + max_cost_cents + expires_at`. L'auteur ne s'approuve jamais lui-même ; un alias de sa famille non plus. Silence et expiration = refus. Changement de paramètres = nouvelle revue.

Le lot atomique doit vérifier le mandat courant, la non-révocation, la validité du jeton, l'empreinte de l'approbation, le plafond, le HALT, le bail et la disponibilité du journal ; réserver le coût maximal puis exécuter et enregistrer l'acte. Échec de n'importe quelle garde = **aucun effet**. Le journal append-only et un digest lisible par Kevin sont obligatoires. Le veto et le HALT de Kevin priment.

## Tests d'acceptation requis avant PR prête

1. Refus individuel de chaque classe d'actes interdits, et d'action inconnue, même avec credential délégué.
2. Import d'état apparemment permis mais contenant une mutation de grant/règle/délégation : refus.
3. Coordinateur absent, inactif, non nommé par Kevin, famille non vérifiée, mandat périmé, jeton expiré/révoqué : refus.
4. Passation et révocation concurrentes d'une exécution : CAS sur `epoch` dans **le même batch** ; aucune exécution postérieure sous l'ancien mandat.
5. Demande en file de l'ancien mandat : jamais de rejeu automatique ; revalidation nécessaire.
6. Auto-approbation, alias même famille, verdict non authentifié, empreinte/ceiling/expiry différents, silence : refus.
7. Concurrence : réservations et compteurs atomiques, jamais de dépassement d'enveloppe ; HALT/veto prioritaires.
8. Erreur d'identité, quota, lease ou journal : refus sans effet ni débit incohérent.
9. Vérification de l'audit et du digest, sans fuite de secrets.

## État de cette branche

Ce document décrit les invariants de sécurité ; **il ne constitue pas l'implémentation exécutable L3c**. Le code, les tests négatifs et la CI au SHA final restent nécessaires avant toute validation D12. Ne pas fusionner cette branche sur la seule base de ce document. Kevin reste seul autorisé à fusionner les chemins protégés.
