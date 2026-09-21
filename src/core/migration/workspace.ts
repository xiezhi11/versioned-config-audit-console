import { canonicalJson, fingerprintJson, stableHash } from './canonical';
import { applyReview, ruleFingerprint } from './engine';
import type {
  ChangeCategory, ChangeRecord, ChangeStatus, HistoryEntry, JsonValue, MigrationAudit,
  MigrationRuleSet, MigrationWorkspace, ReviewState,
} from './types';

export const initialReview = (): ReviewState => ({
  decisions: {},
  manual: {},
  expanded: [],
  filters: { query: '', status: 'all', category: 'all', page: 0, pageSize: 50 },
});

export interface CreateWorkspaceInput {
  input: JsonValue;
  inputText: string;
  dataVersion: string;
  targetVersion: string;
  audit: MigrationAudit;
  rules: MigrationRuleSet;
  by: string;
  at?: string;
}

export function createWorkspace(x: CreateWorkspaceInput): MigrationWorkspace {
  const review = initialReview();
  const at = x.at ?? new Date().toISOString();
  const history: HistoryEntry[] = [{
    id: cryptoId('hist'),
    at, by: x.by, phase: 'preflight', changeIds: x.audit.changes.map((c) => c.id),
    inputFingerprint: fingerprintJson(x.input), ruleFingerprint: x.audit.ruleFingerprint,
    resultFingerprint: fingerprintJson(x.audit.result),
    message: x.audit.ok ? `Preflight migrated ${x.dataVersion} → ${x.targetVersion}.` : (x.audit.reason ?? 'Migration stopped.'),
  }];
  const workspace: MigrationWorkspace = {
    format: 'alertmanager-config-migration-workspace/v1',
    input: x.input, inputText: x.inputText, dataVersion: x.dataVersion, targetVersion: x.targetVersion,
    ruleFingerprint: x.audit.ruleFingerprint, audit: x.audit, review, history,
    summary: '', fingerprint: '',
  };
  workspace.summary = readableSummary(workspace);
  workspace.fingerprint = workspaceFingerprint(workspace);
  return workspace;
}

export type PreflightResult = { ok: true; workspace: MigrationWorkspace } | { ok: false; error: string };

export function importWorkspace(text: string, rules: MigrationRuleSet, now = new Date().toISOString()): PreflightResult {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (e) { return { ok: false, error: `Damaged workspace payload; the previous complete review was kept. JSON: ${(e as Error).message}` }; }
  const ws = parsed as Partial<MigrationWorkspace>;
  if (!ws || ws.format !== 'alertmanager-config-migration-workspace/v1' || !ws.audit || !ws.review) {
    return { ok: false, error: 'Truncated workspace: required migration fields are missing; the previous complete review was kept.' };
  }
  const expectedRules = ruleFingerprint(rules);
  if (ws.ruleFingerprint !== expectedRules || ws.audit.ruleFingerprint !== expectedRules) {
    return { ok: false, error: `Preflight stopped: rule fingerprint ${ws.ruleFingerprint} does not match current rules ${expectedRules}.` };
  }
  if (ws.audit.startVersion !== ws.dataVersion || ws.audit.targetVersion !== ws.targetVersion) {
    return { ok: false, error: 'Preflight stopped: data version and migration chain version do not match.' };
  }
  const fingerprint = ws.fingerprint;
  const restored: MigrationWorkspace = { ...(ws as MigrationWorkspace), fingerprint: '' };
  const actual = workspaceFingerprint(restored);
  if (fingerprint !== actual) return { ok: false, error: `Preflight stopped: workspace fingerprint ${fingerprint} is invalid (expected ${actual}).` };
  restored.history = [...restored.history, makeHistory(restored, 'import', now, 'Workspace imported and fingerprint verified.', [])];
  restored.fingerprint = workspaceFingerprint(restored);
  return { ok: true, workspace: restored };
}

export function decideChange(ws: MigrationWorkspace, changeId: string, decision: 'accepted' | 'rejected', by: string, at = new Date().toISOString()): MigrationWorkspace {
  const next: MigrationWorkspace = structuredClone(ws);
  next.review.decisions[changeId] = { decision, at, by };
  const result = applyReview(next.audit, next.review);
  next.history.push(makeHistory(next, decision === 'accepted' ? 'confirm' : 'reject', at, `${decision} ${changeId}; only the affected branch was recomputed.`, [changeId], result));
  next.fingerprint = workspaceFingerprint(next);
  return next;
}

export function manualChange(ws: MigrationWorkspace, changeId: string, value: JsonValue, by: string, at = new Date().toISOString()): MigrationWorkspace {
  const next: MigrationWorkspace = structuredClone(ws);
  delete next.review.decisions[changeId];
  next.review.manual[changeId] = { value, at, by };
  const result = applyReview(next.audit, next.review);
  next.history.push(makeHistory(next, 'manual', at, `Manual source value recorded for ${changeId}.`, [changeId], result));
  next.fingerprint = workspaceFingerprint(next);
  return next;
}

export function batchAccept(ws: MigrationWorkspace, ids: string[], by: string, at = new Date().toISOString()): MigrationWorkspace {
  const next: MigrationWorkspace = structuredClone(ws);
  const ordered = ids
    .map((id) => next.audit.changes.find((c) => c.id === id))
    .filter((c): c is ChangeRecord => Boolean(c))
    .sort((a, b) => a.order - b.order);
  for (const change of ordered) {
    if (change.status === 'conflict') continue;
    next.review.decisions[change.id] = { decision: 'accepted', at, by };
    next.history.push(makeHistory(next, 'batch-confirm', at, `Batch accepted ${change.id} in rule dependency order.`, [change.id]));
  }
  next.fingerprint = workspaceFingerprint(next);
  return next;
}

export interface ReviewFilters { query?: string; status?: 'all' | ChangeStatus | 'unknown'; category?: 'all' | ChangeCategory; page?: number; pageSize?: number }

export function queryChanges(changes: ChangeRecord[], filters: ReviewFilters): { items: ChangeRecord[]; total: number; pages: number } {
  const q = (filters.query ?? '').trim().toLowerCase();
  const pageSize = filters.pageSize ?? 50;
  const filtered = changes
    .filter((c) => filters.status === 'unknown' ? c.category === 'unknown' : !filters.status || filters.status === 'all' || c.status === filters.status)
    .filter((c) => !filters.category || filters.category === 'all' || c.category === filters.category)
    .filter((c) => !q || [c.id, c.path, c.ruleId, c.opId, c.reason].join(' ').toLowerCase().includes(q))
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(filters.page ?? 0, pages - 1);
  return { items: filtered.slice(page * pageSize, (page + 1) * pageSize), total: filtered.length, pages };
}

export function unresolvedCount(audit: MigrationAudit, review: ReviewState): number {
  return audit.changes.filter((c) => c.status === 'pending' && !review.decisions[c.id] && !review.manual[c.id]).length;
}

export function serializeWorkspace(ws: MigrationWorkspace): string { return JSON.stringify(ws, null, 2); }

function workspaceFingerprint(ws: MigrationWorkspace): string {
  const { fingerprint, ...rest } = ws;
  return stableHash(canonicalJson(rest as unknown as JsonValue));
}
function readableSummary(ws: MigrationWorkspace): string {
  const pending = ws.audit.changes.filter((c) => c.status === 'pending').length;
  const conflicts = ws.audit.conflicts.length;
  return `Config migration ${ws.dataVersion} → ${ws.targetVersion}; path: ${ws.audit.path.map((p) => `${p.from}→${p.to}`).join(', ')}; changes: ${ws.audit.changes.length}; pending: ${pending}; conflicts: ${conflicts}; unknown: ${ws.audit.unknownPaths.length}.`;
}
function makeHistory(ws: MigrationWorkspace, phase: HistoryEntry['phase'], at: string, message: string, changeIds: string[], result?: JsonValue): HistoryEntry {
  return {
    id: cryptoId('hist'), at, by: currentActor(ws), phase, changeIds,
    inputFingerprint: fingerprintJson(ws.input), ruleFingerprint: ws.ruleFingerprint,
    ...(result !== undefined ? { resultFingerprint: fingerprintJson(result) } : {}), message,
  };
}
function currentActor(ws: MigrationWorkspace): string { return ws.history.at(-1)?.by ?? 'unknown'; }
function cryptoId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
