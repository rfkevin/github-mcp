# CC-8 S5 — Canary et branchement F2 (bilan de lot)

Lot S5 du plan CC-PLAN-8 (§4, v0.2 seq 1270 : coût 0 par rejeu simulé ou modèle réellement gratuit, coût/quotas/latence tracés). Rôles D12 : auteur Vibe (GLM, servi par Mistral AI), relecteur GPT-6, testeur Grok.

## Parties et état

| Partie | Contenu | PR |
| --- | --- | --- |
| 1/2 | `src/collab-store/agentrun/canary/` : rejeu stratifié du journal (`replay.ts`), runner sans réseau ni écriture store (`runner.ts`), branchement vers la décision pure CC-7 (`f2.ts`) + spec `cc8-s5-canary.spec.ts` | cette PR |
| 2/2 | Ce bilan + complément au guide du store | cette PR |

## Choix

- **Source du rejeu** : le journal append-only du cycle. Les paquets d’entrée des invocations ne sont jamais persistés (CC-4 A1 : hashés) ; le canary ne rediffuse donc jamais de paquet brut, seulement des prompts bornés et déterministes (type, état, auteur, extrait du payload, empreinte de la source). Coordination (clarify.*, owner.*, task.claim/status, phase.request, objection.*) et mémoire (memory.*) ne sont pas rejouées — pas des tâches de travail, certaines privées par scope.
- **Coût 0 (v0.2)** : aucun appel fournisseur dans ce lot. L’appel passe par le `CanaryCaller` fourni par l’appelant : simulateur déterministe en test ; un modèle réel gratuit seulement sur décision de Kevin ; jamais payant sans plafond owner posé par /owner. Coût mesuré du panier, quotas refusés et latence moyenne tracés dans le rapport.
- **Décision pure intacte** : `promote/decision.ts` (CC-7) n’est pas modifié ; le branchement porte le rapport dans `decidePromotion` et tous les contre-exemples CC-7 restent exacts (1 appel, type manquant, alias latest, tarifs NaN, efforts invalides → reject/propose, jamais auto).
- **Sortie = tâche de promotion** : un verdict `propose`/`auto_apply` produit une `PromotionTaskProposal` (empreinte canonique du rapport, `canary_calls`, `next: beta`) consommée par le lot bêta (S6). `AGENT_RUN_PROMOTE_AUTO` reste éteint en production.
- **Disjonctions** : aucun fichier de S4 (research/, owner/trials.ts, gates/), de S6 (chaînes, bêta, retour arrière) ou de S7 (écritures GitHub) n’est touché ; `agentrun/index.ts` inchangé (imports directs depuis `canary/`).

## AC vérifiés (tests D1 réels, simulateur, horloge figée)

- **rapport rejouable par type** : journal complet → 20 appels, 5 par type, somme = appels ; deux passes → même rapport ; le journal n’est pas modifié (lecture seule) ;
- **contre-exemples F2 conservés à travers le branchement** : 1 appel et type manquant → `propose` seulement (`canary_incomplet`) ; alias `latest` → `reject ref_non_epinglee` sans tâche ; tarifs NaN → `reject tarif_candidat_invalide` ; efforts invalides → `reject sonde_efforts_invalides` ; sonde échouée → `reject sonde_echec` ; fuite d’identité → `reject canary_critique` ; taux d’échec > 5 % → `reject canary_taux_echec` ; coût supérieur → `propose canary_cout_superieur` (jamais auto) ; gratuit devenu payant → `propose gratuit_devenu_payant_gel_ou_repli` ;
- **sortie = tâche de promotion** : canary vert + politique éteinte → `propose` + `PromotionTaskProposal` (`next: beta`, empreinte rejouable) ; `reject` → rien ; en v0 `auto_apply` est interdit inconditionnellement (voir correction 2) ;
- **fail-closed** : caller qui jette → `critical_error`, échecs comptés, `reject` ; canary incomplet (déficit par type) tracé (`insufficient`) → jamais auto même politique allumée ; tarifs manquants → `cost_ratio` neutre, jamais inventé.

## Divulgations

Aucun appel réseau, aucune écriture store, aucun changement runtime (aucune variable wrangler posée ni retirée), `AGENT_RUN_PROMOTE_AUTO` éteint. Base : `mcp/105856986/cc3-integration` @ `8b9e6b09`. Fusion par Kevin uniquement.

## Correction après relecture GPT-6 (commentaire 6585571364, couple b33ac5f4/8b9e6b09)

- **Provenance vérifiable** : `CanaryCaller` déclare `provenance: 'simulation' | 'real'`, portée dans le rapport ; toute autre valeur (ou absence) vaut simulation, fail-closed. `branchCanaryToF2` interdit `auto_apply` à partir d’une simulation — verdict dégradé en `propose` avec raison `canary_simule_pas_de_promotion_auto` ; la proposition non exécutable (`next: beta`) reste disponible pour la préparation. Seul un canary réel (provenance `real`) avec politique owner allumée peut produire `auto_apply` (illustré en test seulement).
- **Rapport lié à la décision** : le rapport doit porter le `cycle_id` et le `candidate_ref` exacts de la décision — un rapport produit pour un autre cycle (`rapport_cycle_etranger`) ou un autre candidat (`rapport_candidat_etranger`) est rejeté fail-closed, sans proposition.
- **Non bloquant noté** : les prompts de rejeu incluent un extrait du payload du journal ; vérifier l’absence de contenu scellé ou privé avant toute transmission future de ces prompts à un modèle externe (note posée dans `replay.ts`).

## Correction 2 après relecture GPT-6 (commentaire 6586929922, couple 7b9adf8f/8b9e6b09)

- **auto_apply interdit inconditionnellement en v0** : la provenance déclarée (`real`) n’est pas une preuve vérifiable — un caller mock étiqueté `real` reste forgeable et obtenait encore `auto_apply`. `branchCanaryToF2` dégrade donc TOUT verdict `auto_apply` en `propose` (raison `canary_v0_auto_interdit`, plus `canary_simule_pas_de_promotion_auto` si le rapport est une simulation) ; la proposition non exécutable (`next: beta`) est conservée. Test négatif : caller mock étiqueté `real` → `propose`, jamais `auto_apply`.
- **Réactivation future** : `auto_apply` ne pourra revenir qu’avec un adaptateur fournisseur attesté et contrôlé côté serveur, ou une attestation non forgeable — jamais une simple étiquette déclarée par l’appelant.
- **Non bloquant à traiter avant activation fournisseur** : `replay.ts` extrait `payload_json` du journal interne — garantir le filtrage/redaction de tout contenu scellé ou privé avant tout envoi externe.
