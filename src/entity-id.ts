const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare const entityIdBrand: unique symbol;
declare const orderedIdBrand: unique symbol;

export type EntityId<Kind extends string> = string & {
  readonly [entityIdBrand]: Kind;
};

export type UserId = EntityId<"user">;
export type DeviceId = EntityId<"device">;
export type ConversationId = EntityId<"conversation">;
export type CommunityId = EntityId<"community">;
export type ChannelId = EntityId<"channel">;
export type AttachmentId = EntityId<"attachment">;
export type RoleId = EntityId<"role">;
export type FriendshipId = EntityId<"friendship">;
export type CallId = EntityId<"call">;
export type PrivateConversationId = EntityId<"private-conversation">;
export type PrivateMessageId = EntityId<"private-message">;
export type InvitationId = EntityId<"invitation">;
export type BlockId = EntityId<"block">;
export type PrivateTransferId = EntityId<"private-transfer">;
export type ActivityId = EntityId<"activity">;
export type RequestId = EntityId<"request">;

export type OrderedId<Kind extends string> = bigint & {
  readonly [orderedIdBrand]: Kind;
};

export type MessageId = OrderedId<"message">;
export type EventId = OrderedId<"event">;
export type NotificationId = OrderedId<"notification">;

export function entityId<Kind extends string>(value: string): EntityId<Kind> {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError("Invalid entity ID");
  return normalized as EntityId<Kind>;
}

export function orderedId<Kind extends string>(
  value: bigint | number | string,
): OrderedId<Kind> {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > 9_223_372_036_854_775_807n)
    throw new TypeError("Invalid ordered ID");
  return parsed as OrderedId<Kind>;
}

export function idKey(id: string | bigint): string {
  return id.toString();
}
