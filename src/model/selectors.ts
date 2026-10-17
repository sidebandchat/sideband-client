import type {
  ActivityView,
  CommunityMember,
  ContactPresence,
  ConversationSummary,
  RosterContact,
  UserSummary,
} from "../domain.js";
import type { CommunityId, ConversationId, UserId } from "../entity-id.js";
import type { EphemeralState } from "../client/ephemeral-state.js";
import type { AccountState } from "../client/state.js";

export type FriendshipLists = {
  accepted: RosterContact[];
  received: RosterContact[];
  sent: RosterContact[];
};

export function friendshipLists(state: AccountState): FriendshipLists {
  const ownUserId = state.ownUserId;
  const result: FriendshipLists = { accepted: [], received: [], sent: [] };
  for (const friendship of state.friendships.values()) {
    if (friendship.state === "accepted") result.accepted.push(friendship);
    else if (friendship.state === "pending")
      result[friendship.requesterId === ownUserId ? "sent" : "received"].push(
        friendship,
      );
  }
  const compare = (left: RosterContact, right: RosterContact) =>
    userName(state, left.userId).localeCompare(userName(state, right.userId));
  result.accepted.sort(compare);
  result.received.sort(compare);
  result.sent.sort(compare);
  return result;
}

export function userName(state: AccountState, userId: UserId) {
  const profile = state.users.get(userId);
  return profile?.displayName.trim() || profile?.username || "Unknown user";
}

export function conversationName(
  state: AccountState,
  conversation: ConversationSummary | ConversationId,
) {
  const record =
    typeof conversation === "string"
      ? state.conversations.get(conversation)
      : conversation;
  if (!record) return "Unknown conversation";
  if (record.name?.trim()) return record.name.trim();
  const others = record.participantIds.filter(
    (userId) => userId !== state.ownUserId,
  );
  const names = (others.length ? others : record.participantIds).map((userId) =>
    userName(state, userId),
  );
  return names.join(", ") || "Conversation";
}

export function conversationProfiles(
  state: AccountState,
  conversationId: ConversationId,
): UserSummary[] {
  return (
    state.conversations
      .get(conversationId)
      ?.participantIds.flatMap((userId) => {
        const profile = state.users.get(userId);
        return profile ? [profile] : [];
      }) ?? []
  );
}

export function communityMembers(
  state: AccountState,
  communityId: CommunityId,
): Array<{ membership: CommunityMember; profile?: UserSummary }> {
  return (
    state.communities.get(communityId)?.members.map((membership) => ({
      membership,
      profile: state.users.get(membership.userId),
    })) ?? []
  );
}

export function unreadCounts(state: AccountState) {
  const counts = new Map<ConversationId, number>();
  for (const entry of unreadInboxEntries(state)) {
    if (entry.kind !== "unread") continue;
    counts.set(
      entry.conversationId,
      (counts.get(entry.conversationId) ?? 0) + (entry.unreadCount ?? 1),
    );
  }
  return counts;
}

export function unreadInboxEntries(state: AccountState) {
  return [...state.inbox.values()].filter((entry) => {
    if (entry.read) return false;
    const readThrough = state.conversations.get(
      entry.conversationId,
    )?.readThroughMessageId;
    return (
      entry.messageId === undefined ||
      readThrough === undefined ||
      entry.messageId > readThrough
    );
  });
}

export function publicPresence(
  ephemeral: EphemeralState,
  userId: UserId,
): ContactPresence {
  return ephemeral.presence.get(userId)?.availability ?? "offline";
}

export function userActivities(
  ephemeral: EphemeralState,
  userId: UserId,
): ActivityView[] {
  return [...ephemeral.activities.values()]
    .filter((view) => view.userId === userId)
    .sort((left, right) =>
      right.activity.updatedAt.localeCompare(left.activity.updatedAt),
    );
}
