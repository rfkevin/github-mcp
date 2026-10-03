import { z } from 'zod';
import { agentLabelSchema } from '../coordinator';

export const batchSha = z.string().regex(/^[a-f0-9]{40}$/i).transform(value => value.toLowerCase());
const path = z.string().min(1).max(1024);
const expectedSha = batchSha.nullable();
const replace = z.object({ type: z.literal('replace'), path, expectedSha: batchSha, oldText: z.string().min(1).max(100_000), newText: z.string().max(100_000) }).strict();
const append = z.object({ type: z.literal('append'), path, expectedSha: batchSha, text: z.string().min(1).max(100_000) }).strict();
const restore = z.object({ type: z.literal('restore'), path, expectedSha, sourceRef: z.string().min(1).max(240) }).strict();
const create = z.object({ type: z.literal('create'), path, content: z.string().max(1_000_000) }).strict();
export const batchOperationSchema = z.discriminatedUnion('type', [replace, append, restore, create]);
export const applyChangesSchema = z.object({
  repository: z.string().min(3).max(200), branch: z.string().min(1).max(240), expectedHeadSha: batchSha,
  message: z.string().trim().min(1).max(200), agentLabel: agentLabelSchema.default('agent non précisé'),
  operations: z.array(batchOperationSchema).min(1).max(50),
}).strict();
export type BatchOperation = z.output<typeof batchOperationSchema>;
export type ApplyChangesInput = z.input<typeof applyChangesSchema>;
export type BatchError = { index: number; path: string; code: string; message: string };
export type BatchOperationState = { index: number; path: string; state: 'prepared' | 'failed' | 'not_evaluated' | 'unchanged' };
export const BATCH_MAX_INPUT_BYTES = 1_000_000;
export const BATCH_MAX_LOADED_BYTES = 2_000_000;
export const BATCH_MAX_WORKING_BYTES = 2_000_000;
