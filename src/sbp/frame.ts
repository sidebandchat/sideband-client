import type { ConversationId } from "../entity-id.js";
import {
  decodeEntityRef,
  decodeRequestRef,
  decodeSbp,
  encodeSbp,
  requestRef,
} from "./codec.js";

export type SbpStream =
  | { kind: "account" }
  | { kind: "conversation"; conversationId: ConversationId };

export type SbpFrame =
  | { kind: "command"; requestId: string; opcode: number; payload: unknown }
  | {
      kind: "response";
      requestId: string;
      status: "ok" | "error";
      opcode?: number;
      payload: unknown;
    }
  | {
      kind: "event";
      stream: SbpStream;
      eventId: bigint;
      timestamp: Date;
      opcode: number;
      payload: unknown;
    }
  | { kind: "control"; opcode: number; payload: unknown };

export function encodeCommand(
  requestId: string,
  opcode: number,
  payload: unknown,
): Uint8Array {
  return encodeSbp([0, requestRef(requestId), [opcode, payload]]);
}

export function encodeControl(opcode: number, payload: unknown): Uint8Array {
  return encodeSbp([3, [opcode, payload]]);
}

export function decodeFrame(bytes: Uint8Array): SbpFrame {
  const frame = decodeSbp(bytes);
  if (!Array.isArray(frame)) throw new TypeError("Invalid SBP frame");

  switch (frame[0]) {
    case 0: {
      requireLength(frame, 3);
      const [opcode, payload] = operation(frame[2]);
      return {
        kind: "command",
        requestId: decodeRequestRef(frame[1]),
        opcode,
        payload,
      };
    }
    case 1: {
      requireLength(frame, 4);
      const requestId = decodeRequestRef(frame[1]);
      if (frame[2] === 0) {
        const [opcode, payload] = operation(frame[3]);
        return { kind: "response", requestId, status: "ok", opcode, payload };
      }
      if (frame[2] === 1)
        return {
          kind: "response",
          requestId,
          status: "error",
          payload: frame[3],
        };
      throw new TypeError("Invalid SBP response status");
    }
    case 2: {
      requireLength(frame, 5);
      const [opcode, payload] = operation(frame[4]);
      return {
        kind: "event",
        stream: decodeStream(frame[1]),
        eventId: integer(frame[2]),
        timestamp: timestamp(frame[3]),
        opcode,
        payload,
      };
    }
    case 3: {
      requireLength(frame, 2);
      const [opcode, payload] = operation(frame[1]);
      return { kind: "control", opcode, payload };
    }
    default:
      throw new TypeError("Unknown SBP frame kind");
  }
}

function operation(value: unknown): [number, unknown] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isInteger(value[0])
  )
    throw new TypeError("Invalid SBP operation");
  return [value[0] as number, value[1]];
}

function decodeStream(value: unknown): SbpStream {
  if (!Array.isArray(value))
    throw new TypeError("Invalid SBP stream reference");
  if (value.length === 1 && value[0] === 0) return { kind: "account" };
  if (value.length === 2 && value[0] === 1)
    return {
      kind: "conversation",
      conversationId: decodeEntityRef(value[1], "conversation"),
    };
  throw new TypeError("Invalid SBP stream reference");
}

function integer(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  throw new TypeError("Invalid SBP ordered ID");
}

function timestamp(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  throw new TypeError("Invalid SBP timestamp");
}

function requireLength(value: unknown[], length: number) {
  if (value.length !== length) throw new TypeError("Invalid SBP frame length");
}
