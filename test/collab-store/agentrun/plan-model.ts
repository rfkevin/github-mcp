/**
 * CC-8 S1a — le planificateur ne crée plus d'exécution sans modèle utilisable (runCapacity). Les tests
 * historiques du planificateur, écrits sans configuration de modèle, déclarent donc explicitement le
 * modèle gratuit Workers AI (binding AI présent) : la capacité n'est plus jamais supposée.
 */
export const PLAN_MODEL = { AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: {} } as const;
