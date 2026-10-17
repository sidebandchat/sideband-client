import { afterEach, describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { encodeSbp, entityRef, requestRef, wireMap } from "../sbp/codec.js";
import { SidebandClient } from "./sideband-client.js";
import { decodeFrame, encodeControl } from "../sbp/frame.js";
import type { SbpSocket } from "../sbp/session.js";

const USER_ID = entityId<"user">("550e8400-e29b-41d4-a716-446655440000");
const DEVICE_ID = entityId<"device">("660e8400-e29b-41d4-a716-446655440000");
const NOW = new Date("2026-10-13T20:00:00.000Z");

class ServerSocket implements SbpSocket {
  binaryType: BinaryType = "blob";
  readyState = 1;
  listeners = new Map<string, Array<(event: never) => void>>();

  send(data: ArrayBufferView | ArrayBuffer) {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const frame = decodeFrame(bytes);
    if (frame.kind === "control" && frame.opcode === 0)
      queueMicrotask(() => this.message(encodeControl(1, authenticated())));
    if (frame.kind === "command" && frame.opcode === 1)
      queueMicrotask(() =>
        this.message(
          encodeSbp([
            1,
            requestRef(frame.requestId),
            0,
            [1, accountSnapshot()],
          ]),
        ),
      );
  }
  close() {}
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  message(data: Uint8Array) {
    this.listeners
      .get("message")
      ?.forEach((listener) => listener({ data } as never));
  }
  open() {
    this.listeners.get("open")?.forEach((listener) => listener({} as never));
  }
  disconnect(code = 1006, reason = "") {
    this.listeners
      .get("close")
      ?.forEach((listener) => listener({ code, reason } as never));
  }
  fail() {
    this.listeners.get("error")?.forEach((listener) => listener({} as never));
    this.disconnect();
  }
}

function authenticated() {
  return wireMap([
    [0, 1],
    [1, entityRef("user", USER_ID)],
    [2, entityRef("device", DEVICE_ID)],
    [3, []],
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
        [6, false],
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
  const user = wireMap([
    [0, entityRef("user", USER_ID)],
    [1, "burger"],
    [2, "Burger"],
    [5, NOW],
    [6, 0],
  ]);
  return wireMap([
    [0, 1],
    [2, user],
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

describe("SidebandClient", () => {
  afterEach(() => vi.useRealTimers());

  it("owns authentication and initial snapshot hydration", async () => {
    const socket = new ServerSocket();
    const credentials = {
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const client = new SidebandClient({
      clientFamily: "sideband-desktop",
      clientVersion: "0.3.0",
      credentials,
      session: { socketFactory: () => socket },
    });
    const credential = {
      instanceDomain: "example.com",
      userId: USER_ID,
      deviceId: DEVICE_ID,
      token: new TextEncoder().encode("secret"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      username: "burger",
    };

    const connecting = client.connect(
      { domain: "example.com", baseUrl: "https://example.com" },
      credential,
    );
    await Promise.resolve();
    socket.open();
    await connecting;

    expect(client.state.connection).toBe("online");
    expect(client.accountState?.ownUserId).toBe(USER_ID);
    expect(client.accountState?.users.get(USER_ID)?.displayName).toBe("Burger");
    expect(credentials.save).toHaveBeenCalledWith(credential);

    client.disconnect();
    expect(client.state).toEqual({ connection: "offline" });
  });

  it("rejects expired stored credentials before opening a socket", async () => {
    const credentials = {
      load: vi.fn().mockResolvedValue({
        instanceDomain: "example.com",
        userId: USER_ID,
        deviceId: DEVICE_ID,
        token: new Uint8Array([1]),
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
      save: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const socketFactory = vi.fn();
    const client = new SidebandClient({
      clientFamily: "test",
      clientVersion: "1",
      credentials,
      session: { socketFactory },
    });
    await expect(
      client.connectStored(
        { domain: "example.com", baseUrl: "https://example.com" },
        { instanceDomain: "example.com", userId: USER_ID },
      ),
    ).rejects.toThrow("expired");
    expect(credentials.delete).toHaveBeenCalledOnce();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("retains account state and reconnects after an unexpected socket close", async () => {
    vi.useFakeTimers();
    const sockets = [new ServerSocket(), new ServerSocket()];
    const credential = {
      instanceDomain: "example.com",
      userId: USER_ID,
      deviceId: DEVICE_ID,
      token: new TextEncoder().encode("secret"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      username: "burger",
    };
    const credentials = {
      load: vi.fn().mockResolvedValue(credential),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const socketFactory = vi
      .fn()
      .mockImplementation(() => sockets[socketFactory.mock.calls.length - 1]!);
    const client = new SidebandClient({
      clientFamily: "sideband-desktop",
      clientVersion: "0.3.0",
      credentials,
      session: { socketFactory },
    });

    const connecting = client.connect(
      { domain: "example.com", baseUrl: "https://example.com" },
      credential,
    );
    await Promise.resolve();
    sockets[0]!.open();
    await connecting;

    sockets[0]!.disconnect();
    expect(client.state.connection).toBe("reconnecting");
    expect(client.accountState?.ownUserId).toBe(USER_ID);

    await vi.advanceTimersByTimeAsync(0);
    expect(socketFactory).toHaveBeenCalledTimes(2);
    sockets[1]!.open();
    await vi.waitFor(() => expect(client.state.connection).toBe("online"));
    expect(client.accountState?.ownUserId).toBe(USER_ID);

    client.disconnect();
  });

  it("retries immediately when requested during reconnect backoff", async () => {
    vi.useFakeTimers();
    const sockets = [
      new ServerSocket(),
      new ServerSocket(),
      new ServerSocket(),
    ];
    const credential = {
      instanceDomain: "example.com",
      userId: USER_ID,
      deviceId: DEVICE_ID,
      token: new TextEncoder().encode("secret"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      username: "burger",
    };
    const credentials = {
      load: vi.fn().mockResolvedValue(credential),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const socketFactory = vi
      .fn()
      .mockImplementation(() => sockets[socketFactory.mock.calls.length - 1]!);
    const client = new SidebandClient({
      clientFamily: "sideband-desktop",
      clientVersion: "0.3.0",
      credentials,
      session: { socketFactory },
    });

    const connecting = client.connect(
      { domain: "example.com", baseUrl: "https://example.com" },
      credential,
    );
    await Promise.resolve();
    sockets[0]!.open();
    await connecting;

    sockets[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(socketFactory).toHaveBeenCalledTimes(2);
    sockets[1]!.fail();
    await Promise.resolve();

    client.retryConnection();
    await vi.advanceTimersByTimeAsync(0);
    expect(socketFactory).toHaveBeenCalledTimes(3);
    sockets[2]!.open();
    await vi.waitFor(() => expect(client.state.connection).toBe("online"));
    client.disconnect();
  });
});
