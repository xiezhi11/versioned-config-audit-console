import { parseEvents, YAMLException, EVENT_SCALAR, EVENT_MAPPING, EVENT_SEQUENCE, EVENT_ALIAS, EVENT_POP, EVENT_DOCUMENT, getScalarValue } from 'js-yaml';
import type { Event } from 'js-yaml';
import type { JsonValue, ParseIssue, SourcePos, SourceRange, StructuredField, StructuredNode, StructuredParseResult } from './types';

const DEFAULT_MAX_DEPTH = 100;

export function parseStructured(input: string, maxDepth = DEFAULT_MAX_DEPTH): StructuredParseResult {
  if (!input.trim()) return fail([issue('syntax', 'Input is empty.', [], null, 'error')], null);
  let events: Event[];
  try {
    events = parseEvents(input, { maxDepth });
  } catch (e) {
    const err = e as YAMLException;
    const range = err.mark ? markToRange(input, err.mark.position) : null;
    const path: (string | number)[] = [];
    return fail([issue('syntax', err.message, path, range, 'error')], null);
  }
  const issues: ParseIssue[] = [];
  try {
    const root = parseNode(input, events, 0, [], issues, maxDepth).node;
    collectShapeIssues(root, issues);
    return { ok: !issues.some((i) => i.severity === 'error'), root, issues };
  } catch (e) {
    if (!isError(e)) throw e;
    return fail([issue(e.code ?? 'syntax', e.message, e.path ?? [], e.range ?? null, 'error')], null);
  }
}

interface ParseError extends Error {
  code?: ParseIssue['code'];
  path?: (string | number)[];
  range?: SourceRange | null;
}

function parseNode(
  source: string,
  events: Event[],
  index: number,
  path: (string | number)[],
  issues: ParseIssue[],
  maxDepth: number,
): { node: StructuredNode; next: number } {
  const event = events[index];
  if (!event) throw parseError('Unexpected end of input while expecting a value.', path, null, 'syntax');
  if (event.type === EVENT_ALIAS) {
    throw parseError('YAML aliases are not allowed in audited migration input.', path, rangeAt(source, event.anchorStart, event.anchorEnd), 'unsupported-alias');
  }
  if (event.type === EVENT_SCALAR) {
    const raw = getScalarValue(source, event);
    const value = parseScalar(raw);
    return { node: node(value === null ? 'null' : 'scalar', value, path, rangeAt(source, event.valueStart, event.valueEnd)), next: index + 1 };
  }
  if (path.length > maxDepth) throw parseError(`Nesting is deeper than ${maxDepth} levels.`, path, null, 'too-deep');
  if (event.type === EVENT_SEQUENCE) {
    const start = posAt(source, event.start);
    let cursor = index + 1;
    const items: StructuredNode[] = [];
    let i = 0;
    let end: SourcePos = posAt(source, event.start);
    while (events[cursor] && events[cursor].type !== EVENT_POP) {
      const child = parseNode(source, events, cursor, [...path, i], issues, maxDepth);
      items.push(child.node);
      end = child.node.range.end;
      cursor = child.next;
      i += 1;
    }
    if (!events[cursor]) throw parseError('Sequence is not closed.', path, null, 'syntax');
    return { node: node('array', items.map((x) => x.value), path, { start, end, snippet: slice(source, start.offset, end.offset) }, { items }), next: cursor + 1 };
  }
  if (event.type === EVENT_MAPPING) {
    const startPos = posAt(source, event.start);
    let cursor = index + 1;
    const fields: StructuredField[] = [];
    const seen = new Map<string, number>();
    const value: Record<string, JsonValue> = {};
    let end: SourcePos = startPos;
    while (events[cursor] && events[cursor].type !== EVENT_POP) {
      const keyEvent = events[cursor];
      if (!keyEvent || keyEvent.type !== EVENT_SCALAR) throw parseError('Object key must be a scalar.', path, null, 'syntax');
      const key = getScalarValue(source, keyEvent);
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      const parsedValue = parseNode(source, events, cursor + 1, [...path, key], issues, maxDepth);
      const fieldRange = rangeAt(source, keyEvent.valueStart, parsedValue.node.range.end.offset);
      fields.push({ id: `${path.join('/')}/${key}#${occurrence}`, key, occurrence, keyRange: fieldRange, value: parsedValue.node });
      value[key] = parsedValue.node.value;
      end = parsedValue.node.range.end;
      cursor = parsedValue.next;
    }
    if (!events[cursor]) throw parseError('Object is not closed.', path, null, 'syntax');
    if (seen.size !== fields.length) {
      const counts = new Set<string>();
      for (const f of fields) if ((seen.get(f.key) ?? 0) > 1) counts.add(f.key);
      for (const f of fields) {
        if (counts.has(f.key)) f.value.duplicateKey = true;
      }
      for (const key of counts) {
        const field = fields.filter((f) => f.key === key).at(-1)!;
        issues.push(issue('duplicate-key', `Duplicate key "${key}": each occurrence is retained; the last value would overwrite earlier values.`, [...path, key], field.keyRange, 'error'));
      }
    }
    return { node: node('object', value, path, { start: startPos, end, snippet: slice(source, startPos.offset, end.offset) }, { fields }), next: cursor + 1 };
  }
  if (event.type === EVENT_DOCUMENT) return parseNode(source, events, index + 1, path, issues, maxDepth);
  throw parseError('Unexpected YAML event.', path, null, 'syntax');
}

function collectShapeIssues(n: StructuredNode, issues: ParseIssue[]): void {
  if (n.kind === 'array' && n.items?.length === 0) issues.push(issue('empty-array', 'Empty array: allowed, but kept as an explicit review item.', n.path, n.range, 'warning'));
  n.fields?.forEach((f) => collectShapeIssues(f.value, issues));
  n.items?.forEach((x) => collectShapeIssues(x, issues));
}

function node(kind: StructuredNode['kind'], value: JsonValue, path: (string | number)[], range: SourceRange, extra: Partial<StructuredNode> = {}): StructuredNode {
  return { kind, value, path, range, ...extra };
}

function parseScalar(raw: string): JsonValue {
  if (raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;
  if (/^-?(0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
  if (/^-?(0|[1-9][0-9]*)\.[0-9]+(e[-+]?[0-9]+)?$/i.test(raw)) return Number(raw);
  return raw;
}

function issue(code: ParseIssue['code'], message: string, path: (string | number)[], range: SourceRange | null, severity: ParseIssue['severity']): ParseIssue {
  return { code, message, path, range, severity };
}
function fail(issues: ParseIssue[], root: null): StructuredParseResult { return { ok: false, root, issues }; }

function isError(e: unknown): e is ParseError { return e instanceof Error; }
function parseError(message: string, path: (string | number)[], range: SourceRange | null, code: ParseIssue['code']): ParseError {
  return Object.assign(new Error(message), { path, range, code });
}
function posAt(source: string, offset: number): SourcePos {
  let line = 1, column = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') { line += 1; column = 1; } else column += 1;
  }
  return { offset, line, column };
}
function rangeAt(source: string, start: number, end: number): SourceRange { const sp = posAt(source, start); return { start: sp, end: posAt(source, end), snippet: slice(source, start, end) }; }
function slice(source: string, start: number, end: number): string { return source.slice(start, Math.max(end, start + 1)).split('\n').slice(0, 4).join('\n'); }
function markToRange(source: string, offset: number): SourceRange { return rangeAt(source, offset, Math.min(source.length, offset + 80)); }
