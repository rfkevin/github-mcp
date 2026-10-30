/**
 * CC-7 M1b — inventaire mémoire ré-exécutable (correctif de la revue GPT-6,
 * PR #236 / commentaire 6523145152 : « livrer le composant ré-exécutable »).
 *
 * Deux outils, toujours enregistrés (aucune porte — lecture seule / calcul pur) :
 * - collab_memory_inventory : lecture du D1 — entrées memory_entries versionnées
 *   de tous statuts avec leur coût PERSISTÉ token_cost (posé dès la proposition
 *   par insertCandidate, migration 0003 — l'inventaire ne le recalcule jamais),
 *   pagination keyset (scope, id, version), rollup par scope (budget
 *   MEMORY_TOKEN_BUDGETS, comptes par statut, tokens actifs, baseline /
 *   occurrences / pause de quota_counters) et pauses du cycle memory-alarms
 *   reliées aux événements correctifs memory.consolidate / memory.retire de
 *   leur fenêtre [ouverture, décision ou maintenant] (ouverture départagée
 *   par seq du journal).
 *   CR-C : un participant ne voit que les scopes partagés et SES scopes
 *   participant (familles logiques comprises, #126) ; un client non
 *   enregistré ne voit que les scopes partagés — jamais le contenu, ni même un
 *   agrégat, d'un scope privé tiers (MEMORY_SCOPE_FORBIDDEN).
 * - collab_memory_growth_simulate : calcul pur, zéro lecture du store — les
 *   simulations de seuils du rapport M1b redeviennent exécutables par
 *   quiconque : mêmes entrées, mêmes positions (règle C4, marge candidate k,
 *   reprise simulée immédiate base ← n, remplissage de budget à coût moyen).
 *
 * Aucun seuil, aucune baseline, aucune entrée n'est modifié ici : le rapport
 * M1b reste le relevé initial, ces outils en sont la relecture outillée.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { outputSchemas } from './schemas';
import { collabSuccess, collabFailure } from './result';
import { ensureSchema } from '../store/schema';
import { equivalentParticipantIds } from '../identity/families';
import { GROWTH_ALARM_PERCENT, MEMORY_TOKEN_BUDGETS, MemoryStoreError } from '../memory/memory-store';
import { MEMORY_ALARM_CYCLE, baselineKey, occurrenceKey, pauseKey } from '../memory/pause-resume';
import { scopeFamily } from '../contracts/memory';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Bornes de lecture : diagonale bornée, jamais une table entière dévidée. */
const MAX_SCOPES = 50;
const MAX_PAUSES = 10;
const MAX_CORRECTIVE = 10;
/** Filet de sécurité des demandes de pause lues (les occurrences récentes d'abord). */
const MAX_PAUSE_ROWS = 1000;

/** Position de pagination keyset : ordre (scope, id, version). */
interface CursorPosition {
  scope: string;
  id: string;
  version: number;
}

interface InventoryEntryRow {
  id: string;
  version: number;
  scope: string;
  kind: string;
  status: string;
  confidence: string;
  token_cost: number;
  author_pid: string;
  reviewer_pid: string;
  supersedes: string | null;
  expires_rev: number | null;
}

interface ScopeRollupRow {
  scope: string;
  candidate: number;
  active: number;
  superseded: number;
  retired: number;
  tokens_active: number;
}

interface PauseRequestRow {
  seq: number;
  at: number;
  scope: string;
  request_id: string;
  occurrence: number;
  reason: string;
}

interface CorrectiveEventRow {
  seq: number;
  at: number;
  type: string;
  cycle_id: string;
  mid: string;
}

interface InventoryInput {
  scopes?: string[];
  status?: 'candidate' | 'active' | 'superseded' | 'retired';
  limit: number;
  cursor?: string;
}

/** Numérote les paramètres SQL au fil des binds, dans l'ordre d'écriture du fragment. */
function binder() {
  const values: unknown[] = [];
  return {
    values,
    sql(fragment: string, ...bound: unknown[]): string {
      let i = 0;
      return fragment.replace(/\?/g, () => '?' + values.push(bound[i++]));
    },
  };
}

/** Décode un curseur base64 [scope, id, version] ; illisible → MEMORY_CURSOR_INVALID (fail-closed). */
function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(atob(cursor));
  } catch {
    // atob / JSON.parse ont échoué : refus typé ci-dessous, jamais une page devinée.
  }
  if (Array.isArray(parsed) && parsed.length === 3 && typeof parsed[0] === 'string' && parsed[0] !== ''
    && typeof parsed[1] === 'string' && parsed[1] !== '' && typeof parsed[2] === 'number'
    && Number.isInteger(parsed[2]) && parsed[2] >= 0) {
    return { scope: parsed[0], id: parsed[1], version: parsed[2] };
  }
  throw new MemoryStoreError(
    'MEMORY_CURSOR_INVALID',
    'Curseur de pagination illisible : reprenez depuis next_cursor du dernier appel, ou repartez sans curseur.',
  );
}

/**
 * Positions de pause de la simulation : pause à n dès que
 * 100 * (n − base) > max(percent * base, 100 * k) ; la reprise simulée est
 * immédiate (base ← n), comme l'approbation owner qui prend la taille
 * approuvée comme nouvelle base de croissance. La marge k reste une règle
 * candidate M1a : aucun seuil réel ne bouge ici.
 */
export function simulateGrowthPauses(base: number, activations: number, k: number, percent = GROWTH_ALARM_PERCENT): number[] {
  const pauses: number[] = [];
  let reference = base;
  for (let step = 1; step <= activations; step += 1) {
    const size = base + step;
    if (100 * (size - reference) > Math.max(percent * reference, 100 * k)) {
      pauses.push(size);
      reference = size;
    }
  }
  return pauses;
}

/**
 * Projection de remplissage de budget à coût moyen constant : activations
 * acceptées avant le premier refus (rang refusé compris) et total alors atteint.
 * Fail-closed : un coût moyen nul ne produit JAMAIS de refus — la boucle serait
 * infinie tant que tokensUsed <= budget. Refus typé, jamais un appel bloquant.
 */
export function simulateBudgetFill(tokensUsed: number, avgCost: number, budget: number): { accepted: number; refused: number; tokens_after: number } {
  if (!(avgCost > 0)) {
    throw new MemoryStoreError(
      'MEMORY_SIMULATION_INVALID',
      'collab_memory_growth_simulate: avg_cost doit être > 0 — un coût moyen nul ne produit jamais de refus de budget.',
    );
  }
  let accepted = 0;
  while (tokensUsed + (accepted + 1) * avgCost <= budget) accepted += 1;
  return { accepted, refused: accepted + 1, tokens_after: tokensUsed + accepted * avgCost };
}

async function memoryInventory(context: CollabToolContext, input: InventoryInput): Promise<Record<string, unknown>> {
  await ensureSchema(context.db);
  const identity = await context.identity();
  const nowAt = Math.floor(Date.now() / 1000);
  // CR-C : seuls les scopes partagés et les scopes participant de SA famille
  // logique sont visibles ; un client non enregistré n'en détient aucun.
  const ownScopes = identity.status === 'registered'
    ? (await equivalentParticipantIds(context.db, identity.participant_id)).map(pid => 'participant:' + pid)
    : [];
  const allowed = (scope: string): boolean => !scope.startsWith('participant:') || ownScopes.includes(scope);
  const forbidden = (scope: string): MemoryStoreError => new MemoryStoreError(
    'MEMORY_SCOPE_FORBIDDEN',
    'collab_memory_inventory: participant scope ' + scope + ' belongs to another logical identity (CR-C).',
  );
  if (input.scopes) {
    for (const scope of input.scopes) {
      if (!allowed(scope)) throw forbidden(scope);
    }
  }
  const cursor: CursorPosition = input.cursor ? decodeCursor(input.cursor) : { scope: '', id: '', version: 0 };
  if (input.cursor && !allowed(cursor.scope)) throw forbidden(cursor.scope);

  // Prédicat de scopes : filtre explicite OU tout scope autorisé (CR-C).
  const scopePredicate = (b: ReturnType<typeof binder>): string => {
    if (input.scopes) {
      return b.sql('scope IN (' + input.scopes.map(() => '?').join(', ') + ')', ...input.scopes);
    }
    return b.sql('(scope NOT LIKE ?' + (ownScopes.length > 0 ? ' OR scope IN (' + ownScopes.map(() => '?').join(', ') + ')' : '') + ')',
      'participant:%', ...ownScopes);
  };

  // Page d'entrées : keyset (scope, id, version) — jamais OFFSET, jamais de
  // recalcul de coût : token_cost est le coût persisté (migration 0003).
  const pageQuery = binder();
  const entrySql = [
    'SELECT id, version, scope, kind, status, confidence,',
    '  COALESCE(token_cost, (length(text) + 3) / 4) AS token_cost, author_pid, reviewer_pid, supersedes, expires_rev',
    'FROM memory_entries WHERE',
    pageQuery.sql('(scope > ? OR (scope = ? AND (id > ? OR (id = ? AND version > ?))))',
      cursor.scope, cursor.scope, cursor.id, cursor.id, cursor.version),
    'AND', scopePredicate(pageQuery),
  ];
  if (input.status) entrySql.push(pageQuery.sql('AND status = ?', input.status));
  entrySql.push('ORDER BY scope, id, version', pageQuery.sql('LIMIT ?', input.limit + 1));
  const entryRows = await context.db.prepare(entrySql.join(' ')).bind(...pageQuery.values).all<InventoryEntryRow>();
  const fetched = entryRows.results ?? [];
  const hasMore = fetched.length > input.limit;
  const entries = (hasMore ? fetched.slice(0, input.limit) : fetched).map(row => ({
    id: row.id,
    version: row.version,
    scope: row.scope,
    kind: row.kind,
    status: row.status,
    confidence: row.confidence,
    token_cost: row.token_cost,
    author_pid: row.author_pid,
    reviewer_pid: row.reviewer_pid,
    supersedes: row.supersedes,
    expires_rev: row.expires_rev,
  }));
  const last = entries[entries.length - 1];
  const nextCursor = hasMore && last ? btoa(JSON.stringify([last.scope, last.id, last.version])) : undefined;

  // Rollup par scope : comptes par statut et tokens actifs mesurés sur le D1
  // (même mesure COALESCE que la garde transactionnelle A03).
  const rollupQuery = binder();
  const rollupSql = [
    'SELECT scope,',
    "  SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate,",
    "  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,",
    "  SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded,",
    "  SUM(CASE WHEN status = 'retired' THEN 1 ELSE 0 END) AS retired,",
    "  SUM(CASE WHEN status = 'active' THEN COALESCE(token_cost, (length(text) + 3) / 4) ELSE 0 END) AS tokens_active",
    'FROM memory_entries WHERE', scopePredicate(rollupQuery),
    'GROUP BY scope ORDER BY scope',
  ].join(' ');
  const rollupRows = await context.db.prepare(rollupSql).bind(...rollupQuery.values).all<ScopeRollupRow>();
  const allScopes = rollupRows.results ?? [];
  const scopesTruncated = allScopes.length > MAX_SCOPES;
  const keptScopes = allScopes.slice(0, MAX_SCOPES);

  // Compteurs CR-F02 : pause, occurrences, baseline de croissance.
  const counters = new Map<string, number>();
  const counterRows = await context.db.prepare(
    "SELECT day, writes FROM quota_counters WHERE day LIKE 'mem:pause:%' OR day LIKE 'mem:base:%' OR day LIKE 'mem:occ:%'",
  ).all<{ day: string; writes: number }>();
  for (const row of counterRows.results ?? []) counters.set(row.day, row.writes);

  // Pauses du cycle memory-alarms des scopes inventoriés — fail-closed sur les
  // types extraits (kind/scope/request_id textuels, occurrence entière).
  const pausesByScope = new Map<string, PauseRequestRow[]>();
  if (keptScopes.length > 0) {
    const pauseQuery = binder();
    const pauseSql = [
      'SELECT seq, at, json_extract(payload_json, \'$.scope\') AS scope,',
      "  json_extract(payload_json, '$.request_id') AS request_id,",
      "  json_extract(payload_json, '$.occurrence') AS occurrence,",
      "  json_extract(payload_json, '$.reason') AS reason",
      'FROM events WHERE',
      pauseQuery.sql('cycle_id = ? AND type = ?', MEMORY_ALARM_CYCLE, 'owner.request'),
      "AND json_type(payload_json, '$.kind') = 'text' AND json_extract(payload_json, '$.kind') = 'memory.pause'",
      "AND json_type(payload_json, '$.scope') = 'text' AND json_type(payload_json, '$.occurrence') = 'integer'",
      "AND json_type(payload_json, '$.request_id') = 'text'",
      pauseQuery.sql("AND json_extract(payload_json, '$.scope') IN (" + keptScopes.map(() => '?').join(', ') + ')',
        ...keptScopes.map(row => row.scope)),
      'ORDER BY seq DESC', pauseQuery.sql('LIMIT ?', MAX_PAUSE_ROWS),
    ].join(' ');
    const pauseRows = await context.db.prepare(pauseSql).bind(...pauseQuery.values).all<PauseRequestRow>();
    for (const row of pauseRows.results ?? []) {
      const list = pausesByScope.get(row.scope) ?? [];
      if (list.length < MAX_PAUSES) list.push(row);
      pausesByScope.set(row.scope, list);
    }
  }

  const emittedPauses = keptScopes.flatMap(row => pausesByScope.get(row.scope) ?? []);
  const decisions = new Map<string, { decision: string; at: number }>();
  const correctiveByScope = new Map<string, CorrectiveEventRow[]>();
  if (emittedPauses.length > 0) {
    const requestIds = [...new Set(emittedPauses.map(row => row.request_id))];
    const decisionQuery = binder();
    const decisionRows = await context.db.prepare(
      decisionQuery.sql('SELECT request_id, decision, at FROM owner_decisions WHERE request_id IN ('
        + requestIds.map(() => '?').join(', ') + ')', ...requestIds),
    ).bind(...decisionQuery.values).all<{ request_id: string; decision: string; at: number }>();
    for (const row of decisionRows.results ?? []) decisions.set(row.request_id, { decision: row.decision, at: row.at });

    // Fenêtre couverte : de l'ouverture la plus ancienne des pauses émises à
    // maintenant ; la fenêtre propre de chaque pause est resserrée en JS.
    const windowStart = Math.min(...emittedPauses.map(row => row.at));
    // CR-D : un id mémoire n'a qu'un scope, immuable sur toutes ses versions —
    // la résolution id → scope des événements correctifs ne peut pas se tromper.
    const mapQuery = binder();
    const idRows = await context.db.prepare(
      mapQuery.sql('SELECT DISTINCT id, scope FROM memory_entries WHERE scope IN ('
        + keptScopes.map(() => '?').join(', ') + ')', ...keptScopes.map(row => row.scope)),
    ).bind(...mapQuery.values).all<{ id: string; scope: string }>();
    const scopeOfId = new Map<string, string>();
    for (const row of idRows.results ?? []) if (!scopeOfId.has(row.id)) scopeOfId.set(row.id, row.scope);
    const correctiveQuery = binder();
    const correctiveRows = await context.db.prepare(
      correctiveQuery.sql('SELECT seq, at, type, cycle_id, json_extract(payload_json, \'$.memory.id\') AS mid'
        + " FROM events WHERE type IN ('memory.consolidate', 'memory.retire') AND at >= ? AND at <= ? ORDER BY seq",
        windowStart, nowAt),
    ).bind(...correctiveQuery.values).all<{ seq: number; at: number; type: string; cycle_id: string; mid: string | null }>();
    for (const row of correctiveRows.results ?? []) {
      // fail-closed : un id non textuel, inconnu ou hors des scopes inventoriés est ignoré.
      if (typeof row.mid !== 'string') continue;
      const scope = scopeOfId.get(row.mid);
      if (!scope) continue;
      const list = correctiveByScope.get(scope) ?? [];
      list.push({ seq: row.seq, at: row.at, type: row.type, cycle_id: row.cycle_id, mid: row.mid });
      correctiveByScope.set(scope, list);
    }
  }

  const scopes = keptScopes.map(row => {
    const family = scopeFamily(row.scope);
    const pauses = (pausesByScope.get(row.scope) ?? []).map(pause => {
      const decision = decisions.get(pause.request_id) ?? null;
      const decidedAt = decision ? decision.at : null;
      const windowEnd = decidedAt ?? nowAt;
      const corrective: Array<{ seq: number; at: number; type: string; cycle_id: string; id: string }> = [];
      let truncated = false;
      // Borne d'ouverture par seq : l'horloge à la seconde ne départage pas
      // deux événements de la même seconde — une consolidation posée AVANT
      // l'ouverture ne doit jamais tomber dans la fenêtre.
      for (const event of correctiveByScope.get(row.scope) ?? []) {
        if (event.seq <= pause.seq || event.at > windowEnd) continue;
        if (corrective.length >= MAX_CORRECTIVE) {
          truncated = true;
          break;
        }
        corrective.push({ seq: event.seq, at: event.at, type: event.type, cycle_id: event.cycle_id, id: event.mid });
      }
      return {
        occurrence: pause.occurrence,
        reason: pause.reason,
        request_id: pause.request_id,
        opened_seq: pause.seq,
        opened_at: pause.at,
        decision: decision ? decision.decision : null,
        decided_at: decidedAt,
        open: !decision || decision.decision !== 'approve',
        corrective_events: corrective,
        corrective_truncated: truncated,
      };
    });
    return {
      scope: row.scope,
      family,
      budget: MEMORY_TOKEN_BUDGETS[family] ?? 500,
      tokens_active: row.tokens_active,
      counts: { candidate: row.candidate, active: row.active, superseded: row.superseded, retired: row.retired },
      baseline: counters.get(baselineKey(row.scope)) ?? 0,
      occurrences: counters.get(occurrenceKey(row.scope)) ?? 0,
      paused: (counters.get(pauseKey(row.scope)) ?? 0) > 0,
      pauses,
    };
  });

  return {
    viewer: { participant_id: identity.participant_id, status: identity.status },
    entries,
    has_more: hasMore,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    scopes,
    scopes_truncated: scopesTruncated,
  };
}

export function registerMemoryTools(server: McpServer, context: CollabToolContext): void {
  server.registerTool('collab_memory_inventory', {
    title: 'Inventaire mémoire ré-exécutable (CC-7 M1b)',
    description: 'Lecture seule du D1 : entrées memory_entries versionnées (tous statuts) avec leur coût PERSISTÉ token_cost — posé dès la proposition (migration 0003), jamais recalculé ici. Pagination keyset (cursor = base64 [scope, id, version] = position dans l’ordre global, ordre scope/id/version, limit 1-200, défaut 50 ; les filtres scopes/status s’appliquent à chaque appel, indépendamment du curseur — le scope du curseur reste soumis à CR-C) ; rollup par scope (budget MEMORY_TOKEN_BUDGETS, comptes par statut, tokens actifs, baseline/occurrences/pause) ; pauses du cycle memory-alarms avec décision owner et événements correctifs memory.consolidate/memory.retire de la fenêtre [ouverture, décision ou maintenant]. CR-C : scopes partagés + vos scopes participant (familles logiques) ; participant:<autre> → MEMORY_SCOPE_FORBIDDEN ; client non enregistré = partagés seulement — jamais le contenu ni l\'agrégat d\'un scope privé tiers. Curseur illisible → MEMORY_CURSOR_INVALID.',
    inputSchema: {
      scopes: z.array(z.string().min(1).max(256)).min(1).max(MAX_SCOPES).optional(),
      status: z.enum(['candidate', 'active', 'superseded', 'retired']).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().min(1).max(4096).optional(),
    },
    outputSchema: outputSchemas.collab_memory_inventory,
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      return collabSuccess(await memoryInventory(context, input));
    } catch (error) {
      return collabFailure(error, 'Inventaire mémoire indisponible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_memory_growth_simulate', {
    title: 'Simulation des seuils de pause mémoire (CC-7 M1b)',
    description: 'Calcul pur — zéro lecture, zéro écriture du store. Rend les simulations du rapport M1b ré-exécutables : pour chaque marge candidate k, positions de pause selon 100·(n−base) > max(GROWTH_ALARM_PERCENT·base, 100·k) avec reprise simulée immédiate (base ← n) ; projection de remplissage de budget à coût moyen constant (rang de la première activation refusée ; avg_cost > 0 exigé : un coût moyen nul ne produit jamais de refus — refus typé MEMORY_SIMULATION_INVALID). Défauts : base 2, activations 40, k 0/3/5/8/10, sans budget. La règle candidate k reste une proposition M1a : aucun seuil réel n\'est changé par cet outil.',
    inputSchema: {
      base: z.number().int().min(0).max(10_000).default(2),
      activations: z.number().int().min(1).max(10_000).default(40),
      k_values: z.array(z.number().int().min(0).max(10_000)).min(1).max(20).default([0, 3, 5, 8, 10]),
      budget: z.object({
        tokens_used: z.number().min(0).max(100_000_000),
        avg_cost: z.number().min(0).max(10_000_000),
        budget: z.number().min(0).max(100_000_000),
      }).optional(),
    },
    outputSchema: outputSchemas.collab_memory_growth_simulate,
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const growth = input.k_values.map(k => ({ k, pauses: simulateGrowthPauses(input.base, input.activations, k) }));
      const budget = input.budget
        ? {
          tokens_used: input.budget.tokens_used,
          avg_cost: input.budget.avg_cost,
          budget: input.budget.budget,
          ...simulateBudgetFill(input.budget.tokens_used, input.budget.avg_cost, input.budget.budget),
        }
        : undefined;
      return collabSuccess({
        rule: {
          growth_alarm_percent: GROWTH_ALARM_PERCENT,
          pause_condition: 'pause à n dès que 100·(n−base) > max(' + GROWTH_ALARM_PERCENT + '·base, 100·k)',
          resume: 'reprise simulée immédiate : base ← n',
        },
        growth,
        ...(budget ? { budget } : {}),
      });
    } catch (error) {
      return collabFailure(error, 'Simulation des seuils indisponible.', {}, context.fallback);
    }
  });
}
