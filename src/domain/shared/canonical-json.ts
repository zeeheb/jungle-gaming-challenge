/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit (default
 * Array#sort), undefined values dropped, no whitespace. Values that define
 * toJSON() (Money, Date) are converted through it first.
 *
 * Two payloads that mean the same thing must produce the same bytes, otherwise
 * the idempotency hash would flag a legit retry as a conflict.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    return normalize(toJSON.call(value));
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, normalize(record[key])]),
  );
}
