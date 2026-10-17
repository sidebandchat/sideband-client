import type {
  Community,
  CommunityChannel,
  CommunityParticipant,
  ContactPresence,
  ConversationSummary,
  PresenceView,
  RosterContact,
  UserSummary,
} from "../domain.js";
import type {
  AttachmentId,
  ChannelId,
  CommunityId,
  ConversationId,
  UserId,
} from "../entity-id.js";
import type { FriendshipLists } from "../model/selectors.js";
import type { AccountState } from "../client/state.js";

export type ConversationDestination = {
  id: string;
  label: string;
  detail: string;
  kind: "dm" | "group_dm" | "channel";
  conversationId?: ConversationId;
  communityId?: CommunityId;
  channelId?: ChannelId;
  userId?: UserId;
  avatarId?: AttachmentId;
  channelKind?: CommunityChannel["kind"];
};

export type WorkspaceDirectory = {
  conversations: ConversationSummary[];
  destinations: ConversationDestination[];
};

export type MentionCandidate = {
  userId: UserId;
  username: string;
  label: string;
};

export function userDisplayName(
  userId: UserId,
  profiles: ReadonlyMap<UserId, UserSummary>,
) {
  const profile = profiles.get(userId);
  return profile?.displayName.trim() || profile?.username || "Unknown user";
}

export function conversationDisplayName(
  conversation: ConversationSummary,
  ownUserId: UserId,
  profiles: ReadonlyMap<UserId, UserSummary>,
) {
  if (conversation.name?.trim()) return conversation.name.trim();
  const others = conversation.participantIds.filter(
    (userId) => userId !== ownUserId,
  );
  const participants = others.length ? others : conversation.participantIds;
  return (
    participants
      .map((userId) => userDisplayName(userId, profiles))
      .join(", ") || "Conversation"
  );
}

export function createWorkspaceDirectory(
  state: Pick<
    AccountState,
    "ownUserId" | "users" | "conversations" | "communities"
  >,
): WorkspaceDirectory {
  if (!state.ownUserId) return { conversations: [], destinations: [] };
  const conversations = [...state.conversations.values()]
    .filter((conversation) => conversation.kind !== "community-channel")
    .sort(compareConversations);
  const conversationDestinations = conversations.map(
    (conversation): ConversationDestination => {
      const userId =
        conversation.kind === "direct"
          ? conversation.participantIds.find(
              (candidate) => candidate !== state.ownUserId,
            )
          : undefined;
      const profile = userId ? state.users.get(userId) : undefined;
      return {
        id: `conversation:${conversation.id}`,
        label: conversationDisplayName(
          conversation,
          state.ownUserId!,
          state.users,
        ),
        detail:
          conversation.kind === "group"
            ? "Group DM"
            : profile?.username || "Direct message",
        kind: conversation.kind === "group" ? "group_dm" : "dm",
        conversationId: conversation.id,
        userId,
        avatarId: conversation.avatarId ?? profile?.avatarId,
      };
    },
  );
  const channelDestinations = [...state.communities.values()].flatMap(
    (community) =>
      community.channels.map((channel): ConversationDestination => ({
        id: `channel:${channel.id}`,
        label: channel.name,
        detail: community.name,
        kind: "channel",
        conversationId: channel.conversationId,
        communityId: community.id,
        channelId: channel.id,
        channelKind: channel.kind,
      })),
  );
  return {
    conversations,
    destinations: [...conversationDestinations, ...channelDestinations],
  };
}

export function createMentionCandidates(options: {
  ownUserId: UserId;
  selectedConversation?: ConversationSummary;
  participants: CommunityParticipant[];
  profiles: ReadonlyMap<UserId, UserSummary>;
}) {
  const participantIds = options.participants.length
    ? options.participants.map((participant) => participant.userId)
    : (options.selectedConversation?.participantIds ?? [options.ownUserId]);
  return uniqueMentionCandidates(
    participantIds
      .filter((userId) => userId !== options.ownUserId)
      .map((userId): MentionCandidate => {
        const profile = options.profiles.get(userId);
        const nick = options.participants.find(
          (participant) => participant.userId === userId,
        )?.nick;
        return {
          userId,
          username: profile?.username || nick || "user",
          label: profile?.displayName || nick || profile?.username || "User",
        };
      }),
  );
}

export function uniqueMentionCandidates(candidates: MentionCandidate[]) {
  const unique = new Map<UserId, MentionCandidate>();
  for (const candidate of candidates) {
    const label = candidate.label.trim();
    if (!label) continue;
    const current = { ...candidate, label };
    const existing = unique.get(candidate.userId);
    if (
      !existing ||
      (existing.label === existing.username && label !== candidate.username)
    )
      unique.set(candidate.userId, current);
  }
  return [...unique.values()];
}

export function typingDisplayNames(
  userIds: Iterable<UserId>,
  participants: CommunityParticipant[],
  profiles: ReadonlyMap<UserId, UserSummary>,
) {
  return [...userIds].flatMap((userId) => {
    const profile = profiles.get(userId);
    const name =
      profile?.displayName ||
      participants.find((participant) => participant.userId === userId)?.nick ||
      profile?.username;
    return name ? [name] : [];
  });
}

export function conversationRelationship(options: {
  userId: UserId;
  friendships: FriendshipLists;
  presence: ReadonlyMap<UserId, PresenceView>;
}) {
  const find = (items: RosterContact[]) =>
    items.find((friendship) => friendship.userId === options.userId);
  const currentPresence = options.presence.get(options.userId);
  return {
    friend: Boolean(find(options.friendships.accepted)),
    requestIncoming: Boolean(find(options.friendships.received)),
    requestSent: Boolean(find(options.friendships.sent)),
    presence: (currentPresence?.availability ?? "offline") as ContactPresence,
    status: currentPresence?.customStatus?.text,
  };
}

function compareConversations(
  left: ConversationSummary,
  right: ConversationSummary,
) {
  const leftId = left.newestEventId ?? 0n;
  const rightId = right.newestEventId ?? 0n;
  return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
}

export function communityForChannel(
  communities: Iterable<Community>,
  channelId: ChannelId,
) {
  return [...communities].find((community) =>
    community.channels.some((channel) => channel.id === channelId),
  );
}
