import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPrivateTransferKey,
  encryptPrivateTransferControl,
} from "./private-transfer-protocol.js";
import { PrivateTransferTransport } from "./private-transfer-transport.js";

const instanceEndpoint = {
  domain: "instance.test",
  baseUrl: "https://instance.test",
};

const mocks = vi.hoisted(() => ({
  channel: undefined as FakeChannel | undefined,
  socket: undefined as FakeSocket | undefined,
  socketArgs: undefined as unknown[] | undefined,
  joinStatus: "ok",
  joinPayload: undefined as unknown,
}));

class FakeChannel {
  listeners = new Map<string, (payload: unknown) => void>();
  push = vi.fn();
  leave = vi.fn();
  join = vi.fn(() => response());
  on(event: string, listener: (payload: unknown) => void) {
    this.listeners.set(event, listener);
  }
  onError(listener: (payload: unknown) => void) {
    this.listeners.set("error", listener);
  }
  onClose(listener: (payload: unknown) => void) {
    this.listeners.set("close", listener);
  }
  emit(event: string, payload?: unknown) {
    this.listeners.get(event)?.(payload);
  }
}

class FakeSocket {
  connect = vi.fn();
  disconnect = vi.fn();
  channel = vi.fn(() => {
    mocks.channel = new FakeChannel();
    return mocks.channel;
  });
}

function response() {
  const value = {
    receive(status: string, callback: (payload?: unknown) => void) {
      if (status === mocks.joinStatus)
        queueMicrotask(() => callback(mocks.joinPayload));
      return value;
    },
  };
  return value;
}

vi.mock("phoenix", () => ({
  Socket: class {
    constructor(...args: unknown[]) {
      mocks.socketArgs = args;
      mocks.socket = new FakeSocket();
      return mocks.socket;
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channel = undefined;
  mocks.socket = undefined;
  mocks.socketArgs = undefined;
  mocks.joinStatus = "ok";
  mocks.joinPayload = undefined;
});

describe("PrivateTransferTransport", () => {
  it("connects with a ticket and relays encrypted binary frames", async () => {
    const key = await createPrivateTransferKey();
    const callbacks = {
      onFrame: vi.fn(),
      onPeerState: vi.fn(),
      onDisconnect: vi.fn(),
      onError: vi.fn(),
    };
    const transport = new PrivateTransferTransport(key, callbacks);
    await transport.connect(instanceEndpoint, "room-id", "single-use-ticket");

    expect(mocks.socketArgs).toEqual([
      "https://instance.test/transfers",
      { params: { ticket: "single-use-ticket" } },
    ]);
    expect(mocks.socket?.channel).toHaveBeenCalledWith("transfer:room-id");
    await transport.sendControl({
      kind: "cancel",
      fileId: "ccf7717f-9562-4ff3-a8b2-b68a61aa14d1",
    });
    expect(mocks.channel?.push).toHaveBeenCalledWith(
      "frame",
      expect.any(ArrayBuffer),
    );
  });

  it("decrypts incoming frames and rejects malformed ones", async () => {
    const key = await createPrivateTransferKey();
    const callbacks = {
      onFrame: vi.fn(),
      onPeerState: vi.fn(),
      onDisconnect: vi.fn(),
      onError: vi.fn(),
    };
    const transport = new PrivateTransferTransport(key, callbacks);
    await transport.connect(instanceEndpoint, "room-id", "ticket");
    const control = {
      kind: "complete" as const,
      fileId: "ccf7717f-9562-4ff3-a8b2-b68a61aa14d1",
    };
    mocks.channel?.emit(
      "frame",
      (await encryptPrivateTransferControl(key, control)).buffer,
    );
    await vi.waitFor(() =>
      expect(callbacks.onFrame).toHaveBeenCalledWith({
        kind: "control",
        control,
      }),
    );

    mocks.channel?.emit("frame", { unexpected: true });
    expect(callbacks.onError).toHaveBeenCalled();
  });

  it("reports peer state and closes both channel and socket", async () => {
    const key = await createPrivateTransferKey();
    const callbacks = {
      onFrame: vi.fn(),
      onPeerState: vi.fn(),
      onDisconnect: vi.fn(),
      onError: vi.fn(),
    };
    const transport = new PrivateTransferTransport(key, callbacks);
    await transport.connect(instanceEndpoint, "room-id", "ticket");
    mocks.channel?.emit("peer", { state: "connected" });
    expect(callbacks.onPeerState).toHaveBeenCalledWith(true);

    transport.close();
    expect(mocks.channel?.leave).toHaveBeenCalled();
    expect(mocks.socket?.disconnect).toHaveBeenCalled();
    mocks.channel?.emit("close");
    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
  });

  it("reports socket events, disconnect reasons, and unclean closure", async () => {
    const key = await createPrivateTransferKey();
    const callbacks = {
      onFrame: vi.fn(),
      onPeerState: vi.fn(),
      onDisconnect: vi.fn(),
      onError: vi.fn(),
    };
    const transport = new PrivateTransferTransport(key, callbacks);
    await transport.connect(instanceEndpoint, "room-id", "ticket");

    mocks.channel?.emit("peer", { state: "disconnected" });
    mocks.channel?.emit("peer", { state: "unknown" });
    mocks.channel?.emit("disconnect", { reason: "peer_left" });
    mocks.channel?.emit("disconnect", {});
    mocks.channel?.emit("error", new Error("socket failed"));
    mocks.channel?.emit("close");

    expect(callbacks.onPeerState).toHaveBeenCalledWith(false);
    expect(callbacks.onPeerState).toHaveBeenCalledTimes(1);
    expect(callbacks.onDisconnect).toHaveBeenNthCalledWith(1, "peer_left");
    expect(callbacks.onDisconnect).toHaveBeenNthCalledWith(2, undefined);
    expect(callbacks.onDisconnect).toHaveBeenNthCalledWith(3);
    expect(callbacks.onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("accepts typed-array frames and sends encrypted chunks", async () => {
    const key = await createPrivateTransferKey();
    const callbacks = {
      onFrame: vi.fn(),
      onPeerState: vi.fn(),
      onDisconnect: vi.fn(),
      onError: vi.fn(),
    };
    const transport = new PrivateTransferTransport(key, callbacks);
    await transport.connect(instanceEndpoint, "room-id", "ticket");
    const control = {
      kind: "complete" as const,
      fileId: "ccf7717f-9562-4ff3-a8b2-b68a61aa14d1",
    };
    const frame = await encryptPrivateTransferControl(key, control);
    mocks.channel?.emit("frame", frame.subarray(0));
    await vi.waitFor(() => expect(callbacks.onFrame).toHaveBeenCalled());

    await transport.sendChunk(
      "ccf7717f-9562-4ff3-a8b2-b68a61aa14d1",
      0,
      new Uint8Array([1]),
    );
    expect(mocks.channel?.push).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate connections and sends while offline", async () => {
    const key = await createPrivateTransferKey();
    const transport = new PrivateTransferTransport(key, {
      onFrame: vi.fn(),
      onPeerState: vi.fn(),
      onDisconnect: vi.fn(),
      onError: vi.fn(),
    });
    await expect(
      transport.sendControl({
        kind: "cancel",
        fileId: "ccf7717f-9562-4ff3-a8b2-b68a61aa14d1",
      }),
    ).rejects.toThrow("offline");
    await transport.connect(instanceEndpoint, "room-id", "ticket");
    await expect(
      transport.connect(instanceEndpoint, "room-id", "ticket"),
    ).rejects.toThrow("active");
  });

  it.each([
    ["error", { reason: "membership_required" }, "membership_required"],
    ["error", {}, "server rejected"],
    ["timeout", undefined, "Timed out"],
  ])("reports %s join failures", async (status, payload, message) => {
    mocks.joinStatus = status;
    mocks.joinPayload = payload;
    const key = await createPrivateTransferKey();
    const transport = new PrivateTransferTransport(key, {
      onFrame: vi.fn(),
      onPeerState: vi.fn(),
      onDisconnect: vi.fn(),
      onError: vi.fn(),
    });
    await expect(
      transport.connect(instanceEndpoint, "room-id", "ticket"),
    ).rejects.toThrow(message);
  });
});
