import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import type { SbpSocket } from "./session.js";
import { decodeFrame, encodeControl } from "./frame.js";
import { encodeSbp, entityRef, requestRef, wireMap } from "./codec.js";
import { SbpSession } from "./session.js";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = entityId<"user">("660e8400-e29b-41d4-a716-446655440000");
const DEVICE_ID = entityId<"device">("770e8400-e29b-41d4-a716-446655440000");

class FakeSocket implements SbpSocket {
  binaryType: BinaryType = "blob";
  readyState = 1;
  sent: Uint8Array[] = [];
  listeners = new Map<string, Array<(event: never) => void>>();
  closedWith?: { code?: number; reason?: string };

  send(data: ArrayBufferView | ArrayBuffer) {
    this.sent.push(
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown) {
    this.listeners.get(type)?.forEach((listener) => listener(event as never));
  }
}

function authenticatedPayload() {
  return wireMap([
    [0, 1],
    [1, entityRef("user", USER_ID)],
    [2, entityRef("device", DEVICE_ID)],
    [3, [0, 1, 2, 3, 4, 5]],
    [4, 30_000],
    [5, 90_000],
    [
      6,
      wireMap([
        [0, true],
        [1, 100_000_000],
        [2, 10],
        [3, 100_000_000],
        [4, true],
        [5, true],
        [6, true],
        [7, 5_000],
        [8, 30_000],
        [9, 15_000],
        [10, 10_000],
      ]),
    ],
    [7, accountSnapshot()],
    [
      8,
      wireMap([
        [0, []],
        [1, []],
        [2, []],
        [3, []],
      ]),
    ],
  ]);
}

function accountSnapshot() {
  return wireMap([
    [0, 1],
    [
      2,
      wireMap([
        [0, entityRef("user", USER_ID)],
        [1, "burger"],
        [2, "Burger"],
        [5, new Date("2026-10-13T20:00:00.000Z")],
        [6, 0],
      ]),
    ],
    [3, []],
    [4, []],
    [5, []],
    [6, []],
    [
      7,
      wireMap([
        [0, 0],
        [1, 0],
        [2, false],
        [4, 0],
      ]),
    ],
    [8, []],
    [9, []],
    [10, []],
    [11, []],
  ]);
}

describe("SbpSession", () => {
  it("negotiates and authenticates an SBP session", async () => {
    const socket = new FakeSocket();
    const session = new SbpSession({
      socketFactory: (url, protocols) => {
        expect(url).toBe("wss://example.com/sbp");
        expect(protocols).toEqual(["sideband.cbor.v1"]);
        return socket;
      },
      randomUuid: () => REQUEST_ID,
    });

    const connected = session.connect({
      endpoint: { domain: "example.com", baseUrl: "https://example.com" },
      credential: new Uint8Array([1, 2, 3]),
      deviceId: DEVICE_ID,
      clientFamily: "sideband-desktop",
      clientVersion: "0.3.0",
    });

    socket.emit("open", {});
    expect(
      socket.sent
        .map(decodeFrame)
        .map((frame) => frame.kind === "control" && frame.opcode),
    ).toEqual([0]);

    socket.emit("message", {
      data: encodeControl(1, authenticatedPayload()),
    });
    await expect(connected).resolves.toMatchObject({
      protocolVersion: 1,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      policy: { attachmentsEnabled: true, maximumAttachmentsPerMessage: 10 },
    });
    session.disconnect();
  });

  it("correlates command responses and rejects protocol errors", async () => {
    const socket = new FakeSocket();
    const session = new SbpSession({
      socketFactory: () => socket,
      randomUuid: () => REQUEST_ID,
    });
    const connected = session.connect({
      endpoint: { domain: "localhost", baseUrl: "http://127.0.0.1:4000" },
      credential: new Uint8Array([1]),
      deviceId: DEVICE_ID,
      clientFamily: "test",
      clientVersion: "1",
    });
    socket.emit("open", {});
    socket.emit("message", { data: encodeControl(1, authenticatedPayload()) });
    await connected;
    socket.sent.length = 0;

    const result = session.command(
      20,
      wireMap([[0, entityRef("user", USER_ID)]]),
    );
    expect(decodeFrame(socket.sent[0]!)).toMatchObject({
      kind: "command",
      opcode: 20,
    });
    socket.emit("message", {
      data: encodeSbp([
        1,
        requestRef(REQUEST_ID),
        0,
        [20, wireMap([[0, "profile"]])],
      ]),
    });
    await expect(result).resolves.toEqual(new Map([[0, "profile"]]));

    const failure = session.command(20, wireMap([]));
    socket.emit("message", {
      data: encodeSbp([
        1,
        requestRef(REQUEST_ID),
        1,
        wireMap([
          [0, 4],
          [1, "User not found"],
        ]),
      ]),
    });
    await expect(failure).rejects.toMatchObject({
      code: 4,
      message: "User not found",
    });
    session.disconnect();
  });

  it("answers server pings", async () => {
    const socket = new FakeSocket();
    const session = new SbpSession({ socketFactory: () => socket });
    const connected = session.connect({
      endpoint: { domain: "example.com", baseUrl: "https://example.com" },
      credential: new Uint8Array([1]),
      deviceId: DEVICE_ID,
      clientFamily: "test",
      clientVersion: "1",
    });
    socket.emit("open", {});
    socket.emit("message", { data: encodeControl(1, authenticatedPayload()) });
    await connected;
    socket.sent.length = 0;
    socket.emit("message", { data: encodeControl(5, 42) });
    expect(decodeFrame(socket.sent[0]!)).toEqual({
      kind: "control",
      opcode: 6,
      payload: 42,
    });
    session.disconnect();
  });

  it("reports application listener failures without closing the socket", async () => {
    const socket = new FakeSocket();
    const onListenerError = vi.fn();
    const session = new SbpSession({
      socketFactory: () => socket,
      onListenerError,
    });
    const connected = session.connect({
      endpoint: { domain: "example.com", baseUrl: "https://example.com" },
      credential: new Uint8Array([1]),
      deviceId: DEVICE_ID,
      clientFamily: "test",
      clientVersion: "1",
    });
    session.subscribeControls(() => {
      throw new Error("projection failed");
    });

    socket.emit("open", {});
    socket.emit("message", { data: encodeControl(1, authenticatedPayload()) });
    await connected;

    socket.emit("message", { data: encodeControl(41, wireMap([[0, null]])) });

    expect(onListenerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "projection failed" }),
    );
    expect(socket.closedWith).toBeUndefined();
    session.disconnect();
  });

  it("uses an application close code when the server sends an invalid frame", async () => {
    const socket = new FakeSocket();
    const session = new SbpSession({ socketFactory: () => socket });
    const connected = session.connect({
      endpoint: { domain: "example.com", baseUrl: "https://example.com" },
      credential: new Uint8Array([1]),
      deviceId: DEVICE_ID,
      clientFamily: "test",
      clientVersion: "1",
    });

    socket.emit("message", { data: new Uint8Array([0xff]) });

    await expect(connected).rejects.toBeInstanceOf(Error);
    expect(socket.closedWith).toEqual({
      code: 4007,
      reason: "Invalid SBP frame",
    });
  });

  it("rejects a session with the server's structured authentication error", async () => {
    const socket = new FakeSocket();
    const session = new SbpSession({ socketFactory: () => socket });
    const connected = session.connect({
      endpoint: { domain: "example.com", baseUrl: "https://example.com" },
      credential: new Uint8Array([1]),
      deviceId: DEVICE_ID,
      clientFamily: "test",
      clientVersion: "1",
    });

    socket.emit("open", {});
    socket.emit("message", {
      data: encodeControl(
        2,
        wireMap([
          [0, 0],
          [1, "Authentication failed"],
          [2, false],
        ]),
      ),
    });

    await expect(connected).rejects.toMatchObject({
      code: 0,
      message: "Authentication failed",
      details: { retryable: false },
    });
  });
});
