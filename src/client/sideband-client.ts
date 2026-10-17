import type {
  ActivityId,
  ChannelId,
  CommunityId,
  ConversationId,
  DeviceId,
  UserId,
} from "../entity-id.js";
import type { InboxEntry } from "../domain.js";
import { entityId } from "../entity-id.js";
import {
  ActivitySharingController,
  type ActivitySharingPlatform,
} from "../activity/activity-sharing-controller.js";
import type { InstanceEndpoint } from "../instance-endpoint.js";
import type { InstancePolicy } from "../instance/instance-policy.js";
import { LiveEventController } from "./live-event-controller.js";
import { SbpMessagingClient } from "../conversations/messaging-client.js";
import { SbpCommunitiesClient } from "../communities/community-client.js";
import { SbpAttachmentsClient } from "../attachments/attachment-client.js";
import { SbpCallsClient } from "../calls/calls-client.js";
import { SbpPrivateConversationsClient } from "../private-conversation/private-conversations-client.js";
import { SbpDevicesClient } from "../devices/device-client.js";
import { SbpRealtimeClient } from "../realtime/realtime-client.js";
import { SessionRuntime } from "./session-runtime.js";
import {
  initialEphemeralState,
  EphemeralStateController,
} from "./ephemeral-state.js";
import type {
  CallMediaAdapter,
  PrivateCryptoAdapter,
  PrivateTransferAdapter,
  CallMediaPreferences,
} from "./platform-adapters.js";
import { SbpSocialClient } from "../social/social-client.js";
import { WorkspaceController } from "../workspace/workspace-controller.js";
import { RepliesController } from "../conversations/replies-controller.js";
import {
  SbpProtocolError,
  SbpSession,
  type SbpSessionOptions,
} from "../sbp/session.js";
import { SnapshotClient } from "./snapshot-client.js";
import {
  AccountStateController,
  type MessageCache,
  type AccountState,
} from "./state.js";
import { BadgeVerifier } from "../badges/badge-verifier.js";

export type AccountKey = {
  instanceDomain: string;
  userId: UserId;
  username?: string;
};

export type StoredCredential = AccountKey & {
  deviceId: DeviceId;
  token: Uint8Array;
  expiresAt: string;
  username?: string;
};

export type CredentialStore = {
  load: (account: AccountKey) => Promise<StoredCredential | undefined>;
  save: (credential: StoredCredential) => Promise<void>;
  delete: (account: AccountKey) => Promise<void>;
};

export type SidebandClientState = {
  connection: "offline" | "connecting" | "reconnecting" | "online";
  endpoint?: InstanceEndpoint;
  policy?: InstancePolicy;
  account?: AccountState;
  error?: unknown;
};

export type SidebandClientOptions = {
  clientFamily: string;
  clientVersion: string;
  credentials: CredentialStore;
  messages?: (account: AccountKey) => MessageCache;
  session?: SbpSessionOptions;
  capabilities?: number[];
  onError?: (reason: unknown) => void;
  media?: CallMediaAdapter;
  privateCrypto?: PrivateCryptoAdapter;
  privateTransfers?: PrivateTransferAdapter;
  mediaPreferences?: CallMediaPreferences;
};

/**
 * Owns one authenticated SBP account lifecycle. Platform applications supply
 * secure credential and message persistence, but never manipulate the
 * protocol session directly.
 */
export class SidebandClient {
  private current: SidebandClientState = { connection: "offline" };
  private listeners = new Set<() => void>();
  private notificationListeners = new Set<(entry: InboxEntry) => void>();
  private session?: SbpSession;
  private liveEvents?: LiveEventController;
  private stateController?: AccountStateController;
  private messagingClient?: SbpMessagingClient;
  private communitiesClient?: SbpCommunitiesClient;
  private attachmentsClient?: SbpAttachmentsClient;
  private callsClient?: SbpCallsClient;
  private privateConversationsClient?: SbpPrivateConversationsClient;
  private devicesClient?: SbpDevicesClient;
  private realtimeClient?: SbpRealtimeClient;
  private liveSessionRuntime?: SessionRuntime;
  private ephemeralStateController?: EphemeralStateController;
  private socialClient?: SbpSocialClient;
  private repliesController?: RepliesController;
  private readonly emptyEphemeralState = initialEphemeralState();
  private workspaceController = new WorkspaceController(
    () => this.stateController?.state,
  );
  private unsubscribeStatus?: () => void;
  private unsubscribeState?: () => void;
  private unsubscribeEphemeral?: () => void;
  private generation = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stateEmitTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private retryReconnect?: () => void;
  private communityMemberLoads = new Map<string, Promise<void>>();

  constructor(private readonly options: SidebandClientOptions) {}

  get state() {
    return this.current;
  }

  get accountState() {
    return this.stateController?.state;
  }

  get ephemeralState() {
    return this.ephemeralStateController?.state ?? this.emptyEphemeralState;
  }

  get messaging() {
    if (!this.messagingClient)
      throw new Error("The Sideband client is offline");
    return this.messagingClient;
  }

  get social() {
    if (!this.socialClient) throw new Error("The Sideband client is offline");
    return this.socialClient;
  }

  get communities() {
    if (!this.communitiesClient)
      throw new Error("The Sideband client is offline");
    return this.communitiesClient;
  }

  get attachments() {
    if (!this.attachmentsClient)
      throw new Error("The Sideband client is offline");
    return this.attachmentsClient;
  }

  get calls() {
    if (!this.callsClient) throw new Error("The Sideband client is offline");
    return this.callsClient;
  }

  get privateConversations() {
    if (!this.privateConversationsClient)
      throw new Error("The Sideband client is offline");
    return this.privateConversationsClient;
  }

  get devices() {
    if (!this.devicesClient) throw new Error("The Sideband client is offline");
    return this.devicesClient;
  }

  get realtime() {
    if (!this.realtimeClient) throw new Error("The Sideband client is offline");
    return this.realtimeClient;
  }

  get liveSessions() {
    if (!this.liveSessionRuntime)
      throw new Error("The Sideband client is offline");
    return this.liveSessionRuntime;
  }

  get ephemeral() {
    if (!this.ephemeralStateController)
      throw new Error("The Sideband client is offline");
    return this.ephemeralStateController;
  }

  get workspace() {
    return this.workspaceController;
  }

  get replies() {
    if (!this.repliesController)
      throw new Error("The Sideband client is offline");
    return this.repliesController;
  }

  createActivitySharingRuntime(
    platform: ActivitySharingPlatform,
    account: UserId,
  ) {
    const activityId = entityId<"activity">(crypto.randomUUID()) as ActivityId;
    const startedAt = new Date();
    return new ActivitySharingController({
      context: {
        account,
        connected: this.current.connection === "online",
      },
      platform,
      setSharingEnabled: async (enabled) => {
        const settings = this.current.account?.realtimeSettings;
        if (!settings) throw new Error("Realtime settings are unavailable");
        if (settings.activitySharingEnabled === enabled) return;
        const updated = await this.realtime.updateSettings({
          ...settings,
          activitySharingEnabled: enabled,
        });
        this.stateController?.setRealtimeSettings(updated);
      },
      publishTune: async (tune) => {
        if (!tune) {
          this.realtime.clearActivity("music");
          return;
        }
        const updatedAt = new Date();
        this.realtime.publishActivity({
          id: activityId,
          kind: "music",
          startedAt,
          updatedAt,
          expiresAt: new Date(updatedAt.getTime() + 90_000),
          payload: tune,
        });
      },
      formatError: (reason) =>
        reason instanceof Error ? reason.message : "Music sharing failed",
    });
  }

  async openConversation(conversationId: ConversationId) {
    this.workspaceController.openConversation(conversationId);
    if (this.stateController?.conversationNeedsRefresh(conversationId))
      await this.loadConversation(conversationId);
    if (this.workspaceController.selectedChannel)
      await this.watchSelectedChannel();
    else await this.clearChannelMemberWatch();
  }

  async openDirectConversation(userId: UserId) {
    if (!this.messagingClient || !this.stateController)
      throw new Error("The Sideband client is offline");
    const conversation = await this.messagingClient.direct(userId);
    this.stateController.upsertConversation(conversation);
    await this.openConversation(conversation.id);
    return conversation;
  }

  async acceptCommunityInvitation(token: string) {
    if (!this.communitiesClient || !this.stateController)
      throw new Error("The Sideband client is offline");
    const community = await this.communitiesClient.acceptInvitation(token);
    this.stateController.upsertCommunity(community);

    const channels = [...community.channels].sort(
      (left, right) => left.position - right.position,
    );
    const initialChannel =
      channels.find((channel) => channel.kind === "text") ?? channels[0];
    if (initialChannel?.conversationId)
      await this.stateController.loadConversation(
        initialChannel.conversationId,
      );

    await this.selectCommunity(community.id);
    return community;
  }

  selectCommunity(communityId: CommunityId) {
    this.workspaceController.selectCommunity(communityId);
    const conversation = this.loadSelectedConversation();
    void conversation
      .then(() => this.watchSelectedChannel())
      .catch((reason: unknown) => this.options.onError?.(reason));
    return conversation;
  }

  selectChannel(channelId: ChannelId) {
    this.workspaceController.selectChannel(channelId);
    const conversation = this.loadSelectedConversation();
    void conversation
      .then(() => this.watchSelectedChannel())
      .catch((reason: unknown) => this.options.onError?.(reason));
    return conversation;
  }

  loadChannelMembers(channelId: ChannelId) {
    return this.loadChannelMemberPage(channelId, false);
  }

  loadChannelOnlineMembers(channelId: ChannelId) {
    return this.loadChannelMemberPage(channelId, true);
  }

  private loadChannelMemberPage(channelId: ChannelId, online: boolean) {
    const key = `${channelId}:${online ? "online" : "all"}`;
    const existing = this.communityMemberLoads.get(key);
    if (existing) return existing;

    const loading = this.loadNextChannelMemberPage(channelId, online).finally(
      () => {
        if (this.communityMemberLoads.get(key) === loading)
          this.communityMemberLoads.delete(key);
      },
    );
    this.communityMemberLoads.set(key, loading);
    return loading;
  }

  private async loadNextChannelMemberPage(
    channelId: ChannelId,
    online: boolean,
  ) {
    if (!this.communitiesClient || !this.stateController)
      throw new Error("The Sideband client is offline");

    const channel = [...this.stateController.state.communities.values()]
      .flatMap((community) => community.channels)
      .find((candidate) => candidate.id === channelId);
    const complete = online
      ? channel?.onlineMembersComplete
      : channel?.membersComplete;
    if (!channel || complete) return;

    const cursor = online
      ? channel.onlineMembersNextCursor
      : channel.membersNextCursor;
    const page = await this.communitiesClient.channelMembers(channelId, {
      cursor,
      limit: 200,
      online,
    });
    if (!page.complete && (!page.nextCursor || page.nextCursor === cursor))
      throw new Error("Community member pagination did not advance");

    this.stateController.mergeChannelMembers(page);
  }

  private async watchSelectedChannel() {
    const channel = this.workspaceController.selectedChannel;
    if (!channel) return this.clearChannelMemberWatch();
    if (!this.communitiesClient || !this.stateController)
      throw new Error("The Sideband client is offline");
    const onlinePage = await this.communitiesClient.channelMembers(channel.id, {
      limit: 200,
      online: true,
    });
    this.stateController.mergeChannelMembers(onlinePage, true);
    if (channel.members === undefined)
      await this.loadChannelMembers(channel.id);
  }

  private async clearChannelMemberWatch() {
    if (this.communitiesClient)
      await this.communitiesClient.clearChannelMemberWatch();
  }

  showFriends() {
    this.workspaceController.showFriends();
    void this.clearChannelMemberWatch().catch((reason) =>
      this.options.onError?.(reason),
    );
  }

  showDirectMessages() {
    this.workspaceController.showDirectMessages();
    void this.clearChannelMemberWatch().catch((reason) =>
      this.options.onError?.(reason),
    );
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeNotifications = (listener: (entry: InboxEntry) => void) => {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  };

  async connectStored(endpoint: InstanceEndpoint, account: AccountKey) {
    const credential = await this.options.credentials.load(account);
    if (!credential) throw new Error("No stored SBP credential is available");
    if (Date.parse(credential.expiresAt) <= Date.now()) {
      await this.options.credentials.delete(account);
      throw new Error("The stored SBP credential has expired");
    }
    return this.connect(endpoint, credential);
  }

  async connect(endpoint: InstanceEndpoint, credential: StoredCredential) {
    const generation = ++this.generation;
    this.disposeRuntime();
    this.set({ connection: "connecting", endpoint });

    const account: AccountKey = {
      instanceDomain: normalizeDomain(credential.instanceDomain),
      userId: credential.userId,
      username: credential.username,
    };
    if (account.instanceDomain !== normalizeDomain(endpoint.domain))
      throw new TypeError(
        "The credential belongs to a different Sideband instance",
      );

    const session = new SbpSession({
      ...this.options.session,
      onListenerError: (reason) => {
        this.options.session?.onListenerError?.(reason);
        this.reportError(reason);
      },
    });
    const snapshots = new SnapshotClient(session);
    const badgeVerifier = new BadgeVerifier(endpoint.authentication?.issuer);
    const social = new SbpSocialClient(
      session,
      (profile) => badgeVerifier.verify(profile),
      (profile) => state.setOwnProfile(profile),
    );
    const state = new AccountStateController(
      snapshots,
      this.options.messages?.(account),
      (reason) => this.reportError(reason),
      (profile) => badgeVerifier.verify(profile),
      (entry) => {
        if (generation === this.generation)
          this.notificationListeners.forEach((listener) => listener(entry));
      },
      (userIds) => social.summaries(userIds),
    );
    const liveEvents = new LiveEventController(session, state, (reason) =>
      this.reportError(reason),
    );
    this.session = session;
    this.realtimeClient = new SbpRealtimeClient(session);
    this.messagingClient = new SbpMessagingClient(
      session,
      (conversationId) => this.realtimeClient?.messageSent(conversationId),
      state,
    );
    this.repliesController = new RepliesController(
      this.messagingClient,
      () => this.stateController?.state,
    );
    this.communitiesClient = new SbpCommunitiesClient(session);
    this.attachmentsClient = new SbpAttachmentsClient(session);
    this.callsClient = new SbpCallsClient(session);
    this.privateConversationsClient = new SbpPrivateConversationsClient(
      session,
    );
    this.devicesClient = new SbpDevicesClient(session);
    this.liveSessionRuntime = new SessionRuntime(
      session,
      this.callsClient,
      this.privateConversationsClient,
      endpoint,
      credential.userId,
      this.options.media,
      this.options.privateCrypto,
      this.options.privateTransfers,
      this.options.mediaPreferences,
    );
    this.liveSessionRuntime.start();
    this.ephemeralStateController = new EphemeralStateController(
      session,
      undefined,
      undefined,
      (channelId, changes, onlineCount) => {
        state.updateChannelOnlinePresences(channelId, changes, onlineCount);
      },
    );
    this.ephemeralStateController.start();
    this.unsubscribeEphemeral = this.ephemeralStateController.subscribe(() =>
      this.scheduleStateEmit(),
    );
    this.socialClient = social;
    this.stateController = state;
    this.liveEvents = liveEvents;
    liveEvents.start();
    this.unsubscribeState = state.subscribe(() => {
      if (generation === this.generation) {
        const account = state.state;
        this.set({
          ...this.current,
          account: account.loaded ? account : this.current.account,
        });
        this.workspaceController.reconcile();
      }
    });
    this.unsubscribeStatus = session.subscribeStatus((status) => {
      if (generation !== this.generation) return;
      if (status.state === "online") {
        this.clearReconnectTimer();
        this.reconnectAttempt = 0;
        this.set({
          ...this.current,
          connection: "online",
          policy: status.session.policy,
          error: undefined,
        });
      } else if (status.state === "offline" && this.current.account) {
        if (status.reason instanceof SbpProtocolError) {
          this.set({
            ...this.current,
            connection: "offline",
            error: undefined,
          });
        } else {
          this.options.onError?.(status.reason);
          this.set({
            ...this.current,
            connection: "reconnecting",
            error: status.reason,
          });
          this.scheduleReconnect(
            generation,
            this.reconnectAttempt === 0 ? 0 : undefined,
          );
        }
      }
    });

    this.retryReconnect = () => {
      if (generation !== this.generation || !this.current.account) return;
      this.clearReconnectTimer();
      this.reconnectAttempt = 0;
      this.scheduleReconnect(generation, 0);
    };

    try {
      const authenticated = await session.connect({
        endpoint,
        credential: credential.token,
        deviceId: credential.deviceId,
        clientFamily: this.options.clientFamily,
        clientVersion: this.options.clientVersion,
        capabilities: this.options.capabilities,
      });
      if (authenticated.userId !== credential.userId)
        throw new Error("The SBP credential authenticated a different account");
      if (generation !== this.generation)
        throw new Error("Connection superseded");
      await this.options.credentials.save(credential);
      const initialSnapshot = session.initialAccountSnapshot;
      if (!initialSnapshot)
        throw new Error("The server did not provide an account snapshot");
      state.loadInitialAccount(initialSnapshot);
      return authenticated;
    } catch (reason) {
      if (generation === this.generation) {
        this.disposeRuntime();
        this.set({ connection: "offline", endpoint, error: reason });
      }
      throw reason;
    }
  }

  retryConnection() {
    this.retryReconnect?.();
  }

  async loadConversation(
    conversationId: Parameters<AccountStateController["loadConversation"]>[0],
  ) {
    if (!this.stateController || this.current.connection !== "online")
      throw new Error("The Sideband client is offline");
    return this.stateController.loadConversation(conversationId);
  }

  async loadOlderHistory(conversationId: ConversationId, limit = 50) {
    if (
      !this.stateController ||
      !this.messagingClient ||
      this.current.connection !== "online"
    )
      throw new Error("The Sideband client is offline");
    const messages = this.stateController.state.messages.get(conversationId);
    const before = messages?.size
      ? [...messages.keys()].reduce((oldest, id) => (id < oldest ? id : oldest))
      : undefined;
    const page = await this.messagingClient.history(conversationId, {
      before,
      limit,
    });
    await this.stateController.mergeHistory(page);
    return page;
  }

  private async loadSelectedConversation() {
    const conversationId =
      this.workspaceController.state.selectedConversationId;
    if (
      conversationId &&
      this.stateController?.conversationNeedsRefresh(conversationId)
    )
      await this.loadConversation(conversationId);
  }

  disconnect() {
    ++this.generation;
    this.disposeRuntime();
    this.set({ connection: "offline" });
  }

  async forget(account: AccountKey) {
    if (
      this.current.account?.ownUserId === account.userId &&
      this.current.endpoint?.domain === account.instanceDomain
    )
      this.disconnect();
    await this.options.credentials.delete(account);
  }

  private disposeRuntime() {
    this.clearReconnectTimer();
    this.retryReconnect = undefined;
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    this.unsubscribeEphemeral?.();
    this.unsubscribeEphemeral = undefined;
    this.liveEvents?.stop();
    this.liveEvents = undefined;
    this.session?.disconnect();
    this.session = undefined;
    this.messagingClient = undefined;
    this.repliesController?.reset();
    this.repliesController = undefined;
    this.communitiesClient = undefined;
    this.attachmentsClient = undefined;
    this.callsClient = undefined;
    this.privateConversationsClient = undefined;
    this.devicesClient = undefined;
    this.realtimeClient = undefined;
    this.liveSessionRuntime?.stop();
    this.liveSessionRuntime = undefined;
    this.ephemeralStateController?.stop();
    this.ephemeralStateController = undefined;
    this.socialClient = undefined;
    this.stateController?.reset();
    this.stateController = undefined;
    this.workspaceController.reset();
  }

  private scheduleReconnect(generation: number, delay?: number) {
    if (this.reconnectTimer || generation !== this.generation) return;
    const wait =
      delay ??
      Math.min(
        30_000,
        1_000 * 2 ** Math.min(Math.max(this.reconnectAttempt - 1, 0), 5),
      );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect(generation);
    }, wait);
  }

  private async reconnect(generation: number) {
    const session = this.session;
    const endpoint = this.current.endpoint;
    const account = this.current.account;
    if (!session || !endpoint || !account || generation !== this.generation)
      return;

    const credential = await this.options.credentials.load({
      instanceDomain: endpoint.domain,
      userId: account.ownUserId!,
    });
    if (!credential || Date.parse(credential.expiresAt) <= Date.now()) {
      this.set({
        ...this.current,
        connection: "offline",
        error: new Error("The stored SBP credential has expired"),
      });
      return;
    }

    this.reconnectAttempt += 1;
    try {
      const authenticated = await session.connect({
        endpoint,
        credential: credential.token,
        deviceId: credential.deviceId,
        clientFamily: this.options.clientFamily,
        clientVersion: this.options.clientVersion,
        capabilities: this.options.capabilities,
      });
      if (authenticated.userId !== credential.userId)
        throw new Error("The SBP credential authenticated a different account");
      if (generation === this.generation) {
        const initialSnapshot = session.initialAccountSnapshot;
        if (!initialSnapshot)
          throw new Error("The server did not provide an account snapshot");
        this.stateController?.loadInitialAccount(initialSnapshot);
        await this.loadSelectedConversation();
      }
    } catch (reason) {
      if (generation !== this.generation) return;
      if (reason instanceof SbpProtocolError) {
        this.set({ ...this.current, connection: "offline", error: reason });
      } else {
        this.set({
          ...this.current,
          connection: "reconnecting",
          error: undefined,
        });
        this.scheduleReconnect(generation);
      }
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private reportError(reason: unknown) {
    this.options.onError?.(reason);
    this.set({ ...this.current, error: reason });
  }

  private set(state: SidebandClientState, emit = true) {
    this.current = state;
    if (emit) this.emit();
  }

  private scheduleStateEmit() {
    if (this.stateEmitTimer) return;
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = undefined;
      this.emit();
    }, 100);
  }

  private emit() {
    if (this.stateEmitTimer) clearTimeout(this.stateEmitTimer);
    this.stateEmitTimer = undefined;
    this.listeners.forEach((listener) => listener());
  }
}

function normalizeDomain(value: string) {
  return value.trim().toLowerCase();
}
