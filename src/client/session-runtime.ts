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
import { SbpProtocolError } from "../sbp/session.js";
import type {
  CallMediaAdapter,
  PrivateCryptoAdapter,
  PrivateCryptoHandle,
  PrivateTransferAdapter,
  CallMediaPreferences,
  CallMediaEvent,
} from "./platform-adapters.js";
import type { InstanceEndpoint } from "../instance-endpoint.js";
import { MediaControls } from "../calls/media-controls.js";
import type {
  CallLifecycleEvent,
  CallRuntimeView,
  CallConnectionState,
} from "../calls/call-runtime.js";
import {
  arrayValue,
  bytesValue,
  mapValue,
  required,
  unsignedValue,
} from "../sbp/value.js";

export type LiveSessionState = {
  currentCallId?: CallId;
  callConnection: CallConnectionState;
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
    callConnection: "idle",
    calls: new Map(),
    privateConversations: new Map(),
    transfers: new Map(),
    privateMessages: new Map(),
  };
  private listeners = new Set<() => void>();
  private privateEventListeners = new Set<
    (event: PrivateConversationRealtimeEvent) => void
  >();
  private callEventListeners = new Set<(event: CallLifecycleEvent) => void>();
  private unsubscribers: Array<() => void> = [];
  private pending: Promise<unknown> = Promise.resolve();
  private cryptoHandles = new Map<PrivateConversationId, PrivateCryptoHandle>();
  private privateInvites = new Map<PrivateConversationId, Uint8Array>();
  private interruptedPrivateConversations = new Set<PrivateConversationId>();
  private connectingTransfers = new Map<PrivateTransferId, Promise<void>>();
  private transferKeys = new Map<PrivateTransferId, Uint8Array>();
  private transferProgress = new Map<PrivateTransferId, number>();
  private connectingAnsweredCalls = new Set<CallId>();
  private watchedCommunityCallIds = new Set<CallId>();
  private mediaGeneration = 0;

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
    private readonly options: {
      reconnectAttempts?: number;
      reconnectDelay?: (attempt: number) => Promise<void>;
      onError?: (reason: unknown) => void;
      onCallUsers?: (userIds: readonly UserId[]) => void;
    } = {},
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

  subscribeCallEvents = (listener: (event: CallLifecycleEvent) => void) => {
    this.callEventListeners.add(listener);
    return () => this.callEventListeners.delete(listener);
  };

  callView(): CallRuntimeView {
    const current = this.current.currentCallId
      ? this.current.calls.get(this.current.currentCallId)
      : undefined;
    const incoming = [...this.current.calls.values()].find(
      (call) =>
        openCall(call) &&
        call.id !== current?.id &&
        call.originatorId !== this.ownUserId &&
        ownParticipant(call, this.ownUserId)?.state === "ringing",
    );
    return {
      connection: this.current.callConnection,
      phase: current ? callPhase(current) : undefined,
      current,
      incoming,
      joinable: new Map(
        [...this.current.calls].filter(
          ([, call]) => openCall(call) && call.target.kind !== "user",
        ),
      ),
      pendingParticipantIds:
        current && current.target.kind === "conversation" && openCall(current)
          ? current.participants
              .filter(
                (participant) =>
                  participant.userId !== current.originatorId &&
                  ["invited", "ringing", "joining"].includes(participant.state),
              )
              .map((participant) => participant.userId)
          : [],
    };
  }

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
    const unsubscribeMedia = this.media?.subscribeEvents?.((event) =>
      this.receiveMediaEvent(event),
    );
    this.unsubscribers = [
      this.session.subscribeEvents((frame) => this.receiveEvent(frame)),
      this.session.subscribeControls((frame) => this.receiveControl(frame)),
      ...(unsubscribeStatus ? [unsubscribeStatus] : []),
      ...(unsubscribeMedia ? [unsubscribeMedia] : []),
    ];
    void this.mediaControls?.start();
  }

  stop() {
    const currentCallId = this.current.currentCallId;
    this.mediaGeneration += 1;
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    if (currentCallId) void this.media?.disconnect(currentCallId);
    this.current = {
      callConnection: "idle",
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
    this.watchedCommunityCallIds.clear();
    for (const transferId of this.connectingTransfers.keys())
      void this.transferAdapter?.disconnect(transferId);
    this.connectingTransfers.clear();
    this.transferKeys.clear();
    this.transferProgress.clear();
    this.mediaControls?.stop();
  }

  private receiveStatus(status: SbpSessionStatus) {
    if (status.state !== "offline") return;
    const currentCallId = this.current.currentCallId;
    this.mediaGeneration += 1;
    if (currentCallId) void this.media?.disconnect(currentCallId);
    this.mediaControls?.resetSession();
    const interrupted = [...this.current.privateConversations.values()].filter(
      (session) => session.state !== "ended",
    );
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
    this.watchedCommunityCallIds.clear();
    this.set({
      ...this.current,
      currentCallId: undefined,
      callConnection: "idle",
      calls: new Map(),
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
    return this.enqueue(() => this.acceptCallNow(callId));
  }

  beginCall(...args: Parameters<SbpCallsClient["start"]>) {
    return this.enqueue(async () => {
      if (this.callView().current)
        throw new Error("End the current call before starting another");
      const existing = this.findJoinableTarget(args[0]);
      if (existing) {
        await this.acceptCallNow(existing.id);
        return existing;
      }
      const call = await this.calls.start(...args);
      this.upsertCall(call);
      this.selectCurrentCall(call.id);
      this.setCallConnection("ringing", call);
      await this.acceptCallNow(call.id);
      return call;
    });
  }

  declineCall(callId: CallId) {
    return this.enqueue(() => this.calls.decline(callId));
  }

  leaveCall(callId: CallId) {
    return this.enqueue(async () => {
      this.mediaGeneration += 1;
      this.setCallConnection("disconnecting");
      await this.media?.disconnect(callId);
      await this.calls.leave(callId);
      if (this.current.currentCallId === callId) this.clearCurrentCall();
      this.mediaControls?.resetSession();
    });
  }

  startCall(...args: Parameters<SbpCallsClient["start"]>) {
    return this.enqueue(async () => {
      if (this.callView().current)
        throw new Error("End the current call before starting another");
      const call = await this.calls.start(...args);
      this.upsertCall(call);
      this.selectCurrentCall(call.id);
      this.setCallConnection("ringing", call);
      return call;
    });
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
      const activeCall = this.callView().current;
      if (activeCall) await this.calls.leave(activeCall.id);
      if (activeCall) this.clearCurrentCall();
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
    if (opcode === 400) this.upsertCall(decodeCall(payload));
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
    if (frame.opcode === 45) {
      this.replaceCommunityCalls(frame.payload);
      return;
    }
    if (frame.opcode === 46) {
      const call = decodeCall(required(mapValue(frame.payload), 1));
      this.watchedCommunityCallIds.add(call.id);
      this.upsertCall(call);
      return;
    }
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
    const calls = keyed(
      arrayValue(required(map, 2)).map(decodeCall),
      (item) => item.id,
    );
    const previousCalls = this.current.calls;
    const previousCurrent = this.callView().current;
    const currentCallId = selectCurrentCallId(
      calls,
      this.ownUserId,
      this.current.currentCallId,
    );
    this.set({
      callConnection: currentCallId ? this.current.callConnection : "idle",
      currentCallId,
      calls,
      privateConversations: keyed(
        availablePrivateConversations,
        (item) => item.id,
      ),
      transfers: this.current.transfers,
      privateMessages: this.current.privateMessages,
    });
    for (const call of calls.values())
      this.emitCallUpdate(call, previousCalls.get(call.id));
    this.options.onCallUsers?.(
      [...calls.values()].flatMap((call) =>
        call.participants.map((item) => item.userId),
      ),
    );
    const nextCurrent = this.callView().current;
    this.emitCurrentChanged(previousCurrent, nextCurrent);
    if (previousCurrent && !nextCurrent)
      this.teardownLocalMedia(previousCurrent.id);
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
    const updated = { ...call, participants };
    this.upsertCall(updated);
    this.emitCallEvent({
      type: "participant-state-changed",
      call: updated,
      userId,
      state,
      previousState: call.participants.find((item) => item.userId === userId)
        ?.state,
    });
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

  private async acceptCallNow(callId: CallId) {
    const activePrivate = [...this.current.privateConversations.values()].find(
      (item) => item.state !== "ended",
    );
    if (activePrivate) await this.privateConversations.end(activePrivate.id);
    const previous = this.callView().current;
    if (previous && previous.id !== callId) {
      this.mediaGeneration += 1;
      this.setCallConnection("replacing", previous);
      await this.media?.disconnect(previous.id);
      await this.calls.leave(previous.id);
    }
    const call = this.current.calls.get(callId);
    if (!call) throw new Error("The call is not available");
    this.selectCurrentCall(callId);
    this.setCallConnection("connecting", call);
    try {
      await this.calls.join(callId);
      if (!this.media) {
        this.setCallConnection("active", call);
        return;
      }
      const admission = await this.calls.admit(callId);
      await this.media.connect({
        endpoint: this.endpoint,
        localUserId: this.ownUserId,
        call,
        admission,
      });
      await this.calls.mediaConnected(callId);
      this.setCallConnection("active", call);
    } catch (reason) {
      this.mediaGeneration += 1;
      await this.media?.disconnect(callId).catch(() => undefined);
      if (call.target.kind !== "user" && staleCallError(reason)) {
        this.discardCall(callId);
        this.mediaControls?.resetSession();
        return;
      }
      await this.calls.leave(callId).catch(() => undefined);
      if (this.current.currentCallId === callId) this.clearCurrentCall();
      this.mediaControls?.resetSession();
      throw reason;
    }
  }

  private findJoinableTarget(target: CallSession["target"]) {
    return [...this.callView().joinable.values()].find((call) =>
      sameCallTarget(call.target, target),
    );
  }

  private discardCall(callId: CallId) {
    const calls = new Map(this.current.calls);
    const previous = calls.get(callId);
    const wasCurrent = this.current.currentCallId === callId;
    calls.delete(callId);
    this.set({
      ...this.current,
      calls,
      currentCallId:
        this.current.currentCallId === callId
          ? undefined
          : this.current.currentCallId,
      callConnection:
        this.current.currentCallId === callId
          ? "idle"
          : this.current.callConnection,
    });
    if (previous && wasCurrent) this.emitCurrentChanged(previous, undefined);
  }

  private receiveMediaEvent(event: CallMediaEvent) {
    if (event.callId !== this.current.currentCallId) return;
    if (event.type === "room-ended") {
      void this.terminateMediaCall(event.callId, "room-ended");
      return;
    }
    if (event.type !== "disconnected") return;
    if (event.reason) {
      void this.terminateMediaCall(event.callId, event.reason);
      return;
    }
    const generation = ++this.mediaGeneration;
    this.setCallConnection(
      "reconnecting",
      this.current.calls.get(event.callId),
    );
    void this.reconnectMedia(event.callId, generation);
  }

  private async reconnectMedia(callId: CallId, generation: number) {
    const attempts = this.options.reconnectAttempts ?? 6;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!this.reconnectCurrent(callId, generation)) return;
      if (attempt > 0)
        await (this.options.reconnectDelay ?? reconnectDelay)(attempt);
      if (!this.reconnectCurrent(callId, generation)) return;
      const call = this.current.calls.get(callId);
      if (!call || !this.media) return;
      try {
        const admission = await this.calls.admit(callId);
        if (!this.reconnectCurrent(callId, generation)) return;
        await this.media.connect({
          endpoint: this.endpoint,
          localUserId: this.ownUserId,
          call,
          admission,
        });
        if (!this.reconnectCurrent(callId, generation)) {
          await this.media.disconnect(callId).catch(() => undefined);
          return;
        }
        await this.calls.mediaConnected(callId);
        this.setCallConnection("active", call);
        return;
      } catch {
        await this.media.disconnect(callId).catch(() => undefined);
      }
    }
    if (this.reconnectCurrent(callId, generation))
      await this.terminateMediaCall(callId, "reconnect-failed");
  }

  private reconnectCurrent(callId: CallId, generation: number) {
    return (
      generation === this.mediaGeneration &&
      this.current.currentCallId === callId
    );
  }

  private async terminateMediaCall(
    callId: CallId,
    reason:
      | NonNullable<Extract<CallMediaEvent, { type: "disconnected" }>["reason"]>
      | "room-ended"
      | "reconnect-failed",
  ) {
    if (this.current.currentCallId !== callId) return;
    this.mediaGeneration += 1;
    this.setCallConnection(
      "disconnecting",
      this.current.calls.get(callId),
      reason,
    );
    await this.media?.disconnect(callId).catch(() => undefined);
    await this.calls.leave(callId).catch(() => undefined);
    if (this.current.currentCallId === callId) this.clearCurrentCall(reason);
    this.mediaControls?.resetSession();
    const message = terminalCallMessage(reason);
    if (message) this.options.onError?.(new Error(message));
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

  private upsertCall(call: CallSession) {
    const previous = this.current.calls.get(call.id);
    const previousCurrent = this.callView().current;
    const calls = new Map(this.current.calls);
    calls.set(call.id, call);
    const currentCallId = selectCurrentCallId(
      calls,
      this.ownUserId,
      this.current.currentCallId,
    );
    this.set({ ...this.current, calls, currentCallId });
    this.emitCallUpdate(call, previous);
    const nextCurrent = this.callView().current;
    this.emitCurrentChanged(previousCurrent, nextCurrent);
    if (previousCurrent && !nextCurrent)
      this.teardownLocalMedia(previousCurrent.id);
    this.connectAnsweredDirectCall(call);
    this.options.onCallUsers?.(call.participants.map((item) => item.userId));
  }

  private replaceCommunityCalls(payload: unknown) {
    const map = mapValue(payload);
    const incoming = arrayValue(required(map, 1)).map(decodeCall);
    const incomingIds = new Set(incoming.map((call) => call.id));
    const calls = new Map(this.current.calls);

    for (const callId of this.watchedCommunityCallIds) {
      if (incomingIds.has(callId)) continue;
      const call = calls.get(callId);
      if (call && !locallySelectable(call, this.ownUserId))
        calls.delete(callId);
    }
    for (const call of incoming) calls.set(call.id, call);

    this.watchedCommunityCallIds = incomingIds;
    this.set({ ...this.current, calls });
    this.options.onCallUsers?.(
      incoming.flatMap((call) => call.participants.map((item) => item.userId)),
    );
  }

  private connectAnsweredDirectCall(call: CallSession) {
    const answered = call.participants.some(
      (participant) =>
        participant.userId !== this.ownUserId && participant.state === "active",
    );
    if (
      call.target.kind !== "user" ||
      call.originatorId !== this.ownUserId ||
      this.current.currentCallId !== call.id ||
      this.current.callConnection !== "ringing" ||
      !answered ||
      this.connectingAnsweredCalls.has(call.id)
    )
      return;

    this.connectingAnsweredCalls.add(call.id);
    void this.acceptCall(call.id).finally(() => {
      this.connectingAnsweredCalls.delete(call.id);
    });
  }

  private selectCurrentCall(callId?: CallId) {
    const previous = this.callView().current;
    const currentCallId = selectCurrentCallId(
      this.current.calls,
      this.ownUserId,
      callId,
    );
    if (currentCallId === this.current.currentCallId) return;
    this.set({ ...this.current, currentCallId });
    this.emitCurrentChanged(previous, this.callView().current);
  }

  private clearCurrentCall(
    reason?: Parameters<SessionRuntime["setCallConnection"]>[2],
  ) {
    const previous = this.callView().current;
    const previousState = this.current.callConnection;
    if (!this.current.currentCallId) return;
    this.set({
      ...this.current,
      currentCallId: undefined,
      callConnection: "idle",
    });
    this.mediaControls?.resetSession();
    this.emitCurrentChanged(previous, undefined);
    this.emitCallEvent({
      type: "connection-state-changed",
      state: "idle",
      previousState,
      call: previous,
      reason,
    });
  }

  private setCallConnection(
    state: CallConnectionState,
    call = this.callView().current,
    reason?: Extract<
      CallLifecycleEvent,
      { type: "connection-state-changed" }
    >["reason"],
  ) {
    const previousState = this.current.callConnection;
    if (state === previousState) return;
    this.set({ ...this.current, callConnection: state });
    this.emitCallEvent({
      type: "connection-state-changed",
      state,
      previousState,
      call,
      reason,
    });
  }

  private teardownLocalMedia(callId: CallId) {
    this.mediaGeneration += 1;
    void this.media?.disconnect(callId);
    this.mediaControls?.resetSession();
    this.setCallConnection("idle");
  }

  private emitCallUpdate(call: CallSession, previous?: CallSession) {
    if (previous === call) return;
    this.emitCallEvent({ type: "call-updated", call, previous });
    if (previous && openCall(previous) && !openCall(call))
      this.emitCallEvent({ type: "call-ended", call });
  }

  private emitCurrentChanged(previous?: CallSession, call?: CallSession) {
    if (previous?.id === call?.id) return;
    this.emitCallEvent({ type: "current-changed", call, previous });
  }

  private emitCallEvent(event: CallLifecycleEvent) {
    this.callEventListeners.forEach((listener) => listener(event));
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

function openCall(call: CallSession) {
  return !["ended", "declined", "expired"].includes(call.state);
}

function callPhase(call: CallSession): "proposal" | "session" {
  if (call.target.kind === "user")
    return call.state === "ringing" ? "proposal" : "session";
  if (call.target.kind === "channel") return "session";
  return call.establishedAt ? "session" : "proposal";
}

function sameCallTarget(
  left: CallSession["target"],
  right: CallSession["target"],
) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "user" && right.kind === "user")
    return left.userId === right.userId;
  if (left.kind === "conversation" && right.kind === "conversation")
    return left.conversationId === right.conversationId;
  return (
    left.kind === "channel" &&
    right.kind === "channel" &&
    left.channelId === right.channelId
  );
}

function staleCallError(reason: unknown) {
  return reason instanceof SbpProtocolError && [4, 5].includes(reason.code);
}

function ownParticipant(call: CallSession, ownUserId: UserId) {
  return call.participants.find(
    (participant) => participant.userId === ownUserId,
  );
}

function locallyParticipating(call: CallSession, ownUserId: UserId) {
  const state = ownParticipant(call, ownUserId)?.state;
  return openCall(call) && (state === "joining" || state === "active");
}

function locallySelectable(call: CallSession, ownUserId: UserId) {
  const state = ownParticipant(call, ownUserId)?.state;
  return (
    openCall(call) && Boolean(state && state !== "declined" && state !== "left")
  );
}

function selectCurrentCallId(
  calls: ReadonlyMap<CallId, CallSession>,
  ownUserId: UserId,
  preferred?: CallId,
) {
  const preferredCall = preferred ? calls.get(preferred) : undefined;
  if (preferredCall && locallySelectable(preferredCall, ownUserId))
    return preferredCall.id;
  return [...calls.values()].find((call) =>
    locallyParticipating(call, ownUserId),
  )?.id;
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

function reconnectDelay(attempt: number) {
  const delay = Math.min(8_000, 1_000 * 2 ** (attempt - 1));
  return new Promise<void>((resolve) => setTimeout(resolve, delay));
}

function terminalCallMessage(
  reason:
    | import("../calls/media-types.js").MediaDisconnectReason
    | "room-ended"
    | "reconnect-failed",
) {
  if (reason === "authorization_revoked")
    return "You no longer have access to this call.";
  if (reason === "policy_violation")
    return "The call was ended because of invalid media activity.";
  if (reason === "replaced")
    return "This call was opened in another Sideband window.";
  if (reason === "reconnect-failed")
    return "The call could not be reconnected.";
  return undefined;
}
