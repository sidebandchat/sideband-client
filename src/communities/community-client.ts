import type {
  ChannelId,
  CommunityId,
  InvitationId,
  RoleId,
  UserId,
} from "../entity-id.js";
import type {
  CommunityPermission,
  CommunityPermissionOverride,
} from "../domain.js";
import { decodeEntityRef, entityRef, wireMap } from "../sbp/codec.js";
import type { SbpCommandTransport } from "../sbp/command-transport.js";
import {
  decodeCommunity,
  decodeCommunityChannel,
  decodeCommunityInvitation,
  decodeCommunityMemberPage,
  decodeCommunityRole,
} from "../sbp/records.js";
import { mapValue, required, unsignedValue } from "../sbp/value.js";

const permissionIds: Record<CommunityPermission, number> = {
  "view-channels": 0,
  "manage-community": 1,
  "manage-channels": 2,
  "manage-roles": 3,
  "manage-members": 4,
  "create-invitations": 5,
  "send-messages": 6,
  "join-voice": 7,
  "manage-messages": 8,
};

export class SbpCommunitiesClient {
  constructor(private readonly transport: SbpCommandTransport) {}

  async create(name: string) {
    return decodeCommunity(
      await this.transport.command(200, wireMap([[0, name]])),
    );
  }

  async acceptInvitation(token: string) {
    return decodeCommunity(
      await this.transport.command(201, wireMap([[0, token]])),
    );
  }

  async removeMember(communityId: CommunityId, userId: UserId) {
    return this.revision(202, [
      [0, entityRef("community", communityId)],
      [1, entityRef("user", userId)],
    ]);
  }

  async createInvitation(
    communityId: CommunityId,
    options: { reusable: boolean; expiresAt?: Date; maximumUses?: number },
  ) {
    return decodeCommunityInvitation(
      await this.transport.command(
        203,
        wireMap([
          [0, entityRef("community", communityId)],
          [1, options.reusable],
          ...optionalEntry(2, options.expiresAt),
          ...optionalEntry(3, options.maximumUses),
        ]),
      ),
    );
  }

  async rename(communityId: CommunityId, name: string, revision: number) {
    return decodeCommunity(
      await this.transport.command(
        204,
        wireMap([
          [0, entityRef("community", communityId)],
          [1, name],
          [2, revision],
        ]),
      ),
    );
  }

  async revokeInvitation(invitationId: InvitationId, revision: number) {
    return decodeCommunityInvitation(
      await this.transport.command(
        205,
        wireMap([
          [0, entityRef("invitation", invitationId)],
          [1, revision],
        ]),
      ),
    );
  }

  leave(communityId: CommunityId, revision: number) {
    return this.revision(206, [
      [0, entityRef("community", communityId)],
      [1, revision],
    ]);
  }

  async transferOwnership(
    communityId: CommunityId,
    userId: UserId,
    revision: number,
  ) {
    return decodeCommunity(
      await this.transport.command(
        207,
        wireMap([
          [0, entityRef("community", communityId)],
          [1, entityRef("user", userId)],
          [2, revision],
        ]),
      ),
    );
  }

  async members(
    communityId: CommunityId,
    options: { after?: UserId; limit?: number; online?: boolean } = {},
  ) {
    return decodeCommunityMemberPage(
      await this.transport.command(
        208,
        wireMap([
          [0, entityRef("community", communityId)],
          ...optionalEntry(
            1,
            options.after ? entityRef("user", options.after) : undefined,
          ),
          ...optionalEntry(2, options.limit),
          ...optionalEntry(3, options.online),
        ]),
      ),
    );
  }

  async channelMembers(
    channelId: ChannelId,
    options: { cursor?: string; limit?: number; online?: boolean } = {},
  ) {
    const response = await this.transport.command(
      209,
      wireMap([
        [0, entityRef("channel", channelId)],
        ...optionalEntry(1, options.cursor),
        ...optionalEntry(2, options.limit),
        ...optionalEntry(3, options.online),
      ]),
    );
    try {
      return decodeCommunityMemberPage(response);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new TypeError(`Invalid channel member page: ${message}`, {
        cause: reason,
      });
    }
  }

  async clearChannelMemberWatch() {
    await this.transport.command(209, wireMap([]));
  }

  async createChannel(
    communityId: CommunityId,
    kind: "text" | "voice",
    name: string,
  ) {
    return decodeCommunityChannel(
      await this.transport.command(
        210,
        wireMap([
          [0, entityRef("community", communityId)],
          [1, kind === "text" ? 0 : 1],
          [2, name],
        ]),
      ),
    );
  }

  async renameChannel(channelId: ChannelId, name: string, revision: number) {
    return decodeCommunityChannel(
      await this.transport.command(
        211,
        wireMap([
          [0, entityRef("channel", channelId)],
          [1, name],
          [2, revision],
        ]),
      ),
    );
  }

  async deleteChannel(channelId: ChannelId, revision: number) {
    const response = mapValue(
      await this.transport.command(
        212,
        wireMap([
          [0, entityRef("channel", channelId)],
          [1, revision],
        ]),
      ),
    );
    return decodeEntityRef(required(response, 0), "channel");
  }

  async createRole(
    communityId: CommunityId,
    name: string,
    permissions: CommunityPermission[],
  ) {
    return decodeCommunityRole(
      await this.transport.command(
        220,
        wireMap([
          [0, entityRef("community", communityId)],
          [1, name],
          [2, encodePermissions(permissions)],
        ]),
      ),
    );
  }

  assignRoles(
    communityId: CommunityId,
    userId: UserId,
    roleIds: RoleId[],
    revision: number,
  ) {
    return this.revision(221, [
      [0, entityRef("community", communityId)],
      [1, entityRef("user", userId)],
      [2, roleIds.map((id) => entityRef("role", id))],
      [3, revision],
    ]);
  }

  async setChannelOverrides(
    channelId: ChannelId,
    overrides: CommunityPermissionOverride[],
    revision: number,
  ) {
    return decodeCommunityChannel(
      await this.transport.command(
        222,
        wireMap([
          [0, entityRef("channel", channelId)],
          [1, overrides.map(encodeOverride)],
          [2, revision],
        ]),
      ),
    );
  }

  async updateRole(
    roleId: RoleId,
    name: string,
    permissions: CommunityPermission[],
    revision: number,
  ) {
    return decodeCommunityRole(
      await this.transport.command(
        223,
        wireMap([
          [0, entityRef("role", roleId)],
          [1, name],
          [2, encodePermissions(permissions)],
          [3, revision],
        ]),
      ),
    );
  }

  async deleteRole(roleId: RoleId, revision: number) {
    const response = mapValue(
      await this.transport.command(
        224,
        wireMap([
          [0, entityRef("role", roleId)],
          [1, revision],
        ]),
      ),
    );
    return decodeEntityRef(required(response, 0), "role");
  }

  private async revision(opcode: number, entries: [number, unknown][]) {
    const response = mapValue(
      await this.transport.command(opcode, wireMap(entries)),
    );
    return unsignedValue(required(response, 0));
  }
}

function encodePermissions(permissions: CommunityPermission[]) {
  return permissions.map((permission) => permissionIds[permission]);
}

function encodeOverride(override: CommunityPermissionOverride) {
  const subject =
    override.subject.kind === "everyone"
      ? [0]
      : override.subject.kind === "role"
        ? [1, entityRef("role", override.subject.roleId)]
        : [2, entityRef("user", override.subject.userId)];
  return wireMap([
    [0, subject],
    [1, encodePermissions(override.allow)],
    [2, encodePermissions(override.deny)],
  ]);
}

function optionalEntry(key: number, value: unknown): [number, unknown][] {
  return value === undefined ? [] : [[key, value]];
}
