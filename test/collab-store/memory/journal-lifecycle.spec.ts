import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore, type AppendOutcome } from '../../../src/collab-store/store/collab-store';
import type { StoreEventType } from '../../../src/collab-store/contracts';
import { MemoryStore, proposeRequestId, retireRequestId } from '../../../src/collab-store/memory/memory-store';
import { recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import { ensureSchema } from '../../../src/collab-store/store/schema';

/**
 * CC-3 CR-B (contre-revue Codex github-mcp#79, CR-02) : le lifecycle memoire
 * C4 (memory.propose / memory.review / memory.consolidate / memory.retire)
 * est dispatche par CollabStore.appendEvent et applique ses effets
 * memory_entries DANS le meme batch CAS que l'append du journal :
 * - un applied porte toujours son effet (champ memory de l'outcome) ;
 * - un refus n'ecrit rien du tout — ni journal, ni memoire ;
 * - l'auteur est le participant serveur de l'evenement, le reviewer doit lui
 *   etre distinct, les kinds proteges exigent une decision owner exact-match.
 * Aucun INSERT SQL de memory_entries ici : tout passe par le journal public.
 */
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const PROOF = { kind: 'secret' as const, subject: 'owner-secret' };
const NOW = () => new Date('2026-11-01T10:00:00.000Z');

let n = 0;
const uniq = (label: string) => 'crb-' + label + '-' + Date.now().toString(36) + '-' + ++n;

const collab = () => new CollabStore(db, { now: NOW, dailyWriteLimit: 100_000 });

interface MemoryRow {
  id: string;
  version: number;
  scope: string;
  kind: string;
  text: string;
  confidence: string;
  status: string;
  author_pid: string;
  reviewer_pid: string;
  supersedes: string | null;
  expires_rev: number | null;
}

interface AppendArgs {
  cycle: string;
  type: StoreEventType;
  participant: string;
  op: string;
  payload: Record<string, unknown>;
  expected_rev?: number;
}

async function append(args: AppendArgs): Promise<AppendOutcome> {
  const store = collab();
  return store.appendEvent({
    cycle_id: args.cycle,
    type: args.type,
    participant_id: args.participant,
    expected_rev: args.expected_rev ?? (await store.currentRevision(args.cycle)),
    payload_json: JSON.stringify(args.payload),
    op_id: 'u:' + args.cycle + ':' + args.op + ':1',
  });
}

/** Code de l'erreur typée du refus — la promesse ne doit jamais s'appliquer. */
async function refuse(args: AppendArgs): Promise<string> {
  try {
    const outcome = await append(args);
    throw new Error('refus attendu, evenement ' + outcome.status);
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}

async function state(cycle: string): Promise<{ revision: number; events: number }> {
  await ensureSchema(db);
  const c = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>();
  const e = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  return { revision: c?.revision ?? 0, events: e?.n ?? 0 };
}

async function row(id: string, version: number): Promise<MemoryRow | null> {
  return db.prepare('SELECT * FROM memory_entries WHERE id = ?1 AND version = ?2').bind(id, version).first<MemoryRow>();
}

async function countRows(id: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE id = ?1').bind(id).first<{ n: number }>())?.n ?? 0;
}

/** Decision owner par le canal C5 reel : owner.request au journal, puis recordOwnerDecision. */
async function ownerApprove(cycle: string, requestId: string, op: string): Promise<void> {
  expect((await append({ cycle, type: 'owner.request', participant: 'agent:a', op,
    payload: { request_id: requestId, summary: 'approbation CR-B' } })).status).toBe('applied');
  const decision = await recordOwnerDecision(db, { request_id: requestId, decision: 'approve', proof: PROOF, now: NOW });
  expect(decision.status).toBe('applied');
}

describe('CC-3 CR-B (CR-02) — lifecycle memoire C4 dispatche par appendEvent (meme batch CAS)', () => {
  it('memory.propose applied porte son effet ; rejeu duplicate ; conflit ; revue pair ; re-propose actif refuse', async () => {
    const cycle = uniq('cyc');
    const scope = 'role:' + uniq('a');
    const id = uniq('mem');
    const x = 'agent:x';
    const y = 'agent:y';
    const payload = { memory: { id, scope, kind: 'fact', text: 'le journal porte le lifecycle memoire', evidence_refs: ['ev:1'] } };

    // propose applied : effet memoire dans l'outcome + ligne candidate.
    const propose = await append({ cycle, type: 'memory.propose', participant: x, op: 'propose', payload });
    expect(propose).toMatchObject({ status: 'applied', revision: 1, memory: { id, version: 1, status: 'candidate' } });
    const candidate = await row(id, 1);
    expect(candidate).toMatchObject({ scope, kind: 'fact', status: 'candidate', author_pid: x, confidence: 'hypothesis' });
    // Hypothese (defaut) : expire a cycle_rev (1) + 3.
    expect(candidate?.expires_rev).toBe(4);

    // Rejeu du meme op_id : duplicate, aucune seconde ecriture memoire, pas de champ memory.
    const replay = await append({ cycle, type: 'memory.propose', participant: x, op: 'propose', payload, expected_rev: 0 });
    expect(replay.status).toBe('duplicate');
    expect('memory' in replay).toBe(false);
    expect(await countRows(id)).toBe(1);

    // Meme op_id, intention differente : conflit, jamais une reecriture silencieuse.
    const divergent = { memory: { id, scope, kind: 'fact', text: 'intention differente', evidence_refs: ['ev:1'] } };
    expect(await refuse({ cycle, type: 'memory.propose', participant: x, op: 'propose', payload: divergent, expected_rev: 1 }))
      .toBe('IDEMPOTENCY_CONFLICT');

    // Revue par un pair distinct : active dans la meme transaction.
    const review = await append({ cycle, type: 'memory.review', participant: y, op: 'review',
      payload: { memory: { id, version: 1 } } });
    expect(review).toMatchObject({ status: 'applied', memory: { id, version: 1, status: 'active' } });
    expect((await row(id, 1))?.reviewer_pid).toBe(y);

    // L'id actif ne peut pas etre re-propose (parcours supersede requis).
    expect(await refuse({ cycle, type: 'memory.propose', participant: x, op: 'repropose',
      payload: { memory: { id, scope, kind: 'fact', text: 'doublon', evidence_refs: ['ev:2'] } } })).toBe('MEMORY_ACTIVE_EXISTS');
    expect(await countRows(id)).toBe(1);
  });

  it('revue : preuve exigee, reviewer distinct, introuvable — aucun etat change', async () => {
    const cycle = uniq('cyc');
    const scope = 'role:' + uniq('b');
    const id = uniq('mem');
    const x = 'agent:x';

    // Candidate sans evidence_refs : posable, jamais activable (C4).
    expect((await append({ cycle, type: 'memory.propose', participant: x, op: 'propose',
      payload: { memory: { id, scope, kind: 'fact', text: 'sans preuve' } } })).status).toBe('applied');

    const before = await state(cycle);
    expect(await refuse({ cycle, type: 'memory.review', participant: 'agent:y', op: 'rev-ev',
      payload: { memory: { id, version: 1 } } })).toBe('MEMORY_EVIDENCE_REQUIRED');
    expect(await refuse({ cycle, type: 'memory.review', participant: x, op: 'rev-self',
      payload: { memory: { id, version: 1 } } })).toBe('MEMORY_SELF_ACTIVATION');
    expect(await refuse({ cycle, type: 'memory.review', participant: 'agent:y', op: 'rev-ghost',
      payload: { memory: { id: id + '-ghost', version: 1 } } })).toBe('MEMORY_NOT_FOUND');
    // Refus = rien ecrit : ni journal, ni effet memoire.
    expect(await state(cycle)).toEqual(before);
    expect((await row(id, 1))?.status).toBe('candidate');
  });

  it('parcours complet propose, review, consolidate, review v2, retire — consolidation nette, cap reserve', async () => {
    const cycle = uniq('cyc');
    const scope = 'role:' + uniq('c');
    const id = uniq('mem');
    const x = 'agent:x';
    const y = 'agent:y';
    const z = 'agent:z';

    expect((await append({ cycle, type: 'memory.propose', participant: x, op: 'p',
      payload: { memory: { id, scope, kind: 'fact', text: 'version initiale', evidence_refs: ['ev:1'], confidence: 'observed' } } }))
      .status).toBe('applied');
    expect((await append({ cycle, type: 'memory.review', participant: y, op: 'r1',
      payload: { memory: { id, version: 1 } } })).status).toBe('applied');

    // Consolidation par un tiers : v1 superseded + v2 candidate, garde d'effet dans le batch.
    const consolidate = await append({ cycle, type: 'memory.consolidate', participant: z, op: 'sup',
      payload: { memory: { id, text: 'version consolidee', evidence_refs: ['ev:2'] } } });
    expect(consolidate).toMatchObject({ status: 'applied', memory: { id, version: 2, status: 'candidate' } });
    expect((await row(id, 1))?.status).toBe('superseded');
    expect(await row(id, 2)).toMatchObject({ status: 'candidate', author_pid: z, supersedes: id + '@1' });

    // consolidate exige evidence_refs : payload invalide, rien n'est ecrit.
    const before = await state(cycle);
    expect(await refuse({ cycle, type: 'memory.consolidate', participant: z, op: 'sup-noev',
      payload: { memory: { id, text: 'sans preuve' } } })).toBe('INVALID_MEMORY_PAYLOAD');
    expect(await state(cycle)).toEqual(before);
    expect(await countRows(id)).toBe(2);

    // Revue v2 par l'auteur initial (different du consolidateur) : active.
    // La consolidation remplace au lieu d'ajouter : pas de fausse alarme de croissance.
    const review2 = await append({ cycle, type: 'memory.review', participant: x, op: 'r2',
      payload: { memory: { id, version: 2 } } });
    expect(review2).toMatchObject({ status: 'applied', memory: { id, version: 2, status: 'active' } });
    expect(await new MemoryStore(db).isActivationPaused(scope)).toBe(false);

    // Retire (tombstone) : cap cycle reserve dans le meme batch, effet verifie.
    const retire = await append({ cycle, type: 'memory.retire', participant: 'agent:w', op: 'ret',
      payload: { memory: { id } } });
    expect(retire).toMatchObject({ status: 'applied', memory: { id, version: 2, status: 'retired' } });
    expect((await row(id, 2))?.status).toBe('retired');
    const cap = await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1')
      .bind('mem:ret:' + cycle + ':' + scope).first<{ writes: number }>();
    expect(cap?.writes).toBe(1);
  });

  it('croissance : la 2e activation d un scope le met en pause, refus suivants sans ecriture', async () => {
    const cycle = uniq('cyc');
    const scope = 'role:' + uniq('g');
    const ids = [uniq('mem'), uniq('mem'), uniq('mem')];
    const x = 'agent:x';
    const y = 'agent:y';

    await append({ cycle, type: 'memory.propose', participant: x, op: 'p0',
      payload: { memory: { id: ids[0], scope, kind: 'fact', text: 'fait numero 0', evidence_refs: ['ev:0'] } } });
    expect((await append({ cycle, type: 'memory.review', participant: y, op: 'r0',
      payload: { memory: { id: ids[0], version: 1 } } })).status).toBe('applied'); // baseline = 1
    await append({ cycle, type: 'memory.propose', participant: x, op: 'p1',
      payload: { memory: { id: ids[1], scope, kind: 'fact', text: 'fait numero 1', evidence_refs: ['ev:1'] } } });
    // 2 entrees actives = +100 % > 25 % : le scope passe en pause DANS le batch d'activation.
    expect((await append({ cycle, type: 'memory.review', participant: y, op: 'r1',
      payload: { memory: { id: ids[1], version: 1 } } })).status).toBe('applied');
    expect(await new MemoryStore(db).isActivationPaused(scope)).toBe(true);

    // Les activations suivantes du scope sont refusees sans rien ecrire.
    await append({ cycle, type: 'memory.propose', participant: x, op: 'p2',
      payload: { memory: { id: ids[2], scope, kind: 'fact', text: 'fait numero 2', evidence_refs: ['ev:2'] } } });
    const before = await state(cycle);
    expect(await refuse({ cycle, type: 'memory.review', participant: y, op: 'r2',
      payload: { memory: { id: ids[2], version: 1 } } })).toBe('ACTIVATION_PAUSED');
    expect(await state(cycle)).toEqual(before);
    expect((await row(ids[2], 1))?.status).toBe('candidate');
  });

  it('kinds proteges : decision owner exact-match requise pour propose et retire', async () => {
    const cycle = uniq('cyc');
    const scope = 'role:' + uniq('p');
    const id = uniq('inv'); // id explicite court requis pour un kind protege
    const x = 'agent:x';
    const y = 'agent:y';

    // Hypothese interdite sur un kind protege.
    expect(await refuse({ cycle, type: 'memory.propose', participant: x, op: 'hyp',
      payload: { memory: { id, scope, kind: 'invariant', text: 'jamais une regle' } } })).toBe('HYPOTHESIS_NOT_RULE');

    // Sans decision owner liee au sujet exact : refus, rien ecrit.
    const before = await state(cycle);
    expect(await refuse({ cycle, type: 'memory.propose', participant: x, op: 'no',
      payload: { memory: { id, scope, kind: 'invariant', text: 'invariant du store', confidence: 'observed' } } }))
      .toBe('PROTECTED_KIND_OWNER_REQUIRED');
    expect(await state(cycle)).toEqual(before);
    expect(await countRows(id)).toBe(0);

    // Approbation owner via le canal C5, propose applique.
    await ownerApprove(cycle, proposeRequestId(id, 1), 'req-propose');
    const propose = await append({ cycle, type: 'memory.propose', participant: x, op: 'ok',
      payload: { memory: { id, scope, kind: 'invariant', text: 'invariant du store', confidence: 'observed', evidence_refs: ['ev:inv'], owner_decision_ref: proposeRequestId(id, 1) } } });
    expect(propose).toMatchObject({ status: 'applied', memory: { id, version: 1, status: 'candidate' } });
    expect((await append({ cycle, type: 'memory.review', participant: y, op: 'rev',
      payload: { memory: { id, version: 1 } } })).status).toBe('applied');
    // L'activation d'un kind protege met le scope en pause (INVARIANT_TOUCHED).
    expect(await new MemoryStore(db).isActivationPaused(scope)).toBe(true);

    // Retire protege : decision liee a la version retiree exacte.
    expect(await refuse({ cycle, type: 'memory.retire', participant: y, op: 'ret-no',
      payload: { memory: { id } } })).toBe('PROTECTED_KIND_OWNER_REQUIRED');
    await ownerApprove(cycle, retireRequestId(id, 1), 'req-retire');
    const retire = await append({ cycle, type: 'memory.retire', participant: y, op: 'ret-ok',
      payload: { memory: { id, owner_decision_ref: retireRequestId(id, 1) } } });
    expect(retire).toMatchObject({ status: 'applied', memory: { id, version: 1, status: 'retired' } });
  });

  it('INVALID_MEMORY_PAYLOAD : payload sans cle memory ou champs invalides, aucun evenement ecrit', async () => {
    const cycle = uniq('cyc');
    const scope = 'role:' + uniq('e');
    const before = await state(cycle);

    const cases: Array<{ type: StoreEventType; participant: string; op: string; payload: Record<string, unknown> }> = [
      { type: 'memory.propose', participant: 'agent:x', op: 'no-key', payload: { note: 'pas de cle memory' } },
      { type: 'memory.propose', participant: 'agent:x', op: 'not-object', payload: { memory: 'texte' } },
      { type: 'memory.propose', participant: 'agent:x', op: 'no-scope', payload: { memory: { kind: 'fact', text: 'sans scope' } } },
      { type: 'memory.propose', participant: 'agent:x', op: 'bad-refs', payload: { memory: { scope, kind: 'fact', text: 'refs mal types', evidence_refs: 'ev:1' } } },
      { type: 'memory.review', participant: 'agent:y', op: 'no-version', payload: { memory: { id: 'whatever' } } },
      { type: 'memory.review', participant: 'agent:y', op: 'zero-version', payload: { memory: { id: 'whatever', version: 0 } } },
      { type: 'memory.retire', participant: 'agent:y', op: 'string-version', payload: { memory: { id: 'whatever', version: '1' } } },
    ];
    for (const invalid of cases) {
      expect(await refuse({ cycle, type: invalid.type, participant: invalid.participant, op: invalid.op, payload: invalid.payload }))
        .toBe('INVALID_MEMORY_PAYLOAD');
    }

    // Aucun de ces refus n'a ecrit : le journal du cycle est toujours vierge...
    expect(await state(cycle)).toEqual(before);
    // ...et reste utilisable pour les evenements non memoire.
    expect((await append({ cycle, type: 'checkpoint', participant: 'agent:x', op: 'cp',
      payload: { note: 'journal intact' } })).status).toBe('applied');
    expect(await state(cycle)).toEqual({ revision: before.revision + 1, events: before.events + 1 });
  });
});
