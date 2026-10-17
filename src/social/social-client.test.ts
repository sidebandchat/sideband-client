import { describe, expect, it, vi } from "vitest";
import { entityId, orderedId } from "../entity-id.js";
import { decodeEntityRef, entityRef, wireMap } from "../sbp/codec.js";
import { SbpSocialClient } from "./social-client.js";

describe("SbpSocialClient", () => {
  it("loads, verifies, and publishes profile updates with each avatar intent", async () => {
    const verify = vi.fn(async (profile) => ({ ...profile, bio: "verified" }));
    const onOwnProfile = vi.fn();
    const command = vi.fn().mockResolvedValue(userProfileRecord());
    const client = new SbpSocialClient({ command }, verify, onOwnProfile);

    await expect(client.profile(userId)).resolves.toMatchObject({
      id: userId,
      bio: "verified",
    });

    for (const avatarId of [undefined, null, attachmentId] as const) {
      await client.updateProfile({
        displayName: "Alice",
        avatarId,
        revision: 4,
      });
      const payload = command.mock.lastCall![1];
      if (avatarId === undefined) expect(payload.has(2)).toBe(false);
      else if (avatarId === null) expect(payload.get(2)).toBeNull();
      else expect(decodeEntityRef(payload.get(2), "attachment")).toBe(avatarId);
    }

    await client.updateProfile({ bio: "Updated bio", revision: 5 });
    expect(command.mock.lastCall![1].has(0)).toBe(false);
    expect(command.mock.lastCall![1].get(1)).toBe("Updated bio");

    expect(verify).toHaveBeenCalledTimes(5);
    expect(onOwnProfile).toHaveBeenCalledTimes(4);
  });

  it("skips summary commands for empty input and resolves populated summaries", async () => {
    const command = vi
      .fn()
      .mockResolvedValue(wireMap([[0, [userProfileRecord()]]]));
    const client = new SbpSocialClient({ command });

    await expect(client.summaries([])).resolves.toEqual([]);
    await expect(client.summaries([userId])).resolves.toMatchObject([
      { id: userId, username: "alice" },
    ]);
    expect(command).toHaveBeenCalledOnce();
  });

  it("filters the inbox with protocol enum values", async () => {
    const conversationId = entityId<"conversation">(
      "11111111-1111-4111-8111-111111111111",
    );
    const command = vi.fn().mockResolvedValue(
      wireMap([
        [
          0,
          [
            wireMap([
              [0, orderedId<"notification">(5)],
              [1, 1],
              [2, entityRef("conversation", conversationId)],
              [6, new Date("2026-01-01T00:00:00.000Z")],
              [7, false],
            ]),
          ],
        ],
      ]),
    );
    const client = new SbpSocialClient({ command });

    const entries = await client.inbox({ kind: "mention", limit: 25 });

    expect(command.mock.calls[0]![0]).toBe(30);
    expect(command.mock.calls[0]![1].get(0)).toBe(1);
    expect(command.mock.calls[0]![1].get(1)).toBe(25);
    expect(entries[0]?.conversationId).toBe(conversationId);
  });

  it("encodes notification settings without leaking transport types", async () => {
    const command = vi
      .fn()
      .mockImplementation((_opcode, payload) => payload.get(0));
    const client = new SbpSocialClient({ command });

    const settings = await client.setNotificationSettings({
      scope: { kind: "account" },
      level: "mentions",
      suppressMassMentions: true,
      revision: 3,
    });

    expect(settings).toEqual({
      scope: { kind: "account" },
      level: "mentions",
      suppressMassMentions: true,
      revision: 3,
    });
  });

  it("encodes every notification scope and level", async () => {
    const command = vi
      .fn()
      .mockImplementation((_opcode, payload) => payload.get(0));
    const client = new SbpSocialClient({ command });
    const cases = [
      { scope: { kind: "account" as const }, level: "all" as const },
      {
        scope: { kind: "conversation" as const, conversationId },
        level: "mentions" as const,
      },
      {
        scope: { kind: "community" as const, communityId },
        level: "none" as const,
      },
    ];

    for (const [revision, entry] of cases.entries()) {
      await expect(
        client.setNotificationSettings({
          ...entry,
          suppressMassMentions: false,
          revision,
        }),
      ).resolves.toMatchObject(entry);
    }
  });

  it("omits absent inbox filters and encodes unread filters", async () => {
    const command = vi.fn().mockResolvedValue(wireMap([[0, []]]));
    const client = new SbpSocialClient({ command });

    await client.inbox();
    expect(command.mock.calls[0]![1].size).toBe(0);
    await client.inbox({ kind: "unread" });
    expect(command.mock.calls[1]![1].get(0)).toBe(0);
  });
});

const userId = entityId<"user">("22222222-2222-4222-8222-222222222222");
const attachmentId = entityId<"attachment">(
  "33333333-3333-4333-8333-333333333333",
);
const conversationId = entityId<"conversation">(
  "44444444-4444-4444-8444-444444444444",
);
const communityId = entityId<"community">(
  "55555555-5555-4555-8555-555555555555",
);

function userProfileRecord() {
  return wireMap([
    [0, entityRef("user", userId)],
    [1, "alice"],
    [2, "Alice"],
    [3, "hello"],
    [4, entityRef("attachment", attachmentId)],
    [5, new Date("2026-01-01T00:00:00.000Z")],
    [6, 4],
  ]);
}
