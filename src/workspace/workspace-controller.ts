import type {
  Community,
  CommunityChannel,
  ConversationSummary,
} from "../domain.js";
import type { ChannelId, CommunityId, ConversationId } from "../entity-id.js";
import type { AccountState } from "../client/state.js";

export type WorkspaceState = {
  view: "friends" | "conversation";
  selectedConversationId?: ConversationId;
  selectedCommunityId?: CommunityId;
  selectedChannelId?: ChannelId;
};

/** Owns transport-neutral workspace selection using stable native IDs. */
export class WorkspaceController {
  private current: WorkspaceState = { view: "friends" };
  private directMessagesView: "friends" | "conversation" = "friends";
  private lastDirectConversationId?: ConversationId;
  private selectedChannelByCommunity = new Map<CommunityId, ChannelId>();
  private listeners = new Set<() => void>();

  constructor(private readonly account: () => AccountState | undefined) {}

  get state() {
    return this.current;
  }

  get selectedConversation(): ConversationSummary | undefined {
    const id = this.current.selectedConversationId;
    return id ? this.account()?.conversations.get(id) : undefined;
  }

  get selectedCommunity(): Community | undefined {
    const id = this.current.selectedCommunityId;
    return id ? this.account()?.communities.get(id) : undefined;
  }

  get selectedChannel(): CommunityChannel | undefined {
    const id = this.current.selectedChannelId;
    return id
      ? this.selectedCommunity?.channels.find((channel) => channel.id === id)
      : undefined;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  openConversation(conversationId: ConversationId) {
    const conversation = this.requireConversation(conversationId);
    const channel =
      (conversation.channelId
        ? this.findChannel(conversation.channelId)
        : undefined) ?? this.findChannelByConversation(conversation.id);
    if (channel) {
      this.selectedChannelByCommunity.set(
        channel.community.id,
        channel.channel.id,
      );
      this.set({
        view: "conversation",
        selectedConversationId: conversation.id,
        selectedCommunityId: channel.community.id,
        selectedChannelId: channel.channel.id,
      });
      return;
    }
    if (conversation.kind === "community-channel")
      throw new Error("Community channel not found");
    this.directMessagesView = "conversation";
    this.lastDirectConversationId = conversation.id;
    this.set({
      view: "conversation",
      selectedConversationId: conversation.id,
    });
  }

  selectCommunity(communityId: CommunityId) {
    const community = this.requireCommunity(communityId);
    const channels = [...community.channels].sort(
      (left, right) => left.position - right.position,
    );
    const rememberedChannelId = this.selectedChannelByCommunity.get(
      community.id,
    );
    const channel =
      channels.find((candidate) => candidate.id === rememberedChannelId) ??
      channels.find((candidate) => candidate.kind === "text") ??
      channels[0];
    if (channel) this.selectedChannelByCommunity.set(community.id, channel.id);
    this.set({
      view: channel ? "conversation" : "friends",
      selectedCommunityId: community.id,
      selectedChannelId: channel?.id,
      selectedConversationId: channel?.conversationId,
    });
  }

  selectChannel(channelId: ChannelId) {
    const found = this.findChannel(channelId);
    if (!found) throw new Error("Community channel not found");
    this.selectedChannelByCommunity.set(found.community.id, found.channel.id);
    this.set({
      view: "conversation",
      selectedCommunityId: found.community.id,
      selectedChannelId: found.channel.id,
      selectedConversationId: found.channel.conversationId,
    });
  }

  showFriends() {
    this.directMessagesView = "friends";
    this.set({
      view: "friends",
      selectedConversationId: this.lastDirectConversationId,
    });
  }

  showDirectMessages() {
    if (this.directMessagesView === "friends") {
      this.set({
        view: "friends",
        selectedConversationId: this.lastDirectConversationId,
      });
      return;
    }
    const selected = this.current.selectedConversationId
      ? this.account()?.conversations.get(this.current.selectedConversationId)
      : undefined;
    const conversation =
      selected && selected.kind !== "community-channel"
        ? selected
        : this.lastDirectConversationId
          ? this.account()?.conversations.get(this.lastDirectConversationId)
          : undefined;
    this.set({
      view: conversation ? "conversation" : "friends",
      selectedConversationId: conversation?.id,
    });
  }

  reset() {
    this.directMessagesView = "friends";
    this.lastDirectConversationId = undefined;
    this.selectedChannelByCommunity.clear();
    this.set({ view: "friends" });
  }

  /** Reconciles selection after snapshots, membership changes, or deletion. */
  reconcile() {
    const account = this.account();
    if (!account) return this.reset();
    if (
      this.lastDirectConversationId &&
      !account.conversations.has(this.lastDirectConversationId)
    )
      this.lastDirectConversationId = undefined;
    const conversationId = this.current.selectedConversationId;
    const communityId = this.current.selectedCommunityId;
    const channelId = this.current.selectedChannelId;
    if (communityId && !account.communities.has(communityId))
      return this.reset();
    if (channelId && !this.findChannel(channelId)) {
      if (communityId) {
        this.selectedChannelByCommunity.delete(communityId);
        return this.selectCommunity(communityId);
      }
      return this.reset();
    }
    if (conversationId && !account.conversations.has(conversationId))
      return this.reset();
    for (const [rememberedCommunityId, rememberedChannelId] of this
      .selectedChannelByCommunity) {
      const community = account.communities.get(rememberedCommunityId);
      if (
        !community?.channels.some(
          (channel) => channel.id === rememberedChannelId,
        )
      )
        this.selectedChannelByCommunity.delete(rememberedCommunityId);
    }
    this.emit();
  }

  private requireConversation(id: ConversationId) {
    const conversation = this.account()?.conversations.get(id);
    if (!conversation) throw new Error("Conversation not found");
    return conversation;
  }

  private requireCommunity(id: CommunityId) {
    const community = this.account()?.communities.get(id);
    if (!community) throw new Error("Community not found");
    return community;
  }

  private findChannel(channelId: ChannelId) {
    for (const community of this.account()?.communities.values() ?? []) {
      const channel = community.channels.find(
        (candidate) => candidate.id === channelId,
      );
      if (channel) return { community, channel };
    }
    return undefined;
  }

  private findChannelByConversation(conversationId: ConversationId) {
    for (const community of this.account()?.communities.values() ?? []) {
      const channel = community.channels.find(
        (candidate) => candidate.conversationId === conversationId,
      );
      if (channel) return { community, channel };
    }
    return undefined;
  }

  private set(state: WorkspaceState) {
    this.current = state;
    this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}
