import { z } from 'zod';

export const PLAN_PATH = '.mcp/checks.json';
export const scopeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const command = z.string().trim().min(1).max(4000).refine(value => !value.includes('\0'));
export const planSchema = z.object({
  version: z.literal(1),
  workingDirectory: z.string().max(240).regex(/^(?:\.|[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*)$/)
    .refine(value => !value.split('/').some(part => part === '..')).default('.'),
  install: z.array(command).max(8).default([]),
  checks: z.record(scopeSchema, z.array(command).min(1).max(12))
    .refine(checks => Object.keys(checks).length <= 8 && Object.hasOwn(checks, 'quick'), 'Un profil quick est obligatoire ; huit profils maximum.'),
}).strict();
export type CheckPlan = z.infer<typeof planSchema>;
export const targetSchema = z.string().max(240).refine(value => value === '' ||
  (/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) && !value.split('/').some(part => part === '..' || part === '.' || !part)),
  'Cible relative sans option ni traversée de dossier.');
export function parsePlan(content: string): CheckPlan {
  if (new TextEncoder().encode(content).byteLength > 64_000) throw new Error('Plan trop volumineux.');
  return planSchema.parse(JSON.parse(content));
}
