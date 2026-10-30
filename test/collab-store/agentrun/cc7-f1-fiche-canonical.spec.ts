import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import ficheRaw from '../../../config/agents.fiche.json?raw';
import generatedRaw from '../../../src/collab-store/agentrun/generated/agent-fiche.generated.ts?raw';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import { createRoutedModel, type ProviderModelContext } from '../../../src/collab-store/agentrun';
import { participantModelVar } from '../../../src/collab-store/agentrun/provider-models';
import {
  deriveAgentRunVars, ficheAliases, ficheStamp, fnv1a64, parseFiche, participantSuffix, renderGeneratedArtifact,
} from '../../../src/collab-store/agentrun/fiche';
import { AGENT_RUN_VARS, FICHE_HASH, FICHE_RAW, FICHE_VERSION } from '../../../src/collab-store/agentrun/generated/agent-fiche.generated';
import { MODEL_FAMILIES, familyOf, participantPolicy, type PolicyEnv } from '../../../src/collab-store/agentrun/model-policy';
import { fetchStub, freshRun } from './cc7-l2-paid-harness';

// CC-7 F1 — fiche canonique unique par agent (P3 #1138 §1, rôles ratifiés #1139) : la source des
// DÉFINITIONS est config/agents.fiche.json. Ce test fait échouer la CI si la fiche, l'artefact
// généré ou les variables AGENT_RUN_* de wrangler.jsonc (env cc3-test) divergent (fail-on-diff
// byte-exact). Le runtime, lui, continue de lire les variables d'environnement : migration en
// lecture parallèle, sans changement de comportement.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const wrangler = JSON.parse(wranglerRaw) as { env: Record<string, { vars: Record<string, string> }> };
const cc3Vars = wrangler.env['cc3-test'].vars;
const fiche = parseFiche(ficheRaw);
const derived = deriveAgentRunVars(fiche);
// Toute variable de DÉFINITION de modèles doit venir de la fiche ; les budgets (AGENT_RUN_PAID_*),
// attestations et secrets restent des réglages owner, hors de ce contrôle.
const MODEL_DEFINITION_RE = /^AGENT_RUN_(PARTICIPANTS|MODEL|MODELS|FAMILY)(_|$)/;

describe('CC-7 F1 — fiche canonique et artefact généré', () => {
  it('fiche valide ; version et empreinte portées par l’artefact (fail-on-diff fiche → artefact)', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64(ficheRaw)).toBe(FICHE_HASH);
    expect(fiche.version).toBe(FICHE_VERSION);
    expect(FICHE_RAW).toBe(ficheRaw);
  });

  it('l’artefact est l’exact rendu déterministe de la fiche (aucune édition manuelle possible)', () => {
    expect(renderGeneratedArtifact(fiche, ficheRaw)).toBe(generatedRaw);
    expect(AGENT_RUN_VARS).toEqual(deriveAgentRunVars(fiche));
  });

  it('wrangler cc3-test : les variables de définition de modèles sont EXACTEMENT celles dérivées de la fiche', () => {
    const present = Object.keys(cc3Vars).filter(key => MODEL_DEFINITION_RE.test(key)).sort();
    expect(present).toEqual(Object.keys(derived).sort());
    for (const key of present) expect(cc3Vars[key], key).toBe(derived[key]);
  });

  it('les suffixes de la fiche suivent la même règle que le runtime (participantModelVar)', () => {
    for (const agent of fiche.agents) {
      expect(participantSuffix(agent.participant_id)).toBe(participantModelVar(agent.participant_id).slice('AGENT_RUN_MODEL_'.length));
    }
  });

  it('lecture parallèle : chaque agent de la fiche retrouve SA politique depuis les variables wrangler, aucun modèle écarté', () => {
    const CC3_TEST: PolicyEnv = { ...cc3Vars, AI: {} } as PolicyEnv;
    for (const agent of fiche.agents) {
      expect(MODEL_FAMILIES as readonly string[]).toContain(agent.family);
      const policy = participantPolicy(CC3_TEST, agent.participant_id);
      expect(policy, agent.id).not.toBeNull();
      expect(policy!.family).toBe(agent.family);
      expect(policy!.models).toEqual(agent.models.map(model => model.ref));
      expect(policy!.rejected).toEqual([]);
      for (const model of agent.models) expect(familyOf(model.ref), agent.id + ' ' + model.ref).toBe(agent.family);
    }
  });

  it('gpt (logique) : variables préparées par la fiche, hors AGENT_RUN_PARTICIPANTS tant que actif = false', () => {
    const gpt = fiche.agents.find(agent => agent.id === 'gpt')!;
    expect(gpt.participant_id).toBe('gpt6');
    expect(gpt.active).toBe(false);
    expect(derived['AGENT_RUN_PARTICIPANTS'].split(',')).toEqual(['claude', 'grok', 'vibe', 'gemini']);
  });

  it('alias ep-* : immuables, cibles épinglées dans les modèles de leur agent ; nom stable réservé pour le 3.8', () => {
    const aliases = ficheAliases(fiche);
    const byId = new Map(aliases.map(alias => [alias.endpoint_id, alias]));
    expect(byId.get('ep-gemini-35-flash-lite')?.ref).toBe('gemini:gemini-3.5-flash-lite'); // historique, inscrit owner (avis relayés #1131/#1134/#1151)
    expect(byId.get('ep-gemini-flash')?.ref).toBe('gemini:gemini-3.8-flash'); // nom stable F1, inscription owner à venir (#1154)
    for (const alias of aliases) {
      const agent = fiche.agents.find(candidate => candidate.id === alias.agent_id)!;
      expect(agent.models.map(model => model.ref), alias.endpoint_id).toContain(alias.ref);
    }
  });

  it('aucun secret, budget ni attestation dans la fiche (D1 : overrides opérationnels seulement, hors fiche)', () => {
    expect(ficheRaw).not.toMatch(/LLM_KEY|SECRET|_CENTS|ATTESTED|API_KEY/i);
  });

  it('chaque choix serveur journalise le tampon version + hash de la fiche (P3 #1138 §1)', async () => {
    expect(ficheStamp(FICHE_VERSION, FICHE_HASH)).toBe(' ; fiche v' + FICHE_VERSION + ' ' + FICHE_HASH);
    const CLAUDE: PolicyEnv = {
      AGENT_RUN_FAMILY_CLAUDE: 'anthropic',
      AGENT_RUN_MODELS_CLAUDE: 'anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5',
      AGENT_RUN_PAID_DAY_CENTS_CLAUDE: '100',
      AGENT_RUN_PAID_CYCLE_CENTS_CLAUDE: '1000',
      LLM_KEY_ANTHROPIC: 'k',
    } as PolicyEnv;
    const run = await freshRun(db, 'f1', 1_979_500_000, 10_000, 'claude');
    const stub = fetchStub([{ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 10 } }]);
    const ctx: ProviderModelContext = {
      env: CLAUDE, db, runId: run.runId, envelope: { dayCents: 100, cycleCents: 1_000, dayTokens: 0, dayRequests: 0 },
      schemas: () => [], system: 'S', maxOutputTokens: 4_096, fetchImpl: stub.fetchImpl, now: () => new Date('2032-10-01T10:00:00Z'),
    };
    const model = createRoutedModel(CLAUDE, ctx);
    const first = await model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'review' });
    expect(first.output.text).toBe('ok');
    const choice = await db.prepare('SELECT reason FROM agent_model_choices WHERE run_id = ?1 AND n = 0').bind(run.runId).first<{ reason: string }>();
    expect(choice!.reason).toContain('défaut : le plus fort abordable');
    expect(choice!.reason).toMatch(new RegExp(' ; fiche v' + FICHE_VERSION + ' ' + FICHE_HASH + '$'));
  });
});
