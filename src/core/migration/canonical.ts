import type { JsonValue } from './types';

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortValue(value));
}

export function stableHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length, h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const a = (h2 >>> 0).toString(16).padStart(8, '0');
  const b = (h1 >>> 0).toString(16).padStart(8, '0');
  return `sha-${a}${b}`;
}

export function fingerprintJson(value: JsonValue | unknown): string {
  return stableHash(canonicalJson(value as JsonValue));
}

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortValue((value as Record<string, JsonValue>)[k])]));
  }
  return value;
}
