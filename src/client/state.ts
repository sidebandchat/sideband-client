import type {
  AccountSnapshot,
  Block,
  ChatMessage,
  ClientDevice,
  Community,
  CommunityMemberPage,
  ConversationSummary,
  HistoryPage,
  InboxEntry,
  NotificationSettings,
  RealtimeSettings,
  RosterContact,
  UserProfile,
  UserSummary,
} from "../domain.js";
import type {
  BlockId,
  ChannelId,
  CommunityId,
  ConversationId,
  DeviceId,
  FriendshipId,
  MessageId,
  NotificationId,
  UserId,
  EventId,
} from "../entity-id.js";
import type { SnapshotClient } from "./snapshot-client.js";
import type { SbpFrame } from "../sbp/frame.js";
import {
  decodeBlock,
  decodeCommunity,
  decodeCommunityChannel,
  decodeCommunityRole,
  decodeConversation,
  decodeDevice,
  decodeFriendship,
  decodeInboxEntry,
  decodeMessage,
  decodeNotificationSettings,
  decodeReactionSummaries,
  decodeRealtimeSettings,
  decodeUserSummary,
} from "../sbp/records.js";
import { decodeEntityRef } from "../sbp/codec.js";
import {
  arrayValue,
  booleanValue,
  mapValue,
  orderedValue,
  required,
  timestampValue,
  unsignedValue,
} from "../sbp/value.js";

export type CachedConversation = {
  messages: ChatMessage[];
  reachedBeginning: boolean;
};

export type MessageCache = {
  load: (
    conversationId: ConversationId,
  ) => Promise<CachedConversation | undefined>;
  put: (
    conversationId: ConversationId,
    messages: ChatMessage[],
    metadata?: { reachedBeginning?: boolean },
  ) => Promise<void>;
  remove: (
    conversationId: ConversationId,
    messageId: MessageId,
  ) => Promise<void>;
};

type ProfileBatch = {
  ids: Set<UserId>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type AccountState = {
  loaded: boolean;
  ownUserId?: UserId;
  ownProfile?: UserProfile;
  users: ReadonlyMap<UserId, UserSummary>;
  friendships: ReadonlyMap<FriendshipId, RosterContact>;
  conversations: ReadonlyMap<ConversationId, ConversationSummary>;
  communities: ReadonlyMap<CommunityId, Community>;
  messages: ReadonlyMap<ConversationId, ReadonlyMap<MessageId, ChatMessage>>;
  pendingMessages: ReadonlyMap<string, ChatMessage>;
  reachedBeginning: ReadonlyMap<ConversationId, boolean>;
  inbox: ReadonlyMap<NotificationId, InboxEntry>;
  blocks: ReadonlyMap<BlockId, Block>;
  notificationSettings: NotificationSettings[];
  devices: ReadonlyMap<DeviceId, ClientDevice>;
  realtimeSettings?: RealtimeSettings;
  accountEventId?: EventId;
  conversationEventIds: ReadonlyMap<ConversationId, EventId>;
};

export function initialAccountState(): AccountState {
  return {
    loaded: false,
    users: new Map(),
    friendships: new Map(),
    conversations: new Map(),
    communities: new Map(),
    messages: new Map(),
    pendingMessages: new Map(),
    reachedBeginning: new Map(),
    inbox: new Map(),
    blocks: new Map(),
    notificationSettings: [],
    devices: new Map(),
    conversationEventIds: new Map(),
  };
}

export class AccountStateController {
  private static readonly remoteNotificationBatchMs = 100;
  private current = initialAccountState();
  private listeners = new Set<() => void>();
  private deferredNotifications = 0;
  private notificationPending = false;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private hydratedConversations = new Set<ConversationId>();
  private profileLoads = new Map<UserId, Promise<void>>();
  private profileBatch?: ProfileBatch;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private optimisticRollbacks = new Map<
    string,
    {
      conversationId: ConversationId;
      messageId: MessageId;
      message: ChatMessage;
      kind: "edit" | "reaction" | "delete";
    }
  >();

  constructor(
    private readonly snapshots: SnapshotClient,
    private readonly messageCache?: MessageCache,
    private readonly onPersistenceError: (reason: unknown) => void = () =>
      undefined,
    private readonly verifyProfile: (
      profile: UserProfile,
    ) => Promise<UserProfile> = async (profile) => profile,
    private readonly onNotification: (entry: InboxEntry) => void = () =>
      undefined,
    private readonly resolveProfiles: (
      userIds: UserId[],
    ) => Promise<UserSummary[]> = async () => [],
  ) {}

  get state() {
    return this.current;
  }

  setRealtimeSettings(settings: RealtimeSettings) {
    this.set({ ...this.current, realtimeSettings: settings });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async loadAccount() {
    const snapshot = await this.snapshots.account();
    this.replaceAccount(snapshot);
    return snapshot;
  }

  loadInitialAccount(snapshot: AccountSnapshot) {
    this.hydratedConversations.clear();
    this.replaceAccount(snapshot);
    this.set({
      ...this.current,
      accountEventId: undefined,
      conversationEventIds: new Map(),
    });
    return snapshot;
  }

  conversationNeedsRefresh(conversationId: ConversationId) {
    return !this.hydratedConversations.has(conversationId);
  }

  async loadConversation(conversationId: ConversationId) {
    if (!this.hydratedConversations.has(conversationId)) {
      this.hydratedConversations.add(conversationId);
      const cached = await this.loadCachedConversation(conversationId);
      if (cached) this.mergeCachedConversation(conversationId, cached);
    }
    const snapshot = await this.snapshots.conversation(conversationId);
    const messages = new Map(this.current.messages);
    const conversationMessages = new Map(messages.get(conversationId) ?? []);
    const snapshotMessages = snapshot.messages.map((message) =>
      withDirection(message, this.current.ownUserId),
    );
    snapshotMessages.forEach((message) =>
      conversationMessages.set(message.id, message),
    );
    messages.set(conversationId, conversationMessages);
    const conversations = new Map(this.current.conversations);
    conversations.set(conversationId, snapshot.conversation);
    const reachedBeginning = new Map(this.current.reachedBeginning);
    const complete =
      snapshot.reachedBeginning ||
      this.current.reachedBeginning.get(conversationId) === true;
    reachedBeginning.set(conversationId, complete);
    const conversationEventIds = new Map(this.current.conversationEventIds);
    const users = mergeProfiles(this.current.users, snapshot.profiles);
    this.set({
      ...this.current,
      users,
      messages,
      conversations,
      reachedBeginning,
      conversationEventIds,
    });
    await this.persistMessages(conversationId, snapshotMessages, {
      reachedBeginning: complete,
    });
    return snapshot;
  }

  async mergeHistory(page: HistoryPage) {
    const messages = new Map(this.current.messages);
    const conversationMessages = new Map(
      messages.get(page.conversationId) ?? [],
    );
    const pageMessages = page.messages.map((message) =>
      withDirection(message, this.current.ownUserId),
    );
    pageMessages.forEach((message) =>
      conversationMessages.set(message.id, message),
    );
    messages.set(page.conversationId, conversationMessages);
    const reachedBeginning = new Map(this.current.reachedBeginning);
    reachedBeginning.set(
      page.conversationId,
      page.reachedBeginning ||
        this.current.reachedBeginning.get(page.conversationId) === true,
    );
    const users = mergeProfiles(this.current.users, page.profiles);
    this.set({ ...this.current, users, messages, reachedBeginning });
    await this.persistMessages(page.conversationId, pageMessages, {
      reachedBeginning: reachedBeginning.get(page.conversationId),
    });
  }

  async applyEvent(frame: Extract<SbpFrame, { kind: "event" }>) {
    this.deferredNotifications += 1;

    try {
      return this.applyEventNow(frame);
    } finally {
      this.deferredNotifications -= 1;
      if (this.deferredNotifications === 0 && this.notificationPending)
        this.scheduleNotification();
    }
  }

  private applyEventNow(frame: Extract<SbpFrame, { kind: "event" }>) {
    if (frame.stream.kind === "account") {
      if (
        this.current.accountEventId !== undefined &&
        frame.eventId <= this.current.accountEventId
      )
        return false;
      this.applyAccountEvent(frame.opcode, frame.payload);
      this.set({ ...this.current, accountEventId: frame.eventId as EventId });
      return true;
    }

    const conversationId = frame.stream.conversationId;
    const previous = this.current.conversationEventIds.get(conversationId);
    if (previous !== undefined && frame.eventId <= previous) return false;
    const cacheMutation = this.applyConversationEvent(
      conversationId,
      frame.opcode,
      frame.payload,
      frame.timestamp,
    );
    const conversationEventIds = new Map(this.current.conversationEventIds);
    conversationEventIds.set(conversationId, frame.eventId as EventId);
    this.set({ ...this.current, conversationEventIds });
    if (cacheMutation?.message)
      this.enqueuePersistence(() =>
        this.persistMessages(conversationId, [cacheMutation.message!], {}),
      );
    else if (cacheMutation?.remove)
      this.enqueuePersistence(() =>
        this.removeCachedMessage(conversationId, cacheMutation.remove!),
      );
    return true;
  }

  async ensureUserProfiles(userIds: Iterable<UserId>) {
    const requested = [...new Set(userIds)].filter(
      (userId) => !this.current.users.has(userId),
    );
    if (!requested.length) return;

    requested
      .filter((userId) => !this.profileLoads.has(userId))
      .forEach((userId) => this.queueProfileLoad(userId));

    await Promise.all(
      requested.map((userId) => this.profileLoads.get(userId)).filter(Boolean),
    );
  }

  reset() {
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = undefined;
    this.notificationPending = false;
    this.deferredNotifications = 0;
    this.hydratedConversations.clear();
    this.profileLoads.clear();
    if (this.profileBatch) clearTimeout(this.profileBatch.timer);
    this.profileBatch = undefined;
    this.persistenceQueue = Promise.resolve();
    this.set(initialAccountState());
  }

  upsertConversation(conversation: ConversationSummary) {
    this.upsert("conversations", conversation, (item) => item.id);
  }

  upsertCommunity(community: Community) {
    this.upsert("communities", community, (item) => item.id);
  }

  mergeCommunityMembers(page: CommunityMemberPage) {
    const community = this.current.communities.get(page.communityId);
    if (!community) return;
    const existing = page.online
      ? (community.onlineMembers ?? [])
      : community.members;
    const members = new Map(existing.map((member) => [member.userId, member]));
    page.members.forEach((member) => members.set(member.userId, member));
    const communities = new Map(this.current.communities);
    communities.set(
      page.communityId,
      page.online
        ? {
            ...community,
            onlineMembers: [...members.values()],
            onlineMembersComplete: page.complete,
            onlineMembersNextAfter: page.nextAfter,
            onlineMemberCount: page.total,
          }
        : {
            ...community,
            members: [...members.values()],
            membersComplete: page.complete,
            membersNextAfter: page.nextAfter,
          },
    );
    const users = new Map(this.current.users);
    page.profiles.forEach((profile) => users.set(profile.id, profile));
    this.set({ ...this.current, communities, users });
  }

  mergeChannelMembers(page: CommunityMemberPage, replace = false) {
    if (!page.channelId) return;
    const communities = new Map(this.current.communities);

    for (const [communityId, community] of communities) {
      const channelIndex = community.channels.findIndex(
        (channel) => channel.id === page.channelId,
      );
      if (channelIndex < 0) continue;
      const channel = community.channels[channelIndex]!;
      const existing = page.online
        ? (channel.onlineMembers ?? [])
        : (channel.members ?? []);
      const members = new Map(
        (replace ? [] : existing).map((member) => [member.userId, member]),
      );
      const pageProfiles = new Map(
        page.profiles.map((profile) => [profile.id, profile]),
      );
      page.members.forEach((member) =>
        members.set(member.userId, {
          ...member,
          profile: pageProfiles.get(member.userId),
        }),
      );
      const updatedChannel = page.online
        ? {
            ...channel,
            onlineMembers: [...members.values()],
            onlineMembersComplete: page.complete,
            onlineMembersNextCursor: page.nextCursor,
            onlineMemberCount: page.total,
          }
        : {
            ...channel,
            members: [...members.values()],
            memberCount: page.total,
            membersComplete: page.complete,
            membersNextCursor: page.nextCursor,
          };
      const channels = [...community.channels];
      channels[channelIndex] = updatedChannel;
      communities.set(communityId, { ...community, channels });
      break;
    }

    const users = new Map(this.current.users);
    page.profiles.forEach((profile) => users.set(profile.id, profile));
    this.set({ ...this.current, communities, users });
  }

  updateChannelOnlinePresence(
    channelId: ChannelId,
    userId: UserId,
    online: boolean,
  ) {
    this.updateChannelOnlinePresences(channelId, new Map([[userId, online]]));
  }

  updateChannelOnlinePresences(
    channelId: ChannelId,
    changes: ReadonlyMap<UserId, boolean>,
    onlineCount?: number,
  ) {
    const communities = new Map(this.current.communities);

    for (const [communityId, community] of communities) {
      const channelIndex = community.channels.findIndex(
        (channel) => channel.id === channelId,
      );
      if (channelIndex < 0) continue;
      const channel = community.channels[channelIndex]!;
      if (!channel.onlineMembers) return;
      const onlineMembers = new Map(
        channel.onlineMembers.map((member) => [member.userId, member]),
      );
      const members = new Map(
        (channel.members ?? []).map((member) => [member.userId, member]),
      );
      changes.forEach((online, userId) => {
        if (!online) onlineMembers.delete(userId);
        else if (!onlineMembers.has(userId) && members.has(userId))
          onlineMembers.set(userId, members.get(userId)!);
      });
      const channels = [...community.channels];
      channels[channelIndex] = {
        ...channel,
        onlineMembers: [...onlineMembers.values()],
        onlineMemberCount: onlineCount ?? channel.onlineMemberCount,
        onlineMembersComplete:
          onlineCount === undefined
            ? channel.onlineMembersComplete
            : onlineMembers.size >= onlineCount,
      };
      communities.set(communityId, { ...community, channels });
      this.set({ ...this.current, communities });
      return;
    }
  }

  resetCommunityOnlineMembers(communityId: CommunityId) {
    const community = this.current.communities.get(communityId);
    if (!community) return;
    const communities = new Map(this.current.communities);
    communities.set(communityId, {
      ...community,
      onlineMembers: [],
      onlineMembersComplete: false,
      onlineMembersNextAfter: undefined,
      onlineMemberCount: undefined,
    });
    this.set({ ...this.current, communities });
  }

  replaceCommunityOnlineMembers(page: CommunityMemberPage) {
    if (!page.online) return;
    const communityId = page.communityId;
    const community = this.current.communities.get(communityId);
    if (!community) return;
    const communities = new Map(this.current.communities);
    communities.set(communityId, {
      ...community,
      onlineMembers: page.members,
      onlineMembersComplete: page.complete,
      onlineMembersNextAfter: page.nextAfter,
      onlineMemberCount: page.total,
    });
    const users = new Map(this.current.users);
    page.profiles.forEach((profile) => users.set(profile.id, profile));
    this.set({ ...this.current, communities, users });
  }

  updateCommunityOnlinePresence(
    communityId: CommunityId,
    userId: UserId,
    online: boolean,
  ) {
    const community = this.current.communities.get(communityId);
    if (!community?.onlineMembers) return;

    const existing = community.onlineMembers.find(
      (member) => member.userId === userId,
    );
    const count = community.onlineMemberCount ?? community.onlineMembers.length;

    if ((online && existing) || (!online && !existing && count === 0)) return;

    const onlineMembers = online
      ? [
          ...community.onlineMembers,
          community.members.find((member) => member.userId === userId) ?? {
            userId,
            joinedAt: new Date(0).toISOString(),
            roleIds: [],
            permissions: [],
            revision: 0,
          },
        ]
      : community.onlineMembers.filter((member) => member.userId !== userId);
    const communities = new Map(this.current.communities);
    communities.set(communityId, {
      ...community,
      onlineMembers,
      onlineMemberCount: Math.max(0, count + (online ? 1 : -1)),
    });
    this.set({ ...this.current, communities });
  }

  addPendingMessage(requestId: string, message: ChatMessage) {
    const pendingMessages = new Map(this.current.pendingMessages);
    pendingMessages.set(requestId, message);
    this.set({ ...this.current, pendingMessages });
  }

  failPendingMessage(requestId: string, reason: unknown) {
    const message = this.current.pendingMessages.get(requestId);
    if (!message) return;
    const pendingMessages = new Map(this.current.pendingMessages);
    pendingMessages.set(requestId, {
      ...message,
      pending: {
        requestId,
        state: "failed",
        error: reason instanceof Error ? reason.message : "Message failed",
      },
    });
    this.set({ ...this.current, pendingMessages });
  }

  markPendingMessageSending(requestId: string) {
    const message = this.current.pendingMessages.get(requestId);
    if (!message) return;
    const pendingMessages = new Map(this.current.pendingMessages);
    pendingMessages.set(requestId, {
      ...message,
      pending: { requestId, state: "sending" },
    });
    this.set({ ...this.current, pendingMessages });
  }

  async confirmPendingMessage(requestId: string, message: ChatMessage) {
    const pendingMessages = new Map(this.current.pendingMessages);
    pendingMessages.delete(requestId);
    const messages = new Map(this.current.messages);
    const conversationMessages = new Map(
      messages.get(message.conversationId) ?? [],
    );
    const confirmed = withDirection(message, this.current.ownUserId);
    const transitioning = {
      ...confirmed,
      confirmationTransition: { requestId },
    };
    conversationMessages.set(transitioning.id, transitioning);
    messages.set(transitioning.conversationId, conversationMessages);
    this.set({ ...this.current, pendingMessages, messages });
    await this.persistMessages(confirmed.conversationId, [confirmed], {});
    globalThis.setTimeout(
      () =>
        this.finishConfirmationTransition(
          confirmed.conversationId,
          confirmed.id,
          requestId,
        ),
      65,
    );
  }

  private finishConfirmationTransition(
    conversationId: ConversationId,
    messageId: MessageId,
    requestId: string,
  ) {
    const conversationMessages = this.current.messages.get(conversationId);
    const current = conversationMessages?.get(messageId);
    if (current?.confirmationTransition?.requestId !== requestId) return;
    const messages = new Map(this.current.messages);
    const nextConversationMessages = new Map(conversationMessages);
    const confirmed = { ...current };
    delete confirmed.confirmationTransition;
    nextConversationMessages.set(messageId, confirmed);
    messages.set(conversationId, nextConversationMessages);
    this.set({ ...this.current, messages });
  }

  discardPendingMessage(requestId: string) {
    if (!this.current.pendingMessages.has(requestId)) return;
    const pendingMessages = new Map(this.current.pendingMessages);
    pendingMessages.delete(requestId);
    this.set({ ...this.current, pendingMessages });
  }

  beginOptimisticMutation(
    requestId: string,
    conversationId: ConversationId,
    messageId: MessageId,
    kind: "edit" | "reaction" | "delete",
    update?: (message: ChatMessage) => ChatMessage,
  ) {
    const original = this.current.messages.get(conversationId)?.get(messageId);
    if (!original) return;
    this.optimisticRollbacks.set(requestId, {
      conversationId,
      messageId,
      message: original,
      kind,
    });
    const messages = new Map(this.current.messages);
    const conversationMessages = new Map(messages.get(conversationId) ?? []);
    if (kind === "delete") conversationMessages.delete(messageId);
    else if (update)
      conversationMessages.set(messageId, {
        ...update(original),
        pendingMutation: { requestId, kind },
      });
    messages.set(conversationId, conversationMessages);
    this.set({ ...this.current, messages });
  }

  completeOptimisticMutation(
    requestId: string,
    revision?: number,
    update?: (message: ChatMessage) => ChatMessage,
  ) {
    const rollback = this.optimisticRollbacks.get(requestId);
    if (!rollback) return;
    this.optimisticRollbacks.delete(requestId);
    if (rollback.kind === "delete") return;
    const current = this.current.messages
      .get(rollback.conversationId)
      ?.get(rollback.messageId);
    if (current?.pendingMutation?.requestId !== requestId) return;
    const messages = new Map(this.current.messages);
    const conversationMessages = new Map(
      messages.get(rollback.conversationId) ?? [],
    );
    const confirmed = { ...(update ? update(current) : current) };
    delete confirmed.pendingMutation;
    conversationMessages.set(rollback.messageId, {
      ...confirmed,
      revision: revision ?? confirmed.revision,
    });
    messages.set(rollback.conversationId, conversationMessages);
    this.set({ ...this.current, messages });
  }

  rollbackOptimisticMutation(requestId: string) {
    const rollback = this.optimisticRollbacks.get(requestId);
    if (!rollback) return;
    this.optimisticRollbacks.delete(requestId);
    const current = this.current.messages
      .get(rollback.conversationId)
      ?.get(rollback.messageId);
    if (
      rollback.kind !== "delete" &&
      current?.pendingMutation?.requestId !== requestId
    )
      return;
    const messages = new Map(this.current.messages);
    const conversationMessages = new Map(
      messages.get(rollback.conversationId) ?? [],
    );
    conversationMessages.set(rollback.messageId, rollback.message);
    messages.set(rollback.conversationId, conversationMessages);
    this.set({ ...this.current, messages });
  }

  private replaceAccount(snapshot: AccountSnapshot) {
    const users = new Map(
      [snapshot.ownUser, ...snapshot.users].map(
        (user) => [user.id, user] as const,
      ),
    );
    this.set({
      ...this.current,
      loaded: true,
      ownUserId: snapshot.ownUser.id,
      ownProfile: snapshot.ownUser,
      users,
      friendships: keyed(snapshot.friendships, (item) => item.friendshipId),
      conversations: keyed(snapshot.conversations, (item) => item.id),
      communities: keyed(snapshot.communities, (item) => item.id),
      inbox: keyed(snapshot.inbox, (item) => item.id),
      blocks: keyed(snapshot.blocks, (item) => item.id),
      notificationSettings: snapshot.notificationSettings,
      devices: keyed(snapshot.devices, (item) => item.id),
      realtimeSettings: snapshot.realtimeSettings,
      accountEventId: undefined,
    });
    if (snapshot.ownUser.badgeAssertion)
      this.verifyAndUpsertProfile(snapshot.ownUser);
  }

  private mergeCachedConversation(
    conversationId: ConversationId,
    cached: CachedConversation,
  ) {
    const messages = new Map(this.current.messages);
    const conversationMessages = new Map(
      cached.messages.map((message) => {
        const directed = withDirection(message, this.current.ownUserId);
        return [directed.id, directed];
      }),
    );
    for (const [id, message] of messages.get(conversationId) ?? [])
      conversationMessages.set(id, message);
    messages.set(conversationId, conversationMessages);
    const reachedBeginning = new Map(this.current.reachedBeginning);
    reachedBeginning.set(conversationId, cached.reachedBeginning);
    this.set({
      ...this.current,
      messages,
      reachedBeginning,
    });
  }

  private async loadCachedConversation(conversationId: ConversationId) {
    try {
      return await this.messageCache?.load(conversationId);
    } catch (reason) {
      this.onPersistenceError(reason);
      return undefined;
    }
  }

  private async persistMessages(
    conversationId: ConversationId,
    messages: ChatMessage[],
    metadata: { reachedBeginning?: boolean },
  ) {
    try {
      await this.messageCache?.put(conversationId, messages, metadata);
    } catch (reason) {
      this.onPersistenceError(reason);
    }
  }

  private async removeCachedMessage(
    conversationId: ConversationId,
    messageId: MessageId,
  ) {
    try {
      await this.messageCache?.remove(conversationId, messageId);
    } catch (reason) {
      this.onPersistenceError(reason);
    }
  }

  private enqueuePersistence(operation: () => Promise<void>) {
    this.persistenceQueue = this.persistenceQueue
      .then(operation)
      .catch((reason) => {
        this.onPersistenceError(reason);
      });
  }

  private queueProfileLoad(userId: UserId) {
    if (!this.profileBatch) {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((batchResolve, batchReject) => {
        resolve = batchResolve;
        reject = batchReject;
      });
      const createdBatch: ProfileBatch = {
        ids: new Set<UserId>(),
        promise,
        resolve,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      createdBatch.timer = setTimeout(
        () => void this.flushProfileBatch(createdBatch),
        25,
      );
      this.profileBatch = createdBatch;
    }

    const batch = this.profileBatch;
    batch.ids.add(userId);
    this.profileLoads.set(userId, batch.promise);
  }

  private async flushProfileBatch(batch: ProfileBatch) {
    if (this.profileBatch === batch) this.profileBatch = undefined;
    const ids = [...batch.ids];

    try {
      const profiles: UserSummary[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        profiles.push(
          ...(await this.resolveProfiles(ids.slice(offset, offset + 100))),
        );
      }
      const users = mergeProfiles(this.current.users, profiles);
      this.set({ ...this.current, users });
      batch.resolve();
    } catch (reason) {
      batch.reject(reason);
    } finally {
      ids.forEach((userId) => {
        if (this.profileLoads.get(userId) === batch.promise)
          this.profileLoads.delete(userId);
      });
    }
  }

  private applyAccountEvent(opcode: number, payload: unknown) {
    switch (opcode) {
      case 2:
        this.upsert("devices", decodeDevice(payload), (item) => item.id);
        return;
      case 3:
        this.remove(
          "devices",
          decodeEntityRef(required(mapValue(payload), 0), "device"),
        );
        return;
      case 20:
        this.upsertUserSummaryNow(decodeUserSummary(payload));
        return;
      case 24:
        this.upsert(
          "friendships",
          decodeFriendship(payload),
          (item) => item.friendshipId,
        );
        return;
      case 30:
        {
          const entry = decodeInboxEntry(payload);
          this.upsert("inbox", entry, (item) => item.id);
          this.onNotification(entry);
        }
        return;
      case 31: {
        const map = mapValue(payload);
        const id = orderedValue<"notification">(required(map, 0));
        const current = this.current.inbox.get(id);
        if (current)
          this.upsert(
            "inbox",
            { ...current, read: booleanValue(required(map, 1)) },
            (item) => item.id,
          );
        return;
      }
      case 32:
        this.upsert("blocks", decodeBlock(payload), (item) => item.id);
        return;
      case 33:
        this.remove(
          "blocks",
          decodeEntityRef(required(mapValue(payload), 0), "block"),
        );
        return;
      case 34: {
        const setting = decodeNotificationSettings(payload);
        this.set({
          ...this.current,
          notificationSettings: [
            ...this.current.notificationSettings.filter(
              (candidate) =>
                notificationScopeKey(candidate) !==
                notificationScopeKey(setting),
            ),
            setting,
          ],
        });
        return;
      }
      case 104: {
        const map = mapValue(payload);
        const conversationId = decodeEntityRef(
          required(map, 0),
          "conversation",
        );
        const userId = decodeEntityRef(required(map, 1), "user");
        if (userId !== this.current.ownUserId) return;
        const readThroughMessageId = orderedValue<"message">(required(map, 2));
        const conversation = this.current.conversations.get(conversationId);
        const conversations = new Map(this.current.conversations);
        if (conversation)
          conversations.set(conversationId, {
            ...conversation,
            readThroughMessageId,
          });
        const inbox = new Map(this.current.inbox);
        for (const [id, entry] of inbox) {
          if (
            !entry.read &&
            entry.conversationId === conversationId &&
            entry.messageId !== undefined &&
            entry.messageId <= readThroughMessageId
          )
            inbox.set(id, { ...entry, read: true });
        }
        this.set({ ...this.current, conversations, inbox });
        return;
      }
      case 105:
        this.upsert(
          "conversations",
          decodeConversation(payload),
          (item) => item.id,
        );
        return;
      case 106:
        this.remove(
          "conversations",
          decodeEntityRef(required(mapValue(payload), 0), "conversation"),
        );
        return;
      case 200:
        this.upsert("communities", decodeCommunity(payload), (item) => item.id);
        return;
      case 201:
      case 202:
        this.applyCommunityMembership(opcode, payload);
        return;
      case 210:
        this.applyChannelUpsert(decodeCommunityChannel(payload));
        return;
      case 211:
        this.applyChannelRemoval(payload);
        return;
      case 220:
        this.applyRoleUpsert(decodeCommunityRole(payload));
        return;
      case 221:
        this.applyMemberRoles(payload);
        return;
      case 222:
        this.applyRoleRemoval(payload);
        return;
      case 500:
        this.set({
          ...this.current,
          realtimeSettings: decodeRealtimeSettings(payload),
        });
        return;
      default:
        return;
    }
  }

  private verifyAndUpsertProfile(profile: UserProfile) {
    if (!profile.badgeAssertion) {
      if (profile.id === this.current.ownUserId)
        this.current = { ...this.current, ownProfile: profile };
      this.upsert("users", profile, (item) => item.id);
      return;
    }
    void this.verifyProfile(profile)
      .then((verified) => {
        if (verified.id === this.current.ownUserId)
          this.current = { ...this.current, ownProfile: verified };
        this.upsert("users", verified, (item) => item.id);
      })
      .catch(this.onPersistenceError);
  }

  setOwnProfile(profile: UserProfile) {
    this.verifyAndUpsertProfile(profile);
  }

  private upsertUserSummaryNow(summary: UserSummary) {
    const current = this.current.users.get(summary.id);
    if (current && current.revision > summary.revision) return;
    this.upsert(
      "users",
      current ? { ...current, ...summary } : summary,
      (item) => item.id,
    );
  }

  private applyConversationEvent(
    conversationId: ConversationId,
    opcode: number,
    payload: unknown,
    timestamp: Date,
  ): { message?: ChatMessage; remove?: MessageId } | undefined {
    const messages = new Map(this.current.messages);
    const conversationMessages = new Map(messages.get(conversationId) ?? []);
    if (opcode === 100 || opcode === 101) {
      const message = withDirection(
        decodeMessage(payload),
        this.current.ownUserId,
      );
      if (message.conversationId !== conversationId)
        throw new TypeError(
          "Message event belongs to a different conversation",
        );
      this.clearOptimisticRollbacks(conversationId, message.id);
      conversationMessages.set(message.id, message);
      messages.set(conversationId, conversationMessages);
      const users = new Map(this.current.users);
      for (const summary of [message.author, message.replyPreview?.author]) {
        if (!summary) continue;
        const current = users.get(summary.id);
        if (!current || current.revision <= summary.revision) {
          users.set(summary.id, current ? { ...current, ...summary } : summary);
        }
      }
      const conversation = this.current.conversations.get(conversationId);
      let inbox = this.current.inbox;
      let notification: InboxEntry | undefined;

      if (
        opcode === 100 &&
        conversation?.kind === "community-channel" &&
        message.authorId !== undefined &&
        message.authorId !== this.current.ownUserId
      ) {
        const previous = [...inbox.values()].find(
          (entry) =>
            entry.kind === "unread" &&
            !entry.read &&
            entry.conversationId === conversationId,
        );

        if (
          previous?.messageId === undefined ||
          previous.messageId < message.id
        ) {
          const updatedInbox = new Map(inbox);
          if (previous) updatedInbox.delete(previous.id);
          notification = {
            id: message.id as unknown as NotificationId,
            kind: "unread",
            conversationId,
            messageId: message.id,
            senderId: message.authorId,
            preview: message.body.slice(0, 240),
            createdAt: message.timestamp,
            read: false,
            unreadCount: (previous?.unreadCount ?? 0) + 1,
          };
          updatedInbox.set(notification.id, notification);
          inbox = updatedInbox;
        }
      }

      this.set({ ...this.current, users, messages, inbox });
      if (notification) this.onNotification(notification);
      return { message };
    } else if (opcode === 102) {
      const map = mapValue(payload);
      if (decodeEntityRef(required(map, 0), "conversation") !== conversationId)
        throw new TypeError(
          "Deletion event belongs to a different conversation",
        );
      const messageId = orderedValue<"message">(required(map, 1));
      this.clearOptimisticRollbacks(conversationId, messageId);
      const message = conversationMessages.get(messageId);
      if (message) {
        const updated = {
          ...message,
          body: "",
          deletedAt: timestamp.toISOString(),
          revision: unsignedValue(required(map, 2)),
        };
        conversationMessages.set(messageId, {
          ...updated,
        });
        messages.set(conversationId, conversationMessages);
        this.set({ ...this.current, messages });
        return { message: updated };
      }
      return { remove: messageId };
    } else if (opcode === 103) {
      const map = mapValue(payload);
      if (decodeEntityRef(required(map, 0), "conversation") !== conversationId)
        throw new TypeError(
          "Reaction event belongs to a different conversation",
        );
      const messageId = orderedValue<"message">(required(map, 1));
      this.clearOptimisticRollbacks(conversationId, messageId);
      const senderId = decodeEntityRef(required(map, 2), "user");
      const message = conversationMessages.get(messageId);
      if (message) {
        const ownEmojis =
          senderId === this.current.ownUserId
            ? arrayValue(required(map, 3)).map(String)
            : (message.reactions ?? [])
                .filter((reaction) => reaction.own)
                .map((reaction) => reaction.emoji);
        const own = new Set(ownEmojis);
        const reactions = decodeReactionSummaries(required(map, 6)).map(
          (reaction) => ({
            ...reaction,
            own: own.has(reaction.emoji),
          }),
        );
        conversationMessages.set(messageId, {
          ...message,
          reactions,
          revision: unsignedValue(required(map, 5)),
        });
        const updated = conversationMessages.get(messageId)!;
        messages.set(conversationId, conversationMessages);
        this.set({ ...this.current, messages });
        return { message: updated };
      }
      return { remove: messageId };
    }
    return undefined;
  }

  private clearOptimisticRollbacks(
    conversationId: ConversationId,
    messageId: MessageId,
  ) {
    for (const [requestId, rollback] of this.optimisticRollbacks) {
      if (
        rollback.conversationId === conversationId &&
        rollback.messageId === messageId
      )
        this.optimisticRollbacks.delete(requestId);
    }
  }

  private applyCommunityMembership(opcode: 201 | 202, payload: unknown) {
    const map = mapValue(payload);
    const communityId = decodeEntityRef(required(map, 0), "community");
    const userId = decodeEntityRef(required(map, 1), "user");
    const community = this.current.communities.get(communityId);
    if (!community) return;
    const members = community.members.filter(
      (member) => member.userId !== userId,
    );
    if (opcode === 201)
      members.push({
        userId,
        joinedAt: timestampValue(required(map, 2)),
        roleIds: [],
        permissions: [],
        revision: 0,
      });
    this.upsert("communities", { ...community, members }, (item) => item.id);
  }

  private applyChannelUpsert(channel: Community["channels"][number]) {
    const community = this.current.communities.get(channel.communityId);
    if (!community) return;
    const existing = community.channels.find((item) => item.id === channel.id);
    this.upsert(
      "communities",
      {
        ...community,
        channels: [
          ...community.channels.filter((item) => item.id !== channel.id),
          { ...existing, ...channel },
        ],
      },
      (item) => item.id,
    );
  }

  private applyChannelRemoval(payload: unknown) {
    const map = mapValue(payload);
    const communityId = decodeEntityRef(required(map, 0), "community");
    const channelId = decodeEntityRef(required(map, 1), "channel");
    const community = this.current.communities.get(communityId);
    if (community)
      this.upsert(
        "communities",
        {
          ...community,
          channels: community.channels.filter((item) => item.id !== channelId),
        },
        (item) => item.id,
      );
  }

  private applyRoleUpsert(role: Community["roles"][number]) {
    const community = this.current.communities.get(role.communityId);
    if (!community) return;
    this.upsert(
      "communities",
      {
        ...community,
        roles: [...community.roles.filter((item) => item.id !== role.id), role],
      },
      (item) => item.id,
    );
  }

  private applyMemberRoles(payload: unknown) {
    const map = mapValue(payload);
    const communityId = decodeEntityRef(required(map, 0), "community");
    const userId = decodeEntityRef(required(map, 1), "user");
    const community = this.current.communities.get(communityId);
    if (!community) return;
    const roleIds = arrayValue(required(map, 2)).map((entry) =>
      decodeEntityRef(entry, "role"),
    );
    const revision = unsignedValue(required(map, 3));
    this.upsert(
      "communities",
      {
        ...community,
        members: community.members.map((member) =>
          member.userId === userId ? { ...member, roleIds, revision } : member,
        ),
      },
      (item) => item.id,
    );
  }

  private applyRoleRemoval(payload: unknown) {
    const map = mapValue(payload);
    const communityId = decodeEntityRef(required(map, 0), "community");
    const roleId = decodeEntityRef(required(map, 1), "role");
    const community = this.current.communities.get(communityId);
    if (!community) return;
    this.upsert(
      "communities",
      {
        ...community,
        roles: community.roles.filter((role) => role.id !== roleId),
        members: community.members.map((member) => ({
          ...member,
          roleIds: member.roleIds.filter((id) => id !== roleId),
        })),
      },
      (item) => item.id,
    );
  }

  private upsert<
    Name extends
      | "users"
      | "friendships"
      | "conversations"
      | "communities"
      | "inbox"
      | "blocks"
      | "devices",
    Value extends (AccountState[Name] extends ReadonlyMap<unknown, infer Item>
      ? Item
      : never),
    Key,
  >(name: Name, value: Value, key: (value: Value) => Key) {
    const values = new Map(this.current[name] as ReadonlyMap<Key, Value>);
    values.set(key(value), value);
    this.set({ ...this.current, [name]: values });
  }

  private remove<
    Name extends
      | "users"
      | "friendships"
      | "conversations"
      | "communities"
      | "inbox"
      | "blocks"
      | "devices",
    Key,
  >(name: Name, key: Key) {
    const values = new Map(this.current[name] as ReadonlyMap<Key, unknown>);
    values.delete(key);
    this.set({ ...this.current, [name]: values });
  }

  private set(state: AccountState) {
    if (state === this.current) return;
    this.current = state;
    if (this.deferredNotifications > 0) {
      this.notificationPending = true;
      return;
    }
    this.notify();
  }

  private scheduleNotification() {
    if (this.notificationTimer) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      if (this.notificationPending) this.notify();
    }, AccountStateController.remoteNotificationBatchMs);
  }

  private notify() {
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = undefined;
    this.notificationPending = false;
    this.listeners.forEach((listener) => listener());
  }
}

function keyed<Key, Value>(values: Value[], key: (value: Value) => Key) {
  return new Map(values.map((value) => [key(value), value] as const));
}

function mergeProfiles(
  current: ReadonlyMap<UserId, UserSummary>,
  profiles: UserSummary[],
) {
  if (!profiles.length) return current;
  const users = new Map(current);
  profiles.forEach((profile) => {
    const existing = users.get(profile.id);
    if (!existing || existing.revision <= profile.revision)
      users.set(profile.id, profile);
  });
  return users;
}

function withDirection(message: ChatMessage, ownUserId?: UserId): ChatMessage {
  return {
    ...message,
    outgoing: ownUserId !== undefined && message.authorId === ownUserId,
  };
}

function notificationScopeKey(setting: NotificationSettings) {
  switch (setting.scope.kind) {
    case "account":
      return "account";
    case "conversation":
      return `conversation:${setting.scope.conversationId}`;
    case "community":
      return `community:${setting.scope.communityId}`;
  }
}
