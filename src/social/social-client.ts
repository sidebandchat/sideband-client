import type {
  BlockId,
  FriendshipId,
  NotificationId,
  UserId,
} from "../entity-id.js";
import type { NotificationSettings } from "../domain.js";
import { decodeEntityRef, entityRef, wireMap } from "../sbp/codec.js";
import type { SbpCommandTransport } from "../sbp/command-transport.js";
import {
  decodeBlock,
  decodeFriendship,
  decodeInboxEntry,
  decodeNotificationSettings,
  decodeUserProfile,
  decodeUserSummary,
} from "../sbp/records.js";
import {
  arrayValue,
  booleanValue,
  mapValue,
  orderedValue,
  required,
} from "../sbp/value.js";

export type UpdateProfileInput = {
  displayName?: string;
  bio?: string;
  avatarId?: import("../entity-id.js").AttachmentId | null;
  revision: number;
};

export class SbpSocialClient {
  constructor(
    private readonly transport: SbpCommandTransport,
    private readonly verifyProfile: (
      profile: ReturnType<typeof decodeUserProfile>,
    ) => Promise<ReturnType<typeof decodeUserProfile>> = async (profile) =>
      profile,
    private readonly onOwnProfile: (
      profile: ReturnType<typeof decodeUserProfile>,
    ) => void = () => undefined,
  ) {}

  async profile(userId: UserId) {
    return this.verifyProfile(
      decodeUserProfile(
        await this.transport.command(
          20,
          wireMap([[0, entityRef("user", userId)]]),
        ),
      ),
    );
  }

  async refreshActivity(userId: UserId) {
    await this.transport.command(35, wireMap([[0, entityRef("user", userId)]]));
  }

  async updateProfile(input: UpdateProfileInput) {
    const avatar =
      input.avatarId === null
        ? null
        : input.avatarId
          ? entityRef("attachment", input.avatarId)
          : undefined;
    const profile = await this.verifyProfile(
      decodeUserProfile(
        await this.transport.command(
          21,
          wireMap([
            ...optionalEntry(0, input.displayName),
            ...optionalEntry(1, input.bio),
            ...optionalEntry(2, avatar),
            [3, input.revision],
          ]),
        ),
      ),
    );
    this.onOwnProfile(profile);
    return profile;
  }

  async resolveHandle(handle: string) {
    return decodeUserSummary(
      await this.transport.command(22, wireMap([[0, handle]])),
    );
  }

  async summaries(userIds: UserId[]) {
    if (!userIds.length) return [];
    const response = mapValue(
      await this.transport.command(
        23,
        wireMap([[0, userIds.map((id) => entityRef("user", id))]]),
      ),
    );
    return arrayValue(required(response, 0)).map(decodeUserSummary);
  }

  async requestFriend(userId: UserId) {
    return decodeFriendship(
      await this.transport.command(
        24,
        wireMap([[0, entityRef("user", userId)]]),
      ),
    );
  }

  acceptFriend(friendshipId: FriendshipId, revision: number) {
    return this.friendshipMutation(25, friendshipId, revision);
  }
  declineFriend(friendshipId: FriendshipId, revision: number) {
    return this.friendshipMutation(26, friendshipId, revision);
  }
  cancelFriend(friendshipId: FriendshipId, revision: number) {
    return this.friendshipMutation(27, friendshipId, revision);
  }
  removeFriend(friendshipId: FriendshipId, revision: number) {
    return this.friendshipMutation(28, friendshipId, revision);
  }

  async inbox(options: { kind?: "unread" | "mention"; limit?: number } = {}) {
    const response = mapValue(
      await this.transport.command(
        30,
        wireMap([
          ...optionalEntry(
            0,
            options.kind === undefined
              ? undefined
              : options.kind === "unread"
                ? 0
                : 1,
          ),
          ...optionalEntry(1, options.limit),
        ]),
      ),
    );
    return arrayValue(required(response, 0)).map(decodeInboxEntry);
  }

  async markInboxRead(notificationId: NotificationId) {
    const response = mapValue(
      await this.transport.command(31, wireMap([[0, notificationId]])),
    );
    return {
      id: orderedValue<"notification">(required(response, 0)),
      read: booleanValue(required(response, 1)),
    };
  }

  async block(userId: UserId) {
    return decodeBlock(
      await this.transport.command(
        32,
        wireMap([[0, entityRef("user", userId)]]),
      ),
    );
  }

  async unblock(blockId: BlockId, revision: number) {
    const response = mapValue(
      await this.transport.command(
        33,
        wireMap([
          [0, entityRef("block", blockId)],
          [1, revision],
        ]),
      ),
    );
    return decodeEntityRef(required(response, 0), "block");
  }

  async setNotificationSettings(settings: NotificationSettings) {
    return decodeNotificationSettings(
      await this.transport.command(
        34,
        wireMap([[0, encodeNotificationSettings(settings)]]),
      ),
    );
  }

  private async friendshipMutation(
    opcode: number,
    friendshipId: FriendshipId,
    revision: number,
  ) {
    return decodeFriendship(
      await this.transport.command(
        opcode,
        wireMap([
          [0, entityRef("friendship", friendshipId)],
          [1, revision],
        ]),
      ),
    );
  }
}

function encodeNotificationSettings(settings: NotificationSettings) {
  const scope =
    settings.scope.kind === "account"
      ? [0]
      : settings.scope.kind === "conversation"
        ? [1, entityRef("conversation", settings.scope.conversationId)]
        : [2, entityRef("community", settings.scope.communityId)];
  const level = { all: 0, mentions: 1, none: 2 }[settings.level];
  return wireMap([
    [0, scope],
    [1, level],
    [2, settings.suppressMassMentions],
    [3, settings.revision],
  ]);
}

function optionalEntry(key: number, value: unknown): [number, unknown][] {
  return value === undefined ? [] : [[key, value]];
}
