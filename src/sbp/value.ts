import { orderedId, type OrderedId } from "../entity-id.js";

export function mapValue(value: unknown): Map<number, unknown> {
  if (
    !(value instanceof Map) ||
    [...value.keys()].some((key) => !Number.isInteger(key))
  )
    throw new TypeError("Expected an SBP integer-keyed map");
  return value as Map<number, unknown>;
}

export function required(map: Map<number, unknown>, key: number): unknown {
  if (!map.has(key)) throw new TypeError(`Missing SBP field ${key}`);
  return map.get(key);
}

export function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an SBP array");
  return value;
}

export function textValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected SBP text");
  return value;
}

export function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new TypeError("Expected an SBP boolean");
  return value;
}

export function integerValue(value: unknown): number {
  if (!Number.isSafeInteger(value))
    throw new TypeError("Expected an SBP integer");
  return value as number;
}

export function unsignedValue(value: unknown): number {
  const result = integerValue(value);
  if (result < 0) throw new TypeError("Expected an SBP unsigned integer");
  return result;
}

export function orderedValue<Kind extends string>(
  value: unknown,
): OrderedId<Kind> {
  if (typeof value !== "number" && typeof value !== "bigint")
    throw new TypeError("Expected an SBP ordered ID");
  return orderedId<Kind>(value);
}

export function timestampValue(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf()))
    throw new TypeError("Expected an SBP timestamp");
  return value.toISOString();
}

export function bytesValue(value: unknown, size?: number): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    (size !== undefined && value.byteLength !== size)
  )
    throw new TypeError("Expected an SBP byte string");
  return new Uint8Array(value);
}

export function optional<T>(
  map: Map<number, unknown>,
  key: number,
  decode: (value: unknown) => T,
): T | undefined {
  return map.has(key) ? decode(map.get(key)) : undefined;
}
