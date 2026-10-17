import { Decoder, Encoder, Tag } from "cbor-x";
import { entityId, type EntityId } from "../entity-id.js";

export const SBP_ENTITY_TAG = 60_003;
export const UUID_TAG = 37;

export const entityKinds = {
  user: 0,
  device: 1,
  conversation: 2,
  community: 3,
  channel: 4,
  attachment: 5,
  role: 6,
  friendship: 7,
  call: 8,
  "private-conversation": 9,
  invitation: 10,
  block: 11,
} as const;

export type EntityKind = keyof typeof entityKinds;

const kindNames = new Map<number, EntityKind>(
  Object.entries(entityKinds).map(([name, value]) => [
    value,
    name as EntityKind,
  ]),
);

const encoder = new Encoder({
  useRecords: false,
  mapsAsObjects: false,
  structuredClone: false,
  bundleStrings: false,
  tagUint8Array: false,
  useTimestamp32: true,
});

const decoder = new Decoder({
  useRecords: false,
  mapsAsObjects: false,
  copyBuffers: true,
});

export function encodeSbp(value: unknown): Uint8Array {
  return encoder.encode(value);
}

export function decodeSbp(bytes: Uint8Array): unknown {
  return decoder.decode(bytes);
}

export function wireMap(entries: Iterable<readonly [number, unknown]>) {
  return new Map([...entries].sort(([left], [right]) => left - right));
}

export function entityRef<Kind extends EntityKind>(
  kind: Kind,
  id: EntityId<Kind>,
) {
  return new Tag([entityKinds[kind], uuidToBytes(id)], SBP_ENTITY_TAG);
}

export function decodeEntityRef<Kind extends EntityKind>(
  value: unknown,
  expectedKind: Kind,
): EntityId<Kind> {
  if (!(value instanceof Tag) || value.tag !== SBP_ENTITY_TAG)
    throw new TypeError("Expected an SBP entity reference");
  if (!Array.isArray(value.value) || value.value.length !== 2)
    throw new TypeError("Invalid SBP entity reference");
  const [kind, bytes] = value.value;
  if (kind !== entityKinds[expectedKind] || !isByteString(bytes, 16))
    throw new TypeError(`Expected an SBP ${expectedKind} reference`);
  return entityId<Kind>(bytesToUuid(bytes));
}

export function decodeAnyEntityRef(value: unknown) {
  if (!(value instanceof Tag) || value.tag !== SBP_ENTITY_TAG)
    throw new TypeError("Expected an SBP entity reference");
  if (!Array.isArray(value.value) || value.value.length !== 2)
    throw new TypeError("Invalid SBP entity reference");
  const [kind, bytes] = value.value;
  const name = typeof kind === "number" ? kindNames.get(kind) : undefined;
  if (!name || !isByteString(bytes, 16))
    throw new TypeError("Unknown SBP entity reference");
  return { kind: name, id: entityId(bytesToUuid(bytes)) };
}

export function requestRef(id: string) {
  return new Tag(uuidToBytes(id), UUID_TAG);
}

export function decodeRequestRef(value: unknown): string {
  if (
    !(value instanceof Tag) ||
    value.tag !== UUID_TAG ||
    !isByteString(value.value, 16)
  )
    throw new TypeError("Invalid SBP request ID");
  return bytesToUuid(value.value);
}

export function uuidToBytes(value: string): Uint8Array {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new TypeError("Invalid UUID");
  return Uint8Array.from(
    compact.match(/../g)!.map((octet) => Number.parseInt(octet, 16)),
  );
}

export function bytesToUuid(value: Uint8Array): string {
  if (!isByteString(value, 16)) throw new TypeError("Invalid UUID bytes");
  const compact = Array.from(value, (octet) =>
    octet.toString(16).padStart(2, "0"),
  ).join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function isByteString(value: unknown, size: number): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === size;
}
