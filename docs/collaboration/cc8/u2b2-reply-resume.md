# CC8 U2b2 — Reprise du même run après clarification

## Anomalie reproductible

Au socle d'intégration `218c5821`, un modèle API peut appeler `store_ask`
et l'effet `clarify.ask` est bien inscrit avec un `seq` dans D1.
Le prochain `runStep` ne contrôle pourtant pas si une réponse appliquée existe :
il peut donc appeler le modèle de nouveau et clôturer prématurément la mission.
Le test de reproduction est `cc8-u2b2-reply-resume.spec.ts` (premier
commit de la branche `de1e9996` : test ciblé rouge).

## Correction, sans nouveau moteur

`runClarificationState` relit UNIQUEMENT les effets `store_ask` terminés,
leur `seq` réel et la réponse `clarify.answer` appliquée au même cycle.
Lorsqu'une question reste ouverte, `runStep` effectue les contrôles de
HALT, bail/chat, deadline, jetons et coût, puis répond
`waiting_for_reply` **sans appeler le fournisseur**. L'ID et le journal du
run restent inchangés ; aucun second run n'est créé ni aucun effet réémis.

L'orchestrateur existant planifie un contrôle D1 borné après 120 secondes,
au lieu de considérer cet état comme une clôture. Lorsque la réponse
existe, le modèle suivant reçoit un extrait borné des réponses validées,
explicitement marqué comme **donnée non fiable**, sans grant, rôle, droit
GitHub ou validation D12 supplémentaire.

## Preuves et contrôles

- Scénario vert sous le même `run_id` : une question appliquée, aucun
  appel modèle avant la réponse, puis reprise avec le texte de la réponse.
- Réponse d'un tiers non autorisé : refus certain du store et aucune reprise.
- Réponse idempotente : duplicate, aucun effet ou appel supplémentaire.
- Préemption par le chat et échéance du run : prioritaires sur l'attente,
  sans second appel modèle.
- Les résultats CI, revues D12 et fusion sont encore à vérifier au
  couple final head/base.

## Limites explicitement NON résolues

Ceci est une reprise **bornée par la deadline existante**. L'alerte après
`clarify.answer` entre bien dans l'outbox événementielle de U2b1
(PR #312), mais cet incrément ne réveille pas directement
une alarme déjà programmée : la reprise peut attendre jusqu'à 120 s.
Un échange humain arrivant après la deadline demande une continuation
d'un nouveau run, avec un transfert explicite — **pas** la reprise
magique d'une session expirée. Les mesures de latence, les demandes
multiples et le vrai pilote API Gemini chat/API doivent encore être
validés en E2E, sans auto-déploiement production ni coût payant.


## Crash, compte d'étapes, longue attente et escalade

Une exécution interrompue après l'effet store_ask n'est pas relancée depuis zéro : le passage périodique existant rescueStalledRuns retrouve les runs D1 running sans alarme vivante et objectWake reconstruit l'alarme. Les réveils d'attente sont purement D1, sans nouvelle étape modèle ni consommation supplémentaire de jetons. Après réponse autorisée, le même run_id et les mêmes effets reprennent.

À la deadline d'origine, le statut terminal reste deadline et stop_reason devient atomiquement clarification_wait_expired ; le journal idempotent clarification_escalation porte owner_attention_required. Ces signaux sont visibles au coordinateur/owner dans les vues de runs existantes. La fonction finish/forget de l'orchestrateur libère le slot DO et efface l'alarme D1. Aucune prolongation de délai, nouveau grant ou relance automatique n'est donnée. Une continuation ultérieure exige un nouveau run autorisé et une passation explicite. Cette escalade durable n'est PAS une notification push au propriétaire : ce dernier doit consulter les diagnostics.
