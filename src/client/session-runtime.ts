import type {
  CallSession,
  PrivateConversationSession,
  PrivateConversationRealtimeEvent,
  PrivateConversationMessage,
  PrivateConversationView,
  PrivateTransfer,
} from "../domain.js";
import type {
  CallId,
  PrivateConversationId,
  PrivateTransferId,
  PrivateMessageId,
  UserId,
} from "../entity-id.js";
import { decodeEntityRef } from "../sbp/codec.js";
import { SbpCallsClient } from "../calls/calls-client.js";
import { SbpPrivateConversationsClient } from "../private-conversation/private-conversations-client.js";
import {
  decodeCall,
  decodePrivateConversation,
  decodePrivateTransfer,
} from "../sbp/records.js";
import type { SbpFrame } from "../sbp/frame.js";
import type { SbpSession, SbpSessionStatus } from "../sbp/session.js";
import type {
  CallMediaAdapter,
  PrivateCryptoAdapter,
  PrivateCryptoHandle,
  PrivateTransferAdapter,
  CallMediaPreferences,
} from "./platform-adapters.js";
import type { InstanceEndpoint } from "../instance-endpoint.js";
import { MediaControls } from "../calls/media-controls.js";
import {
  arrayValue,
  bytesValue,
  mapValue,
  required,
  unsignedValue,
} from "../sbp/value.js";

export type LiveSessionState = {
  calls: ReadonlyMap<CallId, CallSession>;
  privateConversations: ReadonlyMap<
    PrivateConversationId,
    PrivateConversationSession
  >;
  transfers: ReadonlyMap<PrivateTransferId, PrivateTransfer>;
  privateMessages: ReadonlyMap<
    PrivateConversationId,
    readonly PrivateConversationMessage[]
  >;
};

export class SessionRuntime {
  readonly mediaControls?: MediaControls;
  private current: LiveSessionState = {
    calls: new Map(),
    privateConversations: new Map(),
    transfers: new Map(),
    privateMessages: new Map(),
  };
  private listeners = new Set<() => void>();
  private privateEventListeners = new Set<
    (event: PrivateConversationRealtimeEvent) => void
  >();
  private unsubscribers: Array<() => void> = [];
  private pending: Promise<unknown> = Promise.resolve();
  private cryptoHandles = new Map<PrivateConversationId, PrivateCryptoHandle>();
  private privateInvites = new Map<PrivateConversationId, Uint8Array>();
  private interruptedPrivateConversations = new Set<PrivateConversationId>();
  private connectingTransfers = new Map<PrivateTransferId, Promise<void>>();
  private transferKeys = new Map<PrivateTransferId, Uint8Array>();
  private transferProgress = new Map<PrivateTransferId, number>();

  constructor(
    private readonly session: SbpSession,
    readonly calls: SbpCallsClient,
    readonly privateConversations: SbpPrivateConversationsClient,
    private readonly endpoint: InstanceEndpoint,
    private readonly ownUserId: UserId,
    private readonly media?: CallMediaAdapter,
    private readonly crypto?: PrivateCryptoAdapter,
    private readonly transferAdapter?: PrivateTransferAdapter,
    mediaPreferences?: CallMediaPreferences,
  ) {
    if (media) this.mediaControls = new MediaControls(media, mediaPreferences);
  }

  get state() {
    return this.current;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  subscribePrivateEvents = (
    listener: (event: PrivateConversationRealtimeEvent) => void,
  ) => {
    this.privateEventListeners.add(listener);
    return () => this.privateEventListeners.delete(listener);
  };

  privateConversationView(id?: PrivateConversationId): PrivateConversationView {
    const session = id
      ? this.current.privateConversations.get(id)
      : [...this.current.privateConversations.values()].find(
          (item) => item.state !== "ended",
        );
    if (!session) return { status: "idle", messages: [] };
    const status: PrivateConversationView["status"] =
      session.state === "ringing"
        ? session.initiatorId === this.ownUserId
          ? "outgoing"
          : "incoming"
        : session.state === "negotiating" || session.state === "reconnecting"
          ? "connecting"
          : session.state === "active"
            ? "active"
            : "idle";
    return {
      session,
      status,
      messages: (this.current.privateMessages.get(session.id) ?? []).map(
        (message) => ({
          ...message,
          attachments: message.transferIds?.flatMap((transferId) => {
            const transfer = this.current.transfers.get(transferId);
            if (!transfer?.filename || !transfer.mediaType || !transfer.sha256)
              return [];
            const state =
              transfer.state === "offered"
                ? transfer.senderId === this.ownUserId
                  ? "waiting"
                  : "offered"
                : transfer.state === "accepted"
                  ? "waiting"
                  : transfer.state;
            return [
              {
                transferId,
                filename: transfer.filename,
                mediaType: transfer.mediaType,
                byteSize: transfer.byteSize,
                sha256: transfer.sha256,
                state,
                progress: this.transferProgress.get(transferId) ?? 0,
              },
            ];
          }),
        }),
      ),
    };
  }

  start() {
    if (this.unsubscribers.length) return;
    const unsubscribeStatus = this.session.subscribeStatus?.((status) =>
      this.receiveStatus(status),
    );
    this.unsubscribers = [
      this.session.subscribeEvents((frame) => this.receiveEvent(frame)),
      this.session.subscribeControls((frame) => this.receiveControl(frame)),
      ...(unsubscribeStatus ? [unsubscribeStatus] : []),
    ];
    void this.mediaControls?.start();
  }

  stop() {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.current = {
      calls: new Map(),
      privateConversations: new Map(),
      transfers: new Map(),
      privateMessages: new Map(),
    };
    for (const handle of this.cryptoHandles.values())
      void this.crypto?.close(handle);
    this.cryptoHandles.clear();
    this.privateInvites.clear();
    this.interruptedPrivateConversations.clear();
    for (const transferId of this.connectingTransfers.keys())
      void this.transferAdapter?.disconnect(transferId);
    this.connectingTransfers.clear();
    this.transferKeys.clear();
    this.transferProgress.clear();
    this.mediaControls?.stop();
  }

  private receiveStatus(status: SbpSessionStatus) {
    if (status.state !== "offline") return;
    const interrupted = [...this.current.privateConversations.values()].filter(
      (session) => session.state !== "ended",
    );
    if (!interrupted.length) return;

    for (const session of interrupted)
      this.interruptedPrivateConversations.add(session.id);
    for (const handle of this.cryptoHandles.values())
      void this.crypto?.close(handle);
    this.cryptoHandles.clear();
    this.privateInvites.clear();
    for (const transferId of this.connectingTransfers.keys())
      void this.transferAdapter?.disconnect(transferId);
    this.connectingTransfers.clear();
    this.transferKeys.clear();
    this.transferProgress.clear();
    this.set({
      ...this.current,
      privateConversations: new Map(
        [...this.current.privateConversations].filter(
          ([, session]) => session.state === "ended",
        ),
      ),
      transfers: new Map(),
      privateMessages: new Map(),
    });
  }

  acceptCall(callId: CallId) {
    return this.enqueue(async () => {
      const activePrivate = [
        ...this.current.privateConversations.values(),
      ].find((item) => item.state !== "ended");
      if (activePrivate) await this.privateConversations.end(activePrivate.id);
      await this.calls.join(callId);
      if (!this.media) return;
      const call = this.current.calls.get(callId);
      if (!call) throw new Error("The call is not available");
      try {
        const admission = await this.calls.admit(callId);
        await this.media.connect({
          endpoint: this.endpoint,
          localUserId: this.ownUserId,
          call,
          admission,
        });
        await this.calls.mediaConnected(callId);
      } catch (reason) {
        await this.media.disconnect(callId).catch(() => undefined);
        await this.calls.leave(callId).catch(() => undefined);
        throw reason;
      }
    });
  }

  leaveCall(callId: CallId) {
    return this.enqueue(async () => {
      await this.media?.disconnect(callId);
      await this.calls.leave(callId);
    });
  }

  async startCall(...args: Parameters<SbpCallsClient["start"]>) {
    const call = await this.calls.start(...args);
    this.upsert("calls", call, (item) => item.id);
    return call;
  }

  async startPrivateConversation(peerId: UserId) {
    if (!this.crypto)
      throw new Error("Private conversation encryption is unavailable");
    const offer = await this.crypto.createOffer(peerId);
    const session = await this.privateConversations.start(
      peerId,
      offer.payload,
    );
    this.cryptoHandles.set(session.id, offer.handle);
    this.upsert("privateConversations", session, (item) => item.id);
    return session;
  }

  async sendPrivateMessage(
    privateConversationId: PrivateConversationId,
    messageId: PrivateMessageId,
    body: string,
    timestamp = new Date().toISOString(),
    transferIds: PrivateTransferId[] = [],
  ) {
    const handle = this.cryptoHandles.get(privateConversationId);
    const session = this.current.privateConversations.get(
      privateConversationId,
    );
    const trimmed = body.trim();
    if (
      !handle ||
      !session ||
      session.state !== "active" ||
      (!trimmed && transferIds.length === 0)
    )
      return false;
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        kind: "message",
        id: messageId,
        body: trimmed,
        timestamp,
        transferIds,
      }),
    );
    const ciphertext = await this.crypto!.encrypt(handle, plaintext);
    await this.privateConversations.signal(privateConversationId, ciphertext);
    this.appendPrivateMessage({
      id: messageId,
      privateConversationId,
      senderId: this.ownUserId,
      body: trimmed,
      timestamp,
      transferIds,
    });
    return true;
  }

  async offerPrivateTransfer(
    privateConversationId: PrivateConversationId,
    input: {
      resource: unknown;
      filename: string;
      mediaType: string;
      byteSize: number;
    },
  ) {
    if (!this.transferAdapter || !this.crypto)
      throw new Error("Private file transfers are unavailable");
    const handle = this.cryptoHandles.get(privateConversationId);
    if (!handle) throw new Error("Private encryption is not ready");
    const prepared = await this.transferAdapter.prepare(input);
    const transfer = await this.privateConversations.offerTransfer({
      privateConversationId,
      byteSize: input.byteSize,
    });
    const describedTransfer = {
      ...transfer,
      filename: input.filename,
      mediaType: input.mediaType,
      sha256: prepared.sha256,
    };
    this.transferKeys.set(transfer.id, prepared.key);
    await this.transferAdapter.registerSource(transfer.id, input.resource);
    this.mergeTransfer(describedTransfer);
    const offerSignal = await this.crypto.encrypt(
      handle,
      new TextEncoder().encode(
        JSON.stringify({
          kind: "transfer-offer",
          transferId: transfer.id,
          filename: input.filename,
          mediaType: input.mediaType,
          byteSize: input.byteSize,
          sha256: [...prepared.sha256],
          key: [...prepared.key],
        }),
      ),
    );
    await this.privateConversations.signal(privateConversationId, offerSignal);
    return describedTransfer;
  }

  acceptPrivateConversation(
    id: PrivateConversationId,
    encryptedAnswer?: Uint8Array,
  ) {
    return this.enqueue(async () => {
      const activeCall = [...this.current.calls.values()].find(
        (item) => !["ended", "declined", "expired"].includes(item.state),
      );
      if (activeCall) await this.calls.leave(activeCall.id);
      let answer = encryptedAnswer;
      if (this.crypto) {
        const session = this.current.privateConversations.get(id);
        const payload = this.privateInvites.get(id);
        if (!session || !payload)
          throw new Error("The private invitation is unavailable");
        const accepted = await this.crypto.acceptOffer({ session, payload });
        answer = accepted.payload;
        this.cryptoHandles.set(id, accepted.handle);
      }
      if (!answer) throw new Error("An encrypted private answer is required");
      await this.privateConversations.accept(id, answer);
    });
  }

  declinePrivateConversation(id: PrivateConversationId) {
    return this.finishPrivateConversation(id, "decline");
  }

  endPrivateConversation(id: PrivateConversationId) {
    return this.finishPrivateConversation(id, "end");
  }

  async acceptTransfer(transferId: PrivateTransferId) {
    const transfer = this.requireTransfer(transferId);
    const accepted = await this.privateConversations.actOnTransfer(
      transfer.privateConversationId,
      transferId,
      "accept",
    );
    const transferWithMetadata = this.mergeTransfer(accepted);
    await this.connectTransfer(transferWithMetadata);
    return transferWithMetadata;
  }

  async cancelTransfer(transferId: PrivateTransferId) {
    return this.finishTransfer(transferId, "cancel");
  }

  async declineTransfer(transferId: PrivateTransferId) {
    const transfer = this.requireTransfer(transferId);
    const updated = await this.privateConversations.actOnTransfer(
      transfer.privateConversationId,
      transferId,
      "decline",
    );
    this.mergeTransfer(updated);
    return updated;
  }

  showTransferInFolder(transferId: PrivateTransferId) {
    if (!this.transferAdapter)
      throw new Error("Private file transfers are unavailable");
    return this.transferAdapter.showInFolder(transferId);
  }

  async completeTransfer(transferId: PrivateTransferId) {
    return this.finishTransfer(transferId, "complete");
  }

  private receiveEvent(frame: Extract<SbpFrame, { kind: "event" }>) {
    if (frame.stream.kind !== "account") return;
    this.receiveRealtime(frame.opcode, frame.payload, frame.timestamp);
  }

  private receiveRealtime(opcode: number, payload: unknown, timestamp: Date) {
    if (opcode === 400)
      this.upsert("calls", decodeCall(payload), (item) => item.id);
    else if (opcode === 401) this.updateCallParticipant(payload);
    else if (opcode === 420) this.receivePrivateEvent(payload, timestamp);
    else if (opcode === 422) {
      const transfer = decodePrivateTransfer(payload);
      const transferWithMetadata = this.mergeTransfer(transfer);
      if (transfer.state === "accepted")
        void this.connectTransfer(transferWithMetadata);
      if (["completed", "declined", "canceled"].includes(transfer.state))
        void this.transferAdapter?.disconnect(transfer.id);
    }
  }

  private receivePrivateEvent(payload: unknown, timestamp: Date) {
    const map = mapValue(payload);
    const privateConversationId = decodeEntityRef(
      required(map, 0),
      "private-conversation",
    );
    const senderId = decodeEntityRef(required(map, 1), "user");
    const actions = {
      0: "invite",
      1: "accept",
      2: "decline",
      3: "signal",
      5: "end",
      6: "reconnect",
      7: "state",
    } as const;
    const states = [
      "ringing",
      "negotiating",
      "active",
      "reconnecting",
      "ended",
    ] as const;
    const action =
      actions[unsignedValue(required(map, 2)) as keyof typeof actions];
    const state = states[unsignedValue(required(map, 4))];
    if (!action || !state)
      throw new TypeError("Invalid private conversation event");
    const existing = this.current.privateConversations.get(
      privateConversationId,
    );
    const session: PrivateConversationSession = existing
      ? {
          ...existing,
          state,
          encryptedInvitation:
            action === "invite" ? existing.encryptedInvitation : undefined,
        }
      : {
          id: privateConversationId,
          initiatorId: senderId,
          peerId: senderId === this.ownUserId ? this.ownUserId : senderId,
          state,
          startedAt: timestamp.toISOString(),
        };
    this.upsert("privateConversations", session, (item) => item.id);
    const event: PrivateConversationRealtimeEvent = {
      privateConversationId,
      senderId,
      action,
      payload: bytesValue(required(map, 3)),
      state,
      receivedAt: timestamp.toISOString(),
    };
    if (action === "invite")
      this.privateInvites.set(privateConversationId, event.payload);
    const handle = this.cryptoHandles.get(privateConversationId);
    if (
      handle &&
      senderId !== this.ownUserId &&
      (action === "accept" || action === "signal")
    )
      void this.receivePrivateCrypto(handle, event);
    if (action === "accept" || action === "end" || action === "decline") {
      this.privateInvites.delete(privateConversationId);
    }
    if (action === "end" || action === "decline") {
      this.interruptedPrivateConversations.delete(privateConversationId);
      if (handle) {
        this.cryptoHandles.delete(privateConversationId);
        void this.crypto?.close(handle);
      }
    }
    this.privateEventListeners.forEach((listener) => listener(event));
  }

  private async receivePrivateCrypto(
    handle: PrivateCryptoHandle,
    event: PrivateConversationRealtimeEvent,
  ) {
    try {
      const result = await this.crypto!.receive(handle, event);
      for (const outbound of result.outbound ?? [])
        await this.privateConversations.signal(
          event.privateConversationId,
          outbound,
        );
      for (const message of result.messages ?? [])
        this.appendPrivateMessage({
          ...message,
          privateConversationId: event.privateConversationId,
          senderId: event.senderId,
        });
      for (const offer of result.transferOffers ?? []) {
        const existing = this.current.transfers.get(offer.transferId);
        if (existing && existing.byteSize !== offer.byteSize)
          throw new Error(
            "Private transfer size does not match its encrypted offer",
          );
        this.transferKeys.set(offer.transferId, offer.key);
        const transfer: PrivateTransfer = {
          id: offer.transferId,
          privateConversationId: event.privateConversationId,
          senderId: event.senderId,
          state: existing?.state ?? "offered",
          ...existing,
          filename: offer.filename,
          mediaType: offer.mediaType,
          byteSize: offer.byteSize,
          sha256: offer.sha256,
        };
        this.mergeTransfer(transfer);
        if (transfer?.state === "accepted") void this.connectTransfer(transfer);
      }
    } catch {
      await this.privateConversations.end(event.privateConversationId);
    }
  }

  private appendPrivateMessage(message: PrivateConversationMessage) {
    const privateMessages = new Map(this.current.privateMessages);
    privateMessages.set(message.privateConversationId, [
      ...(privateMessages.get(message.privateConversationId) ?? []),
      message,
    ]);
    this.set({ ...this.current, privateMessages });
  }

  private receiveControl(frame: Extract<SbpFrame, { kind: "control" }>) {
    if ([400, 401, 420, 422].includes(frame.opcode)) {
      this.receiveRealtime(frame.opcode, frame.payload, new Date());
      return;
    }
    if (frame.opcode !== 38) return;
    const map = mapValue(frame.payload);
    const privateConversations = arrayValue(required(map, 3)).map(
      decodePrivateConversation,
    );
    const interruptedPrivateConversations = privateConversations.filter(
      (conversation) =>
        this.interruptedPrivateConversations.has(conversation.id) &&
        conversation.state !== "ended",
    );
    const snapshotIds = new Set(
      privateConversations.map((conversation) => conversation.id),
    );
    for (const id of this.interruptedPrivateConversations) {
      if (!snapshotIds.has(id)) this.interruptedPrivateConversations.delete(id);
    }
    for (const conversation of interruptedPrivateConversations)
      void this.privateConversations
        .end(conversation.id)
        .catch(() => undefined);
    const availablePrivateConversations = privateConversations.filter(
      (conversation) =>
        !this.interruptedPrivateConversations.has(conversation.id),
    );
    this.privateInvites.clear();
    for (const conversation of availablePrivateConversations) {
      if (conversation.encryptedInvitation)
        this.privateInvites.set(
          conversation.id,
          conversation.encryptedInvitation,
        );
    }
    this.set({
      calls: keyed(
        arrayValue(required(map, 2)).map(decodeCall),
        (item) => item.id,
      ),
      privateConversations: keyed(
        availablePrivateConversations,
        (item) => item.id,
      ),
      transfers: this.current.transfers,
      privateMessages: this.current.privateMessages,
    });
  }

  private updateCallParticipant(payload: unknown) {
    const map = mapValue(payload);
    const callId = decodeEntityRef(required(map, 0), "call");
    const call = this.current.calls.get(callId);
    if (!call) return;
    const userId = decodeEntityRef(required(map, 1), "user");
    const states = [
      "invited",
      "ringing",
      "joining",
      "active",
      "declined",
      "left",
    ] as const;
    const state = states[unsignedValue(required(map, 2))];
    if (!state) throw new TypeError("Invalid call participant state");
    const participants = [
      ...call.participants.filter((item) => item.userId !== userId),
      { userId, state },
    ];
    this.upsert("calls", { ...call, participants }, (item) => item.id);
  }

  private connectTransfer(transfer: PrivateTransfer) {
    if (!this.transferAdapter) return Promise.resolve();
    if (!completeTransferMetadata(transfer)) return Promise.resolve();
    const key = this.transferKeys.get(transfer.id);
    if (!key) return Promise.resolve();
    const existing = this.connectingTransfers.get(transfer.id);
    if (existing) return existing;
    const operation = (async () => {
      try {
        const admission = await this.privateConversations.admitTransfer(
          transfer.privateConversationId,
          transfer.id,
        );
        await this.transferAdapter!.connect({
          endpoint: this.endpoint,
          transfer,
          admission,
          key,
          direction: transfer.senderId === this.ownUserId ? "send" : "receive",
          onProgress: (progress) => {
            this.transferProgress.set(transfer.id, progress);
            this.set({ ...this.current });
          },
          onComplete: () => void this.completeTransfer(transfer.id),
          onError: () => void this.cancelTransfer(transfer.id),
        });
        this.upsert(
          "transfers",
          { ...transfer, state: "transferring" },
          (item) => item.id,
        );
      } catch (reason) {
        await this.transferAdapter!.disconnect(transfer.id).catch(
          () => undefined,
        );
        await this.privateConversations
          .actOnTransfer(transfer.privateConversationId, transfer.id, "cancel")
          .catch(() => undefined);
        throw reason;
      } finally {
        this.connectingTransfers.delete(transfer.id);
      }
    })();
    this.connectingTransfers.set(transfer.id, operation);
    return operation;
  }

  private async finishTransfer(
    transferId: PrivateTransferId,
    action: "cancel" | "complete",
  ) {
    const transfer = this.requireTransfer(transferId);
    await this.transferAdapter?.disconnect(transferId);
    const updated = await this.privateConversations.actOnTransfer(
      transfer.privateConversationId,
      transferId,
      action,
    );
    return this.mergeTransfer(updated);
  }

  private finishPrivateConversation(
    id: PrivateConversationId,
    action: "decline" | "end",
  ) {
    return this.enqueue(async () => {
      if (action === "decline") await this.privateConversations.decline(id);
      else await this.privateConversations.end(id);
      const handle = this.cryptoHandles.get(id);
      this.cryptoHandles.delete(id);
      this.privateInvites.delete(id);
      if (handle) await this.crypto?.close(handle);
      const session = this.current.privateConversations.get(id);
      if (session)
        this.upsert(
          "privateConversations",
          { ...session, state: "ended" },
          (item) => item.id,
        );
    });
  }

  private requireTransfer(id: PrivateTransferId) {
    const transfer = this.current.transfers.get(id);
    if (!transfer) throw new Error("The private transfer is unavailable");
    return transfer;
  }

  private mergeTransfer(transfer: PrivateTransfer) {
    const merged = {
      ...this.current.transfers.get(transfer.id),
      ...transfer,
      filename:
        transfer.filename ?? this.current.transfers.get(transfer.id)?.filename,
      mediaType:
        transfer.mediaType ??
        this.current.transfers.get(transfer.id)?.mediaType,
      sha256:
        transfer.sha256 ?? this.current.transfers.get(transfer.id)?.sha256,
    };
    this.upsert("transfers", merged, (item) => item.id);
    return merged;
  }

  private upsert<
    Name extends keyof LiveSessionState,
    Value extends (LiveSessionState[Name] extends ReadonlyMap<
      unknown,
      infer Item
    >
      ? Item
      : never),
    Key,
  >(name: Name, value: Value, key: (value: Value) => Key) {
    const values = new Map(this.current[name] as ReadonlyMap<Key, Value>);
    values.set(key(value), value);
    this.set({ ...this.current, [name]: values });
  }

  private set(state: LiveSessionState) {
    this.current = state;
    this.listeners.forEach((listener) => listener());
  }
  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}

function keyed<Key, Value>(values: Value[], key: (value: Value) => Key) {
  return new Map(values.map((value) => [key(value), value] as const));
}

function completeTransferMetadata(
  transfer: PrivateTransfer,
): transfer is PrivateTransfer & {
  filename: string;
  mediaType: string;
  sha256: Uint8Array;
} {
  return Boolean(transfer.filename && transfer.mediaType && transfer.sha256);
}
