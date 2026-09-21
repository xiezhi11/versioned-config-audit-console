import type { JsonValue } from './types';

export const MISSING = Symbol('missing');

export function parsePath(path: string): (string | number)[] {
  return path.split('.').flatMap((part) =>
    part.split(/\[(\d+)\]/).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x)),
  );
}

export function getPath(root: JsonValue, path: string): JsonValue | undefined {
  let cursor: unknown = root;
  for (const key of parsePath(path)) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor as JsonValue | undefined;
}

export function getMissingAware(root: JsonValue, path: string): JsonValue | symbol {
  const value = getPath(root, path);
  return value === undefined ? MISSING : value;
}

export function setPath(root: JsonValue, path: string, value: JsonValue): void {
  const keys = parsePath(path);
  let cursor: Record<string | number, unknown> = root as Record<string | number, unknown>;
  keys.forEach((key, i) => {
    const last = i === keys.length - 1;
    if (last) {
      cursor[key] = value;
      return;
    }
    const nextKey = keys[i + 1];
    if (cursor[key] === undefined || cursor[key] === null) cursor[key] = typeof nextKey === 'number' ? [] : {};
    cursor = cursor[key] as Record<string | number, unknown>;
  });
}

export function removePath(root: JsonValue, path: string): void {
  const keys = parsePath(path);
  let cursor: Record<string | number, unknown> = root as Record<string | number, unknown>;
  for (let i = 0; i < keys.length - 1; i += 1) cursor = cursor[keys[i]] as Record<string | number, unknown>;
  delete cursor[keys[keys.length - 1]];
}

export function valueOrNull(value: JsonValue | symbol): JsonValue {
  return value === MISSING ? null : (value as JsonValue);
}
