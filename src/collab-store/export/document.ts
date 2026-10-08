/**
 * CC-3 C6 — CC-STATE-1 document model (lossless up to a canonical form).
 *
 * A state file is validated with the L1 parser (src/collab/state.ts, unchanged)
 * and kept as ordered blocks: free text lines and Markdown tables. Rendering
 * normalizes only the presentation (line endings, trailing spaces, table cell
 * padding, one final newline), so render(parse(x)) is a fixed point:
 * canonical(canonical(x)) === canonical(x). Every byte of prose is preserved.
 */
import { StateContractError } from '../../collab/contracts';
import { parseWorkflowState } from '../../collab/state';

export interface TextBlock { kind: 'text'; lines: string[] }
export interface TableBlock { kind: 'table'; headers: string[]; rows: string[][] }
export type Block = TextBlock | TableBlock;
export interface Section { name: string; blocks: Block[] }
export interface StateDocument {
  /** Everything before the first `## ` heading: title, control keys, prose. */
  preamble: Block[];
  sections: Section[];
}

/** Hard cap on an imported or exported state file (bytes, UTF-8). */
export const MAX_STATE_BYTES = 262_144;

function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) return null;
  return trimmed.slice(1, -1).split('|').map(cell => cell.trim());
}

function isSeparator(line: string): boolean {
  const row = cells(line);
  return row !== null && row.length > 0 && row.every(cell => /^:?-{3,}:?$/.test(cell));
}

function blocksOf(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let text: string[] = [];
  const flushText = (): void => {
    if (text.length) blocks.push({ kind: 'text', lines: text });
    text = [];
  };
  let index = 0;
  while (index < lines.length) {
    const header = cells(lines[index]);
    if (header && index + 1 < lines.length && isSeparator(lines[index + 1])) {
      flushText();
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = cells(lines[index]);
        if (!row) break;
        rows.push(row);
        index += 1;
      }
      blocks.push({ kind: 'table', headers: header, rows });
      continue;
    }
    text.push(lines[index]);
    index += 1;
  }
  flushText();
  return blocks;
}

function normalizedLines(markdown: string): string[] {
  const lines = markdown.replace(/\r/g, '').split('\n').map(line => line.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Parse and validate a CC-STATE-1 file. Throws the L1 StateContractError codes on invalid input. */
export function parseStateDocument(markdown: string): StateDocument {
  if (new TextEncoder().encode(markdown).byteLength > MAX_STATE_BYTES) {
    throw new StateContractError('STATE_TOO_LARGE', 'State file exceeds ' + MAX_STATE_BYTES + ' bytes');
  }
  const snapshot = parseWorkflowState(markdown);
  if (snapshot.legacySchema) {
    throw new StateContractError('UNSUPPORTED_SCHEMA', 'Only CC-STATE-1 files can be imported or exported (schema_version is missing)');
  }
  const lines = normalizedLines(markdown);
  const preamble: string[] = [];
  const sections: Array<{ name: string; lines: string[] }> = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      sections.push({ name: line.slice(3).trim(), lines: [] });
      continue;
    }
    if (sections.length) sections[sections.length - 1].lines.push(line);
    else preamble.push(line);
  }
  return {
    preamble: blocksOf(preamble),
    sections: sections.map(section => ({ name: section.name, blocks: blocksOf(section.lines) })),
  };
}

function renderBlocks(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      out.push(...block.lines);
      continue;
    }
    out.push('| ' + block.headers.join(' | ') + ' |');
    out.push('| ' + block.headers.map(() => '---').join(' | ') + ' |');
    for (const row of block.rows) out.push('| ' + row.join(' | ') + ' |');
  }
  return out;
}

/** Canonical rendering: one final newline, no trailing spaces, `| a | b |` tables. */
export function renderStateDocument(document: StateDocument): string {
  const lines = renderBlocks(document.preamble);
  for (const section of document.sections) lines.push('## ' + section.name, ...renderBlocks(section.blocks));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

export function canonicalState(markdown: string): string {
  return renderStateDocument(parseStateDocument(markdown));
}

export function cloneDocument(document: StateDocument): StateDocument {
  return JSON.parse(JSON.stringify(document)) as StateDocument;
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;

/** `key: value` control line, same grammar as the L1 parser, without a backtracking regex. */
function headerOf(line: string): { key: string; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 1) return null;
  const key = line.slice(0, colon).trimEnd();
  return KEY_RE.test(key) ? { key, value: line.slice(colon + 1).trim() } : null;
}

export function getHeader(document: StateDocument, key: string): string | undefined {
  for (const block of document.preamble) {
    if (block.kind !== 'text') continue;
    for (const line of block.lines) {
      const header = headerOf(line);
      if (header?.key === key) return header.value;
    }
  }
  return undefined;
}

/** Replace the value of an existing control key (the L1 parser guarantees required keys exist). */
export function setHeader(document: StateDocument, key: string, value: string): void {
  for (const block of document.preamble) {
    if (block.kind !== 'text') continue;
    const index = block.lines.findIndex(line => headerOf(line)?.key === key);
    if (index >= 0) {
      block.lines[index] = key + ': ' + value;
      return;
    }
  }
  throw new StateContractError('MISSING_CONTROL_KEY', 'Missing control key: ' + key, key);
}

export function findSection(document: StateDocument, name: string): Section | undefined {
  return document.sections.find(section => section.name === name);
}

export function findTable(document: StateDocument, section: string, required: string[]): TableBlock | undefined {
  const blocks = findSection(document, section)?.blocks ?? [];
  return blocks.find((block): block is TableBlock => block.kind === 'table'
    && required.every(header => block.headers.includes(header)));
}

/**
 * Append list items to a section, right after its last `- ` line (so closing
 * prose such as "Kevin alone decides…" stays last). Without a list, the items
 * are appended at the end of the section's last text block.
 */
export function appendListItems(document: StateDocument, sectionName: string, items: string[]): void {
  if (!items.length) return;
  const section = findSection(document, sectionName);
  if (!section) throw new StateContractError('MISSING_SECTION', sectionName + ' section is required', sectionName);
  for (let b = section.blocks.length - 1; b >= 0; b -= 1) {
    const block = section.blocks[b];
    if (block.kind !== 'text') continue;
    let last = -1;
    block.lines.forEach((line, index) => { if (line.startsWith('- ')) last = index; });
    if (last >= 0) {
      block.lines.splice(last + 1, 0, ...items);
      return;
    }
  }
  const text = [...section.blocks].reverse().find((block): block is TextBlock => block.kind === 'text');
  if (text) text.lines.push(...items);
  else section.blocks.push({ kind: 'text', lines: items });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A table cell or list item built from store data: one line, no pipe, bounded. */
export function inlineCell(value: string, max = 400): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '/').replace(/\s{2,}/g, ' ').trim();
  const bounded = flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  return bounded || 'n/a';
}
