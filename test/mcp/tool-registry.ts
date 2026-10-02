import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from '../../src/mcp/context';
import { z } from 'zod';
type Result = {
    isError?: boolean;
    structuredContent: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;
export function toolRegistry(register: (server: McpServer, context: ToolContext) => void, context: ToolContext) {
    const handlers = new Map<string, Handler>();
    register({ registerTool(name: string, spec: {
            inputSchema: z.ZodRawShape;
            outputSchema: z.ZodRawShape;
        }, handler: Handler) {
            handlers.set(name, async (input) => {
                const result = await handler(z.object(spec.inputSchema).parse(input));
                if (!result.isError)
                    z.object(spec.outputSchema).parse(result.structuredContent);
                return result;
            });
        } } as unknown as McpServer, context);
    return handlers;
}
