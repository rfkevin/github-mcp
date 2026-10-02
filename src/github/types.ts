// Public compatibility entry point. Domain definitions live in ./types/.
export * from './types/common';
export * from './types/repository';
export * from './types/discussions';
export * from './types/checks';
export * from './types/client';
export * from './types/errors';
export type { FileChange, SecurityPolicy } from '../security/policy';
