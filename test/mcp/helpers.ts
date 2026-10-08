import { expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { assertWritablePath } from '../../src/security/policy';
import type { ToolContext } from '../../src/mcp/context';
import { z } from 'zod';
export const SHA = 'a'.repeat(40);
export const OTHER = 'b'.repeat(40);
export type ToolResult = {
    isError?: boolean;
    structuredContent: Record<string, unknown>;
};
export type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
export function registry(register: (server: McpServer, context: ToolContext) => void, context: ToolContext) {
    const handlers = new Map<string, Handler>();
    const fake = { registerTool: (name: string, spec: {
            outputSchema: z.ZodRawShape;
        }, handler: Handler) => {
            handlers.set(name, async (args) => {
                const result = await handler(args);
                if (!result.isError)
                    z.object(spec.outputSchema).parse(result.structuredContent);
                return result;
            });
        } };
    register(fake as unknown as McpServer, context);
    return (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);
}
export function context() {
    return {
        actor: '123',
        github: { repositories: { getRepository: vi.fn(async () => ({ default_branch: 'master' })) } },
        reads: {
            commits: { getCommit: vi.fn(async () => ({ sha: SHA })), compareRefs: vi.fn() },
            files: { getTextFile: vi.fn(async (_repo: string, path: string, _ref: string) => ({ path, sha: OTHER, size: 8, content: 'one\ntwo\nthree\n' })),
                getRepositoryTree: vi.fn(async () => ({ truncated: false, entries: [] })) },
        },
        checks: { listCheckRuns: vi.fn(async () => []), listCheckAnnotations: vi.fn(async () => []) },
        statuses: { getCombinedStatus: vi.fn(async () => ({ state: 'pending', total_count: 0, statuses: [] })) },
        workflows: { listWorkflowRuns: vi.fn(async () => []), getWorkflowRun: vi.fn(), listWorkflowRunJobs: vi.fn(async () => []), getJobLogs: vi.fn() },
    };
}
it.each(['.github', '.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.github/CODEOWNERS', 'scripts', 'scripts/ci/run-checks.mjs'])('le MCP ne peut pas modifier le contrôleur : %s', path => {
    expect(() => assertWritablePath(path)).toThrow('GitHub Actions');
});
