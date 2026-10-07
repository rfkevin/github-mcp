/**
 * C0 prototype of the role packet (CC-PLAN-3/v1.1 §3.5): layers are added in a
 * fixed priority order until the token budget is reached; anything left out is
 * listed by ID so it can still be fetched. Token estimate = ceil(chars / 4).
 */
export interface PacketMemory { id: string; scope: string; text: string; score: number }
export interface PacketInput {
  header: Record<string, unknown>;
  task: Record<string, unknown>;
  roleCard: string;
  memory: PacketMemory[];
  refs: string[];
  budgetTokens: number;
}
export interface Packet {
  header: Record<string, unknown>;
  task: Record<string, unknown>;
  roleCard: string;
  memory: PacketMemory[];
  refs: string[];
  excludedMemoryIds: string[];
  tokens: number;
}

const SCOPE_ORDER = ['common', 'project', 'role', 'participant', 'task'];

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function scopeRank(scope: string): number {
  const index = SCOPE_ORDER.indexOf(scope.split(':')[0]);
  return index === -1 ? SCOPE_ORDER.length : index;
}

export function buildPacket(input: PacketInput): Packet {
  const packet: Packet = { header: input.header, task: input.task, roleCard: input.roleCard,
    memory: [], refs: [], excludedMemoryIds: [], tokens: 0 };
  // Mandatory layers: without them the packet is useless, so they fail closed.
  if (estimateTokens(packet) > input.budgetTokens) throw new Error('BUDGET_TOO_SMALL');
  const ordered = [...input.memory].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || b.score - a.score);
  for (const entry of ordered) {
    packet.memory.push(entry);
    if (estimateTokens(packet) > input.budgetTokens) {
      packet.memory.pop();
      packet.excludedMemoryIds.push(entry.id);
    }
  }
  for (const ref of input.refs) {
    packet.refs.push(ref);
    if (estimateTokens(packet) > input.budgetTokens) { packet.refs.pop(); break; }
  }
  packet.tokens = estimateTokens(packet);
  // excludedMemoryIds itself costs tokens; trim refs if that pushed us over.
  while (packet.tokens > input.budgetTokens && packet.refs.length) {
    packet.refs.pop();
    packet.tokens = estimateTokens(packet);
  }
  return packet;
}
