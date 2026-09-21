import { describe, expect, it } from 'vitest';
import {
  batchAccept, createWorkspace, decideChange, importWorkspace, migrateStructured,
  parseStructured, queryChanges, unresolvedCount,
} from './index';
import type { MigrationRuleSet } from './index';

const rules: MigrationRuleSet = {
  rules: [
    {
      id: 'v1-v2', fromVersion: '1', toVersion: '2',
      knownPaths: ['version', 'name', 'meta.owner', 'meta.team', 'options.timeoutMs'],
      ops: [
        { id: 'default-timeout', type: 'default', path: 'options.timeoutMs', value: 1000 },
        { id: 'rename-owner', type: 'rename', from: 'owner', to: 'meta.owner' },
      ],
    },
    {
      id: 'v2-v3', fromVersion: '2', toVersion: '3',
      knownPaths: ['version', 'name', 'meta.owner', 'meta.team', 'options.timeoutMs'],
      ops: [
        { id: 'split-team', type: 'split', from: 'meta.owner', targets: [{ path: 'meta.owner', part: 0 }, { path: 'meta.team', part: 1 }], separator: '/' },
        { id: 'custom-bool', type: 'custom', transform: 'enabled-when', reads: ['meta.team'], writes: ['options.enabled'],
          when: { path: 'meta.team', exists: true } },
      ],
    },
    { id: 'v1-v3', fromVersion: '1', toVersion: '3', knownPaths: ['version', 'name', 'meta.owner', 'meta.team', 'options.timeoutMs', 'options.enabled'],
      ops: [{ id: 'direct', type: 'set', path: 'options.enabled', value: true }] },
  ],
};

const transforms = { 'enabled-when': (input: Record<string, unknown>) => ({ 'options.enabled': Boolean(input['meta.team']) }) };

describe('audited structured parsing', () => {
  it('keeps object order, null, arrays and duplicate-key occurrences', () => {
    const result = parseStructured('z: 1\na: null\nlist:\n  - {x: 1}\na: 2\nempty: []\n');
    expect(result.issues.map((i) => i.code)).toContain('duplicate-key');
    expect(result.issues.map((i) => i.code)).toContain('empty-array');
    expect(result.ok).toBe(false);
    expect(result.root?.fields?.map((f) => f.key)).toEqual(['z', 'a', 'list', 'a', 'empty']);
    expect(result.root?.fields?.[1]?.value.kind).toBe('null');
    const issue = result.issues.find((i) => i.code === 'duplicate-key');
    expect(issue?.path).toEqual(['a']);
    expect(issue?.range?.start.line).toBe(5);
    expect(issue?.range?.snippet).toContain('a: 2');
  });

  it('reports hierarchy and snippet for syntax failures', () => {
    const result = parseStructured('outer:\n  inner:\n   bad: [');
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toMatch(/unexpected end|did not find expected/i);
  });

  it('recognises null, arrays and excessive nesting', () => {
    expect(parseStructured('a:\n  - null\n  - []\n').ok).toBe(true);
    const deep = Array.from({ length: 105 }, (_, i) => `${'  '.repeat(i)}a:`).join('\n') + '\n' + '  '.repeat(105) + 'v: 1';
    expect(parseStructured(deep, 100).ok).toBe(false);
  });
});

describe('locked migration chain', () => {
  it('migrates stepwise, records rules and never guesses missing links', () => {
    const parsed = parseStructured('version: "1"\nname: api\nowner: platform/sre\nignored: true\n');
    const audit = migrateStructured(parsed.root!.value, '1', '3', rules, transforms);
    expect(audit.ok).toBe(true);
    expect(audit.path.map((p) => p.ruleId)).toEqual(['v1-v2', 'v2-v3']);
    expect(audit.result).toMatchObject({ meta: { owner: 'platform', team: 'sre' }, options: { enabled: true, timeoutMs: 1000 } });
    expect(audit.unknownPaths).toContain('ignored');
    expect(audit.changes.map((c) => [c.path, c.ruleId, c.opId])).toContainEqual(['meta.owner', 'v1-v2', 'rename-owner']);
    expect(audit.ruleFingerprint).toMatch(/^sha-/);
  });

  it('supports a locked direct old-to-new shortcut', () => {
    const audit = migrateStructured({ version: '1' }, '1', '3', { rules: [rules.rules[2]!] }, transforms);
    expect(audit.path[0].ruleId).toBe('v1-v3');
  });

  it('stops preflight when an intermediate rule is missing', () => {
    const audit = migrateStructured({ version: '1' }, '1', '3', { rules: [rules.rules[0]!] }, transforms);
    expect(audit.ok).toBe(false);
    expect(audit.reason).toMatch(/intermediate version is missing/);
  });

  it('stops on conflicting writes without hiding earlier records', () => {
    const conflictRules: MigrationRuleSet = { rules: [{ id: 'r', fromVersion: '1', toVersion: '2', ops: [
      { id: 'a', type: 'set', path: 'x', value: 1 },
      { id: 'b', type: 'set', path: 'x', value: 2, when: { path: 'x', equals: 1 } },
    ] }] };
    const audit = migrateStructured({ x: 0 }, '1', '2', conflictRules);
    expect(audit.ok).toBe(false);
    expect(audit.conflicts[0].opId).toBe('b');
    expect(audit.changes.map((c) => c.opId)).toEqual(['a', 'b']);
  });

  it('stops preflight on cyclic rule dependencies', () => {
    const cyclic: MigrationRuleSet = { rules: [{ id: 'r', fromVersion: '1', toVersion: '2', dependsOn: ['a:b', 'b:a'], ops: [
      { id: 'a', type: 'set', path: 'a', value: 1 },
      { id: 'b', type: 'set', path: 'b', value: 2 },
    ] }] };
    expect(migrateStructured({}, '1', '2', cyclic).reason).toMatch(/Cyclic/);
  });
});

describe('review workspace', () => {
  const make = () => {
    const parsed = parseStructured('version: "1"\nname: api\nowner: platform/sre\n');
    const audit = migrateStructured(parsed.root!.value, '1', '3', rules, transforms);
    return createWorkspace({ input: parsed.root!.value, inputText: '', dataVersion: '1', targetVersion: '3', audit, rules, by: 'alice' });
  };
  it('accepts in stable order, rejects independently, and preserves decisions', () => {
    let ws = make();
    const ids = ws.audit.changes.filter((c) => c.status === 'pending').map((c) => c.id);
    ws = batchAccept(ws, ids, 'alice');
    expect(ws.history.filter((h) => h.phase === 'batch-confirm').map((h) => h.changeIds[0])).toEqual(ids);
    const rejected = ids[0]!;
    ws = decideChange(ws, rejected, 'rejected', 'bob');
    const restored = importWorkspace(JSON.stringify(ws), rules);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.workspace.review.decisions[rejected]?.decision).toBe('rejected');
      expect(unresolvedCount(restored.workspace.audit, restored.workspace.review)).toBe(0);
    }
  });

  it('rejects damaged workspaces and fingerprint mismatch at preflight', () => {
    const ws = make();
    expect(importWorkspace('{broken', rules).ok).toBe(false);
    const changedRules = structuredClone(rules); changedRules.rules[0]!.description = 'changed';
    expect(importWorkspace(JSON.stringify(ws), changedRules).ok).toBe(false);
  });

  it('search pagination keeps deterministic order', () => {
    const ws = make();
    const p1 = queryChanges(ws.audit.changes, { ...ws.review.filters, pageSize: 2, page: 0 });
    const p2 = queryChanges(ws.audit.changes, { ...ws.review.filters, pageSize: 2, page: 1 });
    expect([...p1.items, ...p2.items].map((c) => c.order)).toEqual([...p1.items, ...p2.items].map((c) => c.order).sort((a, b) => a - b));
  });
});
