import { Tag } from "cbor-x";
import type {
  AccountSnapshot,
  AttachmentMetadata,
  Block,
  CallParticipant,
  CallSession,
  CallTarget,
  ChatMessage,
  ClientDevice,
  Community,
  CommunityChannel,
  CommunityInvitation,
  CommunityMember,
  CommunityMemberPage,
  CommunityPermission,
  CommunityPermissionOverride,
  CommunityRole,
  ConversationSnapshot,
  ConversationSummary,
  ContextHistoryPage,
  HistoryPage,
  InboxEntry,
  Mention,
  NotificationSettings,
  PrivateConversationSession,
  PrivateTransfer,
  RealtimeSettings,
  RosterContact,
  UserProfile,
  UserSummary,
} from "../domain.js";
import { entityId } from "../entity-id.js";
import { decodeEntityRef, decodeRequestRef } from "./codec.js";
import {
  arrayValue,
  booleanValue,
  bytesValue,
  integerValue,
  mapValue,
  optional,
  orderedValue,
  required,
  textValue,
  timestampValue,
  unsignedValue,
} from "./value.js";

const permissions: CommunityPermission[] = [
  "view-channels",
  "manage-community",
  "manage-channels",
  "manage-roles",
  "manage-members",
  "create-invitations",
  "send-messages",
  "join-voice",
  "manage-messages",
];

export function decodeUserSummary(value: unknown): UserSummary {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "user"),
    username: textValue(required(map, 1)),
    displayName: textValue(required(map, 2)),
    avatarId: optional(map, 4, (entry) => decodeEntityRef(entry, "attachment")),
    revision: unsignedValue(required(map, 6)),
  };
}

export function decodeUserProfile(value: unknown): UserProfile {
  const map = mapValue(value);
  return {
    ...decodeUserSummary(value),
    bio: optional(map, 3, textValue) ?? "",
    createdAt: timestampValue(required(map, 5)),
    badgeAssertion: optional(map, 7, textValue),
  };
}

export function decodeFriendship(value: unknown): RosterContact {
  const map = mapValue(value);
  const states = [
    "pending",
    "accepted",
    "declined",
    "cancelled",
    "removed",
  ] as const;
  const userId = decodeEntityRef(required(map, 1), "user");
  return {
    friendshipId: decodeEntityRef(required(map, 0), "friendship"),
    userId,
    name: "",
    state: enumValue(required(map, 2), states, "friendship state"),
    requesterId: decodeEntityRef(required(map, 3), "user"),
    createdAt: timestampValue(required(map, 4)),
    acceptedAt: optional(map, 5, timestampValue),
    revision: unsignedValue(required(map, 6)),
  };
}

export function decodeConversation(value: unknown): ConversationSummary {
  const map = mapValue(value);
  const kinds = ["direct", "group", "community-channel"] as const;
  return {
    id: decodeEntityRef(required(map, 0), "conversation"),
    kind: enumValue(required(map, 1), kinds, "conversation kind"),
    name: optional(map, 2, textValue),
    avatarId: optional(map, 3, (entry) => decodeEntityRef(entry, "attachment")),
    participantIds: arrayValue(required(map, 4)).map((entry) =>
      decodeEntityRef(entry, "user"),
    ),
    channelId: optional(map, 5, (entry) => decodeEntityRef(entry, "channel")),
    newestEventId: optional(map, 7, (entry) => orderedValue<"event">(entry)),
    readThroughMessageId: optional(map, 8, (entry) =>
      orderedValue<"message">(entry),
    ),
    revision: unsignedValue(required(map, 9)),
    ownerId: optional(map, 10, (entry) => decodeEntityRef(entry, "user")),
    createdAt: optional(map, 11, timestampValue),
  };
}

export function decodeMessage(value: unknown): ChatMessage {
  const map = mapValue(value);
  const messageKinds = ["user", "system", "call", "invitation"] as const;
  const kind = enumValue(required(map, 2), messageKinds, "message kind");
  const id = orderedValue<"message">(required(map, 0));
  const system = map.get(7);
  const reactions = optional(map, 13, decodeReactionSummaries);
  return {
    id,
    conversationId: decodeEntityRef(required(map, 1), "conversation"),
    kind,
    authorId: optional(map, 3, (entry) => decodeEntityRef(entry, "user")),
    author: optional(map, 16, decodeUserSummary),
    body: textValue(required(map, 4)),
    outgoing: false,
    timestamp: timestampValue(required(map, 8)),
    editedAt: optional(map, 9, timestampValue),
    deletedAt: optional(map, 10, timestampValue),
    revision: unsignedValue(required(map, 11)),
    attachments: optional(map, 6, (entry) =>
      arrayValue(entry).map(decodeAttachment),
    ),
    system,
    communityInvite:
      kind === "invitation" ? decodeInvitationMessage(system) : undefined,
    communityEvent:
      kind === "system" ? decodeCommunityEvent(system, id) : undefined,
    callEvent: kind === "call" ? decodeCallEvent(system) : undefined,
    privateEvent: kind === "call" ? decodePrivateEvent(system) : undefined,
    gif: optional(map, 12, decodeGif),
    reactions,
    mentions: optional(map, 14, (entry) =>
      arrayValue(entry).map(decodeMention),
    ),
    reply: optional(map, 5, (entry) => ({
      id: orderedValue<"message">(entry),
    })),
    replyPreview: optional(map, 15, decodeReplyPreview),
  };
}

function decodeCallEvent(value: unknown): ChatMessage["callEvent"] {
  const event = arrayValue(value);
  if (event.length !== 2 || event[0] !== 4) return undefined;
  const payload = mapValue(event[1]);
  return {
    callId: decodeEntityRef(required(payload, 0), "call"),
    initiatorId: decodeEntityRef(required(payload, 1), "user"),
    duration: unsignedValue(required(payload, 2)),
    type: enumValue(
      required(payload, 3),
      ["missed", "completed"] as const,
      "call outcome",
    ),
    group: optional(payload, 4, booleanValue) ?? false,
  };
}

function decodePrivateEvent(value: unknown): ChatMessage["privateEvent"] {
  const event = arrayValue(value);
  if (event.length !== 2 || event[0] !== 5) return undefined;
  const payload = mapValue(event[1]);
  return {
    sessionId: decodeEntityRef(required(payload, 0), "private-conversation"),
    initiatorId: decodeEntityRef(required(payload, 1), "user"),
    duration: unsignedValue(required(payload, 2)),
    type: enumValue(
      required(payload, 3),
      ["missed", "completed"] as const,
      "private conversation outcome",
    ),
  };
}

function decodeCommunityEvent(
  value: unknown,
  id: ChatMessage["id"],
): ChatMessage["communityEvent"] {
  const event = arrayValue(value);
  if (event.length !== 2) throw new TypeError("Invalid community event");
  const kinds = ["member-joined", "member-left"] as const;
  const payload = mapValue(event[1]);
  return {
    id,
    type: enumValue(event[0], kinds, "community event kind"),
    communityId: decodeEntityRef(required(payload, 0), "community"),
    userId: decodeEntityRef(required(payload, 1), "user"),
  };
}

function decodeInvitationMessage(value: unknown) {
  const map = mapValue(value);
  return {
    url: taggedText(required(map, 0), 32),
    communityName: textValue(required(map, 1)),
    communityId: decodeEntityRef(required(map, 2), "community"),
  };
}

export function decodeCommunity(value: unknown): Community {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "community"),
    name: textValue(required(map, 1)),
    kind: "community",
    avatarId: optional(map, 2, (entry) => decodeEntityRef(entry, "attachment")),
    ownerId: decodeEntityRef(required(map, 3), "user"),
    createdAt: timestampValue(required(map, 4)),
    members: arrayValue(required(map, 7)).map(decodeCommunityMember),
    membersComplete: optional(map, 9, booleanValue) ?? true,
    channels: arrayValue(required(map, 5)).map(decodeCommunityChannel),
    roles: arrayValue(required(map, 6)).map(decodeCommunityRole),
    revision: unsignedValue(required(map, 8)),
  };
}

export function decodeCommunityMemberPage(value: unknown): CommunityMemberPage {
  const map = mapValue(value);
  const channelId = optional(map, 7, (entry) =>
    decodeEntityRef(entry, "channel"),
  );
  return {
    communityId: decodeEntityRef(required(map, 0), "community"),
    members: arrayValue(required(map, 1)).map(decodeCommunityMember),
    profiles: arrayValue(required(map, 2)).map(decodeUserSummary),
    nextAfter: channelId
      ? undefined
      : optional(map, 3, (entry) => decodeEntityRef(entry, "user")),
    nextCursor: channelId ? optional(map, 3, textValue) : undefined,
    complete: booleanValue(required(map, 4)),
    total: unsignedValue(required(map, 5)),
    online: booleanValue(required(map, 6)),
    channelId,
  };
}

export function decodeCall(value: unknown): CallSession {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "call"),
    target: decodeCallTarget(required(map, 1)),
    originatorId: decodeEntityRef(required(map, 2), "user"),
    media: enumValue(
      required(map, 3),
      ["voice", "video"] as const,
      "call media",
    ),
    state: enumValue(
      required(map, 4),
      [
        "ringing",
        "connecting",
        "active",
        "ended",
        "declined",
        "expired",
      ] as const,
      "call state",
    ),
    startedAt: timestampValue(required(map, 5)),
    endedAt: optional(map, 6, timestampValue),
    participants: arrayValue(required(map, 7)).map(decodeCallParticipant),
    emptyRoomExpiresAt: optional(map, 8, timestampValue),
    establishedAt: optional(map, 9, timestampValue),
  };
}

export function decodePrivateConversation(
  value: unknown,
): PrivateConversationSession {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "private-conversation"),
    initiatorId: decodeEntityRef(required(map, 1), "user"),
    peerId: decodeEntityRef(required(map, 2), "user"),
    state: enumValue(
      required(map, 3),
      ["ringing", "negotiating", "active", "reconnecting", "ended"] as const,
      "private conversation state",
    ),
    startedAt: timestampValue(required(map, 4)),
    reconnectExpiresAt: optional(map, 5, timestampValue),
    encryptedInvitation: optional(map, 6, bytesValue),
  };
}

export function decodePrivateTransfer(value: unknown): PrivateTransfer {
  const map = mapValue(value);
  return {
    id: entityId<"private-transfer">(decodeRequestRef(required(map, 0))),
    privateConversationId: decodeEntityRef(
      required(map, 1),
      "private-conversation",
    ),
    senderId: decodeEntityRef(required(map, 2), "user"),
    byteSize: unsignedValue(required(map, 3)),
    state: enumValue(
      required(map, 4),
      [
        "offered",
        "accepted",
        "transferring",
        "completed",
        "declined",
        "canceled",
      ] as const,
      "private transfer state",
    ),
  };
}

export function decodeCallTarget(value: unknown): CallTarget {
  const target = arrayValue(value);
  if (target.length !== 2) throw new TypeError("Invalid call target");
  if (target[0] === 0)
    return { kind: "user", userId: decodeEntityRef(target[1], "user") };
  if (target[0] === 1)
    return {
      kind: "conversation",
      conversationId: decodeEntityRef(target[1], "conversation"),
    };
  if (target[0] === 2)
    return {
      kind: "channel",
      channelId: decodeEntityRef(target[1], "channel"),
    };
  throw new TypeError("Invalid call target");
}

function decodeCallParticipant(value: unknown): CallParticipant {
  const map = mapValue(value);
  return {
    userId: decodeEntityRef(required(map, 0), "user"),
    state: enumValue(
      required(map, 1),
      ["invited", "ringing", "joining", "active", "declined", "left"] as const,
      "call participant state",
    ),
    joinedAt: optional(map, 2, timestampValue),
  };
}

export function decodeCommunityInvitation(value: unknown): CommunityInvitation {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "invitation"),
    communityId: decodeEntityRef(required(map, 1), "community"),
    token: optional(map, 2, textValue),
    createdAt: timestampValue(required(map, 3)),
    expiresAt: optional(map, 4, timestampValue),
    url: taggedText(required(map, 5), 32),
    reusable: booleanValue(required(map, 6)),
    maximumUses: optional(map, 7, unsignedValue),
    uses: unsignedValue(required(map, 8)),
    revoked: booleanValue(required(map, 9)),
    revision: unsignedValue(required(map, 10)),
  };
}

export function decodeRealtimeSettings(value: unknown): RealtimeSettings {
  const map = mapValue(value);
  const visibility = ["nobody", "friends", "shared-context"] as const;
  return {
    presenceVisibility: enumValue(
      required(map, 0),
      visibility,
      "presence visibility",
    ),
    activityVisibility: enumValue(
      required(map, 1),
      visibility,
      "activity visibility",
    ),
    activitySharingEnabled: booleanValue(required(map, 2)),
    customStatus: optional(map, 3, (entry) => {
      const status = mapValue(entry);
      return {
        text: optional(status, 0, textValue),
        emoji: optional(status, 1, textValue),
        expiresAt: optional(status, 2, timestampValue),
      };
    }),
    revision: unsignedValue(required(map, 4)),
  };
}

export function decodeAccountSnapshot(value: unknown): AccountSnapshot {
  const map = mapValue(value);
  return {
    schemaVersion: unsignedValue(required(map, 0)),
    ownUser: decodeUserProfile(required(map, 2)),
    users: arrayValue(required(map, 3)).map(decodeUserSummary),
    friendships: arrayValue(required(map, 4)).map(decodeFriendship),
    conversations: arrayValue(required(map, 5)).map(decodeConversation),
    communities: arrayValue(required(map, 6)).map(decodeCommunity),
    realtimeSettings: decodeRealtimeSettings(required(map, 7)),
    inbox: arrayValue(required(map, 8)).map(decodeInboxEntry),
    blocks: arrayValue(required(map, 9)).map(decodeBlock),
    notificationSettings: arrayValue(required(map, 10)).map(
      decodeNotificationSettings,
    ),
    devices: arrayValue(required(map, 11)).map(decodeDevice),
  };
}

export function decodeConversationSnapshot(
  value: unknown,
): ConversationSnapshot {
  const map = mapValue(value);
  return {
    schemaVersion: unsignedValue(required(map, 0)),
    conversation: decodeConversation(required(map, 2)),
    messages: arrayValue(required(map, 3)).map(decodeMessage),
    reachedBeginning: booleanValue(required(map, 4)),
    profiles: arrayValue(required(map, 7)).map(decodeUserSummary),
  };
}

export function decodeHistoryPage(value: unknown): HistoryPage {
  const map = mapValue(value);
  return {
    conversationId: decodeEntityRef(required(map, 0), "conversation"),
    messages: arrayValue(required(map, 1)).map(decodeMessage),
    profiles: arrayValue(required(map, 7)).map(decodeUserSummary),
    reachedBeginning: booleanValue(required(map, 2)),
    reachedPresent: booleanValue(required(map, 3)),
    olderBefore: optional(map, 4, (entry) => orderedValue<"message">(entry)),
  };
}

export function decodeContextHistoryPage(value: unknown): ContextHistoryPage {
  const map = mapValue(value);
  return {
    conversationId: decodeEntityRef(required(map, 0), "conversation"),
    messages: arrayValue(required(map, 1)).map(decodeMessage),
    profiles: arrayValue(required(map, 7)).map(decodeUserSummary),
    reachedBeginning: booleanValue(required(map, 2)),
    reachedPresent: booleanValue(required(map, 3)),
    olderBefore: optional(map, 4, (entry) => orderedValue<"message">(entry)),
    newerAfter: optional(map, 5, (entry) => orderedValue<"message">(entry)),
  };
}

export function decodeAttachment(value: unknown): AttachmentMetadata {
  const map = mapValue(value);
  const image = optional(map, 5, mapValue);
  return {
    id: decodeEntityRef(required(map, 0), "attachment"),
    filename: textValue(required(map, 1)),
    mediaType: textValue(required(map, 2)),
    byteSize: unsignedValue(required(map, 3)),
    sha256: bytesValue(required(map, 4), 32),
    width: image ? unsignedValue(required(image, 0)) : undefined,
    height: image ? unsignedValue(required(image, 1)) : undefined,
    blurhash: image ? textValue(required(image, 2)) : undefined,
    revision: unsignedValue(required(map, 6)),
  };
}

function decodeMention(value: unknown): Mention {
  const map = mapValue(value);
  return {
    userId: decodeEntityRef(required(map, 0), "user"),
    begin: unsignedValue(required(map, 1)),
    end: unsignedValue(required(map, 2)),
  };
}

export function decodeReactionSummaries(value: unknown) {
  return arrayValue(value).map((entry) => {
    const map = mapValue(entry);
    return {
      emoji: textValue(required(map, 0)),
      count: unsignedValue(required(map, 1)),
      own: optional(map, 2, booleanValue) ?? false,
    };
  });
}

function decodeReplyPreview(value: unknown) {
  const map = mapValue(value);
  return {
    messageId: orderedValue<"message">(required(map, 0)),
    authorId: optional(map, 1, (entry) => decodeEntityRef(entry, "user")),
    author: optional(map, 4, decodeUserSummary),
    text: textValue(required(map, 2)),
    unavailable: booleanValue(required(map, 3)),
  };
}

function decodeGif(value: unknown): NonNullable<ChatMessage["gif"]> {
  const map = mapValue(value);
  const primary = decodeRendition(required(map, 3));
  const preview = decodeRendition(required(map, 4));
  return {
    url: primary.url,
    title: optional(map, 2, textValue),
    width: primary.width,
    height: primary.height,
    thumbnailUrl: preview.url,
    thumbnailWidth: preview.width,
    thumbnailHeight: preview.height,
    blurhash: optional(map, 5, textValue),
  };
}

function decodeRendition(value: unknown) {
  const map = mapValue(value);
  return {
    url: taggedText(required(map, 0), 32),
    width: unsignedValue(required(map, 2)),
    height: unsignedValue(required(map, 3)),
  };
}

export function decodeCommunityMember(value: unknown): CommunityMember {
  const map = mapValue(value);
  return {
    userId: decodeEntityRef(required(map, 0), "user"),
    joinedAt: timestampValue(required(map, 1)),
    roleIds: arrayValue(required(map, 2)).map((entry) =>
      decodeEntityRef(entry, "role"),
    ),
    permissions: arrayValue(required(map, 3)).map(decodePermission),
    revision: unsignedValue(required(map, 4)),
  };
}

export function decodeCommunityRole(value: unknown): CommunityRole {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "role"),
    communityId: decodeEntityRef(required(map, 6), "community"),
    name: textValue(required(map, 1)),
    position: integerValue(required(map, 2)),
    permissions: arrayValue(required(map, 3)).map(decodePermission),
    managed: booleanValue(required(map, 4)),
    revision: unsignedValue(required(map, 5)),
  };
}

export function decodeCommunityChannel(value: unknown): CommunityChannel {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "channel"),
    communityId: decodeEntityRef(required(map, 1), "community"),
    kind: enumValue(
      required(map, 2),
      ["text", "voice"] as const,
      "channel kind",
    ),
    name: textValue(required(map, 3)),
    position: integerValue(required(map, 4)),
    conversationId: decodeEntityRef(required(map, 5), "conversation"),
    permissionOverrides: arrayValue(required(map, 6)).map(
      decodePermissionOverride,
    ),
    revision: unsignedValue(required(map, 7)),
  };
}

function decodePermissionOverride(value: unknown): CommunityPermissionOverride {
  const map = mapValue(value);
  const rawSubject = arrayValue(required(map, 0));
  let subject: CommunityPermissionOverride["subject"];
  if (rawSubject.length === 1 && rawSubject[0] === 0)
    subject = { kind: "everyone" };
  else if (rawSubject.length === 2 && rawSubject[0] === 1)
    subject = { kind: "role", roleId: decodeEntityRef(rawSubject[1], "role") };
  else if (rawSubject.length === 2 && rawSubject[0] === 2)
    subject = { kind: "user", userId: decodeEntityRef(rawSubject[1], "user") };
  else throw new TypeError("Invalid permission override subject");
  return {
    subject,
    allow: arrayValue(required(map, 1)).map(decodePermission),
    deny: arrayValue(required(map, 2)).map(decodePermission),
  };
}

function decodePermission(value: unknown) {
  return enumValue(value, permissions, "community permission");
}

export function decodeInboxEntry(value: unknown): InboxEntry {
  const map = mapValue(value);
  return {
    id: orderedValue<"notification">(required(map, 0)),
    kind: enumValue(
      required(map, 1),
      ["unread", "mention"] as const,
      "inbox kind",
    ),
    conversationId: decodeEntityRef(required(map, 2), "conversation"),
    messageId: optional(map, 3, (entry) => orderedValue<"message">(entry)),
    senderId: optional(map, 4, (entry) => decodeEntityRef(entry, "user")),
    preview: optional(map, 5, textValue),
    createdAt: timestampValue(required(map, 6)),
    read: booleanValue(required(map, 7)),
    unreadCount: optional(map, 8, unsignedValue) ?? 1,
  };
}

export function decodeBlock(value: unknown): Block {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "block"),
    userId: decodeEntityRef(required(map, 1), "user"),
    createdAt: timestampValue(required(map, 2)),
    revision: unsignedValue(required(map, 3)),
  };
}

export function decodeNotificationSettings(
  value: unknown,
): NotificationSettings {
  const map = mapValue(value);
  const rawScope = arrayValue(required(map, 0));
  let scope: NotificationSettings["scope"];
  if (rawScope.length === 1 && rawScope[0] === 0) scope = { kind: "account" };
  else if (rawScope.length === 2 && rawScope[0] === 1)
    scope = {
      kind: "conversation",
      conversationId: decodeEntityRef(rawScope[1], "conversation"),
    };
  else if (rawScope.length === 2 && rawScope[0] === 2)
    scope = {
      kind: "community",
      communityId: decodeEntityRef(rawScope[1], "community"),
    };
  else throw new TypeError("Invalid notification scope");
  return {
    scope,
    level: enumValue(
      required(map, 1),
      ["all", "mentions", "none"] as const,
      "notification level",
    ),
    suppressMassMentions: booleanValue(required(map, 2)),
    revision: unsignedValue(required(map, 3)),
  };
}

export function decodeDevice(value: unknown): ClientDevice {
  const map = mapValue(value);
  return {
    id: decodeEntityRef(required(map, 0), "device"),
    name: optional(map, 1, textValue),
    platform: optional(map, 2, textValue),
    clientVersion: optional(map, 3, textValue),
    createdAt: timestampValue(required(map, 4)),
    lastSeenAt: timestampValue(required(map, 5)),
    lastIp: optional(map, 6, textValue),
    current: booleanValue(required(map, 7)),
    revision: unsignedValue(required(map, 8)),
  };
}

function taggedText(value: unknown, tag: number): string {
  if (!(value instanceof Tag) || value.tag !== tag)
    throw new TypeError(`Expected CBOR tag ${tag}`);
  return textValue(value.value);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  name: string,
): Values[number] {
  const index = unsignedValue(value);
  const result = values[index];
  if (result === undefined) throw new TypeError(`Invalid ${name}`);
  return result;
}
