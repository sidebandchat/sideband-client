import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { initialAccountState } from "../client/state.js";
import { WorkspaceController } from "./workspace-controller.js";

const COMMUNITY_ID = entityId<"community">(
  "11111111-1111-4111-8111-111111111111",
);
const CHANNEL_ID = entityId<"channel">("22222222-2222-4222-8222-222222222222");
const VOICE_CHANNEL_ID = entityId<"channel">(
  "55555555-5555-4555-8555-555555555555",
);
const SECOND_COMMUNITY_ID = entityId<"community">(
  "77777777-7777-4777-8777-777777777777",
);
const SECOND_CHANNEL_ID = entityId<"channel">(
  "88888888-8888-4888-8888-888888888888",
);
const CONVERSATION_ID = entityId<"conversation">(
  "33333333-3333-4333-8333-333333333333",
);
const DIRECT_CONVERSATION_ID = entityId<"conversation">(
  "66666666-6666-4666-8666-666666666666",
);
const USER_ID = entityId<"user">("44444444-4444-4444-8444-444444444444");

function accountState() {
  return {
    ...initialAccountState,
    conversations: new Map([
      [
        DIRECT_CONVERSATION_ID,
        {
          id: DIRECT_CONVERSATION_ID,
          kind: "direct" as const,
          participantIds: [USER_ID],
          revision: 1,
        },
      ],
      [
        CONVERSATION_ID,
        {
          id: CONVERSATION_ID,
          kind: "community-channel" as const,
          participantIds: [USER_ID],
          channelId: CHANNEL_ID,
          revision: 1,
        },
      ],
    ]),
    communities: new Map([
      [
        COMMUNITY_ID,
        {
          id: COMMUNITY_ID,
          name: "Community",
          kind: "community" as const,
          ownerId: USER_ID,
          members: [],
          roles: [],
          revision: 1,
          channels: [
            {
              id: CHANNEL_ID,
              communityId: COMMUNITY_ID,
              conversationId: CONVERSATION_ID,
              name: "general",
              kind: "text" as const,
              position: 0,
              permissionOverrides: [],
              revision: 1,
            },
            {
              id: VOICE_CHANNEL_ID,
              communityId: COMMUNITY_ID,
              name: "Lounge",
              kind: "voice" as const,
              position: 1,
              permissionOverrides: [],
              revision: 1,
            },
          ],
        },
      ],
      [
        SECOND_COMMUNITY_ID,
        {
          id: SECOND_COMMUNITY_ID,
          name: "Other community",
          kind: "community" as const,
          ownerId: USER_ID,
          members: [],
          roles: [],
          revision: 1,
          channels: [
            {
              id: SECOND_CHANNEL_ID,
              communityId: SECOND_COMMUNITY_ID,
              name: "other-general",
              kind: "text" as const,
              position: 0,
              permissionOverrides: [],
              revision: 1,
            },
          ],
        },
      ],
    ]),
  };
}

describe("WorkspaceController", () => {
  it("opens a community conversation in its community channel", () => {
    const account = accountState();
    const workspace = new WorkspaceController(() => account);

    workspace.openConversation(CONVERSATION_ID);

    expect(workspace.state).toEqual({
      view: "conversation",
      selectedConversationId: CONVERSATION_ID,
      selectedCommunityId: COMMUNITY_ID,
      selectedChannelId: CHANNEL_ID,
    });
    expect(workspace.selectedChannel?.id).toBe(CHANNEL_ID);
  });

  it("resolves a community channel by its conversation mapping", () => {
    const account = accountState();
    const conversation = account.conversations.get(CONVERSATION_ID)!;
    account.conversations.set(CONVERSATION_ID, {
      ...conversation,
      channelId: undefined,
    });
    const workspace = new WorkspaceController(() => account);

    workspace.openConversation(CONVERSATION_ID);

    expect(workspace.state).toMatchObject({
      selectedCommunityId: COMMUNITY_ID,
      selectedChannelId: CHANNEL_ID,
    });
  });

  it("selects communities and channels entirely by native IDs", () => {
    const account = accountState();
    const workspace = new WorkspaceController(() => account);
    const listener = vi.fn();
    workspace.subscribe(listener);

    workspace.selectCommunity(COMMUNITY_ID);

    expect(workspace.state).toEqual({
      view: "conversation",
      selectedCommunityId: COMMUNITY_ID,
      selectedChannelId: CHANNEL_ID,
      selectedConversationId: CONVERSATION_ID,
    });
    expect(workspace.selectedCommunity?.name).toBe("Community");
    expect(workspace.selectedChannel?.name).toBe("general");
    expect(workspace.selectedConversation?.id).toBe(CONVERSATION_ID);
    expect(listener).toHaveBeenCalled();
  });

  it("keeps voice channels as first-class workspace selections", () => {
    const workspace = new WorkspaceController(() => accountState());

    workspace.selectChannel(VOICE_CHANNEL_ID);

    expect(workspace.state).toEqual({
      view: "voice-channel",
      selectedCommunityId: COMMUNITY_ID,
      selectedChannelId: VOICE_CHANNEL_ID,
      selectedConversationId: undefined,
    });
    expect(workspace.selectedChannel?.name).toBe("Lounge");
    expect(workspace.selectedConversation).toBeUndefined();
  });

  it("restores the last selected channel independently for each community", () => {
    const workspace = new WorkspaceController(() => accountState());
    workspace.selectCommunity(COMMUNITY_ID);
    workspace.selectChannel(VOICE_CHANNEL_ID);
    workspace.selectCommunity(SECOND_COMMUNITY_ID);

    workspace.selectCommunity(COMMUNITY_ID);

    expect(workspace.state).toEqual({
      view: "voice-channel",
      selectedCommunityId: COMMUNITY_ID,
      selectedChannelId: VOICE_CHANNEL_ID,
      selectedConversationId: undefined,
    });
  });

  it("restores the last DM instead of reusing a community channel", () => {
    const workspace = new WorkspaceController(() => accountState());
    workspace.openConversation(DIRECT_CONVERSATION_ID);
    workspace.selectChannel(CHANNEL_ID);

    workspace.showDirectMessages();

    expect(workspace.state).toEqual({
      view: "conversation",
      selectedConversationId: DIRECT_CONVERSATION_ID,
    });
    expect(workspace.selectedChannel).toBeUndefined();
    expect(workspace.selectedCommunity).toBeUndefined();
  });

  it("shows Friends when no DM has been selected before a community channel", () => {
    const workspace = new WorkspaceController(() => accountState());
    workspace.selectChannel(CHANNEL_ID);

    workspace.showDirectMessages();

    expect(workspace.state).toEqual({
      view: "friends",
      selectedConversationId: undefined,
    });
  });

  it("restores Friends after visiting a community from the Friends view", () => {
    const workspace = new WorkspaceController(() => accountState());
    workspace.openConversation(DIRECT_CONVERSATION_ID);
    workspace.showFriends();
    workspace.selectChannel(CHANNEL_ID);

    workspace.showDirectMessages();

    expect(workspace.state).toEqual({
      view: "friends",
      selectedConversationId: DIRECT_CONVERSATION_ID,
    });
    expect(workspace.selectedChannel).toBeUndefined();
    expect(workspace.selectedCommunity).toBeUndefined();
  });

  it("resets selection when membership state removes its community", () => {
    let account = accountState();
    const workspace = new WorkspaceController(() => account);
    workspace.openConversation(CONVERSATION_ID);
    account = {
      ...account,
      conversations: new Map(),
      communities: new Map(),
    };

    workspace.reconcile();

    expect(workspace.state).toEqual({ view: "friends" });
  });
});
