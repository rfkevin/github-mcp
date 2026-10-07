#!/usr/bin/env node
/**
 * CC-3 C4 — import AGENT_MEMORY.md contributions as memory candidates.
 * Dry-run by default: prints JSON lines suitable for collab_memory propose.
 * Does NOT write to D1 (owner/C5 or a future wired importer must apply).
 *
 * Usage:
 *   node scripts/cc3/import-agent-memory.mjs [path/to/AGENT_MEMORY.md]
 *   node scripts/cc3/import-agent-memory.mjs --author agent:grok AGENT_MEMORY.md
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
let author = 'agent:import';
let file = 'AGENT_MEMORY.md';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--author' && args[i + 1]) {
    author = args[++i];
  } else if (!args[i].startsWith('-')) {
    file = args[i];
  }
}

const text = readFileSync(resolve(file), 'utf8');
const contribRe = /^###\s+(\d{4}-\d{2}-\d{2}-[\w.-]+)\s*$/gm;
const headers = [...text.matchAll(contribRe)];
const proposals = [];

for (let i = 0; i < headers.length; i++) {
  const id = headers[i][1];
  const start = headers[i].index + headers[i][0].length;
  const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
  let body = text.slice(start, end).trim();
  // One fact: first non-empty paragraph, truncated to 600 chars
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p.length > 0 && !p.startsWith('```'));
  if (!para) continue;
  const fact = para.length > 600 ? para.slice(0, 597) + '...' : para;
  proposals.push({
    op: 'propose',
    scope: `participant:${author}`,
    kind: 'observation',
    text: fact,
    evidence_refs: [`agent-memory:${id}`],
    confidence: 'hypothesis',
    status: 'candidate',
    author_pid: author,
    import_id: id,
  });
}

process.stdout.write(JSON.stringify({ source: file, count: proposals.length, proposals }, null, 2) + '\n');
