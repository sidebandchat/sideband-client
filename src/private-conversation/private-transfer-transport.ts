import { Socket, type Channel } from "phoenix";
import type { InstanceEndpoint } from "../instance-endpoint.js";
import {
  decryptPrivateTransferFrame,
  encryptPrivateTransferChunk,
  encryptPrivateTransferControl,
  type PrivateTransferControl,
  type PrivateTransferFrame,
} from "./private-transfer-protocol.js";

export type PrivateTransferTransportCallbacks = {
  onFrame: (frame: PrivateTransferFrame) => void;
  onPeerState: (connected: boolean) => void;
  onDisconnect: (reason?: string) => void;
  onError: (reason: unknown) => void;
};

export class PrivateTransferTransport {
  private socket?: Socket;
  private channel?: Channel;
  private closed = false;

  constructor(
    private readonly key: CryptoKey,
    private readonly callbacks: PrivateTransferTransportCallbacks,
  ) {}

  async connect(endpoint: InstanceEndpoint, roomId: string, ticket: string) {
    if (this.socket) throw new Error("Private transfer transport is active");
    this.closed = false;
    this.socket = new Socket(
      `${endpoint.baseUrl.replace(/\/$/u, "")}/transfers`,
      { params: { ticket } },
    );
    this.socket.connect();
    this.channel = this.socket.channel(`transfer:${roomId}`);
    this.channel.on("frame", (payload) => {
      const bytes = binaryPayload(payload);
      if (!bytes) {
        this.callbacks.onError(new Error("Invalid private transfer frame"));
        return;
      }
      void decryptPrivateTransferFrame(this.key, bytes)
        .then(this.callbacks.onFrame)
        .catch(this.callbacks.onError);
    });
    this.channel.on("peer", (payload) => {
      const state = (payload as { state?: unknown } | undefined)?.state;
      if (state === "connected" || state === "disconnected")
        this.callbacks.onPeerState(state === "connected");
    });
    this.channel.on("disconnect", (payload) => {
      this.callbacks.onDisconnect(
        typeof (payload as { reason?: unknown } | undefined)?.reason ===
          "string"
          ? String((payload as { reason: string }).reason)
          : undefined,
      );
    });
    this.channel.onError((reason) => this.callbacks.onError(reason));
    this.channel.onClose(() => {
      if (!this.closed) this.callbacks.onDisconnect();
    });
    await joinChannel(this.channel);
  }

  async sendControl(control: PrivateTransferControl) {
    const frame = await encryptPrivateTransferControl(this.key, control);
    this.push(frame);
  }

  async sendChunk(fileId: string, chunk: number, bytes: Uint8Array) {
    const frame = await encryptPrivateTransferChunk(
      this.key,
      fileId,
      chunk,
      bytes,
    );
    this.push(frame);
  }

  close() {
    this.closed = true;
    this.channel?.leave();
    this.socket?.disconnect();
    this.channel = undefined;
    this.socket = undefined;
  }

  private push(frame: Uint8Array) {
    if (!this.channel) throw new Error("Private transfer transport is offline");
    this.channel.push(
      "frame",
      frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength,
      ) as ArrayBuffer,
    );
  }
}

function joinChannel(channel: Channel) {
  return new Promise<void>((resolve, reject) => {
    channel
      .join()
      .receive("ok", () => resolve())
      .receive("error", (reason) =>
        reject(new Error(transferJoinError(reason))),
      )
      .receive("timeout", () =>
        reject(new Error("Timed out connecting the private transfer")),
      );
  });
}

function transferJoinError(reason: unknown) {
  const value = (reason as { reason?: unknown } | undefined)?.reason;
  return typeof value === "string"
    ? `Private transfer was rejected: ${value}`
    : "The server rejected the private transfer";
}

function binaryPayload(payload: unknown) {
  if (payload instanceof ArrayBuffer) return payload;
  if (ArrayBuffer.isView(payload)) {
    const copy = new Uint8Array(payload.byteLength);
    copy.set(
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    );
    return copy.buffer;
  }
  return undefined;
}
