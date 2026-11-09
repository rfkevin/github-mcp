import { describe, expect, it } from 'vitest';
import {
  buildTaskDossier,
  condenseDelta,
  DossierBudgetError,
  DossierSourceError,
  dutyFor,
  DOSSIER_DELTA_BUDGET,
  verifiedScopesFor,
  type DossierGithubState,
  type DossierSource,
  type TaskDossierInput,
} from '../../../src/collab-store/agentrun/task-dossier';
import {
  buildUnifiedContext,
  dossierFingerprint,
  unifiedParityViolations,
  type UnifiedPacketLike,
} from '../../../src/collab-store/agentrun/unified-context';

// CC-8 S7 A1 — dossier universel et contexte unifié chat/API. Le dossier ne
// dépend ni du canal ni du kind (kind = privilèges, pas orchestrateur) ; les
// scopes C4 sont vérifiés serveur uniquement, deny-by-default ; les sources
// figées portent le CONTENU et la provenance — une référence seule est refusée ;
// toute condensation est bornée et signalée, jamais silencieuse. Le module R6
// (assessDossier/buildDossier) est couvert par son propre spec et reste inchangé.

const BASE_SHA = '83932049ef966bf8d5598068384df58a616906b0';

const sources = (): DossierSource[] => [{
  path: 'src/collab-store/context/packet.ts',
  sha: BASE_SHA,
  content_excerpt: 'export const DEFAULT_PACKET_BUDGET = 6000;',
  provenance: 'raw.githubusercontent.com/rfkevin/github-mcp par SHA',
}];

const github = (): DossierGithubState => ({
  repo: 'rfkevin/github-mcp',
  commit_sha: BASE_SHA,
  ci_status: 'success',
  ci_url: 'https://github.com/rfkevin/github-mcp/commit/' + BASE_SHA + '/checks',
  sources: sources(),
});

const dossierInput = (): TaskDossierInput => ({
  header: {
    cycle_id: 'cc8-systeme-unique', phase: 'implementation', revision: 42, status: 'open',
    task_id: 'S7-A1-dossier', participant_id: 'vibe', last_seen_seq: 2024,
  },
  task: {
    task_id: 'S7-A1-dossier', owner_pid: 'vibe', reviewer_pid: 'gpt6', tester_pid: 'grok',
    status: 'in_progress',
    owned_paths: [
      'src/collab-store/agentrun/task-dossier.ts',
      'src/collab-store/agentrun/unified-context.ts',
      'test/collab-store/agentrun/cc8-unified-context.spec.ts',
    ],
    next_action: 'Déposer le code exact dans le store', revision: 3,
  },
  participation: 'owner',
  scopes: verifiedScopesFor({
    participantIds: new Set(['vibe']), taskRole: 'owner', taskId: 'S7-A1-dossier',
    coordinator: false, projectScopeKey: null,
  }),
  openQuestions: [{ seq: 2015, author: 'gpt6', question: 'Contrainte de canal pour le push GitHub ?' }],
  deltaEvents: [
    { seq: 2006, type: 'task.claim', participant_id: 'vibe', summary: 'claim S7-A1-dossier' },
    { seq: 2024, type: 'checkpoint', participant_id: 'vibe', summary: 'dépôt part 1/3 task-dossier.ts' },
  ],
  deltaSinceSeq: 2005,
  handovers: [{
    seq: 2012, at: 1794225093, channel: 'chat',
    done: 'relecture C0', todo: 'déposer le code A1', learned: 'vérifier le contenu par raw SHA',
  }],
  nextActions: ['Déposer task-dossier.ts', 'Déposer unified-context.ts', 'Déposer le spec'],
  github: github(),
  budgetTokens: 6000,
});

const packet = (): UnifiedPacketLike => ({
  header: {
    cycle_id: 'cc8-systeme-unique', phase: 'implementation', revision: 42, status: 'open',
    participant_id: 'vibe', last_seen_seq: 2024,
  },
  role_card: { role: 'owner', duty: dutyFor('owner') },
  open_questions: ['#2015 (gpt6) Contrainte de canal pour le push GitHub ?'],
  budget: { max_tokens: 6000, estimated_tokens: 1200 },
});

describe('CC-8 S7 A1 — dossier universel de tâche', () => {
  it('carte de rôle : devoirs alignés sur le packet, coordonnateur et observateur explicites', () => {
    expect(dutyFor('owner')).toBe('Deliver the task on owned paths; do not self-validate.');
    expect(dutyFor('reviewer')).toBe('Read all changed paths and report blockers or agreement at the exact head.');
    expect(dutyFor('tester')).toBe('Run independent scenarios and report pass, fail or not_tested.');
    expect(dutyFor('coordinator')).toContain('never merge');
    expect(dutyFor('observer')).toContain('without write');
    expect(dutyFor('none')).toContain('ask a question');
  });

  it('scopes C4 vérifiés : deny-by-default, identités seules, jamais les scopes privés d\'autrui', () => {
    const scopes = verifiedScopesFor({
      participantIds: new Set(['vibe', 'glm']), taskRole: 'reviewer', taskId: 'S7-C0-capabilities',
      coordinator: true, projectScopeKey: 'rfkevin-github-mcp',
    });
    const keys = scopes.map(scope => scope.scope);
    expect(keys).toContain('common');
    expect(keys).toContain('participant:vibe');
    expect(keys).toContain('participant:glm');
    expect(keys).toContain('role:reviewer');
    expect(keys).toContain('role:coordinator');
    expect(keys).toContain('task:S7-C0-capabilities');
    expect(keys).toContain('project:rfkevin-github-mcp');
    expect(keys).not.toContain('participant:gpt6');
    expect(keys).not.toContain('participant:grok');
    expect(scopes.every(scope => scope.verified === true)).toBe(true);
  });

  it('delta condensé : ordre seq croissant, plus récents retenus, complete=false dès qu\'un événement cède', () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      seq: 2000 + i, type: 'checkpoint', participant_id: 'gpt6', summary: 'x'.repeat(40),
    }));
    const condensed = condenseDelta(events, 1999, 200);
    expect(condensed.total_events).toBe(40);
    expect(condensed.complete).toBe(false);
    expect(condensed.events.length).toBeGreaterThan(0);
    expect(condensed.events.length).toBeLessThan(40);
    expect(condensed.since_seq).toBe(1999);
    const seqs = condensed.events.map(event => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[seqs.length - 1]).toBe(2039); // le plus récent survit toujours
    const full = condenseDelta(events.slice(0, 3), 1999, DOSSIER_DELTA_BUDGET);
    expect(full.complete).toBe(true);
    expect(full.events.map(event => event.seq)).toEqual([2000, 2001, 2002]);
  });

  it('source figée sans contenu refusée : une référence seule viole le mandat A1', () => {
    const base = dossierInput();
    const empty = { ...base, github: { ...github(), sources: [{ ...sources()[0], content_excerpt: '   ' }] } };
    expect(() => buildTaskDossier(empty)).toThrow(DossierSourceError);
    const noPin = { ...base, github: { ...github(), sources: [{ ...sources()[0], sha: '' }] } };
    expect(() => buildTaskDossier(noPin)).toThrow(DossierSourceError);
    const noProvenance = { ...base, github: { ...github(), sources: [{ ...sources()[0], provenance: '' }] } };
    expect(() => buildTaskDossier(noProvenance)).toThrow(DossierSourceError);
  });

  it('budget : refus explicite DOSSIER_BUDGET_TOO_SMALL, jamais de perte silencieuse', () => {
    expect(() => buildTaskDossier({ ...dossierInput(), budgetTokens: 1 })).toThrow(DossierBudgetError);
  });

  it('handovers et prochaines actions bornés, les plus récents retenus', () => {
    const many = {
      ...dossierInput(),
      handovers: Array.from({ length: 15 }, (_, i) => ({
        seq: 100 + i, at: 1794200000 + i, channel: 'chat' as const,
        done: 'd' + i, todo: 't' + i, learned: 'l' + i,
      })),
      nextActions: Array.from({ length: 15 }, (_, i) => 'action ' + i),
    };
    const dossier = buildTaskDossier(many);
    expect(dossier.handovers.length).toBe(10);
    expect(dossier.handovers[9].seq).toBe(114);
    expect(dossier.next_actions.length).toBe(10);
    expect(dossier.next_actions[0]).toBe('action 0');
  });

  it('dossier complet : état GitHub au SHA immuable avec contenu et provenance', () => {
    const dossier = buildTaskDossier(dossierInput());
    expect(dossier.github?.commit_sha).toBe(BASE_SHA);
    expect(dossier.github?.sources[0].content_excerpt).toContain('DEFAULT_PACKET_BUDGET');
    expect(dossier.github?.sources[0].provenance).toContain('raw.githubusercontent.com');
    expect(dossier.role_card.duty).toBe(dutyFor('owner'));
    expect(dossier.budget.estimated_tokens).toBeLessThanOrEqual(dossier.budget.max_tokens);
    expect(dossier.delta.complete).toBe(true);
  });
});

describe('CC-8 S7 A1 — contexte unifié chat/API (chemin logique unique)', () => {
  it('parité : mêmes entrées, dossiers identiques — le canal n\'est qu\'une étiquette', () => {
    const chat = buildUnifiedContext({ channel: 'chat', packet: packet(), dossier: dossierInput() });
    const api = buildUnifiedContext({ channel: 'api', packet: packet(), dossier: dossierInput() });
    expect(unifiedParityViolations(chat, api)).toEqual([]);
    expect(chat.dossier_fingerprint).toBe(api.dossier_fingerprint);
    expect(chat.channel).toBe('chat');
    expect(api.channel).toBe('api');
  });

  it('kind = privilèges, pas contenu : le dossier ignore le task_kind', () => {
    const implement = buildUnifiedContext({ channel: 'chat', packet: packet(), dossier: dossierInput(), task_kind: 'implement' });
    const review = buildUnifiedContext({ channel: 'chat', packet: packet(), dossier: dossierInput(), task_kind: 'review' });
    expect(implement.dossier_fingerprint).toBe(review.dossier_fingerprint);
  });

  it('empreinte stable et sensible au contenu : même dossier, autre contenu', () => {
    const a = buildTaskDossier(dossierInput());
    const b = buildTaskDossier({ ...dossierInput(), participation: 'reviewer' });
    expect(dossierFingerprint(a)).toBe(dossierFingerprint(buildTaskDossier(dossierInput())));
    expect(dossierFingerprint(a)).not.toBe(dossierFingerprint(b));
  });

  it('budget du packet plafonne le dossier : refus explicite si trop petit', () => {
    const small = { ...packet(), budget: { max_tokens: 1, estimated_tokens: 0 } };
    expect(() => buildUnifiedContext({
      channel: 'chat', packet: small, dossier: { ...dossierInput(), budgetTokens: undefined },
    })).toThrow(DossierBudgetError);
  });
});
