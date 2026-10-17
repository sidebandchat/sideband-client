import { describe, expect, it } from "vitest";
import {
  entityId,
  orderedId,
  type ChannelId,
  type CommunityId,
  type ConversationId,
  type FriendshipId,
  type UserId,
} from "../entity-id.js";
import type {
  Community,
  ConversationSummary,
  RosterContact,
  UserProfile,
} from "../domain.js";
import {
  conversationDisplayName,
  conversationRelationship,
  createMentionCandidates,
  createWorkspaceDirectory,
  typingDisplayNames,
  uniqueMentionCandidates,
  userDisplayName,
} from "./workspace-selectors.js";

const me = id<UserId>("00000000-0000-4000-8000-000000000001");
const alice = id<UserId>("00000000-0000-4000-8000-000000000002");
const bob = id<UserId>("00000000-0000-4000-8000-000000000003");
const directId = id<ConversationId>("10000000-0000-4000-8000-000000000001");
const groupId = id<ConversationId>("10000000-0000-4000-8000-000000000002");
const channelConversationId = id<ConversationId>(
  "10000000-0000-4000-8000-000000000003",
);
const communityId = id<CommunityId>("20000000-0000-4000-8000-000000000001");
const channelId = id<ChannelId>("30000000-0000-4000-8000-000000000001");

const profiles = new Map<UserId, UserProfile>([
  [me, profile(me, "me", "Me")],
  [alice, profile(alice, "alice", "Alice")],
  [bob, profile(bob, "bob", "")],
]);
const direct: ConversationSummary = {
  id: directId,
  kind: "direct",
  participantIds: [me, alice],
  newestEventId: orderedId(10),
  revision: 1,
};
const group: ConversationSummary = {
  id: groupId,
  kind: "group",
  participantIds: [me, alice, bob],
  newestEventId: orderedId(20),
  revision: 1,
};
const community: Community = {
  id: communityId,
  name: "Sideband",
  kind: "community",
  ownerId: me,
  members: [],
  channels: [
    {
      id: channelId,
      communityId,
      name: "general",
      kind: "text",
      conversationId: channelConversationId,
      position: 0,
      permissionOverrides: [],
      revision: 1,
    },
  ],
  roles: [],
  revision: 1,
};

describe("native workspace selectors", () => {
  it("resolves display names from profiles", () => {
    expect(userDisplayName(alice, profiles)).toBe("Alice");
    expect(userDisplayName(bob, profiles)).toBe("bob");
  });

  it("derives unnamed direct and group conversation names", () => {
    expect(conversationDisplayName(direct, me, profiles)).toBe("Alice");
    expect(conversationDisplayName(group, me, profiles)).toBe("Alice, bob");
    expect(
      conversationDisplayName({ ...group, name: "Raid Team" }, me, profiles),
    ).toBe("Raid Team");
  });

  it("builds an ordered native conversation and channel directory", () => {
    const directory = createWorkspaceDirectory({
      ownUserId: me,
      users: profiles,
      conversations: new Map([
        [direct.id, direct],
        [group.id, group],
        [
          channelConversationId,
          {
            id: channelConversationId,
            kind: "community-channel",
            participantIds: [me, alice, bob],
            channelId,
            newestEventId: orderedId(30),
            revision: 1,
          },
        ],
      ]),
      communities: new Map([[community.id, community]]),
    });

    expect(directory.conversations.map(({ id }) => id)).toEqual([
      groupId,
      directId,
    ]);
    expect(directory.destinations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "dm",
          conversationId: directId,
          userId: alice,
          label: "Alice",
        }),
        expect.objectContaining({
          kind: "group_dm",
          conversationId: groupId,
          label: "Alice, bob",
        }),
        expect.objectContaining({
          kind: "channel",
          communityId,
          channelId,
          label: "general",
        }),
      ]),
    );
    expect(directory.destinations).toHaveLength(3);
  });

  it("creates unique mention candidates using native user IDs", () => {
    expect(
      createMentionCandidates({
        ownUserId: me,
        selectedConversation: group,
        participants: [
          { userId: me, nick: "Duplicate Me" },
          { userId: alice, nick: "alice-nick" },
          { userId: bob, nick: "Bobby" },
        ],
        profiles,
      }),
    ).toEqual([
      { userId: alice, username: "alice", label: "Alice" },
      { userId: bob, username: "bob", label: "Bobby" },
    ]);

    expect(
      uniqueMentionCandidates([
        { userId: alice, username: "alice", label: "alice" },
        { userId: alice, username: "alice", label: "Alice" },
      ]),
    ).toEqual([{ userId: alice, username: "alice", label: "Alice" }]);
  });

  it("derives relationship and presence state from native maps", () => {
    const friendship = acceptedFriendship();
    expect(
      conversationRelationship({
        userId: alice,
        friendships: {
          accepted: [friendship],
          received: [],
          sent: [],
        },
        presence: new Map([
          [
            alice,
            {
              userId: alice,
              availability: "online",
              customStatus: { text: "Working" },
              observedAt: "2026-01-01T00:00:00Z",
              expiresAt: "2026-01-01T00:01:00Z",
            },
          ],
        ]),
      }),
    ).toEqual({
      friend: true,
      requestIncoming: false,
      requestSent: false,
      presence: "online",
      status: "Working",
    });
  });

  it("resolves typing names through profiles and participant nicknames", () => {
    expect(
      typingDisplayNames(
        [alice, bob],
        [{ userId: bob, nick: "Bobby" }],
        profiles,
      ),
    ).toEqual(["Alice", "Bobby"]);
  });

  it("withholds unresolved typing identities", () => {
    const unknown = id<UserId>("30000000-0000-4000-8000-000000000099");
    expect(typingDisplayNames([unknown], [], profiles)).toEqual([]);
  });
});

function profile(
  id: UserId,
  username: string,
  displayName: string,
): UserProfile {
  return { id, username, displayName, bio: "", revision: 1 };
}

function acceptedFriendship(): RosterContact {
  return {
    friendshipId: id<FriendshipId>("40000000-0000-4000-8000-000000000001"),
    userId: alice,
    name: "Alice",
    state: "accepted",
    requesterId: me,
    createdAt: "2026-01-01T00:00:00Z",
    acceptedAt: "2026-01-01T00:00:01Z",
    revision: 1,
  };
}

function id<T extends string>(value: string) {
  return entityId(value) as unknown as T;
}
