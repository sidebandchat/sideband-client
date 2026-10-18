import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { decodeEntityRef, entityRef } from "../sbp/codec.js";
import { SbpCommunitiesClient } from "./community-client.js";

const communityId = entityId<"community">(
  "11111111-1111-4111-8111-111111111111",
);
const channelId = entityId<"channel">("22222222-2222-4222-8222-222222222222");
const conversationId = entityId<"conversation">(
  "55555555-5555-4555-8555-555555555555",
);
const roleId = entityId<"role">("33333333-3333-4333-8333-333333333333");
const userId = entityId<"user">("44444444-4444-4444-8444-444444444444");

describe("SbpCommunitiesClient", () => {
  it("requests and decodes an online member page", async () => {
    const command = vi.fn().mockResolvedValue(
      new Map([
        [0, entityRef("community", communityId)],
        [1, []],
        [2, []],
        [4, true],
        [5, 37],
        [6, true],
      ]),
    );
    const client = new SbpCommunitiesClient({ command });

    const page = await client.members(communityId, {
      limit: 200,
      online: true,
    });

    expect(command.mock.calls[0]![0]).toBe(208);
    expect(command.mock.calls[0]![1].get(3)).toBe(true);
    expect(page).toMatchObject({ online: true, total: 37, complete: true });
  });

  it("round-trips opaque channel member cursors", async () => {
    const command = vi.fn().mockResolvedValue(
      new Map([
        [0, entityRef("community", communityId)],
        [1, []],
        [2, []],
        [3, "opaque-next-cursor"],
        [4, false],
        [5, 5000],
        [6, false],
        [7, entityRef("channel", channelId)],
      ]),
    );
    const client = new SbpCommunitiesClient({ command });

    const page = await client.channelMembers(channelId, {
      cursor: "opaque-current-cursor",
      limit: 200,
    });

    const [opcode, payload] = command.mock.calls[0]!;
    expect(opcode).toBe(209);
    expect(payload.get(1)).toBe("opaque-current-cursor");
    expect(page.nextCursor).toBe("opaque-next-cursor");
    expect(page.nextAfter).toBeUndefined();
  });

  it("encodes channel creation with a closed channel-kind value", async () => {
    const command = vi.fn().mockResolvedValue(channelRecord());
    const client = new SbpCommunitiesClient({ command });

    const channel = await client.createChannel(communityId, "voice", "Lounge");

    const [opcode, payload] = command.mock.calls[0]!;
    expect(opcode).toBe(210);
    expect(decodeEntityRef(payload.get(0), "community")).toBe(communityId);
    expect(payload.get(1)).toBe(1);
    expect(channel).toMatchObject({
      id: channelId,
      kind: "voice",
      name: "Lounge",
    });
  });

  it("encodes permission overrides from domain values", async () => {
    const command = vi.fn().mockResolvedValue(channelRecord());
    const client = new SbpCommunitiesClient({ command });

    await client.setChannelOverrides(
      channelId,
      [
        {
          subject: { kind: "everyone" },
          allow: ["view-channels", "send-messages"],
          deny: ["join-voice"],
        },
      ],
      4,
    );

    const payload = command.mock.calls[0]![1];
    expect(payload.get(1)[0].get(0)).toEqual([0]);
    expect(payload.get(1)[0].get(1)).toEqual([0, 6]);
    expect(payload.get(1)[0].get(2)).toEqual([7]);
  });

  it("encodes role and user permission-override subjects", async () => {
    const command = vi.fn().mockResolvedValue(channelRecord());
    const client = new SbpCommunitiesClient({ command });

    await client.setChannelOverrides(
      channelId,
      [
        { subject: { kind: "role", roleId }, allow: [], deny: [] },
        { subject: { kind: "user", userId }, allow: [], deny: [] },
      ],
      5,
    );

    const overrides = command.mock.calls[0]![1].get(1);
    expect(decodeEntityRef(overrides[0].get(0)[1], "role")).toBe(roleId);
    expect(decodeEntityRef(overrides[1].get(0)[1], "user")).toBe(userId);
  });

  it("encodes text channels and member-page cursors", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce(channelRecord("text"))
      .mockResolvedValueOnce(
        new Map([
          [0, entityRef("community", communityId)],
          [1, []],
          [2, []],
          [4, true],
          [5, 0],
          [6, false],
        ]),
      );
    const client = new SbpCommunitiesClient({ command });

    await client.createChannel(communityId, "text", "General");
    expect(command.mock.calls[0]![1].get(1)).toBe(0);
    await client.members(communityId, { after: userId });
    expect(decodeEntityRef(command.mock.calls[1]![1].get(1), "user")).toBe(
      userId,
    );
  });
});

function channelRecord(kind: "text" | "voice" = "voice") {
  return new Map([
    [0, entityRef("channel", channelId)],
    [1, entityRef("community", communityId)],
    [2, kind === "text" ? 0 : 1],
    [3, "Lounge"],
    [4, 0],
    [5, entityRef("conversation", conversationId)],
    [6, []],
    [7, 1],
  ]);
}
