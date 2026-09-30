import { z } from 'zod';

export const checkScopes = ['quick', 'typecheck', 'unit', 'full'] as const;
export const checksConfigSchema = z.array(z.object({
  repository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/),
  ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/)
    .refine(ref => !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.') && !ref.endsWith('.lock')),
  controllerSha: z.string().regex(/^[a-f0-9]{40}$/i),
}).strict()).max(10).refine(items => new Set(items.map(item => item.repository.toLowerCase())).size === items.length,
  'Un seul contrôleur par dépôt.');
export type ChecksConfig = z.infer<typeof checksConfigSchema>;

/** Absent = désactivé. Ne jamais activer implicitement via les droits de la GitHub App. */
export function checksConfig(value?: string): ChecksConfig {
  if (!value?.trim()) return [];
  return checksConfigSchema.parse(JSON.parse(value));
}
