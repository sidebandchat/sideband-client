import type { DeviceId, UserId } from "../entity-id.js";
import type { AccountSnapshot } from "../domain.js";
import type { InstanceEndpoint } from "../instance-endpoint.js";
import type { InstancePolicy } from "../instance/instance-policy.js";
import { decodeEntityRef, entityRef, wireMap } from "./codec.js";
import {
  decodeFrame,
  encodeCommand,
  encodeControl,
  type SbpFrame,
} from "./frame.js";
import { decodeAccountSnapshot } from "./records.js";

export type SbpAuthenticatedSession = {
  protocolVersion: 1;
  userId: UserId;
  deviceId: DeviceId;
  capabilities: number[];
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
  policy: InstancePolicy;
};

export type SbpSocket = {
  binaryType: BinaryType;
  readyState: number;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
};

export type SbpSocketFactory = (url: string, protocols: string[]) => SbpSocket;

type SetTimer = (
  callback: () => void,
  delay?: number,
) => ReturnType<typeof setTimeout>;
type ClearTimer = (timer: ReturnType<typeof setTimeout>) => void;

export type SbpSessionOptions = {
  socketFactory?: SbpSocketFactory;
  randomUuid?: () => string;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  commandTimeoutMs?: number;
  onListenerError?: (reason: unknown) => void;
};

export type SbpSessionStatus =
  | { state: "connecting" }
  | { state: "online"; session: SbpAuthenticatedSession }
  | { state: "offline"; reason?: unknown };

export class SbpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SbpProtocolError";
  }
}

type PendingRequest = {
  opcode: number;
  resolve: (payload: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class SbpSession {
  private socket?: SbpSocket;
  private authenticated?: SbpAuthenticatedSession;
  private accountSnapshot?: AccountSnapshot;
  private connectResolve?: (session: SbpAuthenticatedSession) => void;
  private connectReject?: (reason: unknown) => void;
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<
    (frame: Extract<SbpFrame, { kind: "event" }>) => void
  >();
  private controlListeners = new Set<
    (frame: Extract<SbpFrame, { kind: "control" }>) => void
  >();
  private statusListeners = new Set<(status: SbpSessionStatus) => void>();
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private nonce = 0;
  private readonly socketFactory: SbpSocketFactory;
  private readonly randomUuid: () => string;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly commandTimeoutMs: number;
  private readonly onListenerError: (reason: unknown) => void;

  constructor(options: SbpSessionOptions = {}) {
    this.socketFactory = options.socketFactory ?? browserSocketFactory;
    this.randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
    this.setTimer =
      options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.onListenerError = options.onListenerError ?? (() => undefined);
  }

  get identity() {
    return this.authenticated;
  }

  get initialAccountSnapshot() {
    return this.accountSnapshot;
  }

  connect(input: {
    endpoint: InstanceEndpoint;
    credential: Uint8Array;
    deviceId: DeviceId;
    clientFamily: string;
    clientVersion: string;
    capabilities?: number[];
  }): Promise<SbpAuthenticatedSession> {
    if (this.socket) throw new Error("An SBP session is already active");
    if (input.credential.byteLength < 1 || input.credential.byteLength > 8_192)
      throw new TypeError("Invalid SBP access credential");

    this.emitStatus({ state: "connecting" });
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      const socket = this.socketFactory(
        sbpWebSocketUrl(input.endpoint),
        input.endpoint.sbp?.subprotocols ?? ["sideband.cbor.v1"],
      );
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => {
        try {
          this.openSession(input);
        } catch (reason) {
          socket.close(4000, "Could not open SBP session");
          this.closed(
            reason instanceof Error
              ? reason
              : new Error("Could not open SBP session"),
          );
        }
      });
      socket.addEventListener("message", (event) =>
        this.receive(event.data, input),
      );
      // Browsers follow a WebSocket error with a close event. Wait for that
      // event so its code and reason are not replaced by a generic error.
      socket.addEventListener("error", () => undefined);
      socket.addEventListener("close", (event) =>
        this.closed(
          new Error(
            event.reason || `SBP connection closed (${event.code ?? 1006})`,
          ),
        ),
      );
    });
  }

  command(opcode: number, payload: unknown): Promise<unknown> {
    return this.commandWithHandle(opcode, payload).response;
  }

  commandWithHandle(
    opcode: number,
    payload: unknown,
    requestId = this.randomUuid(),
  ) {
    const socket = this.requireOnline();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(requestId);
        reject(new Error(`SBP command ${opcode} timed out`));
      }, this.commandTimeoutMs);
      this.pending.set(requestId, { opcode, resolve, reject, timer });
      try {
        socket.send(encodeCommand(requestId, opcode, payload));
      } catch (reason) {
        this.clearTimer(timer);
        this.pending.delete(requestId);
        reject(reason);
      }
    });
    return { requestId, response };
  }

  control(opcode: number, payload: unknown) {
    this.requireOnline().send(encodeControl(opcode, payload));
  }

  subscribeEvents(
    listener: (frame: Extract<SbpFrame, { kind: "event" }>) => void,
  ) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeControls(
    listener: (frame: Extract<SbpFrame, { kind: "control" }>) => void,
  ) {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  subscribeStatus(listener: (status: SbpSessionStatus) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  disconnect() {
    this.socket?.close(1000, "Client disconnected");
    this.closed(new Error("SBP session disconnected"));
  }

  private receive(data: unknown, input: Parameters<SbpSession["connect"]>[0]) {
    try {
      const bytes = binaryData(data);
      const frame = decodeFrame(bytes);
      if (frame.kind === "control") this.receiveControl(frame, input);
      else if (frame.kind === "response") this.receiveResponse(frame);
      else if (frame.kind === "event") this.notify(this.eventListeners, frame);
      else throw new TypeError("The server sent a command frame");
    } catch (reason) {
      // Browser WebSocket clients may only initiate close code 1000 or an
      // application-defined code in the 3000-4999 range. RFC code 1007 is
      // valid on the wire, but passing it to WebSocket.close() throws.
      this.socket?.close(4007, "Invalid SBP frame");
      this.closed(
        reason instanceof Error ? reason : new Error("Invalid SBP frame"),
      );
    }
  }

  private receiveControl(
    frame: Extract<SbpFrame, { kind: "control" }>,
    input: Parameters<SbpSession["connect"]>[0],
  ) {
    switch (frame.opcode) {
      case 1: {
        const { session, accountSnapshot, realtimeSnapshot } = sessionReady(
          frame.payload,
        );
        if (session.deviceId !== input.deviceId)
          throw new TypeError("The server authenticated a different device");
        this.authenticated = session;
        this.accountSnapshot = accountSnapshot;
        this.notify(this.controlListeners, {
          kind: "control",
          opcode: 38,
          payload: realtimeSnapshot,
        });
        this.scheduleHeartbeat();
        this.emitStatus({ state: "online", session });
        this.connectResolve?.(session);
        this.connectResolve = undefined;
        this.connectReject = undefined;
        break;
      }
      case 2:
        throw sessionRejected(frame.payload);
      case 5:
        this.socket?.send(encodeControl(6, frame.payload));
        return;
      case 6:
        return;
      case 7:
        throw disconnectError(frame.payload);
    }
    this.notify(this.controlListeners, frame);
  }

  private notify<Frame>(listeners: Set<(frame: Frame) => void>, frame: Frame) {
    listeners.forEach((listener) => {
      try {
        listener(frame);
      } catch (reason) {
        this.onListenerError(reason);
      }
    });
  }

  private openSession(input: Parameters<SbpSession["connect"]>[0]) {
    this.socket?.send(
      encodeControl(
        0,
        wireMap([
          [0, input.credential],
          [1, entityRef("device", input.deviceId)],
          [2, input.clientFamily],
          [3, input.clientVersion],
          [5, input.capabilities ?? []],
        ]),
      ),
    );
  }

  private receiveResponse(frame: Extract<SbpFrame, { kind: "response" }>) {
    const request = this.pending.get(frame.requestId);
    if (!request) return;
    this.pending.delete(frame.requestId);
    this.clearTimer(request.timer);
    if (frame.status === "ok") {
      if (frame.opcode !== request.opcode) {
        request.reject(
          new TypeError("SBP response opcode does not match its command"),
        );
        return;
      }
      request.resolve(frame.payload);
    } else request.reject(protocolError(frame.payload));
  }

  private scheduleHeartbeat() {
    if (!this.authenticated) return;
    this.heartbeatTimer = this.setTimer(() => {
      if (!this.socket || !this.authenticated) return;
      this.socket.send(encodeControl(5, ++this.nonce));
      this.scheduleHeartbeat();
    }, this.authenticated.heartbeatIntervalMs);
  }

  private requireOnline() {
    if (!this.socket || !this.authenticated)
      throw new Error("The SBP session is not authenticated");
    return this.socket;
  }

  private failConnection(reason: unknown) {
    this.connectReject?.(reason);
    this.connectResolve = undefined;
    this.connectReject = undefined;
  }

  private closed(reason: Error) {
    if (
      !this.socket &&
      !this.authenticated &&
      !this.connectReject &&
      this.pending.size === 0
    )
      return;
    if (this.heartbeatTimer) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.authenticated = undefined;
    this.accountSnapshot = undefined;
    this.socket = undefined;
    this.failConnection(reason);
    for (const request of this.pending.values()) {
      this.clearTimer(request.timer);
      request.reject(reason);
    }
    this.pending.clear();
    this.emitStatus({ state: "offline", reason });
  }

  private emitStatus(status: SbpSessionStatus) {
    this.statusListeners.forEach((listener) => listener(status));
  }
}

function sessionReady(payload: unknown) {
  const map = integerMap(payload);
  if (map.get(0) !== 1)
    throw new TypeError("Unsupported negotiated SBP version");
  const session: SbpAuthenticatedSession = {
    protocolVersion: 1,
    userId: decodeEntityRef(map.get(1), "user"),
    deviceId: decodeEntityRef(map.get(2), "device"),
    capabilities: integerArray(map.get(3)),
    heartbeatIntervalMs: positiveInteger(map.get(4)),
    idleTimeoutMs: positiveInteger(map.get(5)),
    policy: instancePolicy(map.get(6)),
  };
  return {
    session,
    accountSnapshot: decodeAccountSnapshot(map.get(7)),
    realtimeSnapshot: map.get(8),
  };
}

function sessionRejected(value: unknown) {
  const map = integerMap(value);
  const error = protocolError(value);
  return new SbpProtocolError(error.code, error.message, {
    retryable: boolean(map.get(2)),
    retryAfterMs: map.has(3) ? nonNegativeInteger(map.get(3)) : undefined,
  });
}

function instancePolicy(value: unknown): InstancePolicy {
  const map = integerMap(value);
  return {
    attachmentsEnabled: boolean(map.get(0)),
    maximumAttachmentBytes: nonNegativeInteger(map.get(1)),
    maximumAttachmentsPerMessage: nonNegativeInteger(map.get(2)),
    maximumAttachmentBytesPerMessage: nonNegativeInteger(map.get(3)),
    privateConversationsEnabled: boolean(map.get(4)),
    privateFileTransfersEnabled: boolean(map.get(5)),
    gifSearchEnabled: boolean(map.get(6)),
    callEmptyGraceMs: nonNegativeInteger(map.get(7)),
    privateInviteTimeoutMs: nonNegativeInteger(map.get(8)),
    privateReconnectGraceMs: nonNegativeInteger(map.get(9)),
  };
}

function protocolError(value: unknown) {
  const map = integerMap(value);
  const code = nonNegativeInteger(map.get(0));
  const message =
    typeof map.get(1) === "string"
      ? (map.get(1) as string)
      : `SBP error ${code}`;
  return new SbpProtocolError(code, message, value);
}

function disconnectError(value: unknown) {
  const error = protocolError(value);
  return new SbpProtocolError(
    error.code,
    `SBP disconnected: ${error.message}`,
    value,
  );
}

function integerMap(value: unknown): Map<number, unknown> {
  if (
    !(value instanceof Map) ||
    [...value.keys()].some((key) => !Number.isInteger(key))
  )
    throw new TypeError("Expected an SBP integer-keyed map");
  return value as Map<number, unknown>;
}

function integerArray(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !Number.isInteger(entry) || entry < 0)
  )
    throw new TypeError("Expected an SBP integer array");
  return value as number[];
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError("Expected a positive integer");
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError("Expected a non-negative integer");
  return value as number;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Expected a boolean");
  return value;
}

function binaryData(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("SBP requires binary WebSocket messages");
}

function sbpWebSocketUrl(endpoint: InstanceEndpoint) {
  const url = new URL(endpoint.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = endpoint.sbp?.websocketPath ?? "/sbp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function browserSocketFactory(url: string, protocols: string[]): SbpSocket {
  return new WebSocket(url, protocols) as unknown as SbpSocket;
}
