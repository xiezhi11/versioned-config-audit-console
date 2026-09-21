import { canonicalJson, stableHash } from './canonical';
import { getMissingAware, MISSING, removePath, setPath, valueOrNull } from './paths';
import type {
  ChangeRecord, Condition, JsonValue, MigrationAudit, MigrationOp, MigrationRule,
  MigrationRuleSet, ReviewState, TransformRegistry,
} from './types';

export function ruleFingerprint(rules: MigrationRuleSet): string {
  return stableHash(canonicalJson(rules as unknown as JsonValue));
}

export function migrateStructured(
  input: JsonValue,
  startVersion: string,
  targetVersion: string,
  ruleSet: MigrationRuleSet,
  transforms: TransformRegistry = {},
): MigrationAudit {
  const fingerprint = ruleFingerprint(ruleSet);
  const chain = findVersionChain(startVersion, targetVersion, ruleSet);
  if (!chain.ok) return blocked(startVersion, targetVersion, fingerprint, chain.reason);

  let current = structuredClone(input);
  const auditedPath: MigrationAudit['path'] = [];
  const changes: ChangeRecord[] = [];
  const unknown = new Set<string>();
  let order = 0;
  const nextOrder = (): number => { order += 1; return order; };

  try {
  for (const rule of chain.rules) {
    const known = collectKnown(rule);
    collectUnknown(current, known, '', unknown);
    let writes = new Map<string, ChangeRecord>();
    for (const op of topoSort(rule).ops) {
      if (!conditionPasses(op.when, current)) continue;
      const made = applyOp(op, current, transforms);
      for (const partial of made.changes) {
        const record: ChangeRecord = {
          ...partial,
          id: `${rule.id}:${partial.id}`,
          ruleId: rule.id,
          fromVersion: rule.fromVersion,
          toVersion: rule.toVersion,
          status: 'pending',
          order: nextOrder(),
          branchKey: branchKey(partial.path),
          dependsOn: opDepends(rule, op),
        };
        const previous = writes.get(record.path);
        if (previous && canonicalJson(previous.newValue) !== canonicalJson(record.newValue)) {
          const conflict: ChangeRecord = {
            ...record,
            category: 'conflict',
            status: 'conflict',
            oldValue: previous.newValue,
            reason: `Rules ${previous.opId} and ${record.opId} overwrite ${record.path} with different values.`,
          };
          changes.push(conflict);
          return blockedAt(current, startVersion, targetVersion, auditedPath, changes, unknown, fingerprint, conflict.reason);
        }
        writes.set(record.path, record);
        changes.push(record);
      }
      current = made.next;
    }
    auditedPath.push({ from: rule.fromVersion, to: rule.toVersion, ruleId: rule.id });
    collectMissing(current, known, changes, rule, nextOrder);
    writes = new Map();
  }
  } catch (e) {
    return { ok: false, startVersion, targetVersion, currentVersion: auditedPath.at(-1)?.to ?? startVersion, path: auditedPath, changes, unknownPaths: [...unknown], conflicts: [], result: current, ruleFingerprint: fingerprint, reason: (e as Error).message };
  }

  return {
    ok: !changes.some((c) => c.status === 'conflict'),
    startVersion, targetVersion, currentVersion: targetVersion, path: auditedPath,
    changes: changes.map((c) => (unknown.has(c.path) ? { ...c, category: 'unknown' } : c)),
    unknownPaths: [...unknown],
    conflicts: changes.filter((c) => c.status === 'conflict'),
    result: current,
    ruleFingerprint: fingerprint,
  };
}

export function applyReview(base: MigrationAudit, review: ReviewState): JsonValue {
  let result = structuredClone(base.result);
  base.changes
    .filter((c) => review.decisions[c.id]?.decision === 'accepted' || review.manual[c.id])
    .sort((a, b) => a.order - b.order)
    .forEach((c) => setPath(result, c.path, review.manual[c.id]?.value ?? c.newValue));
  return result;
}

export function affectedChangeIds(audit: MigrationAudit, changedPath: string): Set<string> {
  const branch = branchKey(changedPath);
  return new Set(audit.changes.filter((c) => c.branchKey === branch || changedPath.startsWith(c.branchKey + '.')).map((c) => c.id));
}

type PartialChange = Omit<ChangeRecord, 'ruleId' | 'fromVersion' | 'toVersion' | 'status' | 'order' | 'branchKey' | 'dependsOn'>;

function applyOp(op: MigrationOp, sourceRoot: JsonValue, transforms: TransformRegistry): { next: JsonValue; changes: PartialChange[] } {
  const next = structuredClone(sourceRoot);
  const rec = (id: string, category: ChangeRecord['category'], path: string, oldValue: JsonValue, newValue: JsonValue, sourcePaths: string[], reason: string): PartialChange =>
    ({ category, path, oldValue, newValue, sourcePaths, opId: op.id, reason, id });

  if (op.type === 'default') {
    if (getMissingAware(next, op.path) !== MISSING) return { next, changes: [] };
    setPath(next, op.path, op.value);
    return { next, changes: [rec(op.id, 'missing', op.path, null, op.value, [], 'Default added because the field was absent.')] };
  }
  if (op.type === 'set') {
    const old = valueOrNull(getMissingAware(next, op.path));
    setPath(next, op.path, op.value);
    return { next, changes: [rec(op.id, 'overwrite', op.path, old, op.value, [op.path], 'Conditional value update.')] };
  }
  if (op.type === 'rename') {
    const old = getMissingAware(next, op.from);
    if (old === MISSING) return { next, changes: [] };
    const oldValue = old as JsonValue;
    removePath(next, op.from); setPath(next, op.to, oldValue);
    return { next, changes: [rec(op.id, 'rename', op.to, oldValue, oldValue, [op.from], `Renamed ${op.from} → ${op.to}.`)] };
  }
  if (op.type === 'split') {
    const source = getMissingAware(next, op.from);
    if (source === MISSING) return { next, changes: [] };
    const parts = String(source as JsonValue).split(op.separator ?? '.');
    const changes = op.targets.map((target) => {
      const part = parts[Number(target.part)] ?? null;
      setPath(next, target.path, part);
      return rec(`${op.id}:${target.path}`, 'split', target.path, null, part, [op.from], `Split from ${op.from}.`);
    });
    if (!op.targets.some((target) => target.path === op.from)) removePath(next, op.from);
    return { next, changes };
  }
  if (op.type === 'merge') {
    const values = op.sources.map((p) => valueOrNull(getMissingAware(next, p)));
    const merged = values.join(op.separator ?? '.');
    op.sources.forEach((p) => removePath(next, p));
    setPath(next, op.target, merged);
    return { next, changes: [rec(op.id, 'merge', op.target, null, merged, op.sources, `Merged ${op.sources.join(', ')} → ${op.target}.`)] };
  }
  const fn = transforms[op.transform];
  if (!fn) throw new Error(`Custom transform "${op.transform}" is not registered on this machine.`);
  const reads: Record<string, JsonValue> = {};
  op.reads.forEach((p) => { reads[p] = valueOrNull(getMissingAware(next, p)); });
  const output = fn(reads, op.args ?? {});
  Object.entries(output as Record<string, JsonValue>).forEach(([p, v]) => setPath(next, p, v));
  return { next, changes: [rec(op.id, 'custom', op.writes[0] ?? op.reads[0] ?? '(custom)', null, output, op.reads, `Custom transform ${op.transform}.`)] };
}

function findVersionChain(start: string, target: string, rules: MigrationRuleSet): { ok: true; rules: MigrationRule[] } | { ok: false; reason: string } {
  const queue: { version: string; rules: MigrationRule[] }[] = [{ version: start, rules: [] }];
  const seen = new Set([start]);
  while (queue.length) {
    const item = queue.shift()!;
    const outgoing = rules.rules.filter((r) => r.fromVersion === item.version).sort((a, b) => a.toVersion.localeCompare(b.toVersion));
    for (const rule of outgoing) {
      if (item.rules.length === 0 && rule.toVersion === target && outgoing.some((r) => r.toVersion !== target)) continue;
      const next = [...item.rules, rule];
      if (rule.toVersion === target) return { ok: true, rules: next };
      if (!seen.has(rule.toVersion)) {
        seen.add(rule.toVersion);
        queue.push({ version: rule.toVersion, rules: next });
      }
    }
  }
  const direct = rules.rules.find((r) => r.fromVersion === start && r.toVersion === target);
  if (direct) return { ok: true, rules: [direct] };
  const steps = rules.rules.map((r) => `${r.fromVersion}→${r.toVersion}`).join(', ');
  return { ok: false, reason: `Cannot safely migrate ${start} to ${target}: a declared intermediate version is missing. Locked steps available: ${steps || '(none)'}.` };
}

function conditionPasses(condition: Condition | undefined, value: JsonValue): boolean {
  if (!condition) return true;
  if ('all' in condition) return condition.all.every((c) => conditionPasses(c, value));
  if ('any' in condition) return condition.any.some((c) => conditionPasses(c, value));
  if ('not' in condition) return !conditionPasses(condition.not, value);
  const current = getMissingAware(value, condition.path);
  if (condition.exists !== undefined) return (current !== MISSING) === condition.exists;
  if (condition.equals !== undefined) return canonicalJson(valueOrNull(current as JsonValue | symbol)) === canonicalJson(condition.equals);
  if (condition.notEquals !== undefined) return canonicalJson(valueOrNull(current as JsonValue | symbol)) !== canonicalJson(condition.notEquals);
  return true;
}

function topoSort(rule: MigrationRule): MigrationRule {
  if (!rule.dependsOn?.length) return rule;
  const byId = new Map(rule.ops.map((o) => [o.id, o]));
  const done = new Set<string>();
  const ops: MigrationOp[] = [];
  const visit = (op: MigrationOp, stack: Set<string>): void => {
    if (done.has(op.id)) return;
    if (stack.has(op.id)) throw new Error(`Cyclic rule dependency at ${op.id} in ${rule.id}.`);
    stack.add(op.id);
    for (const dep of (rule.dependsOn ?? []).filter((d) => d.startsWith(`${op.id}:`)).map((d) => d.slice(op.id.length + 1))) {
      const required = byId.get(dep);
      if (required) visit(required, stack);
    }
    stack.delete(op.id); done.add(op.id); ops.push(op);
  };
  rule.ops.forEach((o) => visit(o, new Set()));
  return { ...rule, ops };
}

function opDepends(rule: MigrationRule, op: MigrationOp): string[] {
  return rule.dependsOn?.filter((d) => d.startsWith(`${op.id}:`)).map((d) => `${rule.id}:${d.slice(op.id.length + 1)}`) ?? [];
}

function collectKnown(rule: MigrationRule): string[] {
  if (rule.knownPaths) return rule.knownPaths;
  return rule.ops.flatMap((o) => {
    if (o.type === 'custom') return [...o.reads, ...o.writes];
    if (o.type === 'merge') return [o.target, ...o.sources];
    if (o.type === 'split') return [o.from, ...o.targets.map((x) => x.path)];
    if (o.type === 'rename') return [o.from, o.to];
    return [o.path];
  });
}

function collectUnknown(value: JsonValue, known: string[], prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectUnknown(v, known, `${prefix}[${i}]`, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!known.some((k) => p === k || p.startsWith(k + '.') || p.startsWith(k + '['))) out.add(p);
    collectUnknown(child, known, p, out);
  }
}

function collectMissing(value: JsonValue, known: string[], changes: ChangeRecord[], rule: MigrationRule, nextOrder: () => number): void {
  for (const p of known) {
    if (getMissingAware(value, p) === MISSING) {
      changes.push({
        id: `${rule.id}:missing:${p}`, category: 'missing', path: p, oldValue: null, newValue: null,
        sourcePaths: [], ruleId: rule.id, opId: 'schema', fromVersion: rule.fromVersion,
        toVersion: rule.toVersion, status: 'pending', reason: 'Required field is absent after migration.',
        dependsOn: [], branchKey: branchKey(p), order: nextOrder(),
      });
    }
  }
}

function branchKey(path: string): string { return path.split(/[.[]/)[0] ?? path; }
function blocked(start: string, target: string, fp: string, reason: string): MigrationAudit {
  return { ok: false, startVersion: start, targetVersion: target, currentVersion: start, path: [], changes: [], unknownPaths: [], conflicts: [], result: null, ruleFingerprint: fp, reason };
}
function blockedAt(current: JsonValue, start: string, target: string, path: MigrationAudit['path'], changes: ChangeRecord[], unknown: Set<string>, fp: string, reason: string): MigrationAudit {
  return { ok: false, startVersion: start, targetVersion: target, currentVersion: path.at(-1)?.from ?? start, path, changes, unknownPaths: [...unknown], conflicts: changes.filter((c) => c.status === 'conflict'), result: current, ruleFingerprint: fp, reason };
}
