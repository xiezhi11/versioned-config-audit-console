import { useEffect, useMemo, useState } from 'react';
import { load as loadYaml } from 'js-yaml';
import {
  affectedChangeIds, batchAccept, createWorkspace, decideChange, importWorkspace, manualChange,
  migrateStructured, parseStructured, queryChanges, serializeWorkspace,
  type ChangeRecord, type MigrationRuleSet, type MigrationWorkspace, type ReviewFilters,
} from '../core/migration';
import { useT } from '../i18n/react';

const STORAGE_KEY = 'am-editor-migration-workspace-v1';

const SAMPLE_CONFIG = 'version: "1"\nname: payments\nowner: platform/sre\nlegacyTimeout: "30s"\n';
const SAMPLE_RULES: MigrationRuleSet = { rules: [
  { id: 'v1-v2', fromVersion: '1', toVersion: '2', knownPaths: ['version', 'name', 'meta.owner', 'options.timeoutMs'], ops: [
    { id: 'owner', type: 'rename', from: 'owner', to: 'meta.owner' },
    { id: 'timeout', type: 'set', path: 'options.timeoutMs', value: 30000, when: { path: 'legacyTimeout', equals: '30s' } },
    { id: 'default-timeout', type: 'default', path: 'options.timeoutMs', value: 1000 },
  ] },
  { id: 'v2-v3', fromVersion: '2', toVersion: '3', knownPaths: ['version', 'name', 'meta.owner', 'meta.team', 'options.timeoutMs', 'options.enabled'], ops: [
    { id: 'split-owner', type: 'split', from: 'meta.owner', targets: [{ path: 'meta.owner', part: 0 }, { path: 'meta.team', part: 1 }], separator: '/' },
    { id: 'enable-team', type: 'custom', transform: 'has-value', reads: ['meta.team'], writes: ['options.enabled'] },
  ] },
  { id: 'v1-v3', fromVersion: '1', toVersion: '3', knownPaths: ['version'], ops: [{ id: 'direct-locked', type: 'set', path: 'options.enabled', value: true }] },
] };

const transforms = { 'has-value': (input: Record<string, unknown>) => ({ 'options.enabled': Boolean(input['meta.team']) }) };

export function MigrationWorkbench({ onExit }: { onExit: () => void }): React.JSX.Element {
  const t = useT();
  const [configText, setConfigText] = useState(SAMPLE_CONFIG);
  const [rulesText, setRulesText] = useState(() => JSON.stringify(SAMPLE_RULES, null, 2));
  const [dataVersion, setDataVersion] = useState('1');
  const [targetVersion, setTargetVersion] = useState('3');
  const [actor, setActor] = useState(() => (globalThis.navigator?.userAgent.includes('Headless') ? 'operator' : 'operator'));
  const [workspace, setWorkspace] = useState<MigrationWorkspace | null>(() => loadStored());
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReviewFilters>(workspace?.review.filters ?? { query: '', status: 'all', category: 'all', page: 0, pageSize: 20 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set(workspace?.review.expanded ?? []));
  const [manualValue, setManualValue] = useState<Record<string, string>>({});

  useEffect(() => { if (workspace) localStorage.setItem(STORAGE_KEY, serializeWorkspace(workspace)); }, [workspace]);
  useEffect(() => {
    if (workspace) {
      const safeFilters = { query: '', status: 'all' as const, category: 'all' as const, page: 0, pageSize: 20, ...filters };
      localStorage.setItem(STORAGE_KEY, serializeWorkspace({ ...workspace, review: { ...workspace.review, filters: safeFilters } }));
    }
  }, [filters, workspace]);
  const parsed = useMemo(() => parseStructured(configText, 100), [configText]);
  const rules = useMemo((): MigrationRuleSet | null => {
    try { const value = loadYaml(rulesText) as MigrationRuleSet; return Array.isArray(value.rules) ? value : null; } catch { return null; }
  }, [rulesText]);
  const activeFilters: Required<ReviewFilters> = { query: '', status: 'all', category: 'all', page: 0, pageSize: 20, ...filters };
  const page = useMemo(() => workspace ? queryChanges(workspace.audit.changes, activeFilters) : { items: [], total: 0, pages: 1 }, [workspace, activeFilters]);

  const runPreflight = (): void => {
    if (!parsed.ok || !parsed.root) { setError(parsed.issues[0]?.message ?? t.migration.parseFailed); return; }
    if (!rules) { setError(t.migration.badRules); return; }
    try {
      const audit = migrateStructured(parsed.root.value, dataVersion, targetVersion, rules, transforms);
      const next = createWorkspace({ input: parsed.root.value, inputText: configText, dataVersion, targetVersion, audit, rules, by: actor || 'operator' });
      setWorkspace(next); setError(audit.ok ? null : audit.reason ?? t.migration.stopped);
    } catch (e) { setError(`${t.migration.stopped} ${(e as Error).message}`); }
  };
  useEffect(() => {
    if (!workspace && new URLSearchParams(window.location.search).has('autoPreflight')) runPreflight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = (next: MigrationWorkspace): void => { setWorkspace(next); localStorage.setItem(STORAGE_KEY, serializeWorkspace(next)); };
  const download = (): void => {
    if (!workspace) return;
    const blob = new Blob([serializeWorkspace(workspace)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'migration-review.json'; a.click(); URL.revokeObjectURL(a.href);
  };
  const importFile = async (file: File): Promise<void> => {
    if (!rules) { setError(t.migration.badRules); return; }
    const text = await file.text();
    const result = importWorkspace(text, rules);
    if (!result.ok) { setError(result.error); return; }
    setError(null); update(result.workspace); setConfigText(result.workspace.inputText); setDataVersion(result.workspace.dataVersion); setTargetVersion(result.workspace.targetVersion);
  };

  return <div className="migration-page">
    <div className="migration-head"><div><h2>{t.migration.title}</h2><p>{t.migration.intro}</p></div><button className="btn" onClick={onExit}>{t.migration.back}</button></div>
    {error && <div className="load-error">{error}</div>}
    {!workspace ? <div className="migration-setup">
      <label>{t.migration.config}<textarea value={configText} onChange={(e) => setConfigText(e.target.value)} spellCheck={false} /></label>
      <label>{t.migration.rules}<textarea value={rulesText} onChange={(e) => setRulesText(e.target.value)} spellCheck={false} /></label>
      <div className="migration-form">
        <label>{t.migration.from}<input value={dataVersion} onChange={(e) => setDataVersion(e.target.value)} /></label>
        <label>{t.migration.to}<input value={targetVersion} onChange={(e) => setTargetVersion(e.target.value)} /></label>
        <label>{t.migration.actor}<input value={actor} onChange={(e) => setActor(e.target.value)} /></label>
        <button className="btn primary" onClick={runPreflight}>{t.migration.preflight}</button>
      </div>
      {!parsed.ok && <ul className="issue-list">{parsed.issues.map((i, n) => <li key={n}><b>{i.path.join(' / ') || '/'}</b><br />{i.range?.snippet && <code>{i.range.snippet}</code>}<span>{i.message}</span></li>)}</ul>}
    </div> : <Review workspace={workspace} page={page.items} total={page.total} pages={page.pages} filters={filters} setFilters={setFilters} expanded={expanded} setExpanded={setExpanded} manualValue={manualValue} setManualValue={setManualValue} update={update} download={download} importFile={importFile} onReset={() => { localStorage.removeItem(STORAGE_KEY); setWorkspace(null); }} />}
  </div>;
}

function Review(props: { workspace: MigrationWorkspace; page: ChangeRecord[]; total: number; pages: number; filters: ReviewFilters; setFilters: (f: ReviewFilters) => void; expanded: Set<string>; setExpanded: (s: Set<string>) => void; manualValue: Record<string, string>; setManualValue: (v: Record<string, string>) => void; update: (w: MigrationWorkspace) => void; download: () => void; importFile: (f: File) => Promise<void>; onReset: () => void }): React.JSX.Element {
  const { workspace: ws } = props; const t = useT(); const sourceRoot = parseStructured(ws.inputText).root;
  const pending = ws.audit.changes.filter((c) => c.status === 'pending' && !ws.review.decisions[c.id] && !ws.review.manual[c.id]).map((c) => c.id);
  const toggle = (id: string): void => { const s = new Set(props.expanded); s.has(id) ? s.delete(id) : s.add(id); props.setExpanded(s); const review = { ...ws.review, expanded: [...s] }; props.update({ ...ws, review }); };
  return <div className="migration-review">
    <section className="migration-summary"><b>{ws.summary}</b><p>{t.migration.fingerprint}: <code>{ws.fingerprint}</code></p><p>{t.migration.ruleFingerprint}: <code>{ws.ruleFingerprint}</code></p><div><button className="btn primary" onClick={props.download}>{t.migration.export}</button><label className="btn">{t.migration.import}<input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void props.importFile(f); }} /></label><button className="btn" onClick={props.onReset}>{t.migration.newReview}</button><button className="btn" onClick={() => props.update(batchAccept(ws, pending, ws.history.at(-1)?.by ?? 'operator'))}>{t.migration.batch}</button></div></section>
    <div className="migration-filters"><input placeholder={t.migration.search} value={props.filters.query ?? ''} onChange={(e) => props.setFilters({ ...props.filters, query: e.target.value, page: 0 })} /><select value={props.filters.status} onChange={(e) => props.setFilters({ ...props.filters, status: e.target.value as ReviewFilters['status'], page: 0 })}>{['all','pending','accepted','rejected','conflict','unknown'].map(x => <option key={x} value={x}>{t.migration.status[x as keyof typeof t.migration.status]}</option>)}</select><span>{props.total}</span></div>
    <div className="change-list">{props.page.map((c) => { const decision = ws.review.decisions[c.id]; const manual = ws.review.manual[c.id]; const affected = [...affectedChangeIds(ws.audit, c.path)]; const origin = sourceRoot && findSource(sourceRoot, c.sourcePaths[0] ?? c.path); return <article key={c.id} className={`change-card ${c.status}`}>
      <header onClick={() => toggle(c.id)}><span>{c.order}</span><b>{c.path}</b><em>{c.category}</em><code>{c.ruleId}/{c.opId}</code></header>
      <div className="change-values"><div><small>{t.migration.oldValue}</small><pre>{safe(c.oldValue)}</pre></div><div><small>{t.migration.newValue}</small><pre>{safe(manual?.value ?? c.newValue)}</pre></div></div>
      {props.expanded.has(c.id) && <div className="change-detail"><p>{c.reason}</p><p>{t.migration.sources}: {c.sourcePaths.join(', ') || '—'}</p>{origin && <><small>{t.migration.origin}</small><code>{origin.range.start.line}:{origin.range.start.column} — {origin.range.snippet}</code></>}<p>{t.migration.affected}: {affected.join(', ')}</p><input aria-label={t.migration.manual} value={props.manualValue[c.id] ?? JSON.stringify(c.newValue)} onChange={(e) => props.setManualValue({ ...props.manualValue, [c.id]: e.target.value })} /><button className="btn" onClick={() => { try { props.update(manualChange(ws, c.id, JSON.parse(props.manualValue[c.id] ?? 'null'), ws.history.at(-1)?.by ?? 'operator')); } catch { /* manual JSON must be valid */ } }}>{t.migration.saveManual}</button></div>}
      <footer><button disabled={Boolean(decision?.decision === 'accepted' || manual)} onClick={() => props.update(decideChange(ws, c.id, 'accepted', ws.history.at(-1)?.by ?? 'operator'))}>{t.migration.accept}</button><button disabled={decision?.decision === 'rejected'} onClick={() => props.update(decideChange(ws, c.id, 'rejected', ws.history.at(-1)?.by ?? 'operator'))}>{t.migration.reject}</button><strong>{decision?.decision ?? (manual ? 'manual' : c.status)}</strong></footer>
    </article>; })}</div>
    <div className="pager"><button disabled={(props.filters.page ?? 0) === 0} onClick={() => props.setFilters({ ...props.filters, page: (props.filters.page ?? 0) - 1 })}>‹</button><span>{(props.filters.page ?? 0) + 1}/{props.pages}</span><button disabled={(props.filters.page ?? 0) >= props.pages - 1} onClick={() => props.setFilters({ ...props.filters, page: (props.filters.page ?? 0) + 1 })}>›</button></div>
    <HistoryList ws={ws} />
  </div>;
}

function HistoryList({ ws }: { ws: MigrationWorkspace }): React.JSX.Element { const t = useT(); return <details className="history-box"><summary>{t.migration.history} ({ws.history.length})</summary>{ws.history.slice().reverse().map(h => <div key={h.id}><time>{h.at}</time><b>{h.by}</b><span>{h.phase}</span><p>{h.message}</p><code>{h.inputFingerprint} / {h.ruleFingerprint}{h.resultFingerprint ? ` / ${h.resultFingerprint}` : ''}</code></div>)}</details>; }
function loadStored(): MigrationWorkspace | null { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) as MigrationWorkspace : null; } catch { return null; } }
function safe(v: unknown): string { return JSON.stringify(v, null, 2); }
function findSource(root: NonNullable<ReturnType<typeof parseStructured>['root']>, path: string) {
  let node: typeof root | undefined = root;
  for (const rawKey of path.split('.').flatMap((p) => p.split(/\[(\d+)\]/).filter(Boolean))) {
    if (!node) return null;
    node = /^\d+$/.test(rawKey) ? node.items?.[Number(rawKey)] : node.fields?.find((f) => f.key === rawKey && f.occurrence === 1)?.value;
  }
  return node ?? null;
}
